const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const codec = require('../state-codec.js');
const source = fs.readFileSync(path.join(__dirname, '../storage.js'), 'utf8');
const seed = [{ id: 'one', name: '沪小宴', category: '炒菜', distanceKm: .2, budget: 28, enabled: true }];
function setup(options = {}) {
  const values = new Map(options.initial || []);
  const listeners = {};
  const messages = [];
  const root = { FoodTimeState: codec, FOOD_TIME_CATALOG: options.catalog, localStorage: {
    getItem: key => values.get(key) || null,
    setItem(key, value) { if (options.failWrite) throw new Error('disk full'); values.set(key, value); }
  }};
  if (options.native) {
    root.FOOD_TIME_DESKTOP = true;
    root.chrome = { webview: {
      addEventListener(type, callback) { listeners[type] = callback; },
      postMessage(message) {
        messages.push(message);
        queueMicrotask(() => listeners.message({ data: { id: message.id, ...options.reply(message) } }));
      }
    }};
  }
  vm.runInNewContext(source, { window: root, setTimeout, clearTimeout, Blob, Date, Map, JSON });
  return { storage: root.FoodTimeStorage, values, messages };
}
test('loads legacy browser data without losing an intentionally empty restaurant list', async () => {
  const app = setup({ initial: [['food-time-studio-v1', JSON.stringify({ restaurants: [], filters: {}, history: [] })]] });
  const loaded = await app.storage.load(seed);
  assert.equal(loaded.state.restaurants.length, 0);
  assert.equal(loaded.isNative, false);
});
test('writes full snapshots and keeps the last valid browser state for recovery', async () => {
  const app = setup();
  const first = codec.normalizeState(null, seed);
  await app.storage.save(first);
  await app.storage.save({ ...first, restaurants: [] });
  assert.equal(codec.parseBackup(app.values.get('food-time-studio-v2')).restaurantCount, 0);
  assert.equal(codec.parseBackup(app.values.get('food-time-studio-v2.previous')).restaurantCount, 1);
  app.values.set('food-time-studio-v2', '{broken');
  const loaded = await app.storage.load([]);
  assert.equal(loaded.state.restaurants.length, 1);
  assert.match(loaded.warning, /恢复/);
});
test('a failed write rejects rather than claiming that the state was saved', async () => {
  const app = setup({ failWrite: true });
  await assert.rejects(app.storage.save(codec.normalizeState(null, seed)), /disk full/);
});
test('native storage loads and saves only through the narrow desktop bridge', async () => {
  const app = setup({ native: true, reply: message => ({ ok: true, result: message.command === 'load' ? { state: null, dataDirectory: 'test-profile', warning: null } : true }) });
  const loaded = await app.storage.load(seed);
  assert.equal(loaded.isNative, true);
  await app.storage.save(loaded.state);
  assert.deepEqual(app.messages.map(message => message.command), ['load', 'save']);
  assert.equal(app.messages[1].payload.schemaVersion, 1);
});
test('native command errors propagate and do not poison a later queued save', async () => {
  let tries = 0;
  const app = setup({ native: true, reply: () => ++tries === 1 ? { ok: false, error: '磁盘不可写' } : { ok: true, result: true } });
  await assert.rejects(app.storage.save(codec.normalizeState(null, seed)), /磁盘不可写/);
  assert.equal(await app.storage.save(codec.normalizeState(null, seed)), true);
});

const batch = {
  batchId: 'guangqi-2026-11-06',
  restaurants: [{ id: 'guangqi-new', name: '周边新餐馆（光启城店）', category: '炒菜', distanceKm: .3, budget: 35, note: '本批新增', enabled: true }]
};

