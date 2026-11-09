const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const codec = require('../state-codec.js');

const original = { id: 'one', name: '街角小面', category: '面食', distanceKm: .45, budget: 28.5, note: '热乎的', enabled: true };
const state = () => ({ restaurants: [{ ...original }], filters: { maxDistanceKm: 1, maxBudget: 60, category: '面食' }, history: [{ restaurant: { ...original }, at: 1793923200000 }] });

test('full snapshots round-trip restaurants, settings and history without changing valid prices', () => {
  const input = state();
  const before = JSON.stringify(input);
  const snapshot = codec.createSnapshot(input);
  const result = codec.parseBackup(JSON.stringify(snapshot));
  assert.equal(snapshot.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(snapshot.exportedAt)));
  assert.equal(result.restaurantCount, 1);
  assert.equal(result.historyCount, 1);
  assert.equal(result.snapshot.restaurants[0].budget, 28.5);
  assert.equal(result.snapshot.restaurants[0].distanceKm, .45);
  assert.deepEqual(result.snapshot, snapshot);
  assert.equal(JSON.stringify(input), before);
});

test('legacy arrays and UTF-8 BOM import as complete backups, keeping zero as unknown', () => {
  const result = codec.parseBackup('\uFEFF' + JSON.stringify([{ name: '未知价的小店', budget: 0, distanceKm: 0, enabled: false }]));
  assert.equal(result.restaurantCount, 1);
  assert.equal(result.historyCount, 0);
  assert.equal(result.snapshot.restaurants[0].budget, 0);
  assert.equal(result.snapshot.restaurants[0].distanceKm, 0);
  assert.equal(result.snapshot.restaurants[0].enabled, false);
  assert.deepEqual(result.snapshot.filters, { maxDistanceKm: 1, maxBudget: 60, category: 'all' });
});

test('duplicate restaurant ids are regenerated so switches cannot modify several restaurants', () => {
  const result = codec.parseBackup(JSON.stringify([{ ...original }, { ...original, name: '另一家' }, { ...original, id: '', name: '第三家' }]));
  const ids = result.snapshot.restaurants.map((item) => item.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], 'one');
  assert.ok(ids.every(Boolean));
});

test('strict import rejects broken structures, unnamed entries and invalid numbers instead of hiding them as zero', () => {
  for (const value of ['', 'not json', 'null', '{}', '{"schemaVersion":2}', '[{"name":" "}]', '[{"name":"小店","budget":-1}]', '[{"name":"小店","distanceKm":1e999}]', '[{"name":"小店","budget":"Infinity"}]', '[{"name":"小店","distanceKm":null}]']) {
    assert.throws(() => codec.parseBackup(value), /备份|餐馆|距离|预算|JSON/);
  }
  assert.throws(() => codec.createSnapshot({ restaurants: [{ ...original, budget: Infinity }] }), /无穷大/);
  assert.throws(() => codec.parseBackup(JSON.stringify({ ...codec.createSnapshot(state()), history: [{ restaurant: original, at: 'yesterday' }] })), /时间无效/);
});

test('size and collection limits reject complete oversized files before partial restoration', () => {
  assert.throws(() => codec.parseBackup(JSON.stringify([{ ...original, note: '米'.repeat(710000) }])), /2 MB/);
  assert.throws(() => codec.createSnapshot({ restaurants: [{ ...original, note: '米'.repeat(710000) }] }), /2 MB/);
  assert.throws(() => codec.parseBackup(JSON.stringify(Array.from({ length: 2001 }, (_, i) => ({ ...original, id: String(i) })))), /2000/);
  const snapshot = codec.createSnapshot(state());
  snapshot.history = Array.from({ length: 366 }, () => ({ restaurant: original, at: 1793923200000 }));
  assert.throws(() => codec.parseBackup(JSON.stringify(snapshot)), /365/);
});

