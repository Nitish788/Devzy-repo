let numbers = [9, 3, 5, 1];

// Ascending sort
numbers.sort((x, y) => x - y);
console.log(numbers); // Output: [1, 3, 5, 9]

// Descending sort
numbers.sort((x, y) => y - x);
console.log(numbers); // Output: [9, 5, 3, 1]

let fruits = ['apple', 'banana', 'orange'];
let idx = fruits.findIndex(x => x === 'banana');
console.log(idx); // Output: 1 (or -1 if not found)
