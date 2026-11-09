(async function () {
  'use strict';
  const { normalizeRestaurant, filterRestaurants, pickRestaurant, describeDistance, describeBudget } = window.FoodOracle;
  const storage = window.FoodTimeStorage;
  const codec = window.FoodTimeState;
  const defaults = { maxDistanceKm: 1, maxBudget: 60, category: 'all' };
  const $ = (selector) => document.querySelector(selector);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const escaped = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const metadata = (item) => [item.category || '未分类', describeDistance(item.distanceKm), describeBudget(item.budget)].join(' · ');
  let drawTimer = null;
  let ticker = null;
  let toastTimer = null;
  let writing = true;
  let filterDraft = null;
  let editingId = null;
  let deletedRestaurant = null;
  let pendingImport = null;
  let isNative = false;
  let state = { restaurants: [], filters: { ...defaults }, history: [], catalogBatches: [], phase: 'idle', selected: null, previousId: null, confirmed: false };
  const pool = () => filterRestaurants(state.restaurants, state.filters);

  function message(error, fallback) {
    return error && typeof error.message === 'string' && error.message.trim() ? error.message : fallback;
  }

  function showToast(text) {
    const toast = $('#toast');
    const dialogs = all('dialog[open]');
    (dialogs[dialogs.length - 1] || document.body).append(toast);
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3400);
  }

  function refreshDisabled() {
    all('button, input').forEach((control) => { control.disabled = writing; });
    const thinking = state.phase === 'thinking';
    $('#draw-button').disabled = writing || thinking || !pool().length;
    $('#draw-button').setAttribute('aria-busy', String(thinking));
    all('[data-open="preferences"], [data-open="library"], [data-edit], [data-delete], [data-toggle]').forEach((button) => { button.disabled = writing || thinking; });
    $('#confirm-button').disabled = writing || state.confirmed || !state.selected;
    $('#clear-history').disabled = writing || !state.history.length;
    $('#clear-history-confirm').disabled = writing || !state.history.length;
    $('#undo-delete').disabled = writing || !deletedRestaurant;
    $('#restore-confirm').disabled = writing || !pendingImport;
    document.body.classList.toggle('is-saving', writing);
  }

  function setSpeech(text) { $('#speech').firstChild.nodeValue = text; }

  function setPlateName(name) {
    const letters = Array.from(name);
    $('#plate-name').textContent = letters.length > 12 ? letters.slice(0, 11).join('') + '…' : name;
    $('#plate-name').title = name;
  }

  function renderCategories() {
    const active = filterDraft || state.filters;
    const categories = [...new Set(state.restaurants.map((item) => item.category).filter(Boolean))];
    if (active.category !== 'all' && !categories.includes(active.category)) active.category = 'all';
    $('#category-options').innerHTML = [{ value: 'all', label: '口味随缘' }, ...categories.map((name) => ({ value: name, label: name }))].map(({ value, label }) => `<button class="category-option" data-category="${escaped(value)}" aria-pressed="${active.category === value}">${escaped(label)}</button>`).join('');
  }

  function syncFilters() {
    const active = filterDraft || state.filters;
    $('#distance-range').value = active.maxDistanceKm;
    $('#budget-range').value = active.maxBudget;
    all('.range-control input').forEach((input) => {
      const progress = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
      input.style.setProperty('--range-progress', progress + '%');
    });
    $('#distance-output').textContent = `${active.maxDistanceKm} km`;
    $('#budget-output').textContent = `¥${active.maxBudget}`;
    $('#distance-summary').textContent = `${state.filters.maxDistanceKm} km 内`;
    $('#budget-summary').textContent = `¥${state.filters.maxBudget} / 人`;
    $('#category-summary').textContent = state.filters.category === 'all' ? '口味随缘' : state.filters.category;
    all('[data-category]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.category === active.category)));
    const draftCount = filterRestaurants(state.restaurants, active).length;
    $('#filter-count').textContent = draftCount ? `${draftCount} 家餐馆，准备好成为今天的答案` : '暂时没有合适的店，换个范围试试吧';
    const count = pool().length;
    $('#availability').textContent = count ? `${count} 家餐馆里，总有今天的心动` : '暂时没有合适的店，试着放宽筛选条件';
    $('#availability').classList.toggle('is-empty', !count);
    if (!count) $('#draw-label').textContent = '换个范围试试';
    else if (state.phase !== 'thinking') $('#draw-label').textContent = state.selected ? '再选一家' : '帮我选一顿';
    refreshDisabled();
  }

  function clearResult() {
    clearTimeout(drawTimer);
    clearInterval(ticker);
    drawTimer = null;
    ticker = null;
    state.selected = null;
    state.confirmed = false;
    state.phase = 'idle';
    $('#scene').classList.remove('is-thinking', 'is-reveal', 'is-confirmed');
    $('#result-card').classList.remove('is-reveal');
    setSpeech('这顿，交给我吧！');
    setPlateName('吃点好的');
    $('#plate-caption').textContent = '一顿好饭，一点好运';
    $('#result-kicker').textContent = '这一餐的小期待';
    $('#result-name').textContent = '好吃的答案，马上就来';
    $('#result-meta').textContent = '选好范围，按一下，让快乐开饭。';
    $('#confirm-button').hidden = true;
  }

  function renderUndo() {
    $('#undo-notice').hidden = !deletedRestaurant;
    $('#undo-message').textContent = deletedRestaurant ? `已移除「${deletedRestaurant.item.name}」` : '';
  }

  function renderLibrary() {
    const query = $('#restaurant-search').value.trim().toLowerCase();
    const list = state.restaurants.filter((item) => `${item.name} ${item.category} ${item.note}`.toLowerCase().includes(query));
    $('#library-count').textContent = `${state.restaurants.length} 家`;
    $('#restaurant-list').innerHTML = list.length ? list.map((item) => `<article class="restaurant-row ${item.enabled ? '' : 'is-disabled'}"><span class="restaurant-letter" aria-hidden="true">${escaped(Array.from(item.name)[0])}</span><div class="restaurant-details"><h3>${escaped(item.name)}</h3><p>${escaped(metadata(item))}</p></div><div class="restaurant-actions"><button class="restaurant-toggle" data-toggle="${escaped(item.id)}" aria-pressed="${item.enabled}" aria-label="让${escaped(item.name)}参与选餐"></button><button class="row-action" data-edit="${escaped(item.id)}" aria-label="编辑${escaped(item.name)}">${icon('edit')}</button><button class="row-action row-delete" data-delete="${escaped(item.id)}" aria-label="移除${escaped(item.name)}">${icon('trash')}</button></div></article>`).join('') : `<p class="empty-state">${state.restaurants.length ? '还没找到这家，试试别的名字吧。' : '清单还是空的，加一家喜欢的店吧。'}</p>`;
    renderUndo();
  }

  function renderHistory() {
    $('#history-count').textContent = state.history.length;
    $('#history-count').hidden = !state.history.length;
    $('#history-list').innerHTML = state.history.length ? state.history.map(({ restaurant, at }, index) => {
      const time = new Date(at);
      const date = `${time.getMonth() + 1} 月 ${time.getDate()} 日`;
      return `<article class="history-row"><span class="history-number">${String(index + 1).padStart(2, '0')}</span><div><h3>${escaped(restaurant.name)}</h3><p>${escaped(metadata(restaurant))}</p></div><span class="history-date">${date}</span></article>`;
    }).join('') : `<div class="empty-state">${icon('bowl')}还没有记下的选择。<br>遇到喜欢的答案，就点「就吃这家」。</div>`;
  }

  function renderData() {
    renderCategories();
    syncFilters();
    renderLibrary();
    renderHistory();
    refreshDisabled();
  }

  // Work on a detached snapshot. An unsuccessful save leaves the current data
  // and any selected restaurant untouched, so the user can safely retry.
  async function commit(change, afterSave, resetSelection = true) {
    if (writing || state.phase === 'thinking') return false;
    let next;
    try {
      next = codec.normalizeState(codec.createSnapshot(state), []);
      change(next);
      next = codec.normalizeState(codec.createSnapshot(next), []);
    } catch (error) {
      showToast(message(error, '这次修改无法保存，请检查输入。'));
      return false;
    }
    writing = true;
    refreshDisabled();
    try {
      await storage.save(next);
      state.restaurants = next.restaurants;
      state.filters = next.filters;
      state.history = next.history;
      state.catalogBatches = next.catalogBatches;
      if (resetSelection) clearResult();
      if (afterSave) afterSave();
      renderData();
      return true;
    } catch (error) {
      showToast(message(error, '没有保存成功，原来的数据已保留，请重试。'));
      return false;
    } finally {
      writing = false;
      refreshDisabled();
    }
  }

  function updateFilterDraft(patch) {
    if (writing || !filterDraft) return;
    Object.assign(filterDraft, patch);
    syncFilters();
  }

  function draw() {
    if (writing || state.phase === 'thinking') return;
    const candidates = pool();
    const selected = pickRestaurant(candidates, state.previousId);
    if (!selected) return;
    clearResult();
    state.phase = 'thinking';
    $('#scene').classList.add('is-thinking');
    $('#draw-label').textContent = '小饭团正在选…';
    $('#result-kicker').textContent = '美味正在就位';
    $('#result-name').textContent = '让我认真想一想';
    $('#result-meta').textContent = '一顿好饭，值得等上这一小会儿。';
    $('#plate-caption').textContent = '正在寻找今天的心动';
    setSpeech('嗯…选哪家好呢？');
    refreshDisabled();
    let tick = 0;
    setPlateName(candidates[0].category || '吃点好的');
    ticker = setInterval(() => { tick += 1; setPlateName(candidates[tick % candidates.length].category || '吃点好的'); }, 160);
    drawTimer = setTimeout(() => {
      clearInterval(ticker);
      ticker = null;
      drawTimer = null;
      state.phase = 'reveal';
      state.selected = selected;
      state.previousId = selected.id;
      $('#scene').classList.remove('is-thinking');
      $('#scene').classList.add('is-reveal');
      setSpeech('就它啦，好好吃饭！');
      setPlateName(selected.name);
      $('#plate-caption').textContent = '小饭团为你认真推荐';
      $('#draw-label').textContent = '再选一家';
      $('#result-card').classList.add('is-reveal');
      $('#result-kicker').textContent = '小饭团说，就吃这家';
      $('#result-name').textContent = selected.name;
      $('#result-meta').textContent = metadata(selected);
      $('#confirm-button').innerHTML = `就吃这家 ${icon('check')}`;
      $('#confirm-button').hidden = false;
      refreshDisabled();
    }, 1750);
  }

  async function confirmChoice() {
    if (!state.selected || state.confirmed || writing) return;
    const chosen = { ...state.selected };
    await commit((next) => {
      next.history.unshift({ restaurant: chosen, at: Date.now() });
      next.history = next.history.slice(0, 365);
    }, () => {
      state.confirmed = true;
      $('#scene').classList.add('is-confirmed');
      $('#result-kicker').textContent = '这顿，就这么定了';
      $('#confirm-button').innerHTML = `已记下 ${icon('check')}`;
      setSpeech('开饭咯，祝你好胃口！');
      showToast('记下这家了，祝你有个好胃口！');
    }, false);
  }

  function restaurantFromForm(form, existing) {
    const values = Object.fromEntries(new FormData(form));
    const item = normalizeRestaurant({ ...values, ...(existing ? { id: existing.id, enabled: existing.enabled } : { enabled: true }) });
    item.distanceKm = Number(values.distanceKm || 0);
    item.budget = Number(values.budget || 0);
    return item;
  }

  function openEditor(id) {
    const item = state.restaurants.find((restaurant) => restaurant.id === id);
    if (!item || writing) return;
    editingId = item.id;
    const form = $('#edit-form');
    for (const field of ['name', 'category', 'distanceKm', 'budget', 'note']) form.elements[field].value = item[field] || '';
    form.elements.name.setCustomValidity('');
    $('#restaurant-editor').showModal();
  }

  async function deleteRestaurant(id) {
    const index = state.restaurants.findIndex((item) => item.id === id);
    if (index < 0) return;
    const record = { item: { ...state.restaurants[index] }, index };
    await commit((next) => { next.restaurants.splice(index, 1); }, () => {
      deletedRestaurant = record;
      showToast('已移出清单，点「撤销移除」可以恢复。');
    });
  }

  async function undoDelete() {
    if (!deletedRestaurant) return;
    const record = deletedRestaurant;
    await commit((next) => {
      if (next.restaurants.some((item) => item.id === record.item.id)) throw new Error('这家店已在清单里，无需重复恢复。');
      next.restaurants.splice(Math.min(record.index, next.restaurants.length), 0, { ...record.item });
    }, () => {
      deletedRestaurant = null;
      $('#restaurant-search').value = '';
      showToast('已恢复到餐馆清单。');
    });
  }

  async function pickBackup() {
    if (writing) return;
    writing = true;
    refreshDisabled();
    try {
      const contents = await storage.pickImportFile();
      if (contents === null) return;
      const parsed = codec.parseBackup(contents);
      pendingImport = parsed;
      $('#restore-restaurant-count').textContent = parsed.restaurantCount;
      $('#restore-history-count').textContent = parsed.historyCount;
      const date = new Date(parsed.snapshot.exportedAt);
      $('#restore-date').textContent = Number.isNaN(date.getTime()) ? '已验证文件格式' : `备份时间：${date.toLocaleString('zh-CN')}`;
      $('#restore-preview').showModal();
    } catch (error) {
      pendingImport = null;
      showToast(message(error, '无法读取这个备份，请重新选择。'));
    } finally {
      writing = false;
      refreshDisabled();
    }
  }

  async function restoreBackup() {
    if (!pendingImport) return;
    const restored = codec.normalizeState(pendingImport.snapshot, []);
    await commit((next) => {
      next.restaurants = restored.restaurants;
      next.filters = restored.filters;
      next.history = restored.history;
      next.catalogBatches = restored.catalogBatches;
    }, () => {
      state.previousId = null;
      deletedRestaurant = null;
      editingId = null;
      filterDraft = null;
      $('#restaurant-search').value = '';
      $('#restore-preview').close();
      showToast('备份已恢复，餐馆清单和选择记录已更新。');
    });
  }

  async function exportBackup() {
    if (writing) return;
    writing = true;
    refreshDisabled();
    try {
      const saved = await storage.exportData(state);
      if (saved) showToast('完整备份已导出，包含餐馆、筛选设置和选择记录。');
    } catch (error) {
      showToast(message(error, '备份没有导出成功，请重试。'));
    } finally {
      writing = false;
      refreshDisabled();
    }
  }

  refreshDisabled();
  const loaded = await storage.load(window.INITIAL_RESTAURANTS || []);
  const initial = codec.normalizeState(loaded.state, window.INITIAL_RESTAURANTS || []);
  state.restaurants = initial.restaurants;
  state.filters = initial.filters;
  state.history = initial.history.slice(0, 365);
  state.catalogBatches = initial.catalogBatches;
  isNative = Boolean(loaded.isNative);
  all('[data-storage-note]').forEach((note) => { note.textContent = isNative ? '数据保存在这台电脑' : '数据保存在当前浏览器'; });
  $('#data-directory').hidden = !isNative;
  if (isNative && loaded.dataDirectory) $('#data-directory').title = loaded.dataDirectory;
  if (loaded.warning) {
    $('#storage-warning').hidden = false;
    $('#storage-warning-text').textContent = loaded.warning;
  }
  writing = false;
  document.body.classList.remove('is-loading');

  all('[data-open]').forEach((button) => button.addEventListener('click', () => {
    if (writing) return;
    const name = button.dataset.open;
    if ((name === 'library' || name === 'preferences') && state.phase === 'thinking') return;
    if (name === 'library') renderLibrary();
    if (name === 'history') renderHistory();
    if (name === 'preferences') { filterDraft = { ...state.filters }; renderCategories(); syncFilters(); }
    $('#' + name).showModal();
    refreshDisabled();
  }));
  all('[data-close]').forEach((button) => button.addEventListener('click', () => { if (!writing) button.closest('dialog').close(); }));
  all('dialog').forEach((dialog) => {
    dialog.addEventListener('cancel', (event) => { if (writing) event.preventDefault(); });
    dialog.addEventListener('click', (event) => {
      if (writing || event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      if (dialog.id === 'preferences') { filterDraft = null; syncFilters(); }
      if (dialog.id === 'restore-preview') { pendingImport = null; refreshDisabled(); }
      if (dialog.id === 'restaurant-editor') editingId = null;
      if (dialog.contains($('#toast'))) { $('#toast').hidden = true; document.body.append($('#toast')); }
    });
  });
  $('#draw-button').addEventListener('click', draw);
  $('#confirm-button').addEventListener('click', confirmChoice);
  $('#distance-range').addEventListener('input', (event) => updateFilterDraft({ maxDistanceKm: Number(event.target.value) }));
  $('#budget-range').addEventListener('input', (event) => updateFilterDraft({ maxBudget: Number(event.target.value) }));
  $('#category-options').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (button) updateFilterDraft({ category: button.dataset.category });
  });
  $('#reset-filters').addEventListener('click', () => updateFilterDraft({ ...defaults }));
  $('#apply-preferences').addEventListener('click', async () => {
    if (!filterDraft) return;
    const filters = { ...filterDraft };
    await commit((next) => { next.filters = filters; }, () => { $('#preferences').close(); });
  });
  $('#restaurant-search').addEventListener('input', () => { renderLibrary(); refreshDisabled(); });
  $('#restaurant-list').addEventListener('click', async (event) => {
    if (writing) return;
    const edit = event.target.closest('[data-edit]');
    if (edit) { openEditor(edit.dataset.edit); return; }
    const remove = event.target.closest('[data-delete]');
    if (remove) { await deleteRestaurant(remove.dataset.delete); return; }
    const toggle = event.target.closest('[data-toggle]');
    if (!toggle) return;
    await commit((next) => {
      const item = next.restaurants.find((restaurant) => restaurant.id === toggle.dataset.toggle);
      if (item) item.enabled = !item.enabled;
    });
  });
  $('#undo-delete').addEventListener('click', undoDelete);
  $('#add-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (writing) return;
    const form = event.currentTarget;
    const item = restaurantFromForm(form);
    if (!item.name) { form.elements.name.setCustomValidity('给这家店起个名字吧'); form.elements.name.reportValidity(); return; }
    await commit((next) => { next.restaurants.push(item); }, () => {
      $('#restaurant-search').value = '';
      form.reset();
      $('.add-restaurant').open = false;
      showToast(`${item.name}已加入清单`);
    });
  });
  $('#edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (writing) return;
    const form = event.currentTarget;
    const existing = state.restaurants.find((item) => item.id === editingId);
    if (!existing) { showToast('这家店已不在清单里，请重新打开清单。'); return; }
    const updated = restaurantFromForm(form, existing);
    if (!updated.name) { form.elements.name.setCustomValidity('请填写餐馆名称'); form.elements.name.reportValidity(); return; }
    await commit((next) => {
      const index = next.restaurants.findIndex((item) => item.id === existing.id);
      if (index < 0) throw new Error('这家店已不在清单里。');
      next.restaurants[index] = updated;
    }, () => {
      $('#restaurant-editor').close();
      showToast('餐馆信息已保存。');
    });
  });
  all('#add-form [name="name"], #edit-form [name="name"]').forEach((input) => input.addEventListener('input', () => input.setCustomValidity('')));
  $('#export-button').addEventListener('click', exportBackup);
  $('#import-button').addEventListener('click', pickBackup);
  $('#restore-confirm').addEventListener('click', restoreBackup);
  $('#data-directory').addEventListener('click', async () => {
    if (!isNative || writing) return;
    try { await storage.openDataDirectory(); }
    catch (error) { showToast(message(error, '无法打开数据文件夹。')); }
  });
  $('#clear-history').addEventListener('click', () => { if (!writing && state.history.length) $('#clear-history-dialog').showModal(); });
  $('#clear-history-confirm').addEventListener('click', async () => {
    await commit((next) => { next.history = []; }, () => {
      $('#clear-history-dialog').close();
      showToast('选择记录已清空，餐馆清单保留。');
    }, false);
  });
  window.addEventListener('pagehide', () => { clearTimeout(drawTimer); clearInterval(ticker); clearTimeout(toastTimer); });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    $('#toast').hidden = true;
    if (state.phase === 'thinking') clearResult();
    syncFilters();
  });
  renderData();
  if (Number.isInteger(loaded.addedCount) && loaded.addedCount > 0) showToast(`已加入 ${loaded.addedCount} 家周边餐馆，原清单与记录已保留。`);
})().catch(function (error) {
  const warning = document.querySelector('#storage-warning');
  warning.hidden = false;
  document.querySelector('#storage-warning-text').textContent = error && error.message ? error.message : '未能读取本地数据，请重新打开应用后重试。';
  document.querySelector('#availability').textContent = '数据尚未加载，请重新打开应用后重试。';
  document.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
  document.body.classList.remove('is-loading', 'is-saving');
});
