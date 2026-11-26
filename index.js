(() => {
  const EXT_KEY = 'st_bulk_scheme_helper';
  let openaiMod = null, wiMod = null;
  const state = {
    preset: { bulk: false, selected: new Set(), rangeMode: false, rangeAnchor: null },
    world: { bulk: false, selected: new Set(), rangeMode: false, rangeAnchor: null },
    activeDockMode: null,
    presetSwitching: false,
    dockFolded: false,
    internalPresetSave: false,
    inserting: false,
  };

  // SillyTavern 出厂内置条目（PromptManager.js chatCompletionDefaultPrompts），按 ID 保护，不依赖预设里的标记是否完整
  const PROTECTED_PROMPT_IDS = new Set([
    'main', 'nsfw', 'jailbreak', 'enhanceDefinitions',
    'dialogueExamples', 'chatHistory', 'worldInfoBefore', 'worldInfoAfter',
    'charDescription', 'charPersonality', 'scenario', 'personaDescription',
  ]);

  /* ===== BaiBai 分组供电：记在方案里的保留键（不会和条目 ID 冲突） ===== */
  const GROUP_POWER_KEY = '__baibaiGroupPower__';
  const META_KEY = '__entryMeta__';
  const isReservedSnapKey = (k) => k === GROUP_POWER_KEY || k === META_KEY;
  const countEntries = (snap) => Object.keys(snap || {}).filter((k) => !isReservedSnapKey(k)).length;

  function hashContent(str) {
    let h = 2166136261;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function readPresetEntriesSync() {
    const pm = openaiMod?.promptManager;
    const order = pm?.getPromptOrderForCharacter?.(pm.activeCharacter);
    const prompts = pm?.serviceSettings?.prompts || openaiMod?.oai_settings?.prompts || [];
    const byId = new Map(prompts.map((p) => [p.identifier, p]));
    if (Array.isArray(order) && order.length) {
      return order.filter((e) => e?.identifier).map((e) => {
        const p = byId.get(e.identifier);
        return {
          id: e.identifier,
          name: String(p?.name ?? '').trim() || e.identifier,
          content: p?.content || '',
        };
      });
    }
    return Array.from(document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]')).map((li) => {
      const id = li.getAttribute('data-pm-identifier');
      const p = byId.get(id);
      const nameEl = li.querySelector('.completion_prompt_manager_prompt_name');
      return {
        id,
        name: String(p?.name ?? nameEl?.textContent ?? '').trim() || id,
        content: p?.content || '',
      };
    }).filter((x) => x.id);
  }

  async function readCurrentEntries(mode, targetName) {
    if (mode === 'preset') return readPresetEntriesSync();
    const loadWI = wiMod?.loadWorldInfo || getCtx().loadWorldInfo;
    if (loadWI && targetName) {
      const data = await loadWI(targetName);
      if (data?.entries) {
        return Object.entries(data.entries).map(([uid, e]) => ({
          id: String(uid),
          name: String(e.comment || '').trim() || (Array.isArray(e.key) ? e.key.join(', ') : '') || `#${uid}`,
          content: e.content || '',
        }));
      }
    }
    return [];
  }

  function buildEntryMeta(entries) {
    const meta = {};
    (entries || []).forEach((e) => {
      if (e?.id) meta[e.id] = { n: e.name, h: hashContent(e.content) };
    });
    return meta;
  }

  function inspectScheme(snap, currentEntries) {
    const meta = (snap && typeof snap[META_KEY] === 'object') ? snap[META_KEY] : null;
    const curMap = new Map(currentEntries.map((e) => [e.id, e]));
    const onList = [];
    const offList = [];
    let hasChanges = false;

    currentEntries.forEach((e) => {
      if (!Object.prototype.hasOwnProperty.call(snap || {}, e.id)) {
        hasChanges = true;
        offList.push({ id: e.id, name: e.name, change: 'added' });
        return;
      }
      const isOn = Boolean(snap[e.id]);
      const oldMeta = meta && meta[e.id];
      const modified = Boolean(oldMeta && oldMeta.h !== hashContent(e.content));
      if (modified) hasChanges = true;
      (isOn ? onList : offList).push({ id: e.id, name: e.name, change: modified ? 'modified' : null });
    });

    Object.keys(snap || {}).forEach((k) => {
      if (isReservedSnapKey(k) || curMap.has(k)) return;
      hasChanges = true;
      const oldName = (meta && meta[k] && meta[k].n) ? meta[k].n : k;
      (Boolean(snap[k]) ? onList : offList).push({ id: k, name: oldName, change: 'deleted' });
    });

    const validOn = onList.filter((x) => x.change !== 'deleted').length;
    return { onList, offList, validOn, totalCurrent: currentEntries.length, hasChanges };
  }

  function getBaiBaiGroupEls() {
    return Array.from(document.querySelectorAll('#completion_prompt_manager_list li.bai-bai-preset-group[data-preset-group-id]'));
  }

  // 返回 { 分组ID: 是否供电 }；页面上没有分组时返回 null（表示不知道，不去动记录）
  function readGroupPower() {
    const els = getBaiBaiGroupEls();
    if (!els.length) return null;
    const m = {};
    els.forEach((g) => { m[g.getAttribute('data-preset-group-id')] = !g.classList.contains('bai-bai-preset-group-powered-off'); });
    return m;
  }

  // 状态不一致的分组替用户点一下 BaiBai 自己的供电开关，返回切换了几个
  function applyGroupPower(rec) {
    if (!rec || typeof rec !== 'object') return 0;
    let c = 0;
    getBaiBaiGroupEls().forEach((g) => {
      const id = g.getAttribute('data-preset-group-id');
      if (!Object.prototype.hasOwnProperty.call(rec, id)) return;
      const on = !g.classList.contains('bai-bai-preset-group-powered-off');
      if (on === Boolean(rec[id])) return;
      const tg = g.querySelector(':scope > .bai-bai-preset-group-header .bai-bai-preset-group-enable-toggle');
      if (tg) { tg.click(); c++; }
    });
    return c;
  }

  const getCtx = () => (window.SillyTavern?.getContext ? window.SillyTavern.getContext() : {});
  const notify = (t, m) => (window.toastr?.[t] ? window.toastr[t](m) : console.log(`[批量方案助手:${t}]`, m));

  function stopDrawerClose(el) {
    ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach((evt) => {
      el.addEventListener(evt, (e) => e.stopPropagation(), false);
    });
  }

  function isDrawerListOpen(mode) {
    const panelId = mode === 'preset' ? 'left-nav-panel' : 'WorldInfo';
    const listId = mode === 'preset' ? 'completion_prompt_manager_list' : 'world_popup_entries_list';
    const panel = document.getElementById(panelId);
    const list = document.getElementById(listId);
    if (!list) return false;
    if (panel) {
      if (panel.classList.contains('closedDrawer')) return false;
      if (panel.classList.contains('openDrawer')) {
        const r = list.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
    }
    const r = list.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(list).visibility !== 'hidden';
  }

  function getRawStore() {
    const ctx = getCtx();
    const ext = ctx.extensionSettings || (window.extension_settings = window.extension_settings || {});
    if (!ext[EXT_KEY]) ext[EXT_KEY] = { presetSchemes: {}, worldSchemes: {}, activePresetScheme: {}, activeWorldScheme: {} };
    const s = ext[EXT_KEY];
    s.presetSchemes ||= {}; s.worldSchemes ||= {}; s.activePresetScheme ||= {}; s.activeWorldScheme ||= {};
    return s;
  }

  /* ===== 预设方案存进预设文件本身（随预设导出/导入/改名） ===== */
  const PRESET_EXT_PATH = 'stBulkSchemeHelper.schemes';
  const migratingPresets = new Set();

  function getPresetExtApi() {
    const pm = getCtx().getPresetManager?.('openai');
    return (typeof pm?.readPresetExtensionField === 'function' && typeof pm?.writePresetExtensionField === 'function') ? pm : null;
  }

  // 切换预设途中：下拉框已是新名字，但 oai_settings.extensions 还是旧预设的，此时不读写预设字段
  function isPresetDataReady() {
    if (state.presetSwitching) return false;
    const cur = openaiMod?.oai_settings?.preset_settings_openai;
    return !cur || cur === getPresetName();
  }

  function getStore() {
    const s = getRawStore();
    const pm = getPresetExtApi(), pname = getPresetName();
    if (!pm || !pname || !isPresetDataReady()) return s;
    const fromPreset = pm.readPresetExtensionField({ path: PRESET_EXT_PATH });
    if (fromPreset && typeof fromPreset === 'object') {
      s.presetSchemes[pname] = structuredClone(fromPreset);
    } else if (Object.keys(s.presetSchemes[pname] || {}).length && !migratingPresets.has(pname)) {
      migratingPresets.add(pname);
      pm.writePresetExtensionField({ path: PRESET_EXT_PATH, value: structuredClone(s.presetSchemes[pname]) })
        .finally(() => migratingPresets.delete(pname));
    }
    return s;
  }

  function persistStore() {
    const fn = getCtx().saveSettingsDebounced || window.saveSettingsDebounced;
    if (typeof fn === 'function') fn();
    const pm = getPresetExtApi(), pname = getPresetName();
    if (!pm || !pname || !isPresetDataReady()) return;
    const local = getRawStore().presetSchemes[pname] || {};
    const fromPreset = pm.readPresetExtensionField({ path: PRESET_EXT_PATH }) || {};
    if (JSON.stringify(local) !== JSON.stringify(fromPreset)) {
      pm.writePresetExtensionField({ path: PRESET_EXT_PATH, value: structuredClone(local) });
    }
  }

  async function tryImport(paths) {
    for (const p of paths) { try { return await import(p); } catch (_) {} }
    return null;
  }

  function reloadWorldUI() {
    if (window.$) window.$('#world_editor_select').trigger('change');
    else document.querySelector('#world_editor_select')?.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function downloadJson(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1200);
  }

  function getPresetName() {
    const sel = document.querySelector('#settings_preset_openai');
    const txt = sel?.selectedOptions?.[0]?.textContent?.trim();
    if (txt) return txt;
    return getCtx().getPresetManager?.('openai')?.getSelectedPresetName?.() || '默认预设';
  }

  function getWorldName() {
    const sel = document.querySelector('#world_editor_select');
    if (!sel || sel.value === '' || sel.value == null) return null;
    const idx = Number(sel.value);
    if (wiMod?.world_names && !Number.isNaN(idx) && wiMod.world_names[idx]) return wiMod.world_names[idx];
    const txt = sel.selectedOptions?.[0]?.textContent?.trim() || '';
    return (!txt || txt.startsWith('---')) ? null : txt;
  }

  function getItems(mode) {
    const list = document.querySelector(mode === 'preset' ? '#completion_prompt_manager_list' : '#world_popup_entries_list');
    if (!list) return [];
    const sel = mode === 'preset' ? 'li[data-pm-identifier]' : '.world_entry[uid]';
    const items = Array.from(list.querySelectorAll(sel)).filter((el) => el.style.display !== 'none' && getComputedStyle(el).display !== 'none');
    state[mode].total = items.length;
    return items;
  }

  const getItemId = (mode, el) => el.getAttribute(mode === 'preset' ? 'data-pm-identifier' : 'uid');

  /* ================== 弹窗（挂到 html 根节点，永不被 body 偏移） ================== */
  function ensureModal() {
    let bd = document.getElementById('st-bs-modal-backdrop');
    if (!bd) {
      bd = document.createElement('div');
      bd.id = 'st-bs-modal-backdrop';
      bd.innerHTML = '<div class="st-bs-modal-card"></div>';
      stopDrawerClose(bd);
      document.documentElement.appendChild(bd);
    }
    bd.style.height = `${window.innerHeight}px`;
    bd.querySelector('.st-bs-subpop')?.remove();
    return bd;
  }

  const closeModal = () => document.getElementById('st-bs-modal-backdrop')?.classList.remove('open');

  function showConfirm({ title, desc, okText = '确认', cancelText = '取消', danger = false }) {
    return new Promise((resolve) => {
      const bd = ensureModal(), card = bd.querySelector('.st-bs-modal-card');
      card.innerHTML = `<div class="st-bs-modal-title"></div><div class="st-bs-modal-desc"></div>
        <div class="st-bs-modal-actions">
          <button type="button" class="st-bs-btn" data-act="cancel"></button>
          <button type="button" class="st-bs-btn ${danger ? 'st-bs-btn-danger' : 'st-bs-btn-primary'}" data-act="ok"></button>
        </div>`;
      card.querySelector('.st-bs-modal-title').textContent = title;
      card.querySelector('.st-bs-modal-desc').textContent = desc;
      card.querySelector('[data-act="cancel"]').textContent = cancelText;
      card.querySelector('[data-act="ok"]').textContent = okText;
      const done = (v) => { bd.onclick = null; closeModal(); resolve(v); };
      card.querySelector('[data-act="cancel"]').onclick = () => done(false);
      card.querySelector('[data-act="ok"]').onclick = () => done(true);
      bd.onclick = (e) => { if (e.target === bd) done(false); };
      bd.classList.add('open');
    });
  }

  function showSaveSchemeModal(mode, fromSaveHook = false, presetInputName = null) {
    const targetName = mode === 'preset' ? getPresetName() : getWorldName();
    if (!targetName) return notify('warning', '请先打开一个世界书再保存方案');
    const store = getStore();
    const bucket = mode === 'preset' ? store.presetSchemes : store.worldSchemes;
    const activeMap = mode === 'preset' ? store.activePresetScheme : store.activeWorldScheme;
    const names = Object.keys(bucket[targetName] || {});

    const bd = ensureModal(), card = bd.querySelector('.st-bs-modal-card');
    card.innerHTML = `
      <div class="st-bs-modal-title">${fromSaveHook ? '是否存为开关方案？' : '存为开关方案'}</div>
      <div class="st-bs-modal-desc"></div>
      <input type="text" class="st-bs-modal-input" placeholder="输入方案名称（如：港风、双语）" />
      <div class="st-bs-modal-chips"></div>
      <div class="st-bs-modal-actions">
        <button type="button" class="st-bs-btn" data-act="cancel">${fromSaveHook ? '取消（仅保存预设）' : '取消'}</button>
        <button type="button" class="st-bs-btn st-bs-btn-primary" data-act="ok">确认存入</button>
      </div>`;
    card.querySelector('.st-bs-modal-desc').textContent =
      `当前${mode === 'preset' ? '预设' : '世界书'}：「${targetName}」。将记录当前所有条目的开/关状态，方便随时一键切换。`;
    const input = card.querySelector('.st-bs-modal-input');
    input.value = presetInputName !== null ? presetInputName : (activeMap[targetName] || '');

    const chips = card.querySelector('.st-bs-modal-chips');
    if (names.length) {
      names.forEach((n) => {
        const c = document.createElement('span');
        c.className = 'st-bs-chip'; c.textContent = n;
        c.onclick = () => { input.value = n; };
        chips.appendChild(c);
      });
    } else chips.style.display = 'none';

    const save = async () => {
      const name = input.value.trim();
      if (!name) { notify('warning', '请输入方案名称'); return; }
      await saveScheme(mode, targetName, name);
      closeModal();
    };
    card.querySelector('[data-act="cancel"]').onclick = closeModal;
    card.querySelector('[data-act="ok"]').onclick = save;
    input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
    bd.onclick = (e) => { if (e.target === bd) closeModal(); };
    bd.classList.add('open');
  }

  function reorderObjectKeys(obj, orderedKeys) {
    if (!obj || typeof obj !== 'object') return;
    const rebuilt = {};
    orderedKeys.forEach((k) => { if (Object.prototype.hasOwnProperty.call(obj, k)) rebuilt[k] = obj[k]; });
    Object.keys(obj).forEach((k) => { if (!Object.prototype.hasOwnProperty.call(rebuilt, k)) rebuilt[k] = obj[k]; });
    Object.keys(obj).forEach((k) => delete obj[k]);
    Object.assign(obj, rebuilt);
  }

  // 仅按住最左侧「三横」把手可拖动排序；其他区域长按/滑动完全不触发，防误触
  function bindHandleDrag(container, itemSelector, onReorder) {
    if (!container || container.dataset.stDragBound) return;
    container.dataset.stDragBound = '1';

    let dragging = null;
    const preventTouchScroll = (e) => { if (dragging) e.preventDefault(); };

    container.addEventListener('click', (e) => {
      if (e.target?.closest?.('.st-bs-drag-handle')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    container.addEventListener('pointerdown', (e) => {
      const handle = e.target?.closest?.('.st-bs-drag-handle');
      if (!handle || !container.contains(handle)) return;
      if (e.button && e.button !== 0) return;
      const row = handle.closest(itemSelector);
      if (!row || row.parentElement !== container) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = row.getBoundingClientRect();
      const ghost = row.cloneNode(true);
      ghost.classList.add('st-bs-drag-ghost');
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      document.documentElement.appendChild(ghost);

      row.classList.add('st-bs-drag-placeholder');
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}

      const initialKeys = Array.from(container.querySelectorAll(`:scope > ${itemSelector}`)).map((el) => el.dataset.dragKey);
      let rafId = 0;
      let lastY = e.clientY;

      const updateSwap = (clientY) => {
        const siblings = Array.from(container.querySelectorAll(`:scope > ${itemSelector}`)).filter((el) => el !== row);
        let placed = false;
        for (const sib of siblings) {
          const r = sib.getBoundingClientRect();
          if (clientY < r.top + r.height / 2) {
            container.insertBefore(row, sib);
            placed = true;
            break;
          }
        }
        if (!placed) container.appendChild(row);
      };

      const autoScroll = () => {
        if (!dragging) return;
        const cr = container.getBoundingClientRect();
        const edge = 36;
        let delta = 0;
        if (lastY < cr.top + edge) delta = -Math.ceil((cr.top + edge - lastY) / 5);
        else if (lastY > cr.bottom - edge) delta = Math.ceil((lastY - (cr.bottom - edge)) / 5);
        if (delta !== 0) {
          const prev = container.scrollTop;
          container.scrollTop += delta;
          if (container.scrollTop !== prev) updateSwap(lastY);
        }
        rafId = requestAnimationFrame(autoScroll);
      };

      dragging = { handle, row, ghost, pointerId: e.pointerId, offsetY: e.clientY - rect.top, initialKeys };

      const onMove = (ev) => {
        if (!dragging || ev.pointerId !== dragging.pointerId) return;
        ev.preventDefault();
        lastY = ev.clientY;
        ghost.style.top = `${ev.clientY - dragging.offsetY}px`;
        updateSwap(ev.clientY);
      };

      const finish = (ev) => {
        if (!dragging || (ev && ev.pointerId !== dragging.pointerId)) return;
        cancelAnimationFrame(rafId);
        document.removeEventListener('touchmove', preventTouchScroll, { passive: false });
        window.removeEventListener('pointermove', onMove, { passive: false });
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        try { dragging.handle.releasePointerCapture(dragging.pointerId); } catch (_) {}
        dragging.ghost.remove();
        dragging.row.classList.remove('st-bs-drag-placeholder');
        const newKeys = Array.from(container.querySelectorAll(`:scope > ${itemSelector}`)).map((el) => el.dataset.dragKey);
        const changed = newKeys.length === dragging.initialKeys.length && newKeys.some((k, i) => k !== dragging.initialKeys[i]);
        dragging = null;
        if (changed) onReorder(newKeys);
      };

      document.addEventListener('touchmove', preventTouchScroll, { passive: false });
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      rafId = requestAnimationFrame(autoScroll);
    });
  }

  function showSchemePickerModal(mode) {
    const targetName = mode === 'preset' ? getPresetName() : getWorldName();
    if (!targetName) return notify('warning', '请先在上方选择一本世界书');

    const store = getStore();
    const bucket = mode === 'preset' ? store.presetSchemes : store.worldSchemes;
    const activeMap = mode === 'preset' ? store.activePresetScheme : store.activeWorldScheme;
    const names = Object.keys(bucket[targetName] || {});
    const cur = activeMap[targetName] || '';

    const bd = ensureModal(), card = bd.querySelector('.st-bs-modal-card');
    card.innerHTML = `
      <div class="st-bs-modal-title">切换开关方案</div>
      <div class="st-bs-modal-desc">当前${mode === 'preset' ? '预设' : '世界书'}：「${targetName}」</div>
      ${mode === 'preset' && names.length ? '<button type="button" class="st-bs-btn" data-act="refresh" style="width:100%;margin:0 0 10px;"><i class="fa-solid fa-rotate"></i> 刷新全部方案</button>' : ''}
      <div class="st-bs-scheme-list"></div>
      <div class="st-bs-modal-actions">
        <button type="button" class="st-bs-btn" data-act="close">关闭</button>
        <button type="button" class="st-bs-btn st-bs-btn-primary" data-act="add">+ 存为新方案</button>
      </div>`;

    const curPresetEntries = mode === 'preset' ? readPresetEntriesSync() : null;
    const listEl = card.querySelector('.st-bs-scheme-list');
    if (!names.length) {
      listEl.innerHTML = '<div style="text-align:center;opacity:0.65;padding:14px 0;font-size:13px;">还没有保存过方案，点右下角「+ 存为新方案」即可保存当前开关状态。</div>';
    } else {
      names.forEach((name) => {
        const snap = bucket[targetName]?.[name];
        const drifted = curPresetEntries && snap ? inspectScheme(snap, curPresetEntries).hasChanges : false;
        const row = document.createElement('div');
        row.className = 'st-bs-scheme-row' + (name === cur ? ' active' : '');
        row.dataset.dragKey = name;
        row.innerHTML = `
          <span class="st-bs-drag-handle" title="按住拖动排序"><i class="fa-solid fa-bars"></i></span>
          <div class="st-bs-scheme-row-main">
            <i class="fa-solid ${name === cur ? 'fa-circle-check' : 'fa-circle'}" style="font-size:12px;opacity:${name === cur ? 1 : 0.35};color:${name === cur ? '#9b6b78' : 'inherit'};"></i>
            <span class="st-bs-scheme-row-name"></span>
            ${drifted ? '<span class="st-bs-drift-dot" title="预设有变动，点开查看详情"></span>' : ''}
          </div>
          <div class="st-bs-scheme-row-actions">
            <button type="button" class="st-bs-scheme-row-btn st-bs-bind-btn${countSchemeBindings(mode, targetName, name) ? ' has-bind' : ''}" data-row-act="bind" title="绑定聊天窗口">${LINK_SVG}${countSchemeBindings(mode, targetName, name) ? `<span class="st-bs-bind-badge">${countSchemeBindings(mode, targetName, name)}</span>` : ''}</button>
            <button type="button" class="st-bs-scheme-row-btn" data-row-act="rename" title="重命名此方案">${PENCIL_SVG}</button>
            <button type="button" class="st-bs-scheme-row-btn" data-row-act="overwrite" title="用当前开关覆盖此方案"><i class="fa-solid fa-floppy-disk"></i></button>
            <button type="button" class="st-bs-scheme-row-btn danger" data-row-act="del" title="删除此方案"><i class="fa-solid fa-trash-can"></i></button>
          </div>`;
        row.querySelector('.st-bs-scheme-row-name').textContent = name;

        row.querySelector('.st-bs-scheme-row-main').onclick = () => {
          showSchemeDetailPopup(bd, mode, targetName, name);
        };
        row.querySelector('[data-row-act="bind"]').onclick = () => {
          showChatBindPopup(bd, mode, targetName, name);
        };
        row.querySelector('[data-row-act="rename"]').onclick = () => {
          openSubPopup(bd, (box, closeSub) => {
            box.innerHTML = `
              <div class="st-bs-modal-title">重命名开关方案</div>
              <div class="st-bs-search-capsule st-bs-subpop-input"><input type="text" class="st-bs-search-input" /></div>
              <div class="st-bs-modal-actions">
                <button type="button" class="st-bs-btn" data-sub="no">取消</button>
                <button type="button" class="st-bs-btn st-bs-btn-primary" data-sub="yes">确定</button>
              </div>`;
            const input = box.querySelector('input');
            input.value = name;
            const confirmRename = () => {
              const nextName = input.value.trim();
              if (!nextName) return notify('warning', '请输入方案名称');
              if (nextName === name) return closeSub();
              const schemes = bucket[targetName];
              if (!schemes) return closeSub();
              if (Object.prototype.hasOwnProperty.call(schemes, nextName)) {
                return notify('warning', `已经有叫「${nextName}」的方案了`);
              }
              const rebuilt = {};
              Object.keys(schemes).forEach((k) => { rebuilt[k === name ? nextName : k] = schemes[k]; });
              Object.keys(schemes).forEach((k) => delete schemes[k]);
              Object.assign(schemes, rebuilt);
              if (activeMap[targetName] === name) activeMap[targetName] = nextName;
              Object.values(getChatBindings(mode)).forEach((b) => {
                if (b && b.targetName === targetName && b.schemeName === name) b.schemeName = nextName;
              });
              persistStore();
              refreshSchemeButton(mode);
              notify('success', `已重命名为「${nextName}」`);
              showSchemePickerModal(mode);
            };
            box.querySelector('[data-sub="no"]').onclick = closeSub;
            box.querySelector('[data-sub="yes"]').onclick = confirmRename;
            input.onkeydown = (e) => { if (e.key === 'Enter') confirmRename(); };
            setTimeout(() => input.focus(), 30);
          });
        };
        row.querySelector('[data-row-act="overwrite"]').onclick = async () => {
          await saveScheme(mode, targetName, name);
          showSchemePickerModal(mode);
        };
        row.querySelector('[data-row-act="del"]').onclick = async () => {
          const ok = await showConfirm({
            title: '删除方案',
            desc: `确定删除方案「${name}」吗？（不会影响原条目）`,
            okText: '删除',
            danger: true,
          });
          if (ok) {
            if (bucket[targetName]) delete bucket[targetName][name];
            if (activeMap[targetName] === name) delete activeMap[targetName];
            const bMap = getChatBindings(mode);
            Object.keys(bMap).forEach((k) => {
              if (bMap[k] && bMap[k].targetName === targetName && bMap[k].schemeName === name) delete bMap[k];
            });
            persistStore();
            refreshSchemeButton(mode);
            notify('info', `已删除方案「${name}」`);
          }
          showSchemePickerModal(mode);
        };
        listEl.appendChild(row);
      });
      bindHandleDrag(listEl, '.st-bs-scheme-row', (newKeys) => {
        if (!bucket[targetName]) return;
        reorderObjectKeys(bucket[targetName], newKeys);
        persistStore();
      });
    }

    card.querySelector('[data-act="close"]').onclick = closeModal;
    card.querySelector('[data-act="add"]').onclick = () => showSaveSchemeModal(mode, false, '');
    const refreshBtn = card.querySelector('[data-act="refresh"]');
    if (refreshBtn) refreshBtn.onclick = () => refreshAllPresetSchemes();
    bd.onclick = (e) => { if (e.target === bd) closeModal(); };
    bd.classList.add('open');
  }

  /* ================== 开关方案详情预览（可拖分割条 + 超小展开键 + 绿色变动提醒） ================== */
  async function showSchemeDetailPopup(bd, mode, targetName, schemeName) {
    const store = getStore();
    const bucket = mode === 'preset' ? store.presetSchemes : store.worldSchemes;
    const snap = bucket[targetName]?.[schemeName];
    if (!snap) return;

    const currentEntries = await readCurrentEntries(mode, targetName);
    const info = inspectScheme(snap, currentEntries);
    const tagText = { added: '新增', modified: '已改', deleted: '已删' };

    openSubPopup(bd, (box, closeSub) => {
      box.classList.add('st-bs-sd-card');
      box.innerHTML = `
        <div class="st-bs-sd-header">
          <div class="st-bs-sd-title"></div>
          <span class="st-bs-sd-counter">${info.validOn} / ${info.totalCurrent}</span>
        </div>
        <div class="st-bs-sd-split" data-split>
          <div class="st-bs-sd-pane" data-pane="on">
            <div class="st-bs-sd-label" data-toggle-pane="on">
              <span>已开启（${info.onList.length}）</span>
              <button type="button" class="st-bs-sd-exp-btn" data-exp="on" title="展开 / 还原"><i class="fa-solid fa-maximize"></i></button>
            </div>
            <div class="st-bs-sd-box" data-box="on"></div>
          </div>
          <div class="st-bs-sd-divider" data-divider title="上下拖动调整比例">
            <span class="st-bs-sd-divider-grip"><i class="fa-solid fa-arrows-up-down"></i></span>
          </div>
          <div class="st-bs-sd-pane" data-pane="off">
            <div class="st-bs-sd-label" data-toggle-pane="off">
              <span>已关闭（${info.offList.length}）</span>
              <button type="button" class="st-bs-sd-exp-btn" data-exp="off" title="展开 / 还原"><i class="fa-solid fa-maximize"></i></button>
            </div>
            <div class="st-bs-sd-box" data-box="off"></div>
          </div>
        </div>
        ${info.hasChanges ? '<div class="st-bs-sd-hint">绿色条目表示当前预设已有变动（新增 / 已改 / 已删），方案尚未更新。</div>' : ''}
        <div class="st-bs-modal-actions st-bs-modal-actions-wrap">
          <button type="button" class="st-bs-btn" data-sub="back">返回</button>
          ${info.hasChanges ? '<button type="button" class="st-bs-btn" data-sub="sync">同步变动</button>' : ''}
          <button type="button" class="st-bs-btn st-bs-btn-primary" data-sub="apply">应用此方案</button>
        </div>`;

      box.querySelector('.st-bs-sd-title').textContent = schemeName;

      const fillBox = (el, items, cls) => {
        if (!items.length) {
          el.innerHTML = '<div class="st-bs-sd-empty">（无）</div>';
          return;
        }
        items.forEach((it) => {
          const row = document.createElement('div');
          row.className = `st-bs-sd-item ${cls}${it.change ? ' is-changed' : ''}`;
          const nameSpan = document.createElement('span');
          nameSpan.className = 'st-bs-sd-item-name';
          nameSpan.textContent = it.name;
          row.appendChild(nameSpan);
          if (it.change) {
            const badge = document.createElement('span');
            badge.className = 'st-bs-sd-badge';
            badge.textContent = tagText[it.change] || '变动';
            row.appendChild(badge);
          }
          el.appendChild(row);
        });
      };

      fillBox(box.querySelector('[data-box="on"]'), info.onList, 'is-on');
      fillBox(box.querySelector('[data-box="off"]'), info.offList, 'is-off');

      /* ===== A + B：中线拖动调整比例 + 超小展开键一键独享全高 ===== */
      const splitEl = box.querySelector('[data-split]');
      const paneOn = box.querySelector('[data-pane="on"]');
      const paneOff = box.querySelector('[data-pane="off"]');
      const divider = box.querySelector('[data-divider]');
      const expOn = box.querySelector('[data-exp="on"]');
      const expOff = box.querySelector('[data-exp="off"]');

      let ratio = 0.5;
      let expanded = null; // 'on' | 'off' | null

      const applySplit = () => {
        if (expanded === 'on') {
          paneOn.classList.remove('collapsed');
          paneOff.classList.add('collapsed');
          paneOn.style.flex = '1 1 0';
          paneOff.style.flex = '0 0 auto';
          divider.style.display = 'none';
        } else if (expanded === 'off') {
          paneOn.classList.add('collapsed');
          paneOff.classList.remove('collapsed');
          paneOn.style.flex = '0 0 auto';
          paneOff.style.flex = '1 1 0';
          divider.style.display = 'none';
        } else {
          paneOn.classList.remove('collapsed');
          paneOff.classList.remove('collapsed');
          paneOn.style.flex = `${ratio} 1 0`;
          paneOff.style.flex = `${1 - ratio} 1 0`;
          divider.style.display = '';
        }
        expOn.classList.toggle('active', expanded === 'on');
        expOn.innerHTML = expanded === 'on' ? '<i class="fa-solid fa-minimize"></i>' : '<i class="fa-solid fa-maximize"></i>';
        expOff.classList.toggle('active', expanded === 'off');
        expOff.innerHTML = expanded === 'off' ? '<i class="fa-solid fa-minimize"></i>' : '<i class="fa-solid fa-maximize"></i>';
      };

      const toggleExpand = (which) => {
        expanded = expanded === which ? null : which;
        applySplit();
      };

      box.querySelector('[data-toggle-pane="on"]').onclick = () => toggleExpand('on');
      box.querySelector('[data-toggle-pane="off"]').onclick = () => toggleExpand('off');

      let draggingDiv = false;
      const preventScroll = (ev) => { if (draggingDiv) ev.preventDefault(); };

      divider.addEventListener('pointerdown', (e) => {
        if (e.button && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        draggingDiv = true;
        divider.classList.add('dragging');
        try { divider.setPointerCapture(e.pointerId); } catch (_) {}

        const sr = splitEl.getBoundingClientRect();
        const dh = divider.getBoundingClientRect().height;
        const pid = e.pointerId;

        const onMove = (ev) => {
          if (!draggingDiv || ev.pointerId !== pid) return;
          ev.preventDefault();
          const rel = (ev.clientY - sr.top - dh / 2) / Math.max(1, sr.height - dh);
          ratio = Math.min(0.85, Math.max(0.15, rel));
          expanded = null;
          applySplit();
        };

        const finish = (ev) => {
          if (!draggingDiv || (ev && ev.pointerId !== pid)) return;
          draggingDiv = false;
          divider.classList.remove('dragging');
          document.removeEventListener('touchmove', preventScroll, { passive: false });
          window.removeEventListener('pointermove', onMove, { passive: false });
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
          try { divider.releasePointerCapture(pid); } catch (_) {}
        };

        document.addEventListener('touchmove', preventScroll, { passive: false });
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
      });

      applySplit();

      box.querySelector('[data-sub="back"]').onclick = closeSub;
      box.querySelector('[data-sub="apply"]').onclick = async () => {
        closeModal();
        await applyScheme(mode, schemeName);
      };
      box.querySelector('[data-sub="sync"]')?.addEventListener('click', () => {
        const curIds = new Set(currentEntries.map((e) => e.id));
        currentEntries.forEach((e) => {
          if (!Object.prototype.hasOwnProperty.call(snap, e.id)) snap[e.id] = false;
        });
        Object.keys(snap).forEach((k) => {
          if (!isReservedSnapKey(k) && !curIds.has(k)) delete snap[k];
        });
        snap[META_KEY] = buildEntryMeta(currentEntries);
        if (mode === 'preset') {
          const groups = readGroupPower();
          const rec = snap[GROUP_POWER_KEY];
          if (groups && rec && typeof rec === 'object') {
            Object.keys(groups).forEach((gid) => { if (!Object.prototype.hasOwnProperty.call(rec, gid)) rec[gid] = true; });
            Object.keys(rec).forEach((gid) => { if (!Object.prototype.hasOwnProperty.call(groups, gid)) delete rec[gid]; });
          }
        }
        persistStore();
        notify('success', `已同步方案「${schemeName}」的条目变动`);
        showSchemePickerModal(mode);
        showSchemeDetailPopup(document.getElementById('st-bs-modal-backdrop'), mode, targetName, schemeName);
      });
    });
  }

  /* ================== 方案存取与应用 ================== */
  // 刷新全部预设方案：新条目记为关闭、已删除条目清掉，原有记录不动
  function refreshAllPresetSchemes() {
    const targetName = getPresetName();
    if (!targetName || !isPresetDataReady()) return notify('warning', '预设还在加载，请稍后再试');
    const pm = openaiMod?.promptManager;
    const order = pm?.getPromptOrderForCharacter?.(pm.activeCharacter);
    if (!Array.isArray(order) || !order.length) return notify('error', '无法读取当前预设条目');
    const ids = new Set(order.map((e) => e?.identifier).filter(Boolean));
    const groups = readGroupPower();
    const schemes = getStore().presetSchemes[targetName] || {};
    const names = Object.keys(schemes);
    if (!names.length) return notify('info', '当前预设还没有方案');

    const addedIds = new Set(), removedIds = new Set();
    names.forEach((n) => {
      const snap = schemes[n];
      ids.forEach((id) => {
        if (!Object.prototype.hasOwnProperty.call(snap, id)) { snap[id] = false; addedIds.add(id); }
      });
      Object.keys(snap).forEach((k) => {
        if (!isReservedSnapKey(k) && !ids.has(k)) { delete snap[k]; removedIds.add(k); }
      });
      snap[META_KEY] = buildEntryMeta(readPresetEntriesSync());
      // 只维护已经记录过分组供电的方案；新分组记为供电开（不影响组内条目自己的开关）
      const rec = snap[GROUP_POWER_KEY];
      if (groups && rec && typeof rec === 'object') {
        Object.keys(groups).forEach((gid) => { if (!Object.prototype.hasOwnProperty.call(rec, gid)) rec[gid] = true; });
        Object.keys(rec).forEach((gid) => { if (!Object.prototype.hasOwnProperty.call(groups, gid)) delete rec[gid]; });
      }
    });
    persistStore();
    notify('success', `已刷新 ${names.length} 个方案：新增 ${addedIds.size} 条（记为关闭），清理 ${removedIds.size} 条`);
  }

  async function saveScheme(mode, targetName, schemeName) {
    const store = getStore(), snap = {};
    if (mode === 'preset') {
      const pm = openaiMod?.promptManager;
      const order = pm?.getPromptOrderForCharacter?.(pm.activeCharacter);
      if (Array.isArray(order) && order.length) {
        order.forEach((e) => { if (e?.identifier) snap[e.identifier] = Boolean(e.enabled); });
      } else {
        document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]').forEach((li) => {
          const id = li.getAttribute('data-pm-identifier');
          const tg = li.querySelector('.prompt-manager-toggle-action, .fa-toggle-on, .fa-toggle-off');
          if (id) snap[id] = tg ? tg.classList.contains('fa-toggle-on') : !li.classList.contains('completion_prompt_manager_prompt_disabled');
        });
      }
      const gp = readGroupPower();
      if (gp) snap[GROUP_POWER_KEY] = gp;
      snap[META_KEY] = buildEntryMeta(readPresetEntriesSync());
      (store.presetSchemes[targetName] ||= {})[schemeName] = snap;
      store.activePresetScheme[targetName] = schemeName;
    } else {
      const loadWI = wiMod?.loadWorldInfo || getCtx().loadWorldInfo;
      const data = loadWI ? await loadWI(targetName) : null;
      if (data?.entries) {
        Object.entries(data.entries).forEach(([u, e]) => { snap[String(u)] = !Boolean(e.disable); });
        snap[META_KEY] = buildEntryMeta(Object.entries(data.entries).map(([u, e]) => ({
          id: String(u),
          name: String(e.comment || '').trim() || (Array.isArray(e.key) ? e.key.join(', ') : '') || `#${u}`,
          content: e.content || '',
        })));
      } else {
        document.querySelectorAll('#world_popup_entries_list .world_entry[uid]').forEach((el) => {
          const u = el.getAttribute('uid'), ks = el.querySelector('.killSwitch');
          if (u) snap[u] = ks ? ks.classList.contains('fa-toggle-on') : true;
        });
      }
      (store.worldSchemes[targetName] ||= {})[schemeName] = snap;
      store.activeWorldScheme[targetName] = schemeName;
    }
    persistStore();
    refreshSchemeButton(mode);
    notify('success', `已存入方案「${schemeName}」（共 ${countEntries(snap)} 条）`);
  }

  /* ================== 方案绑定聊天窗口（🔗 父级角色卡 -> 聊天窗口 -> 自动切换） ================== */
  const LINK_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  const normChatId = (id) => String(id ?? '').trim().replace(/\.jsonl$/i, '');
  const makeChatKey = (avatar, chatName) => `${avatar}::${normChatId(chatName)}`;

  function getChatBindings(mode) {
    const s = getRawStore();
    if (!s.chatBindings || typeof s.chatBindings !== 'object') s.chatBindings = { preset: {}, world: {} };
    if (!s.chatBindings[mode] || typeof s.chatBindings[mode] !== 'object') s.chatBindings[mode] = {};
    return s.chatBindings[mode];
  }

  function countSchemeBindings(mode, targetName, schemeName) {
    const all = getChatBindings(mode);
    return Object.values(all).filter((b) => b && b.targetName === targetName && b.schemeName === schemeName).length;
  }

  function getCurrentActiveChatInfo() {
    const ctx = getCtx();
    if (ctx.groupId) return null;
    const chid = ctx.characterId;
    const char = (chid !== undefined && chid !== null && Array.isArray(ctx.characters)) ? ctx.characters[Number(chid)] : null;
    if (!char || !char.avatar) return null;
    const chatName = normChatId(ctx.chatId || char.chat);
    if (!chatName) return null;
    return {
      charAvatar: char.avatar,
      charName: String(char.name || char.avatar).trim(),
      chatName,
      chatKey: makeChatKey(char.avatar, chatName),
    };
  }

  function createMiniAvatarEl(char) {
    const img = document.createElement('img');
    img.className = 'st-bs-bind-avatar';
    img.alt = char.name || '';
    img.loading = 'lazy';
    const file = encodeURIComponent(char.avatar || '');
    img.src = `/thumbnail?type=avatar&file=${file}`;
    img.onerror = () => {
      if (!img.dataset.fb) {
        img.dataset.fb = '1';
        img.src = `/characters/${file}`;
      } else {
        const fb = document.createElement('span');
        fb.className = 'st-bs-bind-avatar-fallback';
        fb.textContent = String(char.name || '?').trim().slice(0, 1);
        img.replaceWith(fb);
      }
    };
    return img;
  }

  async function fetchCharacterChats(avatarUrl) {
    const ctx = getCtx();
    const headers = typeof ctx.getRequestHeaders === 'function'
      ? ctx.getRequestHeaders()
      : { 'Content-Type': 'application/json' };
    const res = await fetch('/api/characters/chats', {
      method: 'POST',
      headers,
      body: JSON.stringify({ avatar_url: avatarUrl }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
    return arr
      .filter((x) => x && typeof x === 'object' && x.file_name)
      .sort((a, b) => {
        const ta = Date.parse(a.last_mes || '') || 0;
        const tb = Date.parse(b.last_mes || '') || 0;
        return tb - ta;
      });
  }

  function toggleChatBinding(mode, targetName, schemeName, info) {
    const map = getChatBindings(mode);
    const existing = map[info.chatKey];
    if (existing && existing.targetName === targetName && existing.schemeName === schemeName) {
      delete map[info.chatKey];
      persistStore();
      notify('info', `已取消绑定「${info.chatName}」`);
      return false;
    }
    const prevScheme = existing ? existing.schemeName : '';
    map[info.chatKey] = {
      targetName,
      schemeName,
      charAvatar: info.charAvatar,
      charName: info.charName,
      chatName: info.chatName,
    };
    persistStore();
    notify('success', prevScheme && prevScheme !== schemeName
      ? `已从「${prevScheme}」改绑到方案「${schemeName}」`
      : `已绑定到方案「${schemeName}」`);
    return true;
  }

  function showChatBindPopup(bd, mode, targetName, schemeName) {
    openSubPopup(bd, (box, closeSub) => {
      box.classList.add('st-bs-bind-card');
      const finish = () => {
        closeSub();
        showSchemePickerModal(mode);
      };

      /* ===== 第 1 级：父级角色卡列表（带圆形小头像） ===== */
      let charQuery = '';
      const drawChars = () => {
        const ctx = getCtx();
        const chars = Array.isArray(ctx.characters) ? ctx.characters.filter((c) => c && c.avatar) : [];
        const bindings = getChatBindings(mode);
        const curChat = getCurrentActiveChatInfo();

        const countForChar = (avatar, onlyThisScheme) => Object.values(bindings).filter((b) => {
          if (!b || b.charAvatar !== avatar) return false;
          return onlyThisScheme ? (b.targetName === targetName && b.schemeName === schemeName) : true;
        }).length;

        const isCurBound = Boolean(curChat && bindings[curChat.chatKey]
          && bindings[curChat.chatKey].targetName === targetName
          && bindings[curChat.chatKey].schemeName === schemeName);

        box.innerHTML = `
          <div class="st-bs-modal-title">绑定聊天窗口 · ${escapeHtml(schemeName)}</div>
          <div class="st-bs-modal-desc">点角色卡进入它的聊天窗口，选择后打开该窗口即自动切到此方案。</div>
          ${curChat ? `<div class="st-bs-bind-cur">
            <span class="st-bs-bind-cur-text">当前：${escapeHtml(curChat.charName)} · ${escapeHtml(curChat.chatName)}</span>
            <button type="button" class="st-bs-bind-cur-btn${isCurBound ? ' bound' : ''}" data-bind-cur>${isCurBound ? '已绑定' : '绑定当前'}</button>
          </div>` : ''}
          <div class="st-bs-search-capsule st-bs-bind-search">
            <input type="text" class="st-bs-search-input" placeholder="搜索角色卡名称…" />
          </div>
          <div class="st-bs-subpop-list" data-role="char-list"></div>
          <div class="st-bs-modal-actions">
            <button type="button" class="st-bs-btn st-bs-btn-primary" data-sub="done">完成</button>
          </div>`;

        const ul = box.querySelector('[data-role="char-list"]');
        const searchInput = box.querySelector('.st-bs-search-input');
        searchInput.value = charQuery;

        const renderCharRows = () => {
          const q = charQuery.trim().toLowerCase();
          const list = chars
            .filter((c) => !q || String(c.name || '').toLowerCase().includes(q))
            .slice()
            .sort((a, b) => {
              const ba = countForChar(a.avatar, true);
              const bb = countForChar(b.avatar, true);
              if (bb !== ba) return bb - ba;
              const ca = curChat && a.avatar === curChat.charAvatar ? 1 : 0;
              const cb = curChat && b.avatar === curChat.charAvatar ? 1 : 0;
              if (cb !== ca) return cb - ca;
              return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
            });

          ul.innerHTML = '';
          if (!list.length) {
            ul.innerHTML = '<div class="st-bs-sel-empty">没有找到角色卡。</div>';
            return;
          }
          list.forEach((c) => {
            const thisCnt = countForChar(c.avatar, true);
            const otherCnt = countForChar(c.avatar, false) - thisCnt;
            const row = document.createElement('div');
            row.className = 'st-bs-bind-char-row';
            row.appendChild(createMiniAvatarEl(c));

            const nameEl = document.createElement('span');
            nameEl.className = 'st-bs-bind-char-name';
            nameEl.textContent = c.name || c.avatar;
            row.appendChild(nameEl);

            if (thisCnt > 0) {
              const pill = document.createElement('span');
              pill.className = 'st-bs-bind-pill';
              pill.textContent = `已绑 ${thisCnt}`;
              row.appendChild(pill);
            } else if (otherCnt > 0) {
              const pill = document.createElement('span');
              pill.className = 'st-bs-bind-pill other';
              pill.textContent = `他案 ${otherCnt}`;
              row.appendChild(pill);
            }

            const arrow = document.createElement('i');
            arrow.className = 'fa-solid fa-chevron-right';
            arrow.style.cssText = 'opacity:.4;font-size:11px;flex-shrink:0;';
            row.appendChild(arrow);

            row.onclick = () => drawChats(c);
            ul.appendChild(row);
          });
        };

        searchInput.addEventListener('input', () => {
          charQuery = searchInput.value;
          renderCharRows();
        });
        box.querySelector('[data-bind-cur]')?.addEventListener('click', () => {
          if (!curChat) return;
          toggleChatBinding(mode, targetName, schemeName, curChat);
          drawChars();
        });
        box.querySelector('[data-sub="done"]').onclick = finish;
        renderCharRows();
      };

      /* ===== 第 2 级：该角色卡的聊天窗口列表 ===== */
      const drawChats = async (char) => {
        const curChat = getCurrentActiveChatInfo();
        box.innerHTML = `
          <div class="st-bs-bind-chat-header" data-role="ch-head">
            <div style="flex:1;min-width:0;">
              <div class="st-bs-modal-title" style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>
              <div class="st-bs-modal-desc" style="margin:2px 0 0;">绑定到方案「${escapeHtml(schemeName)}」</div>
            </div>
          </div>
          <div class="st-bs-subpop-list st-bs-subpop-cards" data-role="chat-list">
            <div class="st-bs-sel-empty">正在加载聊天窗口…</div>
          </div>
          <div class="st-bs-modal-actions">
            <button type="button" class="st-bs-btn" data-sub="back">返回角色卡</button>
            <button type="button" class="st-bs-btn st-bs-btn-primary" data-sub="done">完成</button>
          </div>`;

        const head = box.querySelector('[data-role="ch-head"]');
        head.insertBefore(createMiniAvatarEl(char), head.firstChild);
        head.querySelector('.st-bs-modal-title').textContent = char.name || char.avatar;
        box.querySelector('[data-sub="back"]').onclick = drawChars;
        box.querySelector('[data-sub="done"]').onclick = finish;

        const ul = box.querySelector('[data-role="chat-list"]');
        let chats = [];
        try {
          chats = await fetchCharacterChats(char.avatar);
        } catch (err) {
          console.error('[批量方案助手] 读取角色聊天列表失败:', err);
          ul.innerHTML = '<div class="st-bs-sel-empty">读取聊天窗口失败，请稍后重试。</div>';
          return;
        }

        const renderChatRows = () => {
          const bindings = getChatBindings(mode);
          ul.innerHTML = '';
          if (!chats.length) {
            ul.innerHTML = '<div class="st-bs-sel-empty">这张角色卡还没有聊天记录。</div>';
            return;
          }
          chats.forEach((ch) => {
            const chatName = normChatId(ch.file_name);
            const chatKey = makeChatKey(char.avatar, chatName);
            const b = bindings[chatKey];
            const isBoundThis = Boolean(b && b.targetName === targetName && b.schemeName === schemeName);
            const isBoundOther = Boolean(b && !isBoundThis);
            const isCurrent = Boolean(curChat && curChat.chatKey === chatKey);

            const row = document.createElement('div');
            row.className = 'st-bs-bind-chat-row' + (isBoundThis ? ' bound' : '');
            const snip = String(ch.mes || '').replace(/\s+/g, ' ').trim();
            const metaParts = [];
            if (ch.chat_items != null) metaParts.push(`${ch.chat_items} 条消息`);
            if (ch.last_mes) metaParts.push(String(ch.last_mes));

            row.innerHTML = `
              <span class="st-bs-bind-chat-check">
                <i class="fa-${isBoundThis ? 'solid fa-circle-check' : 'regular fa-circle'}" style="opacity:${isBoundThis ? 1 : 0.4};"></i>
              </span>
              <div class="st-bs-bind-chat-body">
                <div class="st-bs-bind-chat-title">
                  <span></span>
                  ${isCurrent ? '<span class="st-bs-bind-pill">当前</span>' : ''}
                  ${isBoundOther ? `<span class="st-bs-bind-pill other">已绑：${escapeHtml(b.schemeName)}</span>` : ''}
                </div>
                ${metaParts.length ? `<div class="st-bs-bind-chat-meta">${escapeHtml(metaParts.join(' · '))}</div>` : ''}
                ${snip ? `<div class="st-bs-bind-chat-snip">${escapeHtml(snip.slice(0, 80))}</div>` : ''}
              </div>`;
            row.querySelector('.st-bs-bind-chat-title span').textContent = chatName;
            row.onclick = () => {
              toggleChatBinding(mode, targetName, schemeName, {
                charAvatar: char.avatar,
                charName: String(char.name || char.avatar).trim(),
                chatName,
                chatKey,
              });
              renderChatRows();
            };
            ul.appendChild(row);
          });
        };

        renderChatRows();
      };

      drawChars();
    });
  }

  let chatBindTimer = null;
  let lastAutoChatKey = '';
  let lastAutoChatTs = 0;

  function scheduleChatBindApply(evChatId) {
    clearTimeout(chatBindTimer);
    chatBindTimer = setTimeout(async () => {
      try {
        const ctx = getCtx();
        if (ctx.groupId) return;
        const chid = ctx.characterId;
        const char = (chid !== undefined && chid !== null && Array.isArray(ctx.characters)) ? ctx.characters[Number(chid)] : null;
        if (!char || !char.avatar) return;
        const chatName = normChatId(evChatId || ctx.chatId || char.chat);
        if (!chatName) return;
        const chatKey = makeChatKey(char.avatar, chatName);
        const now = Date.now();
        if (chatKey === lastAutoChatKey && now - lastAutoChatTs < 700) return;
        lastAutoChatKey = chatKey;
        lastAutoChatTs = now;

        const pBind = getChatBindings('preset')[chatKey];
        if (pBind && pBind.schemeName) {
          if (isPresetDataReady() && getPresetName() === pBind.targetName) {
            const schemes = getStore().presetSchemes[pBind.targetName] || {};
            if (Object.prototype.hasOwnProperty.call(schemes, pBind.schemeName)) {
              await applyScheme('preset', pBind.schemeName, { targetName: pBind.targetName, prefix: '已自动切换绑定方案' });
            }
          }
        }

        const wBind = getChatBindings('world')[chatKey];
        if (wBind && wBind.schemeName && wBind.targetName) {
          const wSchemes = getStore().worldSchemes[wBind.targetName] || {};
          if (Object.prototype.hasOwnProperty.call(wSchemes, wBind.schemeName)) {
            await applyScheme('world', wBind.schemeName, { targetName: wBind.targetName, prefix: '已自动切换绑定世界书方案' });
          }
        }
      } catch (err) {
        console.error('[批量方案助手] 自动切换绑定方案异常:', err);
      }
    }, 260);
  }

  async function applyScheme(mode, schemeName, opts = {}) {
    const targetName = opts.targetName || (mode === 'preset' ? getPresetName() : getWorldName());
    if (!targetName || !schemeName) return;
    const store = getStore();
    const bucket = mode === 'preset' ? store.presetSchemes : store.worldSchemes;
    const activeMap = mode === 'preset' ? store.activePresetScheme : store.activeWorldScheme;
    const snap = bucket[targetName]?.[schemeName];
    if (!snap) return;

    let onC = 0, offC = 0, groupC = 0;
    if (mode === 'preset') {
      const sc = document.querySelector('#left-nav-panel'), prev = sc ? sc.scrollTop : 0;
      groupC = applyGroupPower(snap[GROUP_POWER_KEY]);
      const pm = openaiMod?.promptManager;
      const order = pm?.getPromptOrderForCharacter?.(pm.activeCharacter);
      if (Array.isArray(order)) {
        order.forEach((e) => {
          if (Object.prototype.hasOwnProperty.call(snap, e.identifier)) {
            e.enabled = Boolean(snap[e.identifier]);
            e.enabled ? onC++ : offC++;
          }
        });
        pm.render?.(false); pm.saveServiceSettings?.();
      } else {
        document.querySelectorAll('#completion_prompt_manager_list li[data-pm-identifier]').forEach((li) => {
          const id = li.getAttribute('data-pm-identifier');
          if (!Object.prototype.hasOwnProperty.call(snap, id)) return;
          const t = Boolean(snap[id]), tg = li.querySelector('.prompt-manager-toggle-action, .fa-toggle-on, .fa-toggle-off');
          if (tg && tg.classList.contains('fa-toggle-on') !== t) tg.click();
          t ? onC++ : offC++;
        });
      }
      if (sc) setTimeout(() => { sc.scrollTop = prev; }, 50);
      if (state.preset.bulk) setTimeout(() => injectCheckboxes('preset'), 60);
    } else {
      const loadWI = wiMod?.loadWorldInfo || getCtx().loadWorldInfo;
      const saveWI = wiMod?.saveWorldInfo || getCtx().saveWorldInfo;
      if (loadWI && saveWI) {
        const sc = document.querySelector('#WorldInfo') || document.querySelector('#world_popup');
        const prev = sc ? sc.scrollTop : 0;
        const data = await loadWI(targetName);
        if (data?.entries) {
          Object.entries(data.entries).forEach(([u, e]) => {
            if (Object.prototype.hasOwnProperty.call(snap, String(u))) {
              const t = Boolean(snap[String(u)]);
              e.disable = !t; t ? onC++ : offC++;
            }
          });
          await saveWI(targetName, data, true);
          reloadWorldUI();
          if (sc) setTimeout(() => { sc.scrollTop = prev; }, 180);
          if (state.world.bulk) setTimeout(() => injectCheckboxes('world'), 200);
        }
      }
    }
    activeMap[targetName] = schemeName;
    persistStore();
    refreshSchemeButton(mode);
    const label = opts.prefix || '已切换方案';
    notify('success', `${label}「${schemeName}」（开 ${onC} / 关 ${offC}${groupC ? `，切换分组供电 ${groupC} 个` : ''}）`);
  }

  /* ================== 批量操作 ================== */
  async function bulkToggle(mode, enable) {
    const ids = Array.from(state[mode].selected);
    if (!ids.length) return notify('warning', '请先勾选至少一个条目');
    const idSet = new Set(ids);

    if (mode === 'preset') {
      const sc = document.querySelector('#left-nav-panel'), prev = sc ? sc.scrollTop : 0;
      const pm = openaiMod?.promptManager;
      const order = pm?.getPromptOrderForCharacter?.(pm.activeCharacter);
      let c = 0;
      if (Array.isArray(order)) {
        order.forEach((e) => { if (idSet.has(e.identifier)) { e.enabled = enable; c++; } });
        pm.render?.(false); pm.saveServiceSettings?.();
      } else {
        getItems('preset').forEach((li) => {
          if (!idSet.has(getItemId('preset', li))) return;
          const tg = li.querySelector('.prompt-manager-toggle-action, .fa-toggle-on, .fa-toggle-off');
          if (tg && tg.classList.contains('fa-toggle-on') !== enable) tg.click();
          c++;
        });
      }
      if (sc) setTimeout(() => { sc.scrollTop = prev; }, 50);
      setTimeout(() => injectCheckboxes('preset'), 60);
      notify('success', `已批量${enable ? '开启' : '关闭'} ${c} 条预设条目`);
    } else {
      const book = getWorldName();
      if (!book) return notify('warning', '请先选择一个世界书');
      const loadWI = wiMod?.loadWorldInfo || getCtx().loadWorldInfo;
      const saveWI = wiMod?.saveWorldInfo || getCtx().saveWorldInfo;
      if (!loadWI || !saveWI) return notify('error', '无法访问世界书接口');
      const sc = document.querySelector('#WorldInfo') || document.querySelector('#world_popup');
      const prev = sc ? sc.scrollTop : 0;
      const data = await loadWI(book);
      if (!data?.entries) return;
      let c = 0;
      ids.forEach((u) => { if (data.entries[u]) { data.entries[u].disable = !enable; c++; } });
      await saveWI(book, data, true);
      reloadWorldUI();
      if (sc) setTimeout(() => { sc.scrollTop = prev; }, 180);
      setTimeout(() => injectCheckboxes('world'), 200);
      notify('success', `已批量${enable ? '开启' : '关闭'} ${c} 条世界书条目`);
    }
  }

  async function bulkExport(mode) {
    const ids = Array.from(state[mode].selected);
    if (!ids.length) return notify('warning', '请先勾选要导出的条目');
    const idSet = new Set(ids), stamp = new Date().toISOString().slice(0, 10);
    if (mode === 'preset') {
      const name = getPresetName();
      const prompts = (openaiMod?.oai_settings?.prompts || []).filter((p) => idSet.has(p.identifier));
      if (!prompts.length) return notify('warning', '未找到可导出的预设条目数据');
      downloadJson(`${name}-选中${prompts.length}条-${stamp}.json`, { source_preset: name, prompts });
      notify('success', `已导出 ${prompts.length} 条预设条目`);
    } else {
      const book = getWorldName();
      if (!book) return notify('warning', '请先选择一个世界书');
      const loadWI = wiMod?.loadWorldInfo || getCtx().loadWorldInfo;
      const data = loadWI ? await loadWI(book) : null;
      const entries = {}; let c = 0;
      ids.forEach((u) => { if (data?.entries?.[u]) { entries[u] = data.entries[u]; c++; } });
      if (!c) return notify('warning', '未找到可导出的世界书条目');
      downloadJson(`${book}-选中${c}条-${stamp}.json`, { entries });
      notify('success', `已导出 ${c} 条世界书条目`);
    }
  }

  async function bulkDelete(mode) {
    const ids = Array.from(state[mode].selected);
    if (!ids.length) return notify('warning', '请先勾选要删除的条目');
    if (!(await showConfirm({ title: '确认批量删除', desc: `确定删除选中的 ${ids.length} 条${mode === 'preset' ? '预设' : '世界书'}条目吗？删除后不可恢复。`, okText: '确认删除', danger: true }))) return;

    if (mode === 'preset') {
      const settings = openaiMod?.oai_settings, pm = openaiMod?.promptManager;
      if (!Array.isArray(settings?.prompts)) return notify('error', '无法访问预设数据');
      const sc = document.querySelector('#left-nav-panel'), prev = sc ? sc.scrollTop : 0;
      const idSet = new Set(ids), del = new Set(); let skipped = 0;
      settings.prompts.forEach((p) => {
        if (!idSet.has(p.identifier)) return;
        if (p.system_prompt || p.marker || PROTECTED_PROMPT_IDS.has(p.identifier)) skipped++; else del.add(p.identifier);
      });
      if (!del.size) return notify('warning', '勾选的都是系统内置保护条目，无法删除');
      settings.prompts = settings.prompts.filter((p) => !del.has(p.identifier));
      if (Array.isArray(settings.prompt_order)) {
        settings.prompt_order.forEach((po) => { if (Array.isArray(po.order)) po.order = po.order.filter((o) => !del.has(o.identifier)); });
      }
      del.forEach((id) => state.preset.selected.delete(id));
      pm?.render?.(false); pm?.saveServiceSettings?.();
      if (sc) setTimeout(() => { sc.scrollTop = prev; }, 50);
      setTimeout(() => { injectCheckboxes('preset'); updateDockUI(); }, 60);
      notify('success', `已删除 ${del.size} 条预设条目${skipped ? `（跳过 ${skipped} 条系统条目）` : ''}`);
    } else {
      const book = getWorldName();
      if (!book) return notify('warning', '请先选择一个世界书');
      const loadWI = wiMod?.loadWorldInfo || getCtx().loadWorldInfo;
      const saveWI = wiMod?.saveWorldInfo || getCtx().saveWorldInfo;
      if (!loadWI || !saveWI) return notify('error', '无法访问世界书接口');
      const sc = document.querySelector('#WorldInfo') || document.querySelector('#world_popup');
      const prev = sc ? sc.scrollTop : 0;
      const data = await loadWI(book);
      if (!data?.entries) return;
      let c = 0;
      ids.forEach((u) => { if (data.entries[u]) { delete data.entries[u]; state.world.selected.delete(u); c++; } });
      await saveWI(book, data, true);
      reloadWorldUI();
      if (sc) setTimeout(() => { sc.scrollTop = prev; }, 180);
      setTimeout(() => { injectCheckboxes('world'); updateDockUI(); }, 200);
      notify('success', `已删除 ${c} 条世界书条目`);
    }
  }

  /* ================== ↕️ 区间连选 ================== */
  function fillRange(mode) {
    const items = getItems(mode), sel = state[mode].selected;
    let first = -1, last = -1;
    items.forEach((el, i) => {
      if (sel.has(getItemId(mode, el))) { if (first === -1) first = i; last = i; }
    });
    if (first === -1 || first === last) return 0;
    let total = 0;
    for (let i = first; i <= last; i++) {
      const id = getItemId(mode, items[i]);
      if (id) { sel.add(id); total++; }
    }
    syncCheckboxes(mode); updateDockUI();
    return total;
  }

  function onRangeBtn() {
    const mode = state.activeDockMode;
    if (!mode) return;
    const st = state[mode];
    if (!st.rangeMode && st.selected.size >= 2) {
      const c = fillRange(mode);
      if (c > 0) return notify('success', `已连选首尾之间共 ${c} 条`);
    }
    st.rangeMode = !st.rangeMode;
    st.rangeAnchor = st.rangeMode && st.selected.size === 1 ? Array.from(st.selected)[0] : null;
    notify('info', st.rangeMode ? (st.rangeAnchor ? '区间连选：请再勾选另一端条目' : '区间连选：请依次勾选第一条和最后一条') : '已关闭区间连选');
    updateDockUI();
  }

  /* ================== 勾选框注入 ================== */
  function syncCheckboxes(mode) {
    const sel = state[mode].selected;
    getItems(mode).forEach((el) => {
      const on = sel.has(getItemId(mode, el));
      const cb = el.querySelector('.st-bs-cb');
      if (cb) cb.checked = on;
      el.classList.toggle('st-bs-item-checked', on);
    });
  }

  function injectCheckboxes(mode) {
    const list = document.querySelector(mode === 'preset' ? '#completion_prompt_manager_list' : '#world_popup_entries_list');
    if (!list) return;
    const active = state[mode].bulk;
    list.classList.toggle('st-bs-bulk-active', active);
    if (!active) {
      list.querySelectorAll('.st-bs-cb-wrap').forEach((n) => n.remove());
      list.querySelectorAll('.st-bs-item-checked').forEach((n) => n.classList.remove('st-bs-item-checked'));
      return;
    }
    const sel = state[mode].selected;
    getItems(mode).forEach((el) => {
      const id = getItemId(mode, el);
      if (!id) return;
      const target = mode === 'preset' ? (el.querySelector('.completion_prompt_manager_prompt_name') || el) : (el.querySelector('.inline-drawer-header') || el);
      let wrap = target.querySelector('.st-bs-cb-wrap');
      if (!wrap) {
        wrap = document.createElement('label');
        wrap.className = 'st-bs-cb-wrap';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.className = 'st-bs-cb';
        wrap.appendChild(cb);
        wrap.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', (e) => {
          e.stopPropagation();
          const st = state[mode];
          if (cb.checked) {
            st.selected.add(id);
            if (st.rangeMode) {
              if (!st.rangeAnchor) { st.rangeAnchor = id; notify('info', '已选起点，请再勾选最后一条'); }
              else if (st.rangeAnchor !== id) {
                const c = fillRange(mode);
                st.rangeMode = false; st.rangeAnchor = null;
                notify('success', `已自动连选中间共 ${c} 条`);
              }
            }
          } else {
            st.selected.delete(id);
            if (st.rangeAnchor === id) st.rangeAnchor = null;
          }
          el.classList.toggle('st-bs-item-checked', cb.checked);
          updateDockUI();
        });
        target.insertBefore(wrap, target.firstChild);
      }
      const cb = wrap.querySelector('.st-bs-cb'), on = sel.has(id);
      if (cb) cb.checked = on;
      el.classList.toggle('st-bs-item-checked', on);
    });
  }

  /* ================== 左侧居中悬浮条（挂载在 html 根节点） ================== */
  function ensureDock() {
    let dock = document.getElementById('st-bs-floating-dock');
    if (dock) return dock;
    dock = document.createElement('div');
    dock.id = 'st-bs-floating-dock';
    dock.innerHTML = `
      <button type="button" class="st-bs-dock-circle" data-act="all" title="全选/清空">
        <span class="st-bs-dock-count">0</span><span class="st-bs-dock-sub">全选</span>
      </button>
      <div class="st-bs-capsule" title="批量开/关">
        <button type="button" class="st-bs-capsule-half st-bs-capsule-on" data-act="on">开</button>
        <button type="button" class="st-bs-capsule-half st-bs-capsule-off" data-act="off">关</button>
      </div>
      <button type="button" class="st-bs-dock-circle st-bs-dock-range" data-act="range" title="区间连选"><i class="fa-solid fa-arrows-up-down"></i></button>
      <button type="button" class="st-bs-dock-circle" data-act="scheme" title="存为方案"><i class="fa-solid fa-bookmark"></i></button>
      <button type="button" class="st-bs-dock-circle st-bs-dock-archive" data-act="archive" title="存底到记录表"><i class="fa-solid fa-box-archive"></i></button>
      <button type="button" class="st-bs-dock-circle" data-act="export" title="导出"><i class="fa-solid fa-file-export"></i></button>
      <button type="button" class="st-bs-dock-circle st-bs-dock-danger" data-act="del" title="删除"><i class="fa-solid fa-trash-can"></i></button>
      <button type="button" class="st-bs-dock-circle" data-act="fold" title="收起成小球"><i class="fa-solid fa-chevron-left"></i></button>
      <button type="button" class="st-bs-dock-circle st-bs-dock-ball" data-act="unfold" title="展开"><span class="st-bs-dock-ball-count">0</span></button>
      <button type="button" class="st-bs-dock-circle st-bs-dock-close" data-act="exit" title="退出"><i class="fa-solid fa-xmark"></i></button>`;

    stopDrawerClose(dock);

    dock.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || !state.activeDockMode) return;
      const mode = state.activeDockMode, act = btn.getAttribute('data-act');
      if (act === 'all') {
        const items = getItems(mode), sel = state[mode].selected;
        if (sel.size > 0 && sel.size >= items.length) sel.clear();
        else items.forEach((el) => { const id = getItemId(mode, el); if (id) sel.add(id); });
        syncCheckboxes(mode); updateDockUI();
      } else if (act === 'on') bulkToggle(mode, true);
      else if (act === 'off') bulkToggle(mode, false);
      else if (act === 'range') onRangeBtn();
      else if (act === 'scheme') showSaveSchemeModal(mode, false);
      else if (act === 'archive') { if (mode === 'preset') archiveSelected(); }
      else if (act === 'export') bulkExport(mode);
      else if (act === 'del') bulkDelete(mode);
      else if (act === 'exit') setBulkMode(mode, false);
      else if (act === 'fold') { state.dockFolded = true; updateDockUI(); }
      else if (act === 'unfold') { state.dockFolded = false; updateDockUI(); }
    });

    document.documentElement.appendChild(dock);
    return dock;
  }

  function updateDockUI() {
    const dock = ensureDock();
    const pOpen = isDrawerListOpen('preset');
    const wOpen = isDrawerListOpen('world');
    const activeMode = (state.preset.bulk && pOpen) ? 'preset' : ((state.world.bulk && wOpen) ? 'world' : null);
    state.activeDockMode = activeMode;
    dock.classList.toggle('visible', Boolean(activeMode));
    if (!activeMode) return;

    dock.style.top = `${Math.round(window.innerHeight / 2)}px`;
    const st = state[activeMode], total = st.total ?? getItems(activeMode).length;
    dock.querySelector('.st-bs-dock-count').textContent = String(st.selected.size);
    dock.querySelector('.st-bs-dock-sub').textContent = (total > 0 && st.selected.size >= total) ? '清空' : '全选';
    dock.querySelector('.st-bs-dock-range').classList.toggle('active', st.rangeMode);
    dock.querySelector('.st-bs-dock-archive').style.display = activeMode === 'preset' ? '' : 'none';
    dock.classList.toggle('folded', state.dockFolded);
    dock.querySelector('.st-bs-dock-ball-count').textContent = String(st.selected.size);
  }

  /* ================== 右侧「折叠当前分组」按钮（配合 BaiBai-Tools 预设分组） ================== */
  function findOpenPresetGroup() {
    const root = document.querySelector('#completion_prompt_manager');
    if (!root) return null;
    const vh = window.innerHeight, mid = vh / 2;
    let best = null, bestVis = 0;
    root.querySelectorAll('.bai-bai-preset-group:not(.bai-bai-preset-group-collapsed)').forEach((g) => {
      const r = g.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const vis = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (vis <= 0) return;
      if (r.top <= mid && r.bottom >= mid) { best = g; bestVis = Infinity; return; }
      if (vis > bestVis) { best = g; bestVis = vis; }
    });
    return best;
  }

  function ensureCollapseBtn() {
    let btn = document.getElementById('st-bs-collapse-group-btn');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'st-bs-collapse-group-btn';
    btn.title = '折叠当前分组';
    btn.innerHTML = '<i class="fa-solid fa-angles-up"></i>';
    stopDrawerClose(btn);
    btn.addEventListener('click', () => {
      const g = findOpenPresetGroup();
      const header = g?.querySelector(':scope > .bai-bai-preset-group-header');
      const tg = header?.querySelector('.bai-bai-preset-group-toggle');
      if (!tg) return;
      header.scrollIntoView({ block: 'nearest' });
      tg.click();
      setTimeout(updateCollapseBtn, 400);
    });
    document.documentElement.appendChild(btn);
    return btn;
  }

  function updateCollapseBtn() {
    const btn = ensureCollapseBtn();
    const show = isDrawerListOpen('preset') && Boolean(findOpenPresetGroup());
    btn.classList.toggle('visible', show);
    if (show) btn.style.top = `${Math.round(window.innerHeight / 2)}px`;
  }

  function setBulkMode(mode, on) {
    state[mode].bulk = on;
    if (!on) { state[mode].selected.clear(); state[mode].rangeMode = false; state[mode].rangeAnchor = null; state.dockFolded = false; }
    document.querySelector(`.st-bs-bulk-toggle[data-mode="${mode}"]`)?.classList.toggle('active', on);
    injectCheckboxes(mode);
    updateDockUI();
    updateCollapseBtn();
  }

  /* ================== 顶部方案栏（自定义点击按钮，100% 灵敏） ================== */
  function refreshSchemeButton(mode) {
    const btnText = document.querySelector(`.st-bs-scheme-trigger[data-mode="${mode}"] .st-bs-scheme-trigger-text`);
    if (!btnText) return;
    const target = mode === 'preset' ? getPresetName() : getWorldName();
    const store = getStore();
    const bucket = mode === 'preset' ? store.presetSchemes : store.worldSchemes;
    const activeMap = mode === 'preset' ? store.activePresetScheme : store.activeWorldScheme;
    const names = target && bucket[target] ? Object.keys(bucket[target]) : [];
    const cur = target ? activeMap[target] : '';

    const text = (cur && names.includes(cur)) ? `方案：${cur}`
      : (names.length > 0 ? `切换方案（${names.length}）` : '方案：暂无');
    if (btnText.textContent !== text) btnText.textContent = text;
  }

  function createBar(mode) {
    const bar = document.createElement('div');
    bar.className = 'st-bs-bar'; bar.setAttribute('data-bs-bar', mode);
    bar.innerHTML = `
      <div class="st-bs-bar-group">
        <button type="button" class="st-bs-scheme-trigger" data-mode="${mode}" data-bar-act="pick">
          <span class="st-bs-scheme-trigger-text">方案：暂无</span>
          <i class="fa-solid fa-chevron-down" style="font-size:11px;opacity:0.7;"></i>
        </button>
        <button type="button" class="st-bs-mini-btn" data-bar-act="save" title="存为方案"><i class="fa-solid fa-bookmark"></i></button>
        ${mode === 'preset' ? '<button type="button" class="st-bs-mini-btn" data-bar-act="records" title="记录表 / 从旧预设融合"><i class="fa-solid fa-box-archive"></i></button>' : ''}
      </div>
      <button type="button" class="st-bs-mini-btn st-bs-bulk-toggle" data-mode="${mode}" data-bar-act="bulk">
        <i class="fa-solid fa-list-check"></i><span>批量编辑</span>
      </button>`;

    bar.querySelector('[data-bar-act="pick"]').addEventListener('click', (e) => {
      e.stopPropagation();
      showSchemePickerModal(mode);
    });
    bar.querySelector('[data-bar-act="save"]').addEventListener('click', (e) => {
      e.stopPropagation();
      showSaveSchemeModal(mode, false);
    });
    bar.querySelector('[data-bar-act="records"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      showRecordsModal();
    });
    bar.querySelector('[data-bar-act="bulk"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (mode === 'world' && !getWorldName()) return notify('warning', '请先在上方选择一本世界书');
      setBulkMode(mode, !state[mode].bulk);
    });
    bar.querySelector('.st-bs-bulk-toggle').classList.toggle('active', state[mode].bulk);
    return bar;
  }

  function mountBars() {
    const pList = document.querySelector('#completion_prompt_manager_list');
    if (pList?.parentElement && !document.querySelector('.st-bs-bar[data-bs-bar="preset"]')) {
      pList.parentElement.insertBefore(createBar('preset'), pList);
      refreshSchemeButton('preset');
    }
    const wList = document.querySelector('#world_popup_entries_list');
    if (wList?.parentElement && !document.querySelector('.st-bs-bar[data-bs-bar="world"]')) {
      wList.parentElement.insertBefore(createBar('world'), wList);
      refreshSchemeButton('world');
    }
  }

  /* ================== 记录表（存底 / 新增·自动）、➕ 插入、从旧预设融合 ================== */
  const RAINBOW = ' 🌈';
  const RECORDS_FILE_TYPE = 'st-bulk-scheme-helper-records';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* MERGE-CORE-START —— 纯数据逻辑，不碰页面，方便单独测试 */
  const normName = (n) => String(n ?? '').trim();
  const stripRainbow = (n) => normName(n).replace(/\s*🌈$/u, '').trim();
  const isRainbowName = (n) => /🌈$/u.test(normName(n));

  // 邻居：名字（去掉 🌈）+ 它是第几个同名条目 + 原来是不是 🌈 副本
  function neighborAt(order, byId, idx) {
    if (idx < 0 || idx >= order.length) return null;
    const p = byId.get(order[idx].identifier);
    if (!p) return null;
    const raw = normName(p.name);
    let occ = 0;
    for (let i = 0; i <= idx; i++) if (normName(byId.get(order[i].identifier)?.name) === raw) occ++;
    return { name: stripRainbow(raw), occ, rainbow: isRainbowName(raw) };
  }

  // 旧条目ID -> 新条目ID：① 同一个ID ② 「名字 + 第几个同名」 ③ 内容完全相同且唯一
  function matchEntries(oldOrder, oldById, newOrder, newById) {
    const map = new Map(), usedNew = new Set();
    oldOrder.forEach((o) => {
      if (oldById.has(o.identifier) && newById.has(o.identifier) && newOrder.some((x) => x.identifier === o.identifier)) {
        map.set(o.identifier, o.identifier); usedNew.add(o.identifier);
      }
    });
    const keyed = (order, byId) => {
      const cnt = new Map(), out = new Map();
      order.forEach((o) => {
        const p = byId.get(o.identifier); if (!p) return;
        const n = normName(p.name), c = (cnt.get(n) || 0) + 1;
        cnt.set(n, c); out.set(o.identifier, `${n}\u0000${c}`);
      });
      return out;
    };
    const oldKeys = keyed(oldOrder, oldById), newKeyToId = new Map();
    keyed(newOrder, newById).forEach((k, id) => newKeyToId.set(k, id));
    oldOrder.forEach((o) => {
      if (map.has(o.identifier)) return;
      const nid = newKeyToId.get(oldKeys.get(o.identifier));
      if (nid && !usedNew.has(nid)) { map.set(o.identifier, nid); usedNew.add(nid); }
    });
    const byContent = new Map();
    newOrder.forEach((o) => {
      if (usedNew.has(o.identifier)) return;
      const c = newById.get(o.identifier)?.content;
      if (!c) return;
      byContent.set(c, byContent.has(c) ? null : o.identifier); // 出现两次就作废（不唯一）
    });
    oldOrder.forEach((o) => {
      if (map.has(o.identifier)) return;
      const nid = byContent.get(oldById.get(o.identifier)?.content || '');
      if (nid && !usedNew.has(nid)) { map.set(o.identifier, nid); usedNew.add(nid); }
    });
    return map;
  }

  function buildMergePlan({ oldPrompts, oldOrder, oldExt, newPrompts, newOrder, newExt, records, insertedIds, merged }) {
    const GPK = '__baibaiGroupPower__';
    const inserted = new Set(insertedIds || []);
    const oldById = new Map(oldPrompts.map((p) => [p.identifier, p]));
    const newById = new Map(newPrompts.map((p) => [p.identifier, p]));
    const authorOrder = newOrder.filter((o) => !inserted.has(o.identifier)); // 新版里作者的条目（不含我们插入过的）
    const map = matchEntries(oldOrder, oldById, authorOrder, newById);
    const newToOld = new Map(Array.from(map, ([o, n]) => [n, o]));
    const oldEnabled = new Map(oldOrder.map((o) => [o.identifier, o.enabled !== false]));
    const oldIndex = new Map(oldOrder.map((o, i) => [o.identifier, i]));
    const oldIdByName = new Map();
    oldOrder.forEach((o) => { const n = stripRainbow(oldById.get(o.identifier)?.name); if (n && !oldIdByName.has(n)) oldIdByName.set(n, o.identifier); });
    const authorIdByName = new Map();
    authorOrder.forEach((o) => { const n = normName(newById.get(o.identifier)?.name); if (n && !authorIdByName.has(n)) authorIdByName.set(n, o.identifier); });
    const newIdSet = new Set(newOrder.map((o) => o.identifier));
    const existingRainbow = new Map();
    newOrder.forEach((o) => { const p = newById.get(o.identifier); if (p && isRainbowName(p.name)) existingRainbow.set(stripRainbow(p.name), o.identifier); });

    // 1. 开关：作者条目里对上的照搬旧版，作者新加的一律关；我们插入过的不动
    const toggles = new Map();
    authorOrder.forEach((o) => {
      const oid = newToOld.get(o.identifier);
      toggles.set(o.identifier, oid ? Boolean(oldEnabled.get(oid)) : false);
    });

    // 2. 记录：已融合过的跳过；新版有同名 -> 🌈 副本；没有 -> 孤儿（按邻居自动找位置）
    const rainbow = [], orphans = [], sameAsNew = [], skipped = [];
    (records || []).forEach((r) => {
      if (!r?.name || !r.prompt) return;
      const mid = merged?.[r.name];
      if ((mid && newIdSet.has(mid)) || existingRainbow.has(r.name)) { skipped.push(r.name); return; }
      const oid = (r.srcId && oldById.has(r.srcId)) ? r.srcId : oldIdByName.get(r.name) || null;
      const mine = oid ? Boolean(oldEnabled.get(oid)) : r.enabled !== false;
      const target = authorIdByName.get(r.name);
      if (target) {
        if ((newById.get(target)?.content || '') === (r.prompt.content || '')) { sameAsNew.push(r.name); toggles.set(target, mine); return; }
        toggles.set(target, false);
        rainbow.push({ targetId: target, record: r, enabled: mine, oldId: oid });
        return;
      }
      const idx = oid ? oldIndex.get(oid) : -1;
      const prev = r.prev || (idx >= 0 ? neighborAt(oldOrder, oldById, idx - 1) : (r.prevName ? { name: r.prevName, occ: 1 } : null));
      const next = r.next || (idx >= 0 ? neighborAt(oldOrder, oldById, idx + 1) : null);
      orphans.push({ record: r, enabled: mine, oldId: oid, prev, next, sortKey: idx >= 0 ? idx : Number.MAX_SAFE_INTEGER });
    });
    orphans.sort((a, b) => a.sortKey - b.sortKey);

    // 3. 你开着、但新版对不上的作者条目（记录里的、🌈 副本不算）
    const recNames = new Set((records || []).map((r) => r?.name));
    const lostOn = oldOrder
      .filter((o) => o.enabled !== false && !map.has(o.identifier))
      .map((o) => normName(oldById.get(o.identifier)?.name))
      .filter((n) => n && !recNames.has(stripRainbow(n)) && !isRainbowName(n));

    // 4. 分组：ID 不变就用 ID，否则按分组名
    const oldGroups = oldExt?.baibaiToolkit?.presetPromptGroups?.groups || [];
    const newGroups = newExt?.baibaiToolkit?.presetPromptGroups?.groups || [];
    const groupMap = new Map();
    oldGroups.forEach((g) => {
      const same = newGroups.find((x) => x.id === g.id) || newGroups.find((x) => normName(x.name) === normName(g.name));
      if (same) groupMap.set(g.id, same.id);
    });
    const groupPower = {};
    oldGroups.forEach((g) => { if (groupMap.has(g.id)) groupPower[groupMap.get(g.id)] = g.enabled !== false; });

    // 5. 方案：作者条目的 ID 换成新版的；我们插入过的保留当前值；新插入的等插入后再补
    const oldSchemes = oldExt?.stBulkSchemeHelper?.schemes || {};
    const curSchemes = newExt?.stBulkSchemeHelper?.schemes || {};
    const schemes = {};
    Object.entries(oldSchemes).forEach(([sname, snap]) => {
      const ns = {};
      newOrder.forEach((o) => {
        if (inserted.has(o.identifier)) { ns[o.identifier] = hasOwn(curSchemes[sname], o.identifier) ? Boolean(curSchemes[sname][o.identifier]) : false; return; }
        const oid = newToOld.get(o.identifier);
        ns[o.identifier] = oid && hasOwn(snap, oid) ? Boolean(snap[oid]) : false;
      });
      rainbow.forEach((it) => { ns[it.targetId] = false; });
      if (snap[GPK] && typeof snap[GPK] === 'object') {
        const gp = {};
        Object.entries(snap[GPK]).forEach(([gid, on]) => { if (groupMap.has(gid)) gp[groupMap.get(gid)] = Boolean(on); });
        ns[GPK] = gp;
      }
      schemes[sname] = ns;
    });
    const schemeStatesOf = (oldId) => {
      const st = {};
      Object.entries(oldSchemes).forEach(([sname, snap]) => { st[sname] = oldId && hasOwn(snap, oldId) ? Boolean(snap[oldId]) : false; });
      return st;
    };

    // 6. 正则：只搬启用/停用
    const regexDisabled = new Map();
    const oldRx = Array.isArray(oldExt?.regex_scripts) ? oldExt.regex_scripts : [];
    const newRx = Array.isArray(newExt?.regex_scripts) ? newExt.regex_scripts : [];
    newRx.forEach((r) => {
      const o = oldRx.find((x) => x.id && x.id === r.id) || oldRx.find((x) => x.scriptName === r.scriptName);
      if (o && Boolean(o.disabled) !== Boolean(r.disabled)) regexDisabled.set(r.id || r.scriptName, Boolean(o.disabled));
    });

    return { map, toggles, rainbow, orphans, sameAsNew, skipped, lostOn, groupPower, schemes, schemeStatesOf, regexDisabled,
      existingRainbow, stats: { matched: map.size, authorNew: authorOrder.filter((o) => !newToOld.has(o.identifier)).length } };
  }

  // 给孤儿找座位：上一条优先放它下面，否则放下一条上面；邻居若是还没放好的孤儿就先等下一轮
  // ctx: { placed: Map(记录名->新ID), rainbowOf: Map(名字->🌈副本ID), pending: Set(记录名), authorId(name, occ) }
  function resolveAnchor(nb, dir, ctx) {
    if (!nb?.name) return null;
    if (ctx.placed.has(nb.name)) return ctx.placed.get(nb.name);
    if (dir === 'prev' && ctx.rainbowOf.has(nb.name)) return ctx.rainbowOf.get(nb.name);
    if (ctx.pending.has(nb.name)) return null;
    return ctx.authorId(nb.name, nb.occ || 1);
  }

  /* MERGE-CORE-END */

  /* ---------- 记录表存取 ---------- */
  function getRecords() {
    const s = getRawStore();
    if (!s.records || typeof s.records !== 'object') s.records = {};
    return s.records;
  }

  function saveRecords() {
    const fn = getCtx().saveSettingsDebounced || window.saveSettingsDebounced;
    if (typeof fn === 'function') fn();
  }

  function getOrderedRecordNames() {
    const s = getRawStore(), all = getRecords();
    const saved = Array.isArray(s.recordOrder) ? s.recordOrder.filter((n) => hasOwn(all, n)) : [];
    const seen = new Set(saved);
    const extras = Object.values(all)
      .filter((r) => r?.name && !seen.has(r.name))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .map((r) => r.name);
    return [...extras, ...saved];
  }

  function getOrderedRecords() {
    const all = getRecords();
    return getOrderedRecordNames().map((n) => all[n]).filter(Boolean);
  }

  function setRecordOrder(names) {
    const s = getRawStore(), all = getRecords();
    s.recordOrder = Array.from(new Set((names || []).filter((n) => hasOwn(all, n))));
    saveRecords();
  }

  const getPM = () => openaiMod?.promptManager;
  const getPresetOrder = () => { const pm = getPM(); return pm?.getPromptOrderForCharacter?.(pm.activeCharacter); };
  const getHelperExt = () => {
    const s = openaiMod?.oai_settings;
    if (!s) return null;
    s.extensions ||= {};
    s.extensions.stBulkSchemeHelper ||= {};
    return s.extensions.stBulkSchemeHelper;
  };

  function getGroupNameOf(promptId) {
    const g = openaiMod?.oai_settings?.extensions?.baibaiToolkit?.presetPromptGroups;
    const gid = g?.prompts?.[promptId]?.groupId;
    return gid ? (g.groups || []).find((x) => x.id === gid)?.name || '' : '';
  }

  function makeRecord(p, kind, order) {
    const pm = getPM();
    const byId = new Map((pm?.serviceSettings?.prompts || []).map((x) => [x.identifier, x]));
    const idx = order.findIndex((o) => o.identifier === p.identifier);
    const prompt = structuredClone(p);
    delete prompt.identifier;
    const prev = idx >= 0 ? neighborAt(order, byId, idx - 1) : null;
    const next = idx >= 0 ? neighborAt(order, byId, idx + 1) : null;
    return {
      name: stripRainbow(p.name),
      prompt,
      enabled: idx >= 0 ? order[idx].enabled !== false : true,
      kind,
      sourcePreset: getPresetName(),
      srcId: p.identifier,
      prev, next,
      prevName: prev?.name || '',
      groupName: getGroupNameOf(p.identifier),
      savedAt: Date.now(),
    };
  }

  const isRecordable = (p) => p && !p.marker && !PROTECTED_PROMPT_IDS.has(p.identifier);

  // 悬浮条「存底」：勾选的条目写进记录表，同名覆盖
  function archiveSelected() {
    const ids = Array.from(state.preset.selected);
    if (!ids.length) return notify('warning', '请先勾选要存底的条目');
    const pm = getPM(), order = getPresetOrder();
    if (!pm || !Array.isArray(order)) return notify('error', '无法读取当前预设条目');
    const records = getRecords();
    let saved = 0, overwritten = 0, skipped = 0;
    ids.forEach((id) => {
      const p = pm.getPromptById?.(id);
      if (!isRecordable(p)) { skipped++; return; }
      const rec = makeRecord(p, 'manual', order);
      if (hasOwn(records, rec.name)) overwritten++;
      records[rec.name] = rec; saved++;
    });
    saveRecords();
    notify('success', `已存底 ${saved} 条${overwritten ? `（其中覆盖 ${overwritten} 条）` : ''}${skipped ? `，跳过 ${skipped} 条出厂条目` : ''}`);
  }

  // 记录对应的条目是否已经在当前预设里（名字去掉 🌈 后相同，且内容完全一样）
  function recordExistsInCurrent(rec) {
    const prompts = getPM()?.serviceSettings?.prompts || openaiMod?.oai_settings?.prompts || [];
    const content = rec.prompt?.content || '';
    return prompts.some((p) => stripRainbow(p.name) === rec.name && (p.content || '') === content);
  }

  /* ---------- 导出 / 导入记录表（含自定义排序） ---------- */
  function exportRecords(names) {
    const all = getRecords();
    const ordered = typeof getOrderedRecordNames === 'function' ? getOrderedRecordNames() : Object.keys(all);
    const pick = names?.length ? ordered.filter((n) => names.includes(n)) : ordered;
    if (!pick.length) return notify('info', '记录表是空的');
    const records = {};
    pick.forEach((n) => { records[n] = all[n]; });
    const recordSchemes = {};
    Object.entries(getRecordSchemes()).forEach(([sn, members]) => {
      const kept = pick.filter((m) => (members || []).includes(m));
      if (kept.length) recordSchemes[sn] = kept;
    });
    downloadJson(`开关方案助手-记录表-${pick.length}条-${new Date().toISOString().slice(0, 10)}.json`, {
      type: RECORDS_FILE_TYPE,
      version: 1,
      records,
      recordSchemes,
      recordOrder: pick,
    });
    notify('success', `已导出 ${pick.length} 条记录${names?.length ? '（已选）' : '（全部）'}`);
  }

  function importRecords(onDone) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data?.type !== RECORDS_FILE_TYPE || typeof data.records !== 'object') throw new Error('not a record file');
        const records = getRecords();
        let added = 0, overwritten = 0;
        Object.values(data.records).forEach((r) => {
          if (!r?.name || !r.prompt) return;
          if (hasOwn(records, r.name)) overwritten++; else added++;
          records[r.name] = r;
        });
        const incomingOrder = (Array.isArray(data.recordOrder) ? data.recordOrder : Object.keys(data.records))
          .filter((n) => hasOwn(records, n));
        if (incomingOrder.length) {
          const inSet = new Set(incomingOrder);
          const rest = (typeof getOrderedRecordNames === 'function' ? getOrderedRecordNames() : Object.keys(records))
            .filter((n) => !inSet.has(n));
          getRawStore().recordOrder = [...incomingOrder, ...rest];
        }
        let schemeN = 0;
        if (data.recordSchemes && typeof data.recordSchemes === 'object') {
          const rs = getRecordSchemes();
          Object.entries(data.recordSchemes).forEach(([sn, members]) => { if (Array.isArray(members)) { rs[sn] = members; schemeN++; } });
        }
        saveRecords();
        notify('success', `已导入记录表：新增 ${added} 条，覆盖 ${overwritten} 条${schemeN ? `，记录方案 ${schemeN} 个` : ''}`);
        onDone?.();
      } catch (_) {
        notify('error', '这不是记录表文件');
      }
    };
    document.body.appendChild(input);
    input.click();
  }

  /* ---------- 插入条目（借用 BaiBai 的「复制条目」，保证分组跟着目标条目） ---------- */
  const rowSelector = (id) => `#completion_prompt_manager_list li.completion_prompt_manager_prompt[data-pm-identifier="${CSS.escape(id)}"]:not(.bai-bai-preset-favorite-prompt)`;
  const groupSelector = (gid) => `#completion_prompt_manager_list li.bai-bai-preset-group[data-preset-group-id="${CSS.escape(gid)}"]`;
  const expandedByUs = new Set();

  // 目标条目所在分组若是折叠的（BaiBai 会把折叠分组的内容从页面移除），临时展开，操作完再统一收回
  async function ensureRowInDom(id) {
    if (document.querySelector(rowSelector(id))) return;
    const gid = openaiMod?.oai_settings?.extensions?.baibaiToolkit?.presetPromptGroups?.prompts?.[id]?.groupId;
    const g = gid ? document.querySelector(groupSelector(gid)) : null;
    if (!g || !g.classList.contains('bai-bai-preset-group-collapsed')) return;
    g.querySelector(':scope > .bai-bai-preset-group-header .bai-bai-preset-group-toggle')?.click();
    expandedByUs.add(gid);
    for (let i = 0; i < 30 && !document.querySelector(rowSelector(id)); i++) await sleep(50);
  }

  function collapseExpandedByUs() {
    expandedByUs.forEach((gid) => {
      const g = document.querySelector(groupSelector(gid));
      if (g && !g.classList.contains('bai-bai-preset-group-collapsed')) g.querySelector(':scope > .bai-bai-preset-group-header .bai-bai-preset-group-toggle')?.click();
    });
    expandedByUs.clear();
  }

  const newUuid = () => (crypto?.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }));

  // 在 targetId 正下方按顺序插入若干条，返回新条目 ID（与 items 一一对应）
  async function insertBelow(targetId, items, { keepExpanded = false } = {}) {
    state.inserting = true;
    try { return await insertBelowInner(targetId, items); } finally {
      state.inserting = false;
      if (!keepExpanded) collapseExpandedByUs();
    }
  }

  async function insertBelowInner(targetId, items) {
    const pm = getPM(), order = getPresetOrder();
    if (!pm || !Array.isArray(order) || !items.length) return [];
    await ensureRowInDom(targetId);
    const origIds = new Set(order.map((o) => o.identifier));
    const copyBtn = () => document.querySelector(rowSelector(targetId))?.querySelector('[data-preset-prompt-action="copy"]');

    if (copyBtn()) {
      // BaiBai 的复制会把副本放在目标正下方、同一分组
      for (let i = 0; i < items.length; i++) {
        const before = new Set(order.map((o) => o.identifier));
        let btn = copyBtn();
        for (let t = 0; t < 20 && !btn; t++) { await sleep(50); btn = copyBtn(); }
        if (!btn) break;
        btn.click();
        for (let t = 0; t < 20 && order.every((o) => before.has(o.identifier)); t++) await sleep(50);
      }
    }
    // 只认真正新出现的条目，绝不改动原有条目
    const newIds = order.filter((o) => !origIds.has(o.identifier)).map((o) => o.identifier).slice(0, items.length);

    if (newIds.length < items.length) {
      // 没有 BaiBai 或复制没成功的部分：自己插入（不带分组），接在已有新条目后面
      const prompts = pm.serviceSettings.prompts;
      let anchor = newIds.length ? newIds[newIds.length - 1] : targetId;
      while (newIds.length < items.length) {
        const id = newUuid();
        const pIdx = prompts.findIndex((p) => p.identifier === anchor);
        prompts.splice(pIdx >= 0 ? pIdx + 1 : prompts.length, 0, { identifier: id, name: '', content: '', role: 'system' });
        const oIdx = order.findIndex((o) => o.identifier === anchor);
        order.splice(oIdx >= 0 ? oIdx + 1 : order.length, 0, { identifier: id, enabled: false });
        newIds.push(id); anchor = id;
      }
    }

    items.forEach((it, i) => {
      const p = pm.getPromptById(newIds[i]);
      if (!p) return;
      Object.entries(it.record.prompt || {}).forEach(([k, v]) => { if (k !== 'identifier') p[k] = structuredClone(v); });
      p.name = it.name; p.system_prompt = false; p.marker = false;
      const oe = order.find((o) => o.identifier === newIds[i]);
      if (oe) oe.enabled = Boolean(it.enabled);
    });

    const ext = getHelperExt();
    if (ext) {
      ext.insertedIds = Array.from(new Set([...(ext.insertedIds || []), ...newIds]));
      ext.merged ||= {};
      items.forEach((it, i) => { ext.merged[it.record.name] = newIds[i]; });
    }
    return newIds;
  }

  // 放在 anchorId 正上方：先复制到它下面（分组跟着它），再在顺序里挪到它前面
  async function insertAbove(anchorId, item, opts) {
    const [id] = await insertBelow(anchorId, [item], opts);
    const order = getPresetOrder();
    if (!id || !Array.isArray(order)) return id || null;
    const from = order.findIndex((o) => o.identifier === id);
    const [entry] = order.splice(from, 1);
    order.splice(order.findIndex((o) => o.identifier === anchorId), 0, entry);
    return id;
  }

  function refreshPresetUi() {
    const pm = getPM();
    pm?.render?.(false);
    pm?.saveServiceSettings?.();
    setTimeout(() => { if (state.preset.bulk) injectCheckboxes('preset'); updateDockUI(); refreshSchemeButton('preset'); }, 120);
  }

  /* ---------- ➕ 按钮（BaiBai「⋯」菜单里，收藏左边） ---------- */
  function injectInsertButtons() {
    document.querySelectorAll('#completion_prompt_manager_list li.completion_prompt_manager_prompt[data-pm-identifier]:not(.bai-bai-preset-favorite-prompt) .bai-bai-preset-prompt-actions').forEach((box) => {
      if (box.querySelector(':scope > .st-bs-record-insert')) return;
      const btn = document.createElement('span');
      btn.className = 'menu_button bai-bai-preset-prompt-action-button fa-solid fa-plus st-bs-record-insert';
      btn.title = '从记录表插入到此条目下方';
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        const row = btn.closest('li.completion_prompt_manager_prompt[data-pm-identifier]');
        box.classList.remove('bai-bai-preset-prompt-actions-visible');
        row?.classList.remove('bai-bai-preset-prompt-actions-open');
        row?.querySelector('.bai-bai-preset-prompt-actions-hint')?.classList.remove('bai-bai-preset-prompt-actions-hint-hidden');
        const id = row?.getAttribute('data-pm-identifier');
        if (id) showInsertModal(id);
      });
      const fav = box.querySelector(':scope > .bai-bai-preset-prompt-favorite-toggle');
      box.insertBefore(btn, fav || box.firstChild);
    });
  }

  function recordMetaText(r) {
    const parts = [r.kind === 'auto' ? '新增·自动' : '存底·手动'];
    if (r.sourcePreset) parts.push(`来自「${r.sourcePreset}」`);
    if (r.groupName) parts.push(`分组：${r.groupName}`);
    return parts.join(' · ');
  }

  // ➕ 插入：和记录表用同一套界面（插入模式），选择互不干扰
  function showInsertModal(targetId) {
    resetUi(insUi);
    showRecordsModal('insert', targetId);
  }

  /* ---------- 记录表窗口（管理模式：方案栏 📦；插入模式：➕） ---------- */
  const newUi = () => ({ selected: new Set(), query: '', searchOpen: false, rangeMode: false, rangeAnchor: null });
  const recUi = newUi(), insUi = newUi();
  const resetUi = (ui) => { ui.selected.clear(); ui.query = ''; ui.searchOpen = false; ui.rangeMode = false; ui.rangeAnchor = null; };
  const resetRecUi = () => resetUi(recUi);
  // 闭眼：半弧 + 睫毛（和输入密码时的「隐藏」图标同款）
  const EYE_CLOSED_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10c2.4 3.6 5.6 5.4 9 5.4s6.6-1.8 9-5.4"/><path d="M12 15.4v3"/><path d="M7.3 14.3l-1.4 2.5"/><path d="M16.7 14.3l1.4 2.5"/><path d="M4.2 11.8l-2 1.8"/><path d="M19.8 11.8l2 1.8"/></svg>';
  const isHighlightOn = () => getRawStore().ui?.highlight !== false;
  function setHighlight(on) { const s = getRawStore(); s.ui ||= {}; s.ui.highlight = on; saveRecords(); }

  // 在当前弹窗上面再叠一层小弹窗，不改动底下的内容；点小弹窗外面就关掉
  function openSubPopup(bd, build) {
    bd.querySelector('.st-bs-subpop')?.remove();
    const ov = document.createElement('div');
    ov.className = 'st-bs-subpop';
    ov.innerHTML = '<div class="st-bs-subpop-card"></div>';
    const close = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) close(); };
    bd.appendChild(ov);
    build(ov.querySelector('.st-bs-subpop-card'), close);
  }

  // 不区分大小写地查找，返回高亮后的 HTML（关掉高亮时只做转义）
  function markHtml(text, q) {
    const src = String(text ?? '');
    if (!q || !isHighlightOn()) return escapeHtml(src);
    const lower = src.toLowerCase(), ql = q.toLowerCase();
    let out = '', i = 0;
    for (let at = lower.indexOf(ql); at !== -1; at = lower.indexOf(ql, i)) {
      out += escapeHtml(src.slice(i, at)) + `<mark class="st-bs-hl">${escapeHtml(src.slice(at, at + q.length))}</mark>`;
      i = at + q.length;
    }
    return out + escapeHtml(src.slice(i));
  }

  function contentSnippet(content, q) {
    const src = String(content ?? ''), at = src.toLowerCase().indexOf(q.toLowerCase());
    if (at < 0) return '';
    const start = Math.max(0, at - 18), end = Math.min(src.length, at + q.length + 30);
    return (start > 0 ? '…' : '') + markHtml(src.slice(start, end).replace(/\s+/g, ' '), q) + (end < src.length ? '…' : '');
  }

  // 两行内容预览：搜索命中内容时显示命中那一段，否则显示开头
  function previewHtml(content, q) {
    const src = String(content ?? '');
    if (q && src.toLowerCase().includes(q.toLowerCase())) return contentSnippet(src, q);
    return escapeHtml(src.replace(/\s+/g, ' ').trim().slice(0, 160)) || '<span style="opacity:.6">（空）</span>';
  }

  const sourceMetaText = (r) => [r.sourcePreset ? `来自「${r.sourcePreset}」` : '', r.groupName ? `分组：${r.groupName}` : ''].filter(Boolean).join(' · ');

  // 一张记录卡片（管理模式：名字/类型/来源 + 🗑 ⤢；插入模式：名字/来源 + 两行预览 + ⤢，已存在的变灰不可选）
  function buildRecordCard(r, { mode, ui, q, exists, draggable = false, onToggle, onView, onDelete }) {
    const row = document.createElement('div');
    row.className = 'st-bs-record-row st-bs-record-card' + (ui.selected.has(r.name) ? ' selected' : '') + (exists ? ' exists' : '');
    row.dataset.dragKey = r.name;
    const nameHit = q && r.name.toLowerCase().includes(q.toLowerCase());
    let extra = '';
    if (mode === 'insert') extra = `<div class="st-bs-record-preview">${previewHtml(r.prompt?.content, q)}</div>`;
    else if (q && !nameHit) { const sn = contentSnippet(r.prompt?.content, q); if (sn) extra = `<div class="st-bs-record-snippet">${sn}</div>`; }
    const meta = mode === 'insert' ? sourceMetaText(r) + (exists ? '（当前预设里已有）' : '') : recordMetaText(r);
    row.innerHTML = `
      ${draggable ? '<span class="st-bs-drag-handle" title="按住拖动排序"><i class="fa-solid fa-bars"></i></span>' : ''}
      <div class="st-bs-record-text">
        <div class="st-bs-record-name">${markHtml(r.name, q)}</div>
        ${meta ? `<div class="st-bs-record-meta">${escapeHtml(meta)}</div>` : ''}
        ${extra}
      </div>
      <div class="st-bs-record-side">
        ${onDelete ? '<button type="button" class="st-bs-scheme-row-btn danger" data-row="del" title="删除这条记录"><i class="fa-solid fa-trash-can"></i></button>' : ''}
        <button type="button" class="st-bs-scheme-row-btn" data-row="view" title="查看完整内容"><i class="fa-solid fa-maximize"></i></button>
      </div>`;
    row.onclick = () => { if (!exists) onToggle(row); };
    row.querySelector('[data-row="view"]').onclick = (e) => { e.stopPropagation(); onView(); };
    if (onDelete) row.querySelector('[data-row="del"]').onclick = (e) => { e.stopPropagation(); onDelete(); };
    return row;
  }

  function showRecordsModal(mode = 'manage', targetId = null) {
    const ui = mode === 'insert' ? insUi : recUi;
    const target = mode === 'insert' ? getPM()?.getPromptById?.(targetId) : null;
    const bd = ensureModal(), card = bd.querySelector('.st-bs-modal-card');
    card.innerHTML = `
      <div class="st-bs-modal-title"></div>
      <div class="st-bs-modal-desc"></div>
      ${mode === 'manage' ? `<div class="st-bs-rec-actions">
        <button type="button" class="st-bs-btn st-bs-btn-primary" data-act="place"><i class="fa-solid fa-arrow-right-to-bracket"></i> 放进当前预设</button>
        <button type="button" class="st-bs-btn" data-act="merge"><i class="fa-solid fa-code-merge"></i> 版本升级融合</button>
      </div>` : ''}
      <div class="st-bs-rec-toolbar">
        <button type="button" class="st-bs-sel-btn" data-act="sel">已选 <b data-role="selcount">0</b> 条 <i class="fa-solid fa-list"></i></button>
        <div class="st-bs-rec-tools">
          <button type="button" class="st-bs-icon-btn" data-act="rscheme" title="记录方案"><i class="fa-solid fa-layer-group"></i></button>
          <button type="button" class="st-bs-icon-btn st-bs-all-btn" data-act="all" title="一键全选 / 一键清空">全选</button>
          <button type="button" class="st-bs-icon-btn" data-act="range" title="区间选择：点开头和结尾，中间全选"><i class="fa-solid fa-arrows-up-down"></i></button>
          ${mode === 'manage' ? '<button type="button" class="st-bs-icon-btn st-bs-icon-danger" data-act="del" title="删除已选记录"><i class="fa-solid fa-trash-can"></i></button>' : ''}
          <button type="button" class="st-bs-icon-btn" data-act="search" title="查找"><i class="fa-solid fa-magnifying-glass"></i></button>
        </div>
      </div>
      <div class="st-bs-search-row" data-role="searchrow">
        <div class="st-bs-search-capsule">
          <input type="text" class="st-bs-search-input" placeholder="查找名字或内容" />
          <button type="button" class="st-bs-search-clear" data-act="clear" title="清空"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <button type="button" class="st-bs-icon-btn" data-act="hl" title="高亮开关"></button>
      </div>
      <div class="st-bs-scheme-list st-bs-record-list"></div>
      <div class="st-bs-modal-actions st-bs-modal-actions-wrap">
        ${mode === 'manage'
          ? `<button type="button" class="st-bs-btn" data-act="export"><i class="fa-solid fa-file-export"></i> 导出</button>
             <button type="button" class="st-bs-btn" data-act="import"><i class="fa-solid fa-file-import"></i> 导入</button>
             <button type="button" class="st-bs-btn" data-act="close">关闭</button>`
          : `<button type="button" class="st-bs-btn" data-act="close">取消</button>
             <button type="button" class="st-bs-btn st-bs-btn-primary" data-act="insert">插入</button>`}
      </div>`;
    card.querySelector('.st-bs-modal-desc').textContent = mode === 'insert'
      ? `选中的条目会插到「${normName(target?.name) || '该条目'}」下方。灰色表示当前预设里已经有了。`
      : '所有预设共用。重装前记得导出备份。';

    const list = card.querySelector('.st-bs-record-list');
    const input = card.querySelector('.st-bs-search-input');
    const searchRow = card.querySelector('[data-role="searchrow"]');
    const hlBtn = card.querySelector('[data-act="hl"]');
    const existsCache = new Map();
    const isExisting = (r) => {
      if (mode !== 'insert') return false;
      if (!existsCache.has(r.name)) existsCache.set(r.name, recordExistsInCurrent(r));
      return existsCache.get(r.name);
    };
    let shownNames = [];
    const reopen = () => showRecordsModal(mode, targetId);

    const pruneSelection = () => { const all = getRecords(); ui.selected.forEach((n) => { if (!hasOwn(all, n) || isExisting(all[n])) ui.selected.delete(n); }); };

    const renderCount = () => {
      pruneSelection();
      card.querySelector('[data-role="selcount"]').textContent = String(ui.selected.size);
      const allShownSelected = shownNames.length > 0 && shownNames.every((n) => ui.selected.has(n));
      card.querySelector('[data-act="all"]').textContent = allShownSelected ? '清空' : '全选';
      card.querySelector('[data-act="range"]').classList.toggle('active', ui.rangeMode);
    };

    const showSelectedPopup = () => openSubPopup(bd, (box, close) => {
      const draw = () => {
        pruneSelection();
        box.innerHTML = `<div class="st-bs-modal-title">已选 ${ui.selected.size} 条</div><div class="st-bs-subpop-list"></div><div class="st-bs-modal-actions"><button type="button" class="st-bs-btn" data-sub="close">关闭</button></div>`;
        const ul = box.querySelector('.st-bs-subpop-list');
        if (!ui.selected.size) ul.innerHTML = '<div class="st-bs-sel-empty">还没有选中的条目，点卡片即可选中。</div>';
        ui.selected.forEach((n) => {
          const row = document.createElement('div');
          row.className = 'st-bs-sel-item';
          row.innerHTML = `<span class="st-bs-sel-name">${escapeHtml(n)}</span><button type="button" class="st-bs-sel-x" title="取消选中"><i class="fa-solid fa-xmark"></i></button>`;
          row.querySelector('button').onclick = () => { ui.selected.delete(n); draw(); renderList(); };
          ul.appendChild(row);
        });
        box.querySelector('[data-sub="close"]').onclick = close;
      };
      draw();
    });

    bindHandleDrag(list, '.st-bs-record-card', (newKeys) => {
      if (ui.query.trim()) return;
      setRecordOrder(newKeys);
      const all = getRecords();
      shownNames = newKeys.filter((n) => hasOwn(all, n) && !isExisting(all[n]));
    });

    const renderList = () => {
      const all = getOrderedRecords();
      card.querySelector('.st-bs-modal-title').textContent = mode === 'insert' ? `从记录表插入（${all.length}）` : `记录表（${all.length}）`;
      const q = ui.query.trim(), ql = q.toLowerCase();
      const shown = q ? all.filter((r) => r.name.toLowerCase().includes(ql) || String(r.prompt?.content || '').toLowerCase().includes(ql)) : all;
      shownNames = shown.filter((r) => !isExisting(r)).map((r) => r.name);
      list.innerHTML = '';
      if (!all.length) list.innerHTML = '<div class="st-bs-record-empty">还没有记录。在批量编辑里勾选条目，点悬浮条上的「存底」即可记录。</div>';
      else if (!shown.length) list.innerHTML = '<div class="st-bs-record-empty">没有找到匹配的条目。</div>';
      shown.forEach((r) => {
        list.appendChild(buildRecordCard(r, {
          mode, ui, q, exists: isExisting(r), draggable: !q,
          onToggle: (row) => {
            if (ui.rangeMode) {
              ui.selected.add(r.name);
              if (!ui.rangeAnchor) { ui.rangeAnchor = r.name; notify('info', '已选开头，请再点结尾条目'); renderList(); return; }
              const i1 = shownNames.indexOf(ui.rangeAnchor), i2 = shownNames.indexOf(r.name);
              if (i1 >= 0 && i2 >= 0) shownNames.slice(Math.min(i1, i2), Math.max(i1, i2) + 1).forEach((n) => ui.selected.add(n));
              notify('success', `已区间选中 ${Math.abs(i2 - i1) + 1} 条`);
              ui.rangeMode = false; ui.rangeAnchor = null;
              renderList(); return;
            }
            if (ui.selected.has(r.name)) ui.selected.delete(r.name); else ui.selected.add(r.name);
            row.classList.toggle('selected', ui.selected.has(r.name));
            renderCount();
          },
          onView: () => showRecordPreview(r.name, ui.query.trim(), reopen),
          onDelete: null,
        }));
      });
      renderCount();
    };

    const renderSearch = () => {
      searchRow.style.display = ui.searchOpen ? '' : 'none';
      card.querySelector('[data-act="search"]').classList.toggle('active', ui.searchOpen);
      hlBtn.innerHTML = isHighlightOn() ? '<i class="fa-solid fa-eye"></i>' : EYE_CLOSED_SVG;
      card.querySelector('[data-act="clear"]').style.visibility = ui.query ? 'visible' : 'hidden';
    };

    input.value = ui.query;
    input.addEventListener('input', () => { ui.query = input.value; renderSearch(); renderList(); });
    card.querySelector('[data-act="clear"]').onclick = () => { ui.query = ''; input.value = ''; renderSearch(); renderList(); input.focus(); };
    hlBtn.onclick = () => { setHighlight(!isHighlightOn()); renderSearch(); renderList(); };
    card.querySelector('[data-act="search"]').onclick = () => {
      ui.searchOpen = !ui.searchOpen;
      if (!ui.searchOpen) { ui.query = ''; input.value = ''; renderList(); }
      renderSearch();
      if (ui.searchOpen) setTimeout(() => input.focus(), 30);
    };
    card.querySelector('[data-act="sel"]').onclick = () => showSelectedPopup();
    card.querySelector('[data-act="all"]').onclick = () => {
      if (!shownNames.length) return;
      const allSel = shownNames.every((n) => ui.selected.has(n));
      shownNames.forEach((n) => (allSel ? ui.selected.delete(n) : ui.selected.add(n)));
      renderList();
    };
    card.querySelector('[data-act="range"]').onclick = () => {
      const pickedIdx = shownNames.map((n, i) => (ui.selected.has(n) ? i : -1)).filter((i) => i >= 0);
      if (!ui.rangeMode && pickedIdx.length >= 2) {
        const slice = shownNames.slice(pickedIdx[0], pickedIdx[pickedIdx.length - 1] + 1);
        slice.forEach((n) => ui.selected.add(n));
        notify('success', `已区间选中 ${slice.length} 条`);
        renderList();
        return;
      }
      ui.rangeMode = !ui.rangeMode;
      if (ui.rangeMode) {
        ui.rangeAnchor = pickedIdx.length === 1 ? shownNames[pickedIdx[0]] : null;
        notify('info', ui.rangeAnchor ? '区间选择：请再点另一端条目' : '区间选择：请依次点开头和结尾条目');
      } else {
        ui.rangeAnchor = null;
      }
      renderCount();
    };
    card.querySelector('[data-act="rscheme"]').onclick = () => showRecordSchemePopup(bd, { mode, ui, isExisting, onDone: renderList });
    card.querySelector('[data-act="del"]')?.addEventListener('click', () => {
      pruneSelection();
      const ordered = typeof getOrderedRecordNames === 'function' ? getOrderedRecordNames() : Object.keys(getRecords());
      const pick = ordered.filter((n) => ui.selected.has(n));
      if (!pick.length) return notify('warning', '请先选中要删除的记录');
      openSubPopup(bd, (box, closeSub) => {
        box.innerHTML = `
          <div class="st-bs-modal-title">删除已选记录（${pick.length} 条）</div>
          <div class="st-bs-modal-desc">确定从记录表删除以下条目吗？（不会影响预设里的条目）</div>
          <div class="st-bs-subpop-list"></div>
          <div class="st-bs-modal-actions">
            <button type="button" class="st-bs-btn" data-sub="no">取消</button>
            <button type="button" class="st-bs-btn st-bs-btn-danger" data-sub="yes">确认删除</button>
          </div>`;
        const ul = box.querySelector('.st-bs-subpop-list');
        pick.forEach((n) => {
          const item = document.createElement('div');
          item.className = 'st-bs-sel-item';
          item.innerHTML = '<span class="st-bs-sel-name"></span>';
          item.querySelector('span').textContent = n;
          ul.appendChild(item);
        });
        box.querySelector('[data-sub="no"]').onclick = closeSub;
        box.querySelector('[data-sub="yes"]').onclick = () => {
          const all = getRecords();
          pick.forEach((n) => {
            delete all[n];
            ui.selected.delete(n);
          });
          const s = getRawStore();
          if (Array.isArray(s.recordOrder)) {
            const delSet = new Set(pick);
            s.recordOrder = s.recordOrder.filter((n) => !delSet.has(n));
          }
          saveRecords();
          closeSub();
          renderList();
          notify('success', `已从记录表删除 ${pick.length} 条记录`);
        };
      });
    });

    if (mode === 'manage') {
      card.querySelector('[data-act="merge"]').onclick = () => showMergePicker();
      card.querySelector('[data-act="place"]').onclick = () => placeSelectedIntoCurrent();
      card.querySelector('[data-act="export"]').onclick = () => exportRecords(Array.from(ui.selected));
      card.querySelector('[data-act="import"]').onclick = () => importRecords(() => reopen());
      card.querySelector('[data-act="close"]').onclick = () => { resetUi(ui); closeModal(); };
    } else {
      card.querySelector('[data-act="close"]').onclick = () => { resetUi(ui); closeModal(); };
      card.querySelector('[data-act="insert"]').onclick = async () => {
        pruneSelection();
        const names = Array.from(ui.selected);
        if (!names.length) return notify('warning', '请先选择要插入的条目');
        closeModal();
        const all = getRecords();
        const items = names.map((n) => all[n]).filter(Boolean).map((r) => ({ record: r, name: r.name, enabled: r.enabled !== false }));
        const ids = await insertBelow(targetId, items);
        resetUi(ui);
        refreshPresetUi();
        notify('success', `已插入 ${ids.length} 条，确认无误后记得点「保存预设」`);
      };
    }
    bd.onclick = (e) => { if (e.target === bd) { resetUi(ui); closeModal(); } };

    renderSearch(); renderList();
    bd.classList.add('open');
  }

  // 预览：① 上一条名字 ② 可滚动内容 ③ 下一条名字
  function showRecordPreview(name, q = '', back = () => showRecordsModal()) {
    const r = getRecords()[name];
    if (!r) return back();
    const p = r.prompt || {};
    const posText = Number(p.injection_position) === 1 ? `聊天中 · 深度 ${p.injection_depth ?? 4} · 顺序 ${p.injection_order ?? 100}` : '相对位置';
    const nbText = (nb, legacy) => nb?.name ? `${nb.rainbow ? `${nb.name} 🌈` : nb.name}${nb.occ > 1 ? `（第 ${nb.occ} 个同名）` : ''}` : (legacy || '（没有记录，重新存底后会有）');
    const bd = ensureModal(), card = bd.querySelector('.st-bs-modal-card');
    card.innerHTML = `
      <div class="st-bs-modal-title"></div>
      <div class="st-bs-modal-desc"></div>
      <div class="st-bs-preview-label">上一条</div>
      <div class="st-bs-preview-box st-bs-preview-nb"></div>
      <div class="st-bs-preview-label">内容</div>
      <div class="st-bs-preview-box st-bs-preview-content"></div>
      <div class="st-bs-preview-label">下一条</div>
      <div class="st-bs-preview-box st-bs-preview-nb"></div>
      <div class="st-bs-modal-actions"><button type="button" class="st-bs-btn" data-act="back">返回</button></div>`;
    card.querySelector('.st-bs-modal-title').textContent = r.name;
    card.querySelector('.st-bs-modal-desc').textContent = `${recordMetaText(r)} · 角色 ${p.role || 'system'} · ${posText} · 存底时${r.enabled !== false ? '开' : '关'}`;
    const nbs = card.querySelectorAll('.st-bs-preview-nb');
    nbs[0].textContent = nbText(r.prev, r.prevName);
    nbs[1].textContent = nbText(r.next, '');
    const box = card.querySelector('.st-bs-preview-content');
    box.innerHTML = markHtml(p.content || '', q) || '<span style="opacity:.6">（空）</span>';
    card.querySelector('[data-act="back"]').onclick = back;
    bd.onclick = (e) => { if (e.target === bd) back(); };
    bd.classList.add('open');
    const first = box.querySelector('mark.st-bs-hl');
    if (first) setTimeout(() => { box.scrollTop = Math.max(0, first.offsetTop - box.clientHeight / 3); }, 30);
  }

  /* ---------- 放进当前预设 / 版本升级融合（共用同一套摆放逻辑） ---------- */
  // 去掉版本号、括号和符号，用来猜「同一个预设的不同版本」
  const baseName = (n) => String(n || '').toLowerCase().replace(/v?\d+(\.\d+)+/g, '').replace(/[\s\-_.·()（）【】\[\]]/g, '');

  function getStoredPreset(name) {
    const idx = openaiMod?.openai_setting_names?.[name];
    return idx !== undefined ? openaiMod?.openai_settings?.[idx] : null;
  }

  function findOldOrder(old, charId) {
    const lists = Array.isArray(old?.prompt_order) ? old.prompt_order : [];
    return (lists.find((x) => String(x.character_id) === String(charId)) || lists.find((x) => x.character_id === 100001) || lists[0])?.order || [];
  }

  // 记录在某个预设里对应的条目 ID：融合/插入时记下的 → 最初存底的那条 → 名字(去🌈)和内容都相同的
  function findRecordEntryId(r, prompts, merged) {
    const ids = new Set(prompts.map((p) => p.identifier));
    if (merged?.[r.name] && ids.has(merged[r.name])) return merged[r.name];
    if (r.srcId && ids.has(r.srcId)) return r.srcId;
    const content = r.prompt?.content || '';
    return prompts.find((p) => stripRainbow(p.name) === r.name && (p.content || '') === content)?.identifier || null;
  }

  const recordsContainedIn = (presetObj) => {
    const prompts = presetObj?.prompts || [], merged = presetObj?.extensions?.stBulkSchemeHelper?.merged || {};
    return Object.values(getRecords()).filter((r) => r?.name && findRecordEntryId(r, prompts, merged));
  };

  // 融合前用旧预设里的最新版本更新记录（内容、开关、上下邻居、来自哪里）
  function refreshRecordsFrom(presetObj, presetName, recs, charId) {
    const prompts = presetObj?.prompts || [], merged = presetObj?.extensions?.stBulkSchemeHelper?.merged || {};
    const byId = new Map(prompts.map((p) => [p.identifier, p]));
    const order = findOldOrder(presetObj, charId);
    const g = presetObj?.extensions?.baibaiToolkit?.presetPromptGroups;
    let n = 0;
    recs.forEach((r) => {
      const id = findRecordEntryId(r, prompts, merged);
      if (!id) return;
      const prompt = structuredClone(byId.get(id));
      delete prompt.identifier;
      const idx = order.findIndex((o) => o.identifier === id);
      const gid = g?.prompts?.[id]?.groupId;
      Object.assign(r, {
        prompt, srcId: id, sourcePreset: presetName,
        enabled: idx >= 0 ? order[idx].enabled !== false : r.enabled,
        prev: idx >= 0 ? neighborAt(order, byId, idx - 1) : r.prev,
        next: idx >= 0 ? neighborAt(order, byId, idx + 1) : r.next,
        groupName: gid ? (g.groups || []).find((x) => x.id === gid)?.name || r.groupName : r.groupName,
        savedAt: Date.now(),
      });
      r.prevName = r.prev?.name || '';
      n++;
    });
    if (n) saveRecords();
    return n;
  }

  // 共用：插入 🌈 副本，再按上下邻居连锁放置孤儿；返回摆放结果
  async function placeIntoCurrent(rainbowItems, orphanItems, existingRainbow) {
    const pm = getPM(), order = getPresetOrder(), ext = getHelperExt();
    const rainbowOf = new Map(existingRainbow);
    const added = [], rainbowReport = [], placedReport = [], failed = [];
    for (const it of rainbowItems) {
      const [id] = await insertBelow(it.targetId, [{ record: it.record, name: `${it.record.name}${RAINBOW}`, enabled: it.enabled }], { keepExpanded: true });
      if (id) {
        rainbowOf.set(it.record.name, id); added.push({ id, oldId: it.oldId });
        rainbowReport.push(`${it.record.name}${RAINBOW} → 「${it.record.name}」下面${it.enabled ? '（开）' : '（关）'}`);
      } else failed.push(it.record.name);
    }
    const placed = new Map();
    Object.entries(ext.merged || {}).forEach(([n, id]) => { if (order.some((o) => o.identifier === id)) placed.set(n, id); });
    const inserted = new Set(ext.insertedIds || []);
    const authorId = (name, occ) => {
      const hits = order.filter((o) => !inserted.has(o.identifier) && normName(pm.getPromptById(o.identifier)?.name) === name);
      return (hits[occ - 1] || hits[0])?.identifier || null;
    };
    const pending = orphanItems.slice();
    const ctx = { placed, rainbowOf, pending: new Set(pending.map((x) => x.record.name)), authorId };
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (const it of pending.slice()) {
        const pa = resolveAnchor(it.prev, 'prev', ctx);
        const na = pa ? null : resolveAnchor(it.next, 'next', ctx);
        if (!pa && !na) continue;
        const item = { record: it.record, name: it.record.name, enabled: it.enabled };
        const id = pa ? (await insertBelow(pa, [item], { keepExpanded: true }))[0] : await insertAbove(na, item, { keepExpanded: true });
        if (!id) continue;
        placed.set(it.record.name, id); ctx.pending.delete(it.record.name);
        pending.splice(pending.indexOf(it), 1);
        added.push({ id, oldId: it.oldId });
        placedReport.push(`${it.record.name} → 「${stripRainbow(pm.getPromptById(pa || na)?.name)}」${pa ? '下面' : '上面'}${it.enabled ? '（开）' : '（关）'}`);
        progress = true;
      }
    }
    collapseExpandedByUs();
    return { added, rainbowReport, placedReport, failed, left: pending.map((x) => x.record.name) };
  }

  /* ----- ① 放进当前预设：只用已选记录，不需要出处 ----- */
  async function placeSelectedIntoCurrent() {
    const names = Array.from(recUi.selected).filter((n) => hasOwn(getRecords(), n));
    if (!names.length) return notify('warning', '请先选择要放进来的记录（点卡片，或点「全选」）');
    if (!isPresetDataReady()) return notify('warning', '预设还在加载，请稍后再试');
    const pm = getPM(), order = getPresetOrder(), ext = getHelperExt();
    if (!pm || !Array.isArray(order) || !ext) return notify('error', '无法读取当前预设');
    const cur = getPresetName();
    const ok = await showConfirm({
      title: '放进当前预设',
      desc: `把已选的 ${names.length} 条记录放进「${cur}」：有同名条目的插到它下面并加 🌈，没有的按原来的上下邻居找位置，找不到的会列出来。不会自动保存，检查无误后请点「保存预设」。`,
      okText: '开始',
    });
    if (!ok) return showRecordsModal();
    closeModal();

    const records = names.map((n) => getRecords()[n]);
    const prompts = pm.serviceSettings.prompts;
    const inserted = new Set(ext.insertedIds || []);
    const idSet = new Set(order.map((o) => o.identifier));
    const existingRainbow = new Map();
    order.forEach((o) => { const p = pm.getPromptById(o.identifier); if (p && isRainbowName(p.name)) existingRainbow.set(stripRainbow(p.name), o.identifier); });
    const authorIdByName = new Map();
    order.forEach((o) => { if (inserted.has(o.identifier)) return; const n = normName(pm.getPromptById(o.identifier)?.name); if (n && !authorIdByName.has(n)) authorIdByName.set(n, o.identifier); });

    const rainbowItems = [], orphanItems = [], skipped = [];
    records.forEach((r) => {
      const mid = ext.merged?.[r.name];
      if ((mid && idSet.has(mid)) || existingRainbow.has(r.name) || findRecordEntryId(r, prompts, null)) { skipped.push(r.name); return; }
      const enabled = r.enabled !== false;
      const target = authorIdByName.get(r.name);
      if (target) {
        if (enabled) { const oe = order.find((o) => o.identifier === target); if (oe) oe.enabled = false; }
        rainbowItems.push({ targetId: target, record: r, enabled });
      } else {
        orphanItems.push({ record: r, enabled, prev: r.prev || (r.prevName ? { name: r.prevName, occ: 1 } : null), next: r.next || null });
      }
    });

    try {
      const res = await placeIntoCurrent(rainbowItems, orphanItems, existingRainbow);
      refreshPresetUi();
      showPlaceReport({
        title: '放进当前预设',
        intro: `把 ${names.length} 条记录放进「${cur}」：`,
        lines: [],
        res,
        notMergedExtra: skipped.map((n) => `${n} —— 当前预设里已经有了，跳过`),
      });
    } catch (err) {
      console.error('[批量编辑与开关方案助手] 放进当前预设异常:', err);
      collapseExpandedByUs(); refreshPresetUi();
      notify('error', '中途出错，已停止。请先不要保存预设，切换一次预设即可放弃这次改动。');
    }
  }

  /* ----- ② 版本升级融合：需要旧预设（开关/方案/正则/分组供电在它里面） ----- */
  function showMergePicker() {
    const cur = getPresetName();
    if (!cur || !isPresetDataReady()) return notify('warning', '预设还在加载，请稍后再试');
    const names = Object.keys(openaiMod?.openai_setting_names || {}).filter((n) => n !== cur);
    const contained = new Map(names.map((n) => [n, recordsContainedIn(getStoredPreset(n))]));
    const curBase = baseName(cur);
    names.sort((a, b) => (Number(baseName(b) === curBase) - Number(baseName(a) === curBase)) || (contained.get(b).length - contained.get(a).length) || a.localeCompare(b));
    const selNames = Array.from(recUi.selected).filter((n) => hasOwn(getRecords(), n));

    const bd = ensureModal(), card = bd.querySelector('.st-bs-modal-card');
    card.innerHTML = `
      <div class="st-bs-modal-title">版本升级融合：选择旧版本</div>
      <div class="st-bs-modal-desc"></div>
      <div class="st-bs-scheme-list st-bs-record-list"></div>
      <div class="st-bs-modal-actions"><button type="button" class="st-bs-btn" data-act="back">返回</button></div>`;
    card.querySelector('.st-bs-modal-desc').textContent = selNames.length
      ? `把旧版本的开关、方案、正则和分组供电搬到当前预设「${cur}」，并融合已选的 ${selNames.length} 条记录。`
      : `把旧版本的开关、方案、正则和分组供电搬到当前预设「${cur}」。没有选记录，默认融合旧版本里包含的记录。`;
    const list = card.querySelector('.st-bs-record-list');
    names.forEach((n) => {
      const c = contained.get(n).length, recommended = baseName(n) === curBase;
      const row = document.createElement('div');
      row.className = 'st-bs-record-row st-bs-record-pick';
      row.innerHTML = `<div class="st-bs-record-text"><div class="st-bs-record-name">${escapeHtml(n)}${recommended ? ' <span class="st-bs-tag">推荐</span>' : ''}</div><div class="st-bs-record-meta">${c ? `包含记录表里的 ${c} 条` : '不包含记录表里的条目'}</div></div>`;
      row.onclick = async () => {
        const old = getStoredPreset(n);
        const inOld = contained.get(n);
        const recs = selNames.length ? selNames.map((x) => getRecords()[x]) : inOld;
        const refreshCount = recs.filter((r) => inOld.includes(r)).length;
        const ok = await showConfirm({
          title: '确认融合',
          desc: `把「${n}」的条目开关、开关方案、正则启用状态和分组供电搬到「${cur}」，并融合 ${recs.length} 条记录${refreshCount ? `（其中 ${refreshCount} 条会先用「${n}」里的最新内容更新）` : ''}：新版有同名的插入 🌈 副本，没有的按上下邻居自动放好。旧版本的开关以它最后一次保存时为准。融合不会自动保存，检查无误后请点「保存预设」。`,
          okText: '开始融合',
        });
        if (!ok) return showMergePicker();
        refreshRecordsFrom(old, n, recs.filter((r) => inOld.includes(r)), getPM()?.activeCharacter?.id);
        runMerge(n, recs);
      };
      list.appendChild(row);
    });
    if (!names.length) list.innerHTML = '<div class="st-bs-record-empty">没有其他预设。</div>';
    card.querySelector('[data-act="back"]').onclick = () => showRecordsModal();
    bd.onclick = (e) => { if (e.target === bd) showRecordsModal(); };
    bd.classList.add('open');
  }

  async function runMerge(oldName, recs) {
    const old = getStoredPreset(oldName), pm = getPM(), order = getPresetOrder();
    const settings = openaiMod?.oai_settings;
    if (!old || !pm || !Array.isArray(order) || !settings) return notify('error', '无法读取预设数据，融合已取消');
    closeModal();
    notify('info', '正在融合，请稍候…');
    const ext = getHelperExt();

    const plan = buildMergePlan({
      oldPrompts: old.prompts || [],
      oldOrder: findOldOrder(old, pm.activeCharacter?.id),
      oldExt: old.extensions || {},
      newPrompts: pm.serviceSettings.prompts,
      newOrder: order,
      newExt: settings.extensions,
      records: recs,
      insertedIds: ext.insertedIds,
      merged: ext.merged,
    });

    try {
      // 1. 开关
      order.forEach((o) => { if (plan.toggles.has(o.identifier)) o.enabled = plan.toggles.get(o.identifier); });

      // 2+3. 🌈 副本 + 按邻居连锁放置
      const res = await placeIntoCurrent(plan.rainbow, plan.orphans, plan.existingRainbow);

      // 4. 方案（与当前预设已有方案合并，同名以旧预设为准）
      if (Object.keys(plan.schemes).length) {
        res.added.forEach(({ id, oldId }) => {
          Object.entries(plan.schemeStatesOf(oldId)).forEach(([sname, on]) => { if (plan.schemes[sname]) plan.schemes[sname][id] = on; });
        });
        ext.schemes = { ...(ext.schemes || {}), ...plan.schemes };
        getRawStore().presetSchemes[getPresetName()] = structuredClone(ext.schemes);
      }

      // 5. 正则启用状态
      let rxChanged = 0;
      if (plan.regexDisabled.size && Array.isArray(settings.extensions.regex_scripts)) {
        settings.extensions.regex_scripts.forEach((r) => {
          const k = r.id || r.scriptName;
          if (plan.regexDisabled.has(k)) { r.disabled = plan.regexDisabled.get(k); rxChanged++; }
        });
      }

      // 6. 分组供电（点 BaiBai 自己的开关）
      const groupC = applyGroupPower(plan.groupPower);

      refreshPresetUi();
      resetRecUi();
      showPlaceReport({
        title: '版本升级融合完成',
        intro: `从「${oldName}」融合到「${getPresetName()}」，共 ${recs.length} 条记录：`,
        lines: [
          `对上的条目 ${plan.stats.matched} 个，开关照旧；作者新加的 ${plan.stats.authorNew} 个已关闭`,
          `开关方案 ${Object.keys(plan.schemes).length} 个；正则启用状态改了 ${rxChanged} 条；分组供电切换 ${groupC} 个`,
        ],
        res,
        notMergedExtra: [
          ...plan.sameAsNew.map((n) => `${n} —— 和新版内容完全一样，没插副本（开关已照旧）`),
          ...plan.skipped.map((n) => `${n} —— 之前已经融合过，跳过`),
        ],
        lostOn: plan.lostOn,
      });
    } catch (err) {
      console.error('[批量编辑与开关方案助手] 融合异常:', err);
      collapseExpandedByUs();
      refreshPresetUi();
      notify('error', '融合中途出错，已停止。请先不要保存预设，切换一次预设即可放弃这次改动。');
    }
  }

  function showPlaceReport({ title, intro, lines, res, notMergedExtra = [], lostOn = [] }) {
    const bd = ensureModal(), card = bd.querySelector('.st-bs-modal-card');
    const li = (arr) => arr.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
    const mergedList = [...res.rainbowReport, ...res.placedReport];
    const notMerged = [
      ...res.left.map((n) => `${n} —— 上下邻居在当前预设里都没有，找不到位置`),
      ...res.failed.map((n) => `${n} —— 插入失败`),
      ...notMergedExtra,
    ];
    card.innerHTML = `
      <div class="st-bs-modal-title">${escapeHtml(title)}</div>
      <div class="st-bs-record-report">
        <p>${escapeHtml(intro)}</p>
        ${lines.length ? `<ul>${li(lines)}</ul>` : ''}
        <p><b>✅ 已放进来 ${mergedList.length} 条：</b></p>
        ${mergedList.length ? `<ul>${li(mergedList)}</ul>` : '<p style="opacity:.6">（无）</p>'}
        <p><b>⚠️ 没有放进来 ${notMerged.length} 条：</b></p>
        ${notMerged.length ? `<ul>${li(notMerged)}</ul>` : '<p style="opacity:.6">（无，全部放进来了）</p>'}
        ${res.left.length ? '<p>找不到位置的，可以在目标条目的「⋯」菜单里点 ➕ 手动插入。</p>' : ''}
        ${lostOn.length ? `<p><b>你开着、但新版里找不到的作者条目 ${lostOn.length} 个</b>（作者可能删了或改了名，请自己找替代）：</p><ul>${li(lostOn)}</ul>` : ''}
        <p><b>还没有保存。</b>检查无误后，请点 SillyTavern 的「保存预设」。</p>
      </div>
      <div class="st-bs-modal-actions"><button type="button" class="st-bs-btn st-bs-btn-primary" data-act="ok">知道了</button></div>`;
    card.querySelector('[data-act="ok"]').onclick = closeModal;
    bd.onclick = null;
    bd.classList.add('open');
  }

  /* ---------- 记录方案：一组记录存个名字；点开可单选 / 区间 / 全选，还能添加、移除、改名 ---------- */
  function getRecordSchemes() {
    const s = getRawStore();
    if (!s.recordSchemes || typeof s.recordSchemes !== 'object') s.recordSchemes = {};
    return s.recordSchemes;
  }

  const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/><path d="M14.5 5.5l3 3"/></svg>';

  // 按记录表的顺序排序（最新存底在前），保证方案内顺序和记录表一致
  function sortByRecordOrder(names) {
    const all = getRecords();
    const orderIdx = new Map(getOrderedRecordNames().map((n, i) => [n, i]));
    return Array.from(new Set((names || []).filter((x) => hasOwn(all, x))))
      .sort((a, b) => (orderIdx.get(a) ?? 999999) - (orderIdx.get(b) ?? 999999));
  }

  function showRecordSchemePopup(bd, { mode, ui, isExisting, onDone }) {
    const editable = mode === 'manage';
    openSubPopup(bd, (box, close) => {
      const done = () => { close(); onDone(); };

      /* 列表页 */
      const drawList = () => {
        const schemes = getRecordSchemes(), all = getRecords();
        const names = Object.keys(schemes);
        box.innerHTML = `
          <div class="st-bs-modal-title">记录方案</div>
          <div class="st-bs-subpop-list"></div>
          ${editable ? '<div class="st-bs-search-capsule st-bs-subpop-input"><input type="text" class="st-bs-search-input" placeholder="新方案名称" /></div>' : ''}
          <div class="st-bs-modal-actions st-bs-modal-actions-wrap">
            <button type="button" class="st-bs-btn" data-sub="close">关闭</button>
            ${editable ? `<button type="button" class="st-bs-btn st-bs-btn-primary" data-sub="save">把已选 ${ui.selected.size} 条存为方案</button>` : ''}
          </div>`;
        const ul = box.querySelector('.st-bs-subpop-list');
        if (!names.length) ul.innerHTML = `<div class="st-bs-sel-empty">还没有记录方案。${editable ? '先选好几条记录，在下面输入名称后保存。' : '可以在 📦 记录表里创建。'}</div>`;
        names.forEach((n) => {
          const count = (schemes[n] || []).filter((x) => hasOwn(all, x)).length;
          const row = document.createElement('div');
          row.className = 'st-bs-sel-item';
          row.dataset.dragKey = n;
          row.innerHTML = `${editable ? '<span class="st-bs-drag-handle" title="按住拖动排序"><i class="fa-solid fa-bars"></i></span>' : ''}<span class="st-bs-sel-name st-bs-rs-open" title="点开查看并选择"><b></b> <small style="opacity:.6">${count} 条</small></span>
            ${editable ? `<button type="button" class="st-bs-sel-x" data-rs="rename" title="重命名">${PENCIL_SVG}</button>
            <button type="button" class="st-bs-sel-x" data-rs="del" title="删除这个方案"><i class="fa-solid fa-trash-can"></i></button>` : '<i class="fa-solid fa-chevron-right" style="opacity:.4;font-size:12px;"></i>'}`;
          row.querySelector('b').textContent = n;
          row.querySelector('.st-bs-rs-open').onclick = () => drawDetail(n);
          row.querySelector('[data-rs="rename"]')?.addEventListener('click', () => drawRename(n));
          row.querySelector('[data-rs="del"]')?.addEventListener('click', () => drawConfirm({
            title: '删除记录方案',
            desc: `确定删除记录方案「${n}」吗？只删除这个方案，记录表里的条目不会被删除。`,
            okText: '删除',
            onYes: () => { delete getRecordSchemes()[n]; saveRecords(); notify('info', `已删除记录方案「${n}」`); drawList(); },
            onNo: drawList,
          }));
          ul.appendChild(row);
        });
        if (editable && names.length > 1) {
          bindHandleDrag(ul, '.st-bs-sel-item', (newKeys) => {
            reorderObjectKeys(getRecordSchemes(), newKeys);
            saveRecords();
          });
        }
        box.querySelector('[data-sub="close"]').onclick = done;
        box.querySelector('[data-sub="save"]')?.addEventListener('click', () => {
          const name = box.querySelector('input').value.trim();
          if (!ui.selected.size) return notify('warning', '先选好记录再保存方案');
          if (!name) return notify('warning', '请输入方案名称');
          const existed = hasOwn(schemes, name);
          schemes[name] = sortByRecordOrder(Array.from(ui.selected));
          saveRecords(); drawList();
          notify('success', `${existed ? '已覆盖' : '已保存'}记录方案「${name}」（${schemes[name].length} 条）`);
        });
      };

      /* 重命名（保持方案原来的排列顺序） */
      const drawRename = (n) => {
        box.innerHTML = `
          <div class="st-bs-modal-title">重命名记录方案</div>
          <div class="st-bs-search-capsule st-bs-subpop-input"><input type="text" class="st-bs-search-input" /></div>
          <div class="st-bs-modal-actions">
            <button type="button" class="st-bs-btn" data-sub="no">取消</button>
            <button type="button" class="st-bs-btn st-bs-btn-primary" data-sub="yes">确定</button>
          </div>`;
        const input = box.querySelector('input');
        input.value = n;
        box.querySelector('[data-sub="no"]').onclick = drawList;
        box.querySelector('[data-sub="yes"]').onclick = () => {
          const name = input.value.trim(), schemes = getRecordSchemes();
          if (!name) return notify('warning', '请输入方案名称');
          if (name === n) return drawList();
          if (hasOwn(schemes, name)) return notify('warning', `已经有叫「${name}」的方案了`);
          const rebuilt = {};
          Object.keys(schemes).forEach((k) => { rebuilt[k === n ? name : k] = schemes[k]; });
          Object.keys(schemes).forEach((k) => delete schemes[k]);
          Object.assign(schemes, rebuilt);
          saveRecords(); notify('success', `已重命名为「${name}」`); drawList();
        };
        setTimeout(() => input.focus(), 30);
      };

      /* 通用确认（叠在小弹窗里，不动底下的记录表） */
      const drawConfirm = ({ title, desc, okText, onYes, onNo }) => {
        box.innerHTML = `
          <div class="st-bs-modal-title"></div>
          <div class="st-bs-modal-desc"></div>
          <div class="st-bs-modal-actions">
            <button type="button" class="st-bs-btn" data-sub="no">取消</button>
            <button type="button" class="st-bs-btn st-bs-btn-danger" data-sub="yes"></button>
          </div>`;
        box.querySelector('.st-bs-modal-title').textContent = title;
        box.querySelector('.st-bs-modal-desc').textContent = desc;
        box.querySelector('[data-sub="yes"]').textContent = okText;
        box.querySelector('[data-sub="no"]').onclick = onNo;
        box.querySelector('[data-sub="yes"]').onclick = onYes;
      };

      /* 查看全文（在小弹窗里，带搜索高亮，返回回到方案详情） */
      const drawPreview = (name, q = '', back) => {
        const r = getRecords()[name];
        if (!r) return back();
        const nbText = (nb, legacy) => nb?.name ? `${nb.rainbow ? `${nb.name} 🌈` : nb.name}${nb.occ > 1 ? `（第 ${nb.occ} 个同名）` : ''}` : (legacy || '（没有记录）');
        box.innerHTML = `
          <div class="st-bs-modal-title"></div>
          <div class="st-bs-modal-desc"></div>
          <div class="st-bs-preview-label">上一条</div>
          <div class="st-bs-preview-box st-bs-preview-nb"></div>
          <div class="st-bs-preview-label">内容</div>
          <div class="st-bs-preview-box st-bs-preview-content st-bs-preview-content-sub"></div>
          <div class="st-bs-preview-label">下一条</div>
          <div class="st-bs-preview-box st-bs-preview-nb"></div>
          <div class="st-bs-modal-actions"><button type="button" class="st-bs-btn" data-sub="back">返回</button></div>`;
        box.querySelector('.st-bs-modal-title').textContent = r.name;
        box.querySelector('.st-bs-modal-desc').textContent = sourceMetaText(r);
        const nbs = box.querySelectorAll('.st-bs-preview-nb');
        nbs[0].textContent = nbText(r.prev, r.prevName);
        nbs[1].textContent = nbText(r.next, '');
        const content = box.querySelector('.st-bs-preview-content');
        content.innerHTML = markHtml(r.prompt?.content || '', q) || '<span style="opacity:.6">（空）</span>';
        box.querySelector('[data-sub="back"]').onclick = back;
        const first = content.querySelector('mark.st-bs-hl');
        if (first) setTimeout(() => { content.scrollTop = Math.max(0, first.offsetTop - content.clientHeight / 3); }, 30);
      };

      /* 方案详情：按记录表排序 + 单点 / 区间 / 全选 + 查找/清空/高亮/开闭眼 + 添加/移除 */
      const drawDetail = (n, initSearch = null) => {
        const all = getRecords();
        const memberNames = sortByRecordOrder(getRecordSchemes()[n] || []);
        const members = memberNames.map((x) => all[x]);
        const toAdd = () => Array.from(ui.selected).filter((x) => hasOwn(all, x) && !memberNames.includes(x));
        const range = { on: false, anchor: null };
        const subSearch = initSearch ? { ...initSearch } : { open: false, q: '' };
        let shownSelectable = [];

        box.innerHTML = `
          <div class="st-bs-modal-title"></div>
          <div class="st-bs-rec-toolbar">
            <span class="st-bs-sel-empty" style="padding:0" data-role="cnt"></span>
            <div class="st-bs-rec-tools">
              <button type="button" class="st-bs-icon-btn st-bs-all-btn" data-sub="all">全选</button>
              <button type="button" class="st-bs-icon-btn" data-sub="range" title="区间选择：点开头和结尾，中间全选"><i class="fa-solid fa-arrows-up-down"></i></button>
              ${editable ? '<button type="button" class="st-bs-icon-btn st-bs-icon-danger" data-sub="remove" title="把已选条目移出这个方案"><i class="fa-solid fa-trash-can"></i></button>' : ''}
              <button type="button" class="st-bs-icon-btn" data-sub="search" title="查找"><i class="fa-solid fa-magnifying-glass"></i></button>
            </div>
          </div>
          <div class="st-bs-search-row" data-role="sub-searchrow">
            <div class="st-bs-search-capsule">
              <input type="text" class="st-bs-search-input" placeholder="查找名字或内容" />
              <button type="button" class="st-bs-search-clear" data-sub="clear" title="清空"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <button type="button" class="st-bs-icon-btn" data-sub="hl" title="高亮开关"></button>
          </div>
          <div class="st-bs-subpop-list st-bs-subpop-cards"></div>
          <div class="st-bs-modal-actions st-bs-modal-actions-wrap">
            <button type="button" class="st-bs-btn" data-sub="back">返回</button>
            ${editable ? '<button type="button" class="st-bs-btn" data-sub="add"></button>' : ''}
            <button type="button" class="st-bs-btn st-bs-btn-primary" data-sub="done">完成</button>
          </div>`;
        box.querySelector('.st-bs-modal-title').textContent = `${n}（${members.length} 条）`;

        const ul = box.querySelector('.st-bs-subpop-list');
        const searchRow = box.querySelector('[data-role="sub-searchrow"]');
        const searchInput = box.querySelector('.st-bs-search-input');
        const hlBtn = box.querySelector('[data-sub="hl"]');

        const sync = () => {
          const totalPicked = memberNames.filter((x) => !isExisting(all[x]) && ui.selected.has(x)).length;
          const shownPicked = shownSelectable.filter((x) => ui.selected.has(x)).length;
          box.querySelector('[data-role="cnt"]').textContent = `本方案已选 ${totalPicked} 条`;
          box.querySelector('[data-sub="all"]').textContent = shownSelectable.length && shownPicked === shownSelectable.length ? '清空' : '全选';
          box.querySelector('[data-sub="range"]').classList.toggle('active', range.on);
          ul.querySelectorAll('.st-bs-mini-card').forEach((el) => el.classList.toggle('selected', ui.selected.has(el.dataset.name)));
          const addBtn = box.querySelector('[data-sub="add"]');
          if (addBtn) addBtn.textContent = `添加已选 ${toAdd().length} 条`;
        };

        const renderSearch = () => {
          searchRow.style.display = subSearch.open ? '' : 'none';
          box.querySelector('[data-sub="search"]').classList.toggle('active', subSearch.open);
          hlBtn.innerHTML = isHighlightOn() ? '<i class="fa-solid fa-eye"></i>' : EYE_CLOSED_SVG;
          box.querySelector('[data-sub="clear"]').style.visibility = subSearch.q ? 'visible' : 'hidden';
        };

        const renderMembers = () => {
          const q = subSearch.q.trim(), ql = q.toLowerCase();
          const shown = q ? members.filter((r) => r.name.toLowerCase().includes(ql) || String(r.prompt?.content || '').toLowerCase().includes(ql)) : members;
          shownSelectable = shown.filter((r) => !isExisting(r)).map((r) => r.name);
          ul.innerHTML = '';
          if (!members.length) {
            ul.innerHTML = '<div class="st-bs-sel-empty">这个方案里还没有条目。在记录表里选好条目后，点下面的「添加已选」。</div>';
          } else if (!shown.length) {
            ul.innerHTML = '<div class="st-bs-sel-empty">没有找到匹配的条目。</div>';
          }
          shown.forEach((r) => {
            const exists = isExisting(r);
            const cardEl = document.createElement('div');
            cardEl.className = 'st-bs-record-row st-bs-record-card st-bs-mini-card' + (exists ? ' exists' : '');
            cardEl.dataset.name = r.name;
            cardEl.innerHTML = `<div class="st-bs-record-text"><div class="st-bs-record-name">${markHtml(r.name, q)}${exists ? '（当前预设里已有）' : ''}</div><div class="st-bs-record-preview">${previewHtml(r.prompt?.content, q)}</div></div>
              <div class="st-bs-record-side"><button type="button" class="st-bs-scheme-row-btn" title="查看完整内容"><i class="fa-solid fa-maximize"></i></button></div>`;
            cardEl.onclick = () => {
              if (exists) return;
              if (range.on) {
                ui.selected.add(r.name);
                if (!range.anchor) { range.anchor = r.name; notify('info', '已选开头，请再点结尾条目'); return sync(); }
                const i1 = shownSelectable.indexOf(range.anchor), i2 = shownSelectable.indexOf(r.name);
                if (i1 >= 0 && i2 >= 0) shownSelectable.slice(Math.min(i1, i2), Math.max(i1, i2) + 1).forEach((x) => ui.selected.add(x));
                notify('success', `已区间选中 ${Math.abs(i2 - i1) + 1} 条`);
                range.on = false; range.anchor = null;
                return sync();
              }
              if (ui.selected.has(r.name)) ui.selected.delete(r.name); else ui.selected.add(r.name);
              sync();
            };
            cardEl.querySelector('button').onclick = (e) => { e.stopPropagation(); drawPreview(r.name, subSearch.q.trim(), () => drawDetail(n, subSearch)); };
            ul.appendChild(cardEl);
          });
          sync();
        };

        searchInput.value = subSearch.q;
        searchInput.addEventListener('input', () => { subSearch.q = searchInput.value; renderSearch(); renderMembers(); });
        box.querySelector('[data-sub="clear"]').onclick = () => { subSearch.q = ''; searchInput.value = ''; renderSearch(); renderMembers(); searchInput.focus(); };
        hlBtn.onclick = () => { setHighlight(!isHighlightOn()); renderSearch(); renderMembers(); };
        box.querySelector('[data-sub="search"]').onclick = () => {
          subSearch.open = !subSearch.open;
          if (!subSearch.open) { subSearch.q = ''; searchInput.value = ''; renderMembers(); }
          renderSearch();
          if (subSearch.open) setTimeout(() => searchInput.focus(), 30);
        };
        box.querySelector('[data-sub="all"]').onclick = () => {
          if (!shownSelectable.length) return;
          const allPicked = shownSelectable.every((x) => ui.selected.has(x));
          shownSelectable.forEach((x) => (allPicked ? ui.selected.delete(x) : ui.selected.add(x)));
          sync();
        };
        box.querySelector('[data-sub="range"]').onclick = () => {
          const pickedIdx = shownSelectable.map((x, i) => (ui.selected.has(x) ? i : -1)).filter((i) => i >= 0);
          if (!range.on && pickedIdx.length >= 2) {
            const slice = shownSelectable.slice(pickedIdx[0], pickedIdx[pickedIdx.length - 1] + 1);
            slice.forEach((x) => ui.selected.add(x));
            notify('success', `已区间选中 ${slice.length} 条`);
            return sync();
          }
          range.on = !range.on;
          if (range.on) {
            range.anchor = pickedIdx.length === 1 ? shownSelectable[pickedIdx[0]] : null;
            notify('info', range.anchor ? '区间选择：请再点另一端条目' : '区间选择：请依次点开头和结尾条目');
          } else {
            range.anchor = null;
          }
          sync();
        };
        box.querySelector('[data-sub="remove"]')?.addEventListener('click', () => {
          const pick = memberNames.filter((x) => ui.selected.has(x));
          if (!pick.length) return notify('warning', '先在方案里选中要移出的条目');
          box.innerHTML = `
            <div class="st-bs-modal-title">移出方案（${pick.length} 条）</div>
            <div class="st-bs-modal-desc">把以下条目移出方案「${escapeHtml(n)}」吗？只是移出方案，记录表里的条目不会被删除。</div>
            <div class="st-bs-subpop-list"></div>
            <div class="st-bs-modal-actions">
              <button type="button" class="st-bs-btn" data-sub="no">取消</button>
              <button type="button" class="st-bs-btn st-bs-btn-danger" data-sub="yes">确认移出</button>
            </div>`;
          const delUl = box.querySelector('.st-bs-subpop-list');
          pick.forEach((x) => {
            const item = document.createElement('div');
            item.className = 'st-bs-sel-item';
            item.innerHTML = '<span class="st-bs-sel-name"></span>';
            item.querySelector('span').textContent = x;
            delUl.appendChild(item);
          });
          box.querySelector('[data-sub="no"]').onclick = () => drawDetail(n, subSearch);
          box.querySelector('[data-sub="yes"]').onclick = () => {
            const s = getRecordSchemes(); s[n] = sortByRecordOrder((s[n] || []).filter((x) => !pick.includes(x)));
            pick.forEach((x) => ui.selected.delete(x));
            saveRecords(); notify('success', `已从方案移出 ${pick.length} 条`); drawDetail(n, subSearch);
          };
        });
        box.querySelector('[data-sub="add"]')?.addEventListener('click', () => {
          const add = toAdd();
          if (!add.length) return notify('warning', '先在记录表里选中要加进来的条目（已经在方案里的不算）');
          const s = getRecordSchemes(); s[n] = sortByRecordOrder([...(s[n] || []), ...add]);
          saveRecords(); notify('success', `已添加 ${add.length} 条到方案「${n}」`); drawDetail(n, subSearch);
        });
        box.querySelector('[data-sub="back"]').onclick = drawList;
        box.querySelector('[data-sub="done"]').onclick = done;

        renderSearch();
        renderMembers();
      };

      drawList();
    });
  }

  /* ---------- 新增·自动：导入时记下作者原有条目，之后新出现的自动进记录表 ---------- */
  function onPresetImportReady(ev) {
    const data = ev?.data;
    if (!data || !Array.isArray(data.prompts)) return;
    data.extensions ||= {};
    data.extensions.stBulkSchemeHelper ||= {};
    data.extensions.stBulkSchemeHelper.baseIds = data.prompts.map((p) => p?.identifier).filter(Boolean);
    data.extensions.stBulkSchemeHelper.insertedIds = [];
    data.extensions.stBulkSchemeHelper.merged = {};
  }

  let autoTimer = null;
  function scheduleAutoRecord() { clearTimeout(autoTimer); autoTimer = setTimeout(autoRecordPass, 1500); }

  function autoRecordPass() {
    if (state.inserting) return scheduleAutoRecord();
    if (!isPresetDataReady()) return;
    const ext = openaiMod?.oai_settings?.extensions?.stBulkSchemeHelper;
    if (!Array.isArray(ext?.baseIds)) return;
    const pm = getPM(), order = getPresetOrder();
    if (!pm || !Array.isArray(order)) return;
    const base = new Set(ext.baseIds), inserted = new Set(ext.insertedIds || []);
    const records = getRecords(), pname = getPresetName();
    let changed = 0;
    order.forEach((o) => {
      const id = o.identifier;
      if (base.has(id) || inserted.has(id)) return;
      const p = pm.getPromptById?.(id);
      if (!isRecordable(p)) return;
      const rec = makeRecord(p, 'auto', order);
      const prev = Object.values(records).find((r) => r?.kind === 'auto' && r.srcId === id && r.sourcePreset === pname);
      if (!prev && hasOwn(records, rec.name) && records[rec.name].kind !== 'auto') return; // 不覆盖手动存底
      const same = prev && prev.name === rec.name && prev.enabled === rec.enabled
        && JSON.stringify(prev.prompt) === JSON.stringify(rec.prompt)
        && JSON.stringify(prev.prev) === JSON.stringify(rec.prev) && JSON.stringify(prev.next) === JSON.stringify(rec.next);
      if (same) return;
      if (prev && prev.name !== rec.name) delete records[prev.name];
      records[rec.name] = rec; changed++;
    });
    if (changed) saveRecords();
  }

  function bindEvents() {
    let pt = null, wt = null;
    const pRoot = document.querySelector('#completion_prompt_manager');
    if (pRoot) new MutationObserver(() => {
      clearTimeout(pt); pt = setTimeout(() => {
        mountBars(); refreshSchemeButton('preset');
        if (state.preset.bulk) injectCheckboxes('preset');
        injectInsertButtons();
        updateDockUI();
        scheduleAutoRecord();
      }, 70);
    }).observe(pRoot, { childList: true, subtree: true });

    const wList = document.querySelector('#world_popup_entries_list');
    if (wList) new MutationObserver(() => {
      if (!state.world.bulk) return;
      clearTimeout(wt); wt = setTimeout(() => { injectCheckboxes('world'); updateDockUI(); }, 70);
    }).observe(wList, { childList: true });

    document.addEventListener('change', (e) => {
      if (e.target?.id === 'settings_preset_openai') {
        state.preset.selected.clear();
        setTimeout(() => { refreshSchemeButton('preset'); if (state.preset.bulk) injectCheckboxes('preset'); updateDockUI(); }, 150);
      } else if (e.target?.id === 'world_editor_select') {
        state.world.selected.clear();
        setTimeout(() => { refreshSchemeButton('world'); if (state.world.bulk) injectCheckboxes('world'); updateDockUI(); }, 180);
      }
    });

    // BaiBai 预设搜索：过滤结果变化后（它自己有 150ms 防抖）重新数一遍条目
    let searchTimer = null;
    const onBaiBaiSearch = (e) => {
      if (!state.preset.bulk || !e.target?.closest?.('.bai-bai-preset-search-input, .bai-bai-preset-search-clear, .bai-bai-preset-search-toggle')) return;
      clearTimeout(searchTimer); searchTimer = setTimeout(() => { injectCheckboxes('preset'); updateDockUI(); }, 300);
    };
    ['input', 'compositionend', 'keyup', 'click'].forEach((t) => document.addEventListener(t, onBaiBaiSearch, true));

    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t?.closest) return;
      if (t.closest('.drawer-toggle, .drawer-icon, #top-bar')) {
        setTimeout(() => { mountBars(); refreshSchemeButton('preset'); refreshSchemeButton('world'); updateDockUI(); }, 150);
      }
    });

    window.addEventListener('resize', () => {
      if (state.activeDockMode) updateDockUI();
      const bd = document.getElementById('st-bs-modal-backdrop');
      if (bd?.classList.contains('open')) bd.style.height = `${window.innerHeight}px`;
    });

    const ctx = getCtx();
    if (ctx.eventSource && ctx.event_types) {
      if (ctx.event_types.OAI_PRESET_CHANGED_BEFORE) ctx.eventSource.on(ctx.event_types.OAI_PRESET_CHANGED_BEFORE, () => {
        state.presetSwitching = true;
        state.preset.selected.clear(); state.preset.rangeMode = false; state.preset.rangeAnchor = null;
      });
      if (ctx.event_types.OAI_PRESET_CHANGED_AFTER) ctx.eventSource.on(ctx.event_types.OAI_PRESET_CHANGED_AFTER, () => {
        state.presetSwitching = false;
        mountBars(); refreshSchemeButton('preset');
        if (state.preset.bulk) injectCheckboxes('preset');
        updateDockUI();
      });
      if (ctx.event_types.OAI_PRESET_IMPORT_READY) ctx.eventSource.on(ctx.event_types.OAI_PRESET_IMPORT_READY, onPresetImportReady);
      const sync = () => { mountBars(); refreshSchemeButton('preset'); refreshSchemeButton('world'); updateDockUI(); };
      if (ctx.event_types.SETTINGS_LOADED) ctx.eventSource.on(ctx.event_types.SETTINGS_LOADED, sync);
      if (ctx.event_types.PRESET_CHANGED) ctx.eventSource.on(ctx.event_types.PRESET_CHANGED, sync);
      if (ctx.event_types.CHAT_CHANGED) ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, (cid) => scheduleChatBindApply(cid));
    }

    setInterval(() => { if (state.preset.bulk || state.world.bulk) updateDockUI(); }, 450);
    setInterval(() => {
      const panel = document.getElementById('left-nav-panel');
      if (panel && !panel.classList.contains('openDrawer')) {
        document.getElementById('st-bs-collapse-group-btn')?.classList.remove('visible');
        return;
      }
      updateCollapseBtn();
    }, 400);
  }

  async function init() {
    try {
      openaiMod = await tryImport(['../../../openai.js', '/scripts/openai.js']);
      wiMod = await tryImport(['../../../world-info.js', '/scripts/world-info.js']);
      ensureDock();
      mountBars();
      bindEvents();
      console.log('[批量编辑与开关方案助手] v1.1.0 已加载');
    } catch (err) {
      console.error('[批量编辑与开关方案助手] 初始化异常:', err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 700));
  else setTimeout(init, 700);
})();
