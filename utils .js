// utils.js - A comprehensive example with multiple extractable constructs

import { fetch } from 'node-fetch';
import { validateEmail, formatDate } from './helpers.js';

/**
 * User management utilities
 */
class UserService {
  constructor(apiUrl) {
    this.apiUrl = apiUrl;
    this.cache = new Map();
  }

  /**
   * Fetch user by ID from API
   */
  async getUserById(userId) {
    if (this.cache.has(userId)) {
      return this.cache.get(userId);
    }

    try {
      const response = await fetch(`${this.apiUrl}/users/${userId}`);
      const user = await response.json();
      this.cache.set(userId, user);
      return user;
    } catch (error) {
      console.error('Failed to fetch user:', error);
      throw error;
    }
  }

  /**
   * Create a new user
   */
  async createUser(userData) {
    const isValid = validateEmail(userData.email);
    if (!isValid) {
      throw new Error('Invalid email address');
    }

    const response = await fetch(`${this.apiUrl}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData),
    });

    return await response.json();
  }

  /**
   * Get all users with pagination
   */
  async getAllUsers(page = 1, limit = 10) {
    const response = await fetch(
      `${this.apiUrl}/users?page=${page}&limit=${limit}`
    );
    const data = await response.json();
    return data.users;
  }
}

/**
 * Data processing utilities
 */
class DataProcessor {
  /**
   * Sort array of numbers in ascending order
   */
  static sortNumbers(numbers) {
    if (!Array.isArray(numbers)) {
      throw new TypeError('Input must be an array');
    }
    return [...numbers].sort((x, y) => x - y);
  }

  /**
   * Sort array of numbers in descending order
   */
  static sortNumbersDesc(numbers) {
    return [...numbers].sort((x, y) => y - x);
  }

  /**
   * Find index of item in array
   */
  static findIndex(items, predicate) {
    return items.findIndex(predicate);
  }

  /**
   * Transform array items using mapper function
   */
  static mapItems(items, mapper) {
    return items.map(mapper);
  }

  /**
   * Filter array items
   */
  static filterItems(items, predicate) {
    return items.filter(predicate);
  }
}

/**
 * Format user data for display
 */
function formatUser(user) {
  const formatted = {
    id: user.id,
    name: `${user.firstName} ${user.lastName}`,
    email: user.email,
    createdAt: formatDate(user.createdAt),
  };
  return formatted;
}

/**
 * Calculate statistics from user data
 */
function calculateUserStats(users) {
  const total = users.length;
  const active = users.filter((u) => u.isActive).length;
  const inactive = total - active;

  return {
    total,
    active,
    inactive,
    activePercentage: ((active / total) * 100).toFixed(2),
  };
}

/**
 * Validate user input data
 */
function validateUserInput(userData) {
  const errors = [];

  if (!userData.email || !validateEmail(userData.email)) {
    errors.push('Invalid email address');
  }

  if (!userData.firstName || userData.firstName.length < 2) {
    errors.push('First name must be at least 2 characters');
  }

  if (!userData.lastName || userData.lastName.length < 2) {
    errors.push('Last name must be at least 2 characters');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Process array of items asynchronously
 */
async function processItems(items, processor) {
  const results = [];
  for (const item of items) {
    try {
      const result = await processor(item);
      results.push(result);
    } catch (error) {
      console.error('Error processing item:', error);
    }
  }
  return results;
}

/**
 * Debounce function to limit function calls
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Throttle function to limit function execution rate
 */
function throttle(func, limit) {
  let inThrottle;
  return function executedFunction(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

// Arrow function assigned to variable
const fetchUserData = async (userId) => {
  const userService = new UserService('https://api.example.com');
  const user = await userService.getUserById(userId);
  return formatUser(user);
};

// Another arrow function
const processUserList = async (userIds) => {
  const userService = new UserService('https://api.example.com');
  const users = await Promise.all(
    userIds.map((id) => userService.getUserById(id))
  );
  return users.map(formatUser);
};

// Export statements
export { UserService, DataProcessor };
export { formatUser, calculateUserStats, validateUserInput };
export { fetchUserData, processUserList };
export default UserService;
