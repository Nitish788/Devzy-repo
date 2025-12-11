/**
 * kg_builder.js
 *
 * Heavy Node.js pipeline:
 *  - Walk repo
 *  - Parse files via tree-sitter per language
 *  - Extract Function / Class entities
 *  - Compute embeddings (pluggable)
 *  - Upsert nodes + relationships into Neo4j
 *
 * Usage:
 *  node kg_builder.js
 *
 * Note: tune BATCH_SIZE and CONCURRENCY for your environment.
 */

require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const fg = require('fast-glob');
const pLimit = require('p-limit');

const TreeSitter = require('tree-sitter');
const Python = require('tree-sitter-python');
const JS = require('tree-sitter-javascript');
const Go = require('tree-sitter-go');

const neo4j = require('neo4j-driver');

const { OpenAI } = require('openai'); // optional, if using OpenAI embeddings

// --- Config from env
const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PWD = process.env.NEO4J_PASSWORD || 'password';
const BASE_DIR = process.env.BASE_DIR || process.cwd();
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '200', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

// === Neo4j driver
const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PWD), {
  // tuned options if necessary
  maxConnectionPoolSize: 50
});

// === OpenAI client (optional)
let openai;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// --- language map by extension
const LANG_MAP = {
  '.py': { name: 'python', grammar: Python },
  '.js': { name: 'javascript', grammar: JS },
  '.jsx': { name: 'javascript', grammar: JS },
  '.ts': { name: 'typescript', grammar: JS }, // tree-sitter-javascript handles TS-ish; optionally use tree-sitter-typescript
  '.go': { name: 'go', grammar: Go },
};

// Allowed extensions
const EXTENSIONS = Object.keys(LANG_MAP);

// === Utility: safe read
async function safeRead(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    console.warn(`Failed to read ${file}: ${e.message}`);
    return null;
  }
}

// === Build tree-sitter parser for a grammar
function makeParser(grammar) {
  const parser = new TreeSitter();
  parser.setLanguage(grammar);
  return parser;
}

// === Node extraction helpers per language node types
function extractEntitiesFromTree(tree, source, langName) {
  const root = tree.rootNode;
  const entities = [];

  function nodeText(node) {
    return source.slice(node.startByte, node.endByte);
  }

  function walk(node, parentContext = null) {
    // Python: function_definition, class_definition
    // JS: function_declaration, function_expression, method_definition, class_declaration
    // Go: function_declaration, method_declaration, type_spec/struct_type
    const t = node.type;

    if (langName === 'python') {
      if (t === 'function_definition') {
        const nameNode = node.childForFieldName('name') || node.child(1);
        const name = nameNode ? nodeText(nameNode).trim() : '<anon>';
        const start = node.startPosition;
        const end = node.endPosition;
        // docstring heuristic: first expr_statement if it's a string literal
        let doc = '';
        const firstChild = node.namedChildren[0];
        if (firstChild && firstChild.type === 'expression_statement'
            && firstChild.firstChild && firstChild.firstChild.type === 'string') {
          doc = firstChild.firstChild.text.replace(/^['"`]+|['"`]+$/g, '');
        }
        entities.push({
          type: 'Function',
          lang: 'python',
          name,
          startLine: start.row + 1,
          endLine: end.row + 1,
          snippet: nodeText(node),
          doc,
        });
      } else if (t === 'class_definition') {
        const nameNode = node.childForFieldName('name') || node.child(1);
        const name = nameNode ? nodeText(nameNode).trim() : '<anon>';
        const start = node.startPosition;
        const end = node.endPosition;
        entities.push({
          type: 'Class',
          lang: 'python',
          name,
          startLine: start.row + 1,
          endLine: end.row + 1,
          snippet: nodeText(node),
          doc: '', // could parse __doc__ similarly
        });
      }
    } else if (langName === 'javascript' || langName === 'typescript') {
      if (t === 'function_declaration' || t === 'method_definition') {
        let name = '<anon>';
        if (node.childForFieldName && node.childForFieldName('name')) {
          name = nodeText(node.childForFieldName('name')).trim();
        } else {
          // search for identifier child
          const id = node.descendantsOfType ? node.descendantsOfType('identifier') : null;
          if (id && id.length) name = nodeText(id[0]);
        }
        entities.push({
          type: 'Function',
          lang: langName,
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          snippet: nodeText(node),
          doc: '',
        });
      } else if (t === 'class_declaration') {
        const nameNode = node.childForFieldName && node.childForFieldName('name');
        const name = nameNode ? nodeText(nameNode).trim() : '<anon>';
        entities.push({
          type: 'Class',
          lang: langName,
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          snippet: nodeText(node),
          doc: '',
        });
      }
    } else if (langName === 'go') {
      if (t === 'function_declaration' || t === 'method_declaration') {
        // find identifier
        const id = node.namedChildren.find(n => n.type === 'identifier');
        const name = id ? nodeText(id) : '<anon>';
        entities.push({
          type: 'Function',
          lang: 'go',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          snippet: nodeText(node),
          doc: '',
        });
      } else if (t === 'struct_type' || t === 'type_spec') {
        // type_spec contains identifier + type; handle struct_type
        const parent = node.parent;
        let name = '<anon>';
        if (parent && parent.type === 'type_spec') {
          const id = parent.childForFieldName && parent.childForFieldName('name');
          if (id) name = nodeText(id);
        }
        entities.push({
          type: 'Class', // treat struct as Class/Type in KG
          lang: 'go',
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          snippet: nodeText(node),
          doc: '',
        });
      }
    }

    for (const c of node.namedChildren) walk(c, parentContext);
  }

  walk(root);
  return entities;
}

// === Create a textual blob for embedding
function makeBlob(entity, filePath) {
  const header = `${entity.type} ${entity.name} (${entity.lang})\nfile: ${filePath}:${entity.startLine}-${entity.endLine}`;
  const doc = entity.doc ? `\ndoc: ${entity.doc}` : '';
  const code = `\n\n${entity.snippet.substring(0, 32 * 1024)}`; // trim very large bodies
  return `${header}${doc}${code}`;
}

// === Embedding function (pluggable)
async function embed(text) {
  // If OpenAI configured, call it. Otherwise return a mock vector (useful for testing).
  if (openai) {
    // Use OpenAI embeddings endpoint
    const resp = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    });
    return resp.data[0].embedding;
  } else {
    // deterministic hash-to-vector fallback (not for production)
    const crypto = require('crypto');
    const h = crypto.createHash('sha256').update(text).digest();
    // convert to small float vector
    const vec = Array.from(h).slice(0, 1536).map((b, i) => (b / 255) - 0.5);
    return vec;
  }
}

