// This WILL create a chunk
function sortNumbers(numbers) {
  return numbers.sort((x, y) => x - y);
}

// This WILL create a chunk
const findItem = (items, target) => {
  return items.findIndex(x => x === target);
};

// This WILL create a chunk
class DataProcessor {
  process(data) {
    return data.map(item => item.toUpperCase());
  }
}
