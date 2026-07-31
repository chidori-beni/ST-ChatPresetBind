/**
 * ST-ChatPresetBind · 聊天预设绑定插件
 * Author: chidori
 * Version: 1.1.5
 *
 * 新增：每个聊天可绑定多个配置快照，支持命名、设为默认、一键应用
 * 1.1.5：提示词开关改为读写 oai_settings.prompt_order 数据源，不再依赖 DOM 渲染
 */

'use strict';

// ─── 常量 ────────────────────────────────────────────────────────────────────
const MODULE   = 'chat_preset_bind';
const VERSION  = '1.1.5';
const META_KEY = 'cpb_snapshots';   // 存快照列表（数组）
const PANEL_ID = 'cpb_panel';
const ENTRY_ID = 'cpb_menu_entry';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function ctx() { return SillyTavern.getContext(); }

function getCurrentChatId() {
    const context = ctx();
    if (typeof context.getCurrentChatId === 'function') return context.getCurrentChatId();
    const active = document.querySelector('#select_chat_div .chat_file_select.active');
    return active ? active.getAttribute('data-file') || null : null;
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escHtml(str) {
    return String(str)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function shortId(id) {
    const base = id.replace(/\.jsonl?$/i, '');
    return base.length > 28 ? '…' + base.slice(-28) : base;
}

function uuidShort() {
    return Math.random().toString(36).slice(2, 8);
}

function formatTime(ts) {
    return new Date(ts).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

// ─── 数据源读取（替代 DOM 抓取）───────────────────────────────────────────────

function getOaiSettings() {
    const c = ctx();
    return c.chatCompletionSettings || window.oai_settings || null;
}

function getTextGenSettings() {
    const c = ctx();
    return c.textCompletionSettings || window.textgenerationwebui_settings || null;
}

function getApiType() {
    const c = ctx();
    return c.mainApi || c.main_api || window.main_api?.value || null;
}

/**
 * 取当前生效的 prompt_order 数组（返回的是引用，可直接改）
 * ST 结构：oai_settings.prompt_order = [{ character_id, order: [{identifier, enabled}] }]
 * 全局排序策略使用 dummy id 100001
 */
function getLivePromptOrder() {
    const oai = getOaiSettings();
    if (!oai || !Array.isArray(oai.prompt_order) || !oai.prompt_order.length) return null;
    const list = oai.prompt_order;
    const charId = ctx().characterId;

    let entry = list.find(e => Number(e.character_id) === 100001);
    if (!entry && charId !== undefined && charId !== null) {
        entry = list.find(e => String(e.character_id) === String(charId));
    }
    if (!entry) {
        entry = list.reduce((a, b) => ((b.order?.length || 0) > (a.order?.length || 0) ? b : a), list[0]);
    }
    return Array.isArray(entry?.order) ? entry.order : null;
}

/** identifier → 显示名，方便快照里留个人类可读的记录 */
function getPromptNameMap() {
    const oai = getOaiSettings();
    const map = {};
    (oai?.prompts || []).forEach(p => { if (p?.identifier) map[p.identifier] = p.name || p.identifier; });
    return map;
}

/** 只改图标外观，不触发 ST 的 click 处理（数据已单独写过了，避免二次翻转） */
function syncPromptToggleIcons(order) {
    order.forEach(({ identifier, enabled }) => {
        let row = null;
        try { row = document.querySelector(`[data-pm-identifier="${CSS.escape(identifier)}"]`); } catch { return; }
        const toggle = row?.querySelector('.prompt-manager-toggle-action');
        if (!toggle) return;
        toggle.classList.toggle('fa-toggle-on', !!enabled);
        toggle.classList.toggle('fa-toggle-off', !enabled);
    });
}

/** 按 API 类型拿到对应的生成参数对象 */
function getGenSettingsObject(apiType) {
    const api = apiType || getApiType();
    switch (api) {
        case 'openai':
        case 'claude':
            return getOaiSettings();
        case 'textgenerationwebui':
            return getTextGenSettings();
        case 'kobold':
            return window.koboldai_settings || null;
        case 'novel':
            return window.nai_settings || null;
        default:
            return getOaiSettings();   // 中转站基本都走 chat completion
    }
}

// ─── 预设切换 ─────────────────────────────────────────────────────────────────

function normalizePresetName(name) {
    return String(name).replace(/\s+/g, ' ').trim();
}

async function switchPreset(presetName) {
    return switchPresetViaDOM(presetName);
}

function switchPresetViaDOM(presetName) {
    const targetNorm = normalizePresetName(presetName);
    const SELECTORS = [
        '#settings_preset_openai', '#settings_preset',
        '#openai_preset_name', '#textgenerationwebui_preset',
        'select[name="settings_preset"]',
    ];
    let selectEl = null, matchedOption = null;

    for (const sel of SELECTORS) {
        const el = document.querySelector(sel);
        if (el?.tagName === 'SELECT') {
            const opt = Array.from(el.options).find(o =>
                normalizePresetName(o.text) === targetNorm ||
                normalizePresetName(o.value) === targetNorm
            );
            if (opt) { selectEl = el; matchedOption = opt; break; }
        }
    }
    if (!selectEl) {
        for (const sel of document.querySelectorAll('select')) {
            const opt = Array.from(sel.options).find(o =>
                normalizePresetName(o.text) === targetNorm ||
                normalizePresetName(o.value) === targetNorm
            );
            if (opt) { selectEl = sel; matchedOption = opt; break; }
        }
    }
    if (!selectEl || !matchedOption) {
        console.warn(`[${MODULE}] 找不到预设 "${presetName}"`);
        return false;
    }
    selectEl.value = matchedOption.value;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`[${MODULE}] 预设切换成功 → "${presetName}"`);
    return true;
}

// ─── 快照：捕获 ──────────────────────────────────────────────────────────────

function captureSnapshot(label) {
    const context = ctx();
    const pm = context.getPresetManager ? context.getPresetManager() : null;
    const rawName = pm ? pm.getSelectedPresetName() : null;
    const presetName = rawName ? normalizePresetName(rawName) : null;
    const apiType = getApiType();

    // 提示词开关：优先读 oai_settings.prompt_order（真实数据源）
    let promptOrder = null;
    try {
        const live = getLivePromptOrder();
        if (live && live.length) {
            const nameMap = getPromptNameMap();
            promptOrder = live.map(o => ({
                identifier: o.identifier,
                enabled: !!o.enabled,
                name: nameMap[o.identifier],
            }));
        } else {
            // 兜底：老路子扒 DOM（只在真的抓到多条时才认）
            const rows = document.querySelectorAll('[data-pm-identifier]');
            if (rows.length > 1) {
                promptOrder = [];
                rows.forEach(row => {
                    const identifier = row.getAttribute('data-pm-identifier');
                    if (!identifier) return;
                    const toggle = row.querySelector('.prompt-manager-toggle-action');
                    promptOrder.push({ identifier, enabled: toggle ? toggle.classList.contains('fa-toggle-on') : true });
                });
            }
        }
        if (!promptOrder || !promptOrder.length) {
            promptOrder = null;
            console.warn(`[${MODULE}] 未能读取提示词开关状态（prompt_order 为空）`);
        }
    } catch (e) { console.warn(`[${MODULE}] 捕获 promptOrder 失败:`, e); }

    // 生成参数
    let genSettings = null;
    try {
        const GEN_KEYS = [
            'temperature','max_tokens','max_length','top_p','top_k','top_a','min_p',
            'rep_pen','rep_pen_range','mirostat_mode','mirostat_tau','mirostat_eta',
            'temp','freq_pen','pres_pen','top_p_openai','max_context','openai_max_tokens',
        ];
        const src = getGenSettingsObject(apiType) || {};
        const obj = {};
        GEN_KEYS.forEach(k => { if (k in src) obj[k] = src[k]; });
        if (Object.keys(obj).length) genSettings = obj;
    } catch (e) { console.warn(`[${MODULE}] 捕获 genSettings 失败:`, e); }

    // 自动命名：预设名 + 时间
    const autoLabel = `${presetName || '未知预设'} ${formatTime(Date.now())}`;

    return {
        id: uuidShort(),
        label: label || autoLabel,
        presetName,
        apiType,
        promptOrder,
        genSettings,
        capturedAt: Date.now(),
    };
}

// ─── 快照：恢复 ──────────────────────────────────────────────────────────────

async function applySnapshot(snapshot) {
    if (!snapshot) return;

    const needsSwitch = snapshot.presetName && (() => {
        const pm = ctx().getPresetManager?.();
        const cur = pm ? normalizePresetName(pm.getSelectedPresetName() || '') : '';
        return cur !== snapshot.presetName;
    })();

    if (needsSwitch) {
        const { eventSource, event_types } = ctx();
        const onPresetChanged = () => {
            eventSource.removeListener(event_types.PRESET_CHANGED, onPresetChanged);
            restorePromptOrderAndGen(snapshot);
        };
        eventSource.once
            ? eventSource.once(event_types.PRESET_CHANGED, onPresetChanged)
            : eventSource.on(event_types.PRESET_CHANGED, onPresetChanged);

        const ok = await switchPreset(snapshot.presetName);
        if (!ok) {
            eventSource.removeListener(event_types.PRESET_CHANGED, onPresetChanged);
            toastr.warning(`未能切换到预设「${snapshot.presetName}」`, '聊天预设绑定');
        }
        setTimeout(() => eventSource.removeListener(event_types.PRESET_CHANGED, onPresetChanged), 3000);
    } else {
        restorePromptOrderAndGen(snapshot);
    }
}

function restorePromptOrderAndGen(snapshot) {
    if (snapshot.promptOrder?.length > 0) {
        // 切预设后 prompt_order 会被整体替换，留点缓冲
        setTimeout(() => {
            try {
                const live = getLivePromptOrder();
                if (!live) {
                    console.warn(`[${MODULE}] 未取到 prompt_order，跳过提示词恢复`);
                    return;
                }
                const wanted = new Map(snapshot.promptOrder.map(p => [p.identifier, !!p.enabled]));
                let adjusted = 0;
                live.forEach(item => {
                    if (!wanted.has(item.identifier)) return;
                    const val = wanted.get(item.identifier);
                    if (!!item.enabled !== val) { item.enabled = val; adjusted++; }
                });
                const missing = snapshot.promptOrder.filter(
                    p => !live.some(i => i.identifier === p.identifier)
                ).length;

                ctx().saveSettingsDebounced?.();
                syncPromptToggleIcons(live);
                console.log(`[${MODULE}] 提示词开关恢复 ${adjusted} 项` + (missing ? `，${missing} 项在当前预设中不存在` : ''));
            } catch (e) { console.warn(`[${MODULE}] 恢复 promptOrder 失败:`, e); }
        }, 500);
    }
    if (snapshot.genSettings) {
        setTimeout(() => {
            try { restoreGenSettings(snapshot.genSettings, snapshot.apiType); }
            catch (e) { console.warn(`[${MODULE}] 恢复 genSettings 失败:`, e); }
        }, 300);
    }
}

function restoreGenSettings(settings, apiType) {
    if (!settings) return;
    const target = getGenSettingsObject(apiType);
    if (!target) return;
    let changed = false;
    Object.entries(settings).forEach(([key, val]) => {
        if (key in target && target[key] !== val) {
            target[key] = val; changed = true;
            const el = document.getElementById(key) || document.querySelector(`[name="${key}"]`);
            if (el) {
                el.type === 'checkbox' ? (el.checked = !!val) : (el.value = val);
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    });
    if (changed) ctx().saveSettingsDebounced?.();
}

// ─── chatMetadata 操作 ────────────────────────────────────────────────────────
// 数据结构：{ snapshots: [...], defaultId: 'xxx' }

function loadData() {
    const { chatMetadata } = ctx();
    const raw = chatMetadata?.[META_KEY];
    if (!raw) return { snapshots: [], defaultId: null };
    // 兼容旧版单快照格式
    if (raw.presetName !== undefined || raw.promptOrder !== undefined) {
        const migrated = { ...raw, id: uuidShort(), label: raw.presetName || '已迁移配置' };
        return { snapshots: [migrated], defaultId: migrated.id };
    }
    return { snapshots: raw.snapshots || [], defaultId: raw.defaultId || null };
}

async function saveData(data) {
    const context = ctx();
    context.chatMetadata[META_KEY] = data;
    await context.saveMetadata();
}

// ─── UI 面板 ──────────────────────────────────────────────────────────────────

function buildPanel() {
    document.getElementById(PANEL_ID)?.remove();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'cpb-panel';
    panel.innerHTML = `
        <div class="cpb-header">
            <span class="cpb-title"><i class="fa-solid fa-link"></i> 聊天预设绑定</span>
            <div class="cpb-header-right">
                <span class="cpb-version">v${VERSION}</span>
                <button class="cpb-close-btn" id="cpb_btn_close"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="cpb-body">
            <div class="cpb-status-block" id="cpb_status"></div>

            <div class="cpb-actions">
                <button id="cpb_btn_save" class="cpb-btn cpb-btn-primary">
                    <i class="fa-solid fa-floppy-disk"></i> 保存当前配置
                </button>
            </div>

            <div class="cpb-divider"></div>
            <div class="cpb-section-title">已保存的配置</div>
            <div id="cpb_list" class="cpb-list"></div>
            <div class="cpb-divider"></div>

            <div class="cpb-option-row">
                <label class="cpb-checkbox-label">
                    <input type="checkbox" id="cpb_opt_auto_apply" />
                    <span>切换聊天时自动应用默认配置</span>
                </label>
            </div>
            <div class="cpb-option-row">
                <label class="cpb-checkbox-label">
                    <input type="checkbox" id="cpb_opt_save_gen" />
                    <span>包含生成参数</span>
                </label>
            </div>
            <div class="cpb-option-row">
                <label class="cpb-checkbox-label">
                    <input type="checkbox" id="cpb_opt_save_prompt" />
                    <span>包含提示词开关状态</span>
                </label>
            </div>
        </div>`;
    return panel;
}

function refreshPanel() {
    const statusEl = document.getElementById('cpb_status');
    const listEl   = document.getElementById('cpb_list');
    if (!statusEl || !listEl) return;

    const chatId = getCurrentChatId();
    const data   = loadData();
    const { snapshots, defaultId } = data;

    // 状态栏
    statusEl.innerHTML = `
        <span class="cpb-badge ${snapshots.length ? 'cpb-badge-bound' : 'cpb-badge-none'}">
            ${snapshots.length ? snapshots.length + ' 个配置' : '未绑定'}
        </span>
        <span class="cpb-chat-id">${chatId ? escHtml(shortId(chatId)) : '无活动聊天'}</span>`;

    // 列表
    if (!snapshots.length) {
        listEl.innerHTML = '<div class="cpb-empty">此聊天暂无保存的配置</div>';
        return;
    }

    listEl.innerHTML = snapshots.map(snap => `
        <div class="cpb-item ${snap.id === defaultId ? 'cpb-item-default' : ''}" data-id="${snap.id}">
            <div class="cpb-item-header">
                <span class="cpb-item-label" title="${escHtml(snap.label)}">${escHtml(snap.label)}</span>
                <div class="cpb-item-actions">
                    <button class="cpb-icon-btn cpb-btn-apply" title="应用此配置" data-id="${snap.id}">
                        <i class="fa-solid fa-play"></i>
                    </button>
                    <button class="cpb-icon-btn cpb-btn-default ${snap.id === defaultId ? 'cpb-active' : ''}"
                        title="${snap.id === defaultId ? '取消默认' : '设为默认'}" data-id="${snap.id}">
                        <i class="fa-solid fa-star"></i>
                    </button>
                    <button class="cpb-icon-btn cpb-btn-update" title="用当前配置覆盖此快照" data-id="${snap.id}">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                    <button class="cpb-icon-btn cpb-btn-rename" title="重命名" data-id="${snap.id}">
                        <i class="fa-solid fa-pencil"></i>
                    </button>
                    <button class="cpb-icon-btn cpb-btn-delete caution" title="删除" data-id="${snap.id}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="cpb-item-meta">
                <span>${escHtml(snap.presetName || '未知预设')}</span>
                <span class="cpb-dot">·</span>
                <span>${snap.promptOrder ? snap.promptOrder.filter(p=>p.enabled).length+'/'+snap.promptOrder.length+' 条' : '不含提示词'}</span>
                <span class="cpb-dot">·</span>
                <span>${formatTime(snap.capturedAt)}</span>
            </div>
        </div>
    `).join('');

    // 列表事件委托
    listEl.onclick = async (e) => {
        const applyBtn  = e.target.closest('.cpb-btn-apply');
        const defBtn    = e.target.closest('.cpb-btn-default');
        const renameBtn = e.target.closest('.cpb-btn-rename');
        const deleteBtn = e.target.closest('.cpb-btn-delete');

        if (applyBtn) {
            const snap = data.snapshots.find(s => s.id === applyBtn.dataset.id);
            if (snap) { await applySnapshot(snap); toastr.success(`已应用「${snap.label}」`, '聊天预设绑定'); }
        }
        if (defBtn) {
            const id = defBtn.dataset.id;
            data.defaultId = data.defaultId === id ? null : id;
            await saveData(data); refreshPanel();
        }
        const updateBtn = e.target.closest('.cpb-btn-update');
        if (updateBtn) {
            const snap = data.snapshots.find(s => s.id === updateBtn.dataset.id);
            if (!snap) return;
            const settings = getSettings();
            const fresh = captureSnapshot(snap.label); // 保留原来的名字
            fresh.id = snap.id;                        // 保留原来的ID
            if (!settings.saveGen)    fresh.genSettings  = null;
            if (!settings.savePrompt) fresh.promptOrder  = null;
            data.snapshots = data.snapshots.map(s => s.id === snap.id ? fresh : s);
            await saveData(data); refreshPanel();
            toastr.success(`已更新「${snap.label}」`, '聊天预设绑定');
        }
        if (renameBtn) {
            const snap = data.snapshots.find(s => s.id === renameBtn.dataset.id);
            if (!snap) return;
            const newName = prompt('重命名配置', snap.label);
            if (newName && newName.trim()) {
                snap.label = newName.trim();
                await saveData(data); refreshPanel();
            }
        }
        if (deleteBtn) {
            const id = deleteBtn.dataset.id;
            data.snapshots = data.snapshots.filter(s => s.id !== id);
            if (data.defaultId === id) data.defaultId = null;
            await saveData(data); refreshPanel();
            toastr.info('已删除配置', '聊天预设绑定');
        }
    };
}

function syncOptions() {
    const s = getSettings();
    const a = document.getElementById('cpb_opt_auto_apply');
    const g = document.getElementById('cpb_opt_save_gen');
    const p = document.getElementById('cpb_opt_save_prompt');
    if (a) a.checked = s.autoApply;
    if (g) g.checked = s.saveGen;
    if (p) p.checked = s.savePrompt;
}

// ─── 插件设置 ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = Object.freeze({ autoApply: true, saveGen: true, savePrompt: true });

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(DEFAULT_SETTINGS);
    const s = extensionSettings[MODULE];
    Object.keys(DEFAULT_SETTINGS).forEach(k => { if (!(k in s)) s[k] = DEFAULT_SETTINGS[k]; });
    return s;
}

function saveExtSettings() { ctx().saveSettingsDebounced?.(); }

// ─── 事件绑定 ─────────────────────────────────────────────────────────────────

function bindPanelEvents() {
    document.getElementById('cpb_btn_close')?.addEventListener('click', () => {
        document.getElementById(PANEL_ID).style.display = 'none';
    });

    makeDraggable(document.getElementById(PANEL_ID), document.querySelector('.cpb-header'));

    document.getElementById('cpb_btn_save')?.addEventListener('click', async () => {
        const settings = getSettings();
        const snap = captureSnapshot();
        if (!settings.saveGen)    snap.genSettings  = null;
        if (!settings.savePrompt) snap.promptOrder  = null;

        const data = loadData();
        // 如果是第一个，自动设为默认
        if (!data.snapshots.length) data.defaultId = snap.id;
        data.snapshots.push(snap);
        await saveData(data);
        refreshPanel();
        toastr.success(`已保存「${snap.label}」`, '聊天预设绑定');
    });

    document.getElementById('cpb_opt_auto_apply')?.addEventListener('change', e => { getSettings().autoApply = e.target.checked; saveExtSettings(); });
    document.getElementById('cpb_opt_save_gen')?.addEventListener('change',   e => { getSettings().saveGen   = e.target.checked; saveExtSettings(); });
    document.getElementById('cpb_opt_save_prompt')?.addEventListener('change',e => { getSettings().savePrompt= e.target.checked; saveExtSettings(); });
}

// ─── 菜单入口 ─────────────────────────────────────────────────────────────────

function injectMenuEntry() {
    if (document.getElementById(ENTRY_ID)) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;

    const item = document.createElement('div');
    item.id = ENTRY_ID;
    item.className = 'list-group-item flex-container flexGap5';
    item.innerHTML = `<i class="fa-solid fa-link extensionsMenuExtensionButton"></i><span>聊天预设绑定</span>`;

    item.addEventListener('click', () => {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const isHidden = panel.style.display === 'none' || panel.style.display === '';
        if (isHidden) {
            panel.style.transform = 'none';
            panel.style.left = '-9999px';
            panel.style.top  = '-9999px';
            panel.style.display = 'block';
            refreshPanel(); syncOptions();
            requestAnimationFrame(() => {
                const left = Math.max(8, Math.round((window.innerWidth  - panel.offsetWidth)  / 2));
                const top  = Math.max(8, Math.round((window.innerHeight - panel.offsetHeight) / 2));
                panel.style.left = left + 'px';
                panel.style.top  = top  + 'px';
            });
        } else {
            panel.style.display = 'none';
        }
    });

    try {
        const ch = menu.children;
        ch.length > 15 ? ch[15].after(item) : menu.appendChild(item);
    } catch { menu.appendChild(item); }

    document.body.appendChild(buildPanel());
    bindPanelEvents();
    syncOptions();
}

// ─── 核心逻辑 ─────────────────────────────────────────────────────────────────

let _lastChatId = null;

async function onChatChanged() {
    const currentChatId = getCurrentChatId();

    // 只有聊天窗口真正切换时才自动应用，同一聊天内的预设切换不触发
    const chatActuallyChanged = currentChatId !== _lastChatId;
    _lastChatId = currentChatId;

    refreshPanel();

    if (!chatActuallyChanged) return;

    const settings = getSettings();
    if (!settings.autoApply) return;
    const data = loadData();
    if (!data.defaultId || !data.snapshots.length) return;
    const snap = data.snapshots.find(s => s.id === data.defaultId);
    if (snap) await applySnapshot(snap);
}

// ─── 拖拽 ─────────────────────────────────────────────────────────────────────

function makeDraggable(panel, handle) {
    if (!panel || !handle) return;
    let startX, startY, startLeft, startTop, isDragging = false;

    function clamp(left, top) {
        return {
            left: Math.max(0, Math.min(left, window.innerWidth  - panel.offsetWidth)),
            top:  Math.max(0, Math.min(top,  window.innerHeight - panel.offsetHeight)),
        };
    }
    function onStart(cx, cy) {
        panel.style.transform = 'none';
        isDragging = true;
        startX = cx; startY = cy;
        startLeft = parseFloat(panel.style.left);
        startTop  = parseFloat(panel.style.top);
        panel.style.userSelect = 'none';
    }
    function onMove(cx, cy) {
        if (!isDragging) return;
        const { left, top } = clamp(startLeft + cx - startX, startTop + cy - startY);
        panel.style.left = left + 'px'; panel.style.top = top + 'px';
    }
    function onEnd() { isDragging = false; panel.style.userSelect = ''; }

    handle.addEventListener('mousedown', e => { if (!e.target.closest('.cpb-close-btn')) onStart(e.clientX, e.clientY); });
    document.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
    document.addEventListener('mouseup', onEnd);

    handle.addEventListener('touchstart', e => {
        if (e.target.closest('.cpb-close-btn')) return;
        onStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    document.addEventListener('touchmove', e => {
        if (!isDragging) return;
        e.preventDefault();
        onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    document.addEventListener('touchend', onEnd);
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

(function init() {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, () => { injectMenuEntry(); refreshPanel(); });
    eventSource.on(event_types.CHAT_CHANGED, debounce(onChatChanged, 400));
})();