test('an intentionally empty saved list only gains the new batch once and deleted new restaurants stay deleted on restart', async () => {
  const empty = codec.createSnapshot({ restaurants: [], filters: {}, history: [] });
  const app = setup({ catalog: batch, initial: [['food-time-studio-v2', JSON.stringify(empty)]] });
  const first = await app.storage.load(seed);
  assert.equal(first.addedCount, 1);
  assert.deepEqual(first.state.restaurants.map(item => item.id), ['guangqi-new']);
  assert.deepEqual(first.state.catalogBatches, [batch.batchId]);
  assert.equal(first.state.restaurants.some(item => item.id === seed[0].id), false, 'old defaults do not resurrect');
  await app.storage.save({ ...first.state, restaurants: [] });
  const saved = app.values.get('food-time-studio-v2');
  const second = await app.storage.load(seed);
  assert.equal(second.addedCount, 0);
  assert.deepEqual(second.state.restaurants, []);
  assert.deepEqual(second.state.catalogBatches, [batch.batchId]);
  assert.equal(app.values.get('food-time-studio-v2'), saved, 'an applied batch does not trigger another write');
});

test('a failed batch save preserves user data and retries later without claiming success or replacing unreadable data', async () => {
  const edited = { ...seed[0], name: '用户改过的名称', enabled: false, note: '保留备注' };
  const original = codec.createSnapshot({ restaurants: [edited], filters: { maxBudget: 90 }, history: [{ restaurant: seed[0], at: 1793923200000 }] });
  const contents = JSON.stringify(original);
  const options = { catalog: batch, failWrite: true, initial: [['food-time-studio-v2', contents]] };
  const app = setup(options);
  const failed = await app.storage.load(seed);
  assert.equal(failed.addedCount, 0);
  assert.match(failed.warning, /尚未保存.*下次打开时会重试/);
  assert.deepEqual(failed.state.restaurants, original.restaurants);
  assert.deepEqual(failed.state.history, original.history);
  assert.deepEqual(failed.state.catalogBatches, []);
  assert.equal(app.values.get('food-time-studio-v2'), contents);
  options.failWrite = false;
  const retried = await app.storage.load(seed);
  assert.equal(retried.addedCount, 1);
  assert.deepEqual(retried.state.restaurants[0], original.restaurants[0]);
  assert.deepEqual(retried.state.history, original.history);
  assert.deepEqual(codec.parseBackup(app.values.get('food-time-studio-v2')).snapshot.catalogBatches, [batch.batchId]);

  const damaged = setup({ catalog: batch, initial: [['food-time-studio-v2', '{broken']] });
  const recovery = await damaged.storage.load(seed);
  assert.equal(recovery.addedCount, 0);
  assert.ok(recovery.warning);
  assert.equal(damaged.values.get('food-time-studio-v2'), '{broken', 'an update must not overwrite an unreadable user file with defaults');
});

test('native catalog migration only returns success after the desktop bridge saves the marker and can retry a failed save', async () => {
  let diskState = codec.createSnapshot({ restaurants: [], filters: {}, history: [{ restaurant: seed[0], at: 1793923200000 }] });
  let failNextSave = true;
  const app = setup({ native: true, catalog: batch, reply(message) {
    if (message.command === 'load') return { ok: true, result: { state: diskState, dataDirectory: 'test-profile', warning: null } };
    if (failNextSave) { failNextSave = false; return { ok: false, error: '磁盘暂时不可写' }; }
    diskState = message.payload;
    return { ok: true, result: true };
  }});
  const failed = await app.storage.load(seed);
  assert.equal(failed.addedCount, 0);
  assert.equal(failed.state.restaurants.length, 0);
  assert.deepEqual(diskState.catalogBatches, []);
  assert.match(failed.warning, /尚未保存/);
  const success = await app.storage.load(seed);
  assert.equal(success.addedCount, 1);
  assert.deepEqual(diskState.catalogBatches, [batch.batchId]);
  assert.equal(diskState.history.length, 1);
  await app.storage.save({ ...success.state, restaurants: [] });
  const afterDelete = await app.storage.load(seed);
  assert.equal(afterDelete.addedCount, 0);
  assert.equal(afterDelete.state.restaurants.length, 0);
  assert.equal(app.messages.filter(message => message.command === 'save').length, 3);
});
