(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.FoodTimeState = factory(root.FoodOracle);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  if (!core || typeof core.normalizeRestaurant !== 'function') {
    throw new Error('应用数据模块未加载，请重新打开应用。');
  }

  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_RESTAURANTS = 2000;
  const MAX_HISTORY = 365;
  const MAX_CATALOG_BATCHES = 1000;
  const MAX_DATE = 8640000000000000;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function field(object, key) {
    return own(object, key) ? object[key] : undefined;
  }

  function text(value) {
    return typeof value === 'string'
      ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
      : '';
  }

  function numeric(value, label) {
    if (value === undefined) return 0;
    if ((typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !value.trim())) {
      throw new Error(label + '必须是大于或等于 0 的数字，未知时请填写 0。');
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(label + '不能是负数、无穷大或无效数字。');
    }
    return number;
  }

  function restaurant(input, label) {
    if (!record(input)) throw new Error(label + '的格式不正确。');
    const name = text(field(input, 'name'));
    if (!name) throw new Error(label + '缺少有效的餐馆名称。');
    for (const key of ['category', 'note']) {
      const value = field(input, key);
      if (value !== undefined && typeof value !== 'string') {
        throw new Error(label + (key === 'category' ? '的分类' : '的备注') + '必须是文字。');
      }
    }
    const enabled = field(input, 'enabled');
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new Error(label + '的启用状态必须是 true 或 false。');
    }
    const distanceKm = numeric(field(input, 'distanceKm'), label + '的距离');
    const budget = numeric(field(input, 'budget'), label + '的人均预算');
    const rawId = field(input, 'id');
    const id = typeof rawId === 'string' ? text(rawId)
      : typeof rawId === 'number' && Number.isFinite(rawId) ? String(rawId) : '';
    const output = core.normalizeRestaurant({
      id: id,
      name: name,
      category: text(field(input, 'category')),
      note: text(field(input, 'note')),
      distanceKm: distanceKm,
      budget: budget,
      enabled: enabled !== false
    });
    // A valid imported price may include decimals. Validation must not turn it
    // into an unknown value or silently change it during a backup round-trip.
    output.distanceKm = distanceKm;
    output.budget = budget;
    return output;
  }

  function uniqueRestaurants(items, strict) {
    const seen = new Set();
    const output = [];
    items.slice(0, MAX_RESTAURANTS).forEach(function (item, index) {
      try {
        const normalized = restaurant(item, '第 ' + (index + 1) + ' 家餐馆');
        if (seen.has(normalized.id)) {
          const base = core.normalizeRestaurant({ name: normalized.name }).id;
          let generated = base;
          let suffix = 1;
          while (seen.has(generated)) generated = base + '-' + suffix++;
          normalized.id = generated;
        }
        seen.add(normalized.id);
        output.push(normalized);
      } catch (error) {
        if (strict) throw error;
      }
    });
    return output;
  }

  function historyEntries(items, strict) {
    const output = [];
    items.slice(0, MAX_HISTORY).forEach(function (entry, index) {
      try {
        if (!record(entry)) throw new Error('第 ' + (index + 1) + ' 条记录的格式不正确。');
        const at = field(entry, 'at');
        if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > MAX_DATE) {
          throw new Error('第 ' + (index + 1) + ' 条记录的时间无效。');
        }
        output.push({ restaurant: restaurant(field(entry, 'restaurant'), '第 ' + (index + 1) + ' 条记录中的餐馆'), at: at });
      } catch (error) {
        if (strict) throw error;
      }
    });
    return output;
  }

  function filterNumber(value, fallback, min, max) {
    const number = (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN;
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function filters(input, restaurants) {
    const value = record(input) ? input : {};
    let category = text(field(value, 'category')) || 'all';
    if (category !== 'all' && !restaurants.some((item) => item.category === category)) category = 'all';
    return {
      maxDistanceKm: filterNumber(field(value, 'maxDistanceKm'), 1, .5, 5),
      maxBudget: filterNumber(field(value, 'maxBudget'), 60, 10, 200),
      category: category
    };
  }

  function catalogBatches(input, strict) {
    if (input === undefined) return [];
    if (!Array.isArray(input)) {
      if (strict) throw new Error('餐馆更新批次必须是文字列表。');
      return [];
    }
    if (strict && input.length > MAX_CATALOG_BATCHES) throw new Error('餐馆更新批次过多。');
    const batches = [];
    for (const value of input.slice(0, MAX_CATALOG_BATCHES)) {
      const batch = text(value);
      if (!batch || batch.length > 128) {
        if (strict) throw new Error('餐馆更新批次包含无效标识。');
        continue;
      }
      if (!batches.includes(batch)) batches.push(batch);
    }
    return batches;
  }

  function normalizeState(input, fallbackRestaurants) {
    const value = record(input) ? input : {};
    const supplied = field(value, 'restaurants');
    const fallback = Array.isArray(fallbackRestaurants) ? fallbackRestaurants : [];
    const restaurants = uniqueRestaurants(Array.isArray(supplied) ? supplied : fallback, false);
    const history = field(value, 'history');
    return {
      restaurants: restaurants,
      filters: filters(field(value, 'filters'), restaurants),
      history: historyEntries(Array.isArray(history) ? history : [], false),
      catalogBatches: catalogBatches(field(value, 'catalogBatches'), false)
    };
  }

  function validateCollections(input) {
    if (!record(input) || !Array.isArray(field(input, 'restaurants'))) {
      throw new Error('备份中缺少有效的餐馆清单。');
    }
    if (input.restaurants.length > MAX_RESTAURANTS) throw new Error('餐馆清单不能超过 2000 家。');
    if (!Array.isArray(field(input, 'history'))) throw new Error('备份中的选择记录格式不正确。');
    if (input.history.length > MAX_HISTORY) throw new Error('选择记录不能超过 365 条。');
    if (!record(field(input, 'filters'))) throw new Error('备份中的筛选设置格式不正确。');
  }

  function createSnapshot(input) {
    const value = record(input) ? input : {};
    const candidate = {
      restaurants: field(value, 'restaurants') === undefined ? [] : field(value, 'restaurants'),
      filters: field(value, 'filters') === undefined ? {} : field(value, 'filters'),
      history: field(value, 'history') === undefined ? [] : field(value, 'history'),
      catalogBatches: field(value, 'catalogBatches')
    };
    validateCollections(candidate);
    const restaurants = uniqueRestaurants(candidate.restaurants, true);
    const snapshot = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      restaurants: restaurants,
      filters: filters(candidate.filters, restaurants),
      history: historyEntries(candidate.history, true),
      catalogBatches: catalogBatches(candidate.catalogBatches, true)
    };
    if (utf8Length(JSON.stringify(snapshot)) > MAX_BYTES) throw new Error('备份文件不能超过 2 MB。');
    return snapshot;
  }

  function utf8Length(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
      if (bytes > MAX_BYTES) break;
    }
    return bytes;
  }

  function assertSafeKeys(input) {
    const stack = [input];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object') continue;
      for (const key of Object.keys(value)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
          throw new Error('备份包含不安全的字段，已取消导入。');
        }
        if (value[key] && typeof value[key] === 'object') stack.push(value[key]);
      }
    }
  }

  function parseBackup(contents) {
    if (typeof contents !== 'string') throw new Error('备份内容必须是 JSON 文本文件。');
    if (utf8Length(contents) > MAX_BYTES) throw new Error('备份文件不能超过 2 MB。');
    const clean = contents.replace(/^\uFEFF/, '').trim();
    if (!clean) throw new Error('备份文件为空。');
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch (_) { throw new Error('无法读取备份，请选择完整且有效的 JSON 文件。'); }
    assertSafeKeys(parsed);
    let snapshot;
    if (Array.isArray(parsed)) {
      snapshot = createSnapshot({ restaurants: parsed, filters: {}, history: [] });
    } else {
      if (!record(parsed) || field(parsed, 'schemaVersion') !== 1) {
        throw new Error('不支持这个备份版本，请选择饭点版本 1 的备份或旧餐馆清单。');
      }
      const exportedAt = field(parsed, 'exportedAt');
      if (typeof exportedAt !== 'string' || !exportedAt.trim() || !Number.isFinite(Date.parse(exportedAt))) {
        throw new Error('备份中的导出时间无效。');
      }
      validateCollections(parsed);
      snapshot = createSnapshot(parsed);
      snapshot.exportedAt = new Date(exportedAt).toISOString();
    }
    return { snapshot: snapshot, restaurantCount: snapshot.restaurants.length, historyCount: snapshot.history.length };
  }

  function catalogName(value) {
    let name = text(value).normalize('NFKC').toLowerCase();
    let previous;
    // A branch label must not duplicate the same restaurant already maintained
    // under its short name. Repeated passes also handle nested branch labels.
    do {
      previous = name;
      name = name.replace(/\([^()]*\)|\[[^\[\]]*\]|【[^【】]*】/g, '');
    } while (name !== previous);
    return name.replace(/[\s\p{P}\p{S}]/gu, '');
  }

  function applyCatalogBatch(input, catalog) {
    const current = record(input) ? input : normalizeState(null, []);
    if (catalog === undefined || catalog === null) return { state: current, addedCount: 0, applied: false };
    if (!record(catalog)) throw new Error('周边餐馆更新格式不正确。');
    const batchId = text(field(catalog, 'batchId'));
    if (!batchId || batchId.length > 128) throw new Error('周边餐馆更新缺少有效批次标识。');
    const batches = catalogBatches(field(current, 'catalogBatches'), true);
    if (batches.includes(batchId)) return { state: current, addedCount: 0, applied: false };
    const incoming = field(catalog, 'restaurants');
    if (!Array.isArray(incoming) || incoming.length > MAX_RESTAURANTS) throw new Error('周边餐馆更新清单不正确或超过数量限制。');
    const existing = Array.isArray(current.restaurants) ? current.restaurants : [];
    const ids = new Set(existing.map((item) => item.id));
    const names = new Set(existing.map((item) => catalogName(item.name)).filter(Boolean));
    const additions = [];
    incoming.forEach(function (inputRestaurant, index) {
      const item = restaurant(inputRestaurant, '新增的第 ' + (index + 1) + ' 家餐馆');
      const name = catalogName(item.name);
      if (ids.has(item.id) || (name && names.has(name))) return;
      ids.add(item.id);
      if (name) names.add(name);
      additions.push(item);
    });
    if (existing.length + additions.length > MAX_RESTAURANTS) throw new Error('更新后的餐馆清单不能超过 2000 家。');
    if (batches.length >= MAX_CATALOG_BATCHES) throw new Error('餐馆更新批次已达到上限，请先备份数据。');
    return {
      state: Object.assign({}, current, { restaurants: existing.concat(additions), catalogBatches: batches.concat(batchId) }),
      addedCount: additions.length,
      applied: true
    };
  }

  return Object.freeze({
    createSnapshot: createSnapshot,
    parseBackup: parseBackup,
    normalizeState: normalizeState,
    applyCatalogBatch: applyCatalogBatch
  });
});