// === Neo4j upsert batch
async function upsertBatch(session, filePath, entitiesWithEmbeddings) {
  // entitiesWithEmbeddings: [{ entity, embedding, id }]
  // We upsert File node, then Function/Class nodes, then DEF relationship
  const tx = session.beginTransaction();
  try {
    // Merge File node
    await tx.run(
      `MERGE (f:File {path: $path})
       ON CREATE SET f.created = timestamp()
       RETURN id(f) as fileId`, { path: filePath }
    );

    // Upsert entities
    // We'll create nodes with a composite key: filePath + startLine + type
    for (const { entity, embedding } of entitiesWithEmbeddings) {
      const uid = `${filePath}::${entity.startLine}::${entity.endLine}::${entity.type}`;
      const params = {
        uid,
        filePath,
        name: entity.name,
        type: entity.type,
        lang: entity.lang,
        startLine: neo4j.int(entity.startLine),
        endLine: neo4j.int(entity.endLine),
        snippet: entity.snippet,
        doc: entity.doc || '',
        embedding, // will be stored as list
      };
      // Upsert node and relationship to file
      await tx.run(
        `MERGE (e:Entity {uid: $uid})
         ON CREATE SET e.created = timestamp()
         SET e.name = $name, e.type = $type, e.lang = $lang,
             e.startLine = $startLine, e.endLine = $endLine,
             e.snippet = $snippet, e.doc = $doc, e.embedding = $embedding
         WITH e
         MATCH (f:File {path: $filePath})
         MERGE (f)-[:DEFINES]->(e)`,
        params
      );
    }

    await tx.commit();
  } catch (err) {
    console.error('Neo4j upsert error', err);
    await tx.rollback();
    throw err;
  }
}

// === Main pipeline
async function run() {
  // 1) discover files
  const patterns = EXTENSIONS.map(ext => `**/*${ext}`);
  const files = await fg(patterns, {
    cwd: BASE_DIR,
    absolute: true,
    dot: false,
    ignore: ['**/node_modules/**', '**/.git/**', '**/venv/**', '**/__pycache__/**'],
  });

  console.log(`Found ${files.length} source files. Starting parse...`);

  // 2) create parsers per language
  const parserCache = {};
  for (const ext of EXTENSIONS) {
    const lang = LANG_MAP[ext].grammar;
    // instantiate parser per grammar
    parserCache[ext] = makeParser(lang);
  }

  // 3) process files with concurrency limit
  const limit = pLimit(CONCURRENCY);
  const tasks = files.map(file => limit(async () => {
    const ext = path.extname(file);
    const map = LANG_MAP[ext];
    if (!map) return null;
    const parser = parserCache[ext];
    const src = await safeRead(file);
    if (!src) return null;
    let tree;
    try {
      tree = parser.parse(Buffer.from(src));
    } catch (err) {
      console.warn(`Parse failed ${file}: ${err.message}`);
      return null;
    }
    const langName = map.name;
    const entities = extractEntitiesFromTree(tree, src, langName);
    if (!entities.length) return null;
    // attach file path
    return { file, entities };
  }));

  const parsed = (await Promise.all(tasks)).filter(Boolean);
  console.log(`Parsed ${parsed.length} files with entities.`);

  // 4) flatten and compute embeddings in batches
  const session = driver.session();
  try {
    let batch = [];
    for (const item of parsed) {
      const filePath = path.relative(BASE_DIR, item.file);
      for (const entity of item.entities) {
        const blob = makeBlob(entity, filePath);
        const embedding = await embed(blob);
        batch.push({ filePath, entity, embedding });

        if (batch.length >= BATCH_SIZE) {
          // group by file to upsert
          const byFile = groupBy(batch, b => b.filePath);
          for (const [fp, arr] of Object.entries(byFile)) {
            await upsertBatch(session, fp, arr.map(x => ({ entity: x.entity, embedding: x.embedding })));
          }
          batch = [];
        }
      }
    }

    // flush last batch
    if (batch.length) {
      const byFile = groupBy(batch, b => b.filePath);
      for (const [fp, arr] of Object.entries(byFile)) {
        await upsertBatch(session, fp, arr.map(x => ({ entity: x.entity, embedding: x.embedding })));
      }
    }

    console.log('Done upserting to Neo4j.');
  } finally {
    await session.close();
  }
}

// small helper
function groupBy(arr, fn) {
  return arr.reduce((acc, item) => {
    const k = fn(item);
    (acc[k] ||= []).push(item);
    return acc;
  }, {});
}

// Run
run()
  .then(() => {
    console.log('Pipeline completed.');
    return driver.close();
  })
  .catch(async (err) => {
    console.error('Pipeline failed', err);
    try { await driver.close(); } catch (e) {}
    process.exit(1);
  });
