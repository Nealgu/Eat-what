(function (root) {
  'use strict';
  const codec = root.FoodTimeState;
  const KEY = 'food-time-studio-v2';
  const LEGACY_KEY = 'food-time-studio-v1';
  const native = Boolean(root.FOOD_TIME_DESKTOP && root.chrome && root.chrome.webview);
  const pending = new Map();
  let sequence = 0;
  let saveQueue = Promise.resolve();

  if (native) {
    root.chrome.webview.addEventListener('message', (event) => {
      const response = event.data;
      if (!response || typeof response !== 'object' || typeof response.id !== 'string') return;
      const operation = pending.get(response.id);
      if (!operation) return;
      pending.delete(response.id);
      clearTimeout(operation.timer);
      if (response.ok === true) operation.resolve(response.result);
      else operation.reject(new Error(typeof response.error === 'string' ? response.error : '保存未完成，请重试。'));
    });
  }

  function request(command, payload, timeout = 15000) {
    if (!native) return Promise.reject(new Error('此操作需要桌面版。'));
    return new Promise((resolve, reject) => {
      const id = 'foodtime-' + Date.now().toString(36) + '-' + (++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('应用暂时没有响应，请重试；未确认保存的数据请先备份。'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try { root.chrome.webview.postMessage({ id, command, payload: payload === undefined ? null : payload }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }

  async function loadStored(fallbackRestaurants) {
    if (native) {
      const response = await request('load');
      if (!response || typeof response !== 'object') throw new Error('无法读取应用数据，请重新打开应用。');
      const state = response.state ? codec.parseBackup(JSON.stringify(response.state)).snapshot : null;
      return {
        state: codec.normalizeState(state, fallbackRestaurants),
        warning: response.warning || null,
        isNative: true,
        dataDirectory: typeof response.dataDirectory === 'string' ? response.dataDirectory : null,
        canApplyCatalog: Boolean(response.state || !response.warning)
      };
    }
    let warning = null;
    let value = null;
    try {
      const current = root.localStorage.getItem(KEY);
      if (current) {
        try { value = codec.parseBackup(current).snapshot; }
        catch (_) {
          const previous = root.localStorage.getItem(KEY + '.previous');
          if (previous) {
            try { value = codec.parseBackup(previous).snapshot; warning = '当前数据无法读取，已恢复到上一份有效数据。'; } catch (_) { /* Try the original browser version. */ }
          }
          if (!value) warning = '保存的数据无法读取，请从备份恢复；当前先显示初始清单。';
        }
      }
      if (!value) {
        const legacy = root.localStorage.getItem(LEGACY_KEY);
        if (legacy) {
          try { value = JSON.parse(legacy); } catch (_) { warning = warning || '旧数据无法读取，可使用备份恢复。'; }
        }
      }
    } catch (_) { warning = '浏览器存储不可用，本次数据请在关闭前备份。'; }
    return { state: codec.normalizeState(value, fallbackRestaurants), warning, isNative: false, dataDirectory: null, canApplyCatalog: Boolean(value || !warning) };
  }

  async function load(fallbackRestaurants) {
    const result = await loadStored(fallbackRestaurants);
    const { canApplyCatalog, ...loaded } = result;
    loaded.addedCount = 0;
    // Do not replace an unreadable saved file with defaults during an update.
    // The existing recovery warning remains visible until the user restores it.
    if (!canApplyCatalog || !root.FOOD_TIME_CATALOG) return loaded;
    try {
      const update = codec.applyCatalogBatch(loaded.state, root.FOOD_TIME_CATALOG);
      if (!update.applied) return loaded;
      await save(update.state);
      return { ...loaded, state: update.state, addedCount: update.addedCount, catalogApplied: true };
    } catch (error) {
      const reason = error && typeof error.message === 'string' ? '（' + error.message + '）' : '';
      const warning = '周边新餐馆尚未保存，原来的清单和记录已保留；下次打开时会重试。' + reason;
      return { ...loaded, warning: loaded.warning ? loaded.warning + ' ' + warning : warning };
    }
  }

  function save(state) {
    // Snapshot now so later UI edits cannot change a queued write.
    let snapshot;
    try { snapshot = codec.createSnapshot(state); }
    catch (error) { return Promise.reject(error); }
    const operation = saveQueue.catch(() => {}).then(async () => {
      if (native) {
        const saved = await request('save', snapshot);
        if (saved !== true) throw new Error('数据未保存，请重试。');
      } else {
        const current = root.localStorage.getItem(KEY);
        if (current) {
          try { codec.parseBackup(current); root.localStorage.setItem(KEY + '.previous', current); }
          catch (error) { if (error && error.name === 'QuotaExceededError') throw error; }
        }
        root.localStorage.setItem(KEY, JSON.stringify(snapshot));
      }
      return true;
    });
    saveQueue = operation;
    return operation;
  }

  async function exportData(state) {
    const snapshot = codec.createSnapshot(state);
    const json = JSON.stringify(snapshot, null, 2);
    const filename = '饭点备份-' + new Date().toISOString().slice(0, 10) + '.json';
    if (native) {
      const response = await request('export', { json, filename }, 300000);
      return Boolean(response && response.saved);
    }
    const url = root.URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = root.document.createElement('a');
    link.href = url;
    link.download = filename;
    root.document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => root.URL.revokeObjectURL(url), 1000);
    return true;
  }

  async function pickImportFile() {
    if (native) {
      const response = await request('import', null, 300000);
      return response && typeof response.text === 'string' ? response.text : null;
    }
    return new Promise((resolve, reject) => {
      const input = root.document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.hidden = true;
      root.document.body.append(input);
      input.addEventListener('cancel', () => { input.remove(); resolve(null); }, { once: true });
      input.addEventListener('change', async () => {
        try {
          const file = input.files && input.files[0];
          if (!file) { resolve(null); return; }
          if (file.size > 2 * 1024 * 1024) throw new Error('备份文件不能大于 2 MB。');
          resolve(await file.text());
        } catch (error) { reject(error); }
        finally { input.remove(); }
      }, { once: true });
      input.click();
    });
  }

  root.FoodTimeStorage = Object.freeze({
    load, save, exportData, pickImportFile,
    openDataDirectory: () => native ? request('openDataDirectory') : Promise.resolve(false),
    isNative: native
  });
})(window);
