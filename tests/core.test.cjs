const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const oracle = require('../core.js');

function restaurant(patch = {}) {
  return oracle.normalizeRestaurant({ id: 'one', name: '沪小宴', category: '炒菜', distanceKm: 0.4, budget: 28, ...patch });
}

test('applies distance, budget and category together without changing source restaurants', () => {
  const items = [
    restaurant(),
    restaurant({ id: 'far', distanceKm: 2 }),
    restaurant({ id: 'pricey', budget: 80 }),
    restaurant({ id: 'noodle', category: '面食' })
  ];
  const before = JSON.stringify(items);
  const results = oracle.filterRestaurants(items, { maxDistanceKm: 1, maxBudget: 60, category: '炒菜' });
  assert.deepEqual(results.map(item => item.id), ['one']);
  assert.equal(results[0], items[0]);
  assert.equal(JSON.stringify(items), before);
  assert.equal(oracle.filterRestaurants(items, {}).length, 4);
});

test('unknown values stay eligible and are described as incomplete rather than free or at zero distance', () => {
  const unknown = restaurant({ distanceKm: 0, budget: 0 });
  assert.deepEqual(oracle.filterRestaurants([unknown], { maxDistanceKm: 0.5, maxBudget: 10 }), [unknown]);
  assert.equal(oracle.describeDistance(unknown.distanceKm), '距离待补充');
  assert.equal(oracle.describeBudget(unknown.budget), '人均待补充');
  assert.equal(oracle.describeDistance(0.45), '450 m');
  assert.equal(oracle.describeDistance(1.25), '1.3 km');
  assert.equal(oracle.describeBudget(28), '¥28 / 人');
});

test('disabled, unnamed and malformed entries never enter a draw', () => {
  const valid = restaurant();
  const items = [restaurant({ id: 'off', enabled: false }), restaurant({ id: 'blank', name: '   ' }), null, false, valid];
  assert.deepEqual(oracle.filterRestaurants(items, { category: 'all' }), [valid]);
  assert.deepEqual(oracle.filterRestaurants(null, {}), []);
});

test('empty and single-choice pools are safe, and repeated draws use another restaurant when available', () => {
  const first = restaurant();
  const second = restaurant({ id: 'two', name: '避风塘' });
  const third = restaurant({ id: 'three', name: '玺炖' });
  assert.equal(oracle.pickRestaurant([], null), null);
  assert.equal(oracle.pickRestaurant([first], first.id), first);
  assert.equal(oracle.pickRestaurant([first, second, third], first.id, () => 0), second);
  assert.equal(oracle.pickRestaurant([first, second, third], first.id, () => 1), third);
  assert.equal(oracle.pickRestaurant([first, second], null, () => NaN), first);
});

test('normalization restricts output fields, keeps markup as plain text, and rejects invalid numeric values', () => {
  const payload = JSON.parse('{"id":" custom ","name":" <img src=x onerror=alert(1)> ","category":" ","distanceKm":"-1","budget":"Infinity","note":"  午餐  ","__proto__":{"polluted":true},"unexpected":true}');
  const item = oracle.normalizeRestaurant(payload);
  assert.deepEqual(item, {
    id: 'custom', name: '<img src=x onerror=alert(1)>', category: '未分类',
    distanceKm: 0, budget: 0, note: '午餐', enabled: true
  });
  assert.equal({}.polluted, undefined);
  assert.equal(oracle.normalizeRestaurant({ name: { toString() { throw new Error('must not invoke'); } } }).name, '');
  assert.equal(oracle.normalizeRestaurant({ budget: '28.7', distanceKm: '0.35' }).budget, 29);
  assert.ok(oracle.normalizeRestaurant(null).id);
});

test('loads as a browser global without a bundler or CommonJS runtime', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../core.js'), 'utf8'), context);
  assert.equal(typeof context.FoodOracle.pickRestaurant, 'function');
  assert.equal(context.FoodOracle.describeDistance(0.2), '200 m');
});
