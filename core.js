(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.FoodOracle = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  let nextId = 0;

  // Keep text as text. The view uses textContent rather than treating it as HTML.
  function plainText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  }

  function numberOr(value, fallback) {
    if (typeof value !== 'number' && typeof value !== 'string') return fallback;
    if (typeof value === 'string' && !value.trim()) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nonNegative(value) {
    return Math.max(0, numberOr(value, 0));
  }

  function createId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    nextId += 1;
    return 'restaurant-' + Date.now().toString(36) + '-' + nextId.toString(36);
  }

  function normalizeRestaurant(input) {
    const item = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      id: plainText(item.id) || createId(),
      name: plainText(item.name),
      category: plainText(item.category) || '未分类',
      distanceKm: nonNegative(item.distanceKm),
      budget: Math.round(nonNegative(item.budget)),
      note: plainText(item.note),
      enabled: item.enabled !== false
    };
  }

  function filterRestaurants(restaurants, filters) {
    const settings = filters || {};
    const maxDistance = Math.max(0, numberOr(settings.maxDistanceKm, Infinity));
    const maxBudget = Math.max(0, numberOr(settings.maxBudget, Infinity));
    const category = plainText(settings.category) || 'all';
    return (Array.isArray(restaurants) ? restaurants : []).filter(function (item) {
      if (!item || typeof item !== 'object' || item.enabled === false || !plainText(item.name)) return false;
      const itemCategory = plainText(item.category) || '未分类';
      return nonNegative(item.distanceKm) <= maxDistance &&
        nonNegative(item.budget) <= maxBudget &&
        (category === 'all' || category === itemCategory);
    });
  }

  function pickRestaurant(candidates, previousId, random) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    let pool = candidates;
    if (candidates.length > 1 && previousId !== null && previousId !== undefined) {
      const alternatives = candidates.filter(function (item) { return item.id !== previousId; });
      if (alternatives.length) pool = alternatives;
    }
    const sample = (typeof random === 'function' ? random : Math.random)();
    const fraction = Math.max(0, Math.min(1 - Number.EPSILON, numberOr(sample, 0)));
    return pool[Math.floor(fraction * pool.length)];
  }

  function describeDistance(value) {
    const distance = nonNegative(value);
    if (!distance) return '距离待补充';
    return distance < 1 ? Math.round(distance * 1000) + ' m' : distance.toFixed(1) + ' km';
  }

  function describeBudget(value) {
    const budget = Math.round(nonNegative(value));
    return budget ? '¥' + budget + ' / 人' : '人均待补充';
  }

  return Object.freeze({
    normalizeRestaurant: normalizeRestaurant,
    filterRestaurants: filterRestaurants,
    pickRestaurant: pickRestaurant,
    describeDistance: describeDistance,
    describeBudget: describeBudget
  });
});