test('startup recovery respects an intentionally empty catalog, cleans bad entries and restores usable filter bounds', () => {
  assert.deepEqual(codec.normalizeState({ restaurants: [] }, [original]).restaurants, []);
  const cleaned = codec.normalizeState({
    restaurants: [original, { ...original, id: 'bad', budget: -10 }, null, { name: '' }],
    filters: { maxDistanceKm: -2, maxBudget: Infinity, category: '消失的分类' },
    history: [{ restaurant: original, at: 1793923200000 }, { restaurant: original, at: NaN }]
  });
  assert.equal(cleaned.restaurants.length, 1);
  assert.equal(cleaned.history.length, 1);
  assert.deepEqual(cleaned.filters, { maxDistanceKm: .5, maxBudget: 60, category: 'all' });
  assert.equal(codec.normalizeState(null, [original]).restaurants.length, 1);
});

test('prototype pollution keys are rejected while markup in restaurant text stays plain text', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const text = '[{"name":"小店","' + key + '":{"polluted":true}}]';
    assert.throws(() => codec.parseBackup(text), /不安全/);
  }
  assert.equal({}.polluted, undefined);
  const result = codec.parseBackup(JSON.stringify([{ name: '<script>小店 & 晚饭</script>' }]));
  assert.equal(result.snapshot.restaurants[0].name, '<script>小店 & 晚饭</script>');
  const untrusted = JSON.parse('{"restaurants":[],"__proto__":{"polluted":true}}');
  codec.normalizeState(untrusted);
  assert.equal({}.polluted, undefined);
});

test('browser global works without CommonJS or TextEncoder and enforces UTF-8 byte limits', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'state-codec.js'), 'utf8');
  const context = { FoodOracle: require('../core.js') };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(typeof context.FoodTimeState.parseBackup, 'function');
  const result = context.FoodTimeState.parseBackup('[{"name":"中文小店","budget":0,"distanceKm":0}]');
  assert.equal(result.restaurantCount, 1);
  assert.throws(() => context.FoodTimeState.parseBackup(JSON.stringify([{ name: '小店', note: '米'.repeat(710000) }])), /2 MB/);
});

test('catalog batch markers survive normalization and backup round-trips while older schema 1 backups remain readable', () => {
  const marked = { ...state(), catalogBatches: ['guangqi-2026-11-06', 'other-batch'] };
  const snapshot = codec.createSnapshot(marked);
  const restored = codec.normalizeState(codec.parseBackup(JSON.stringify(snapshot)).snapshot, []);
  assert.deepEqual(restored.catalogBatches, marked.catalogBatches);
  const legacy = { ...snapshot };
  delete legacy.catalogBatches;
  assert.deepEqual(codec.parseBackup(JSON.stringify(legacy)).snapshot.catalogBatches, []);
  assert.throws(() => codec.parseBackup(JSON.stringify({ ...snapshot, catalogBatches: [42] })), /批次/);
});

test('a catalog batch only appends distinct new restaurants and never overwrites user edits, disabled entries or history', () => {
  const edited = { ...original, name: '我改过的店名', enabled: false, note: '用户自己的备注' };
  const existingCafe = { ...original, id: 'cafe', name: '咖啡·角', category: '咖啡' };
  const current = codec.normalizeState({ ...state(), restaurants: [edited, existingCafe] }, []);
  const before = JSON.stringify(current);
  const batch = {
    batchId: 'guangqi-2026-11-06',
    restaurants: [
      { ...original, name: '随包更新的名字' },
      { ...original, id: 'cafe-new-id', name: '咖啡角（光启城店）' },
      { ...original, id: 'new-one', name: '新餐馆（光启城店）' },
      { ...original, id: 'new-one-other-id', name: '新餐馆 (宜山路店)' }
    ]
  };
  const update = codec.applyCatalogBatch(current, batch);
  assert.equal(update.addedCount, 1);
  assert.deepEqual(update.state.restaurants.map(item => item.id), ['one', 'cafe', 'new-one']);
  assert.equal(update.state.restaurants[0], current.restaurants[0]);
  assert.deepEqual(update.state.restaurants[0], edited);
  assert.equal(update.state.history, current.history);
  assert.equal(update.state.filters, current.filters);
  assert.equal(JSON.stringify(current), before);
  const repeated = codec.applyCatalogBatch(update.state, batch);
  assert.equal(repeated.applied, false);
  assert.equal(repeated.addedCount, 0);
  assert.equal(repeated.state, update.state);
});
