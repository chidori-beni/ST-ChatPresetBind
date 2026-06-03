/**
 * ST-ChatPresetBind · 聊天预设绑定插件
 * Author: chidori
 * Version: 1.0.1
 *
 * 修复：
 * - 预设切换改用 DOM select 触发，确保 ST 内部状态正确更新
 * - 面板增加关闭按钮
 */

'use strict';

// ─── 常量 ────────────────────────────────────────────────────────────────────
const MODULE   = 'chat_preset_bind';
const META_KEY = 'cpb_snapshot';
const PANEL_ID = 'cpb_panel';
const ENTRY_ID = 'cpb_menu_entry';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function ctx() {
    return SillyTavern.getContext();
}

function getCurrentChatId() {
    const context = ctx();
    if (typeof context.getCurrentChatId === 'function') {
        return context.getCurrentChatId();
    }
    const active = document.querySelector('#select_chat_div .chat_file_select.active');
    if (active) return active.getAttribute('data-file') || null;
    return null;
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortId(id) {
    const base = id.replace(/\.jsonl?$/i, '');
    return base.length > 32 ? '…' + base.slice(-32) : base;
}

// ─── 预设切换（核心修复） ─────────────────────────────────────────────────────

/**
 * 切换预设的正确方式：
 * 找到页面上的预设下拉框，设置对应值，然后触发 change 事件。
 * ST 的预设下拉框 id 因 API 类型不同而不同：
 *   Chat Completion (openai/claude 等) → #settings_preset
 *   Text Completion (textgenerationwebui 等) → #settings_preset
 *   （实际上都是同一个 id，ST 会根据当前 API 动态替换内容）
 */
/**
 * 标准化预设名：去掉首尾空白、把连续空白（含换行）合并为单个空格
 * 解决预设名含 \n 导致字符串比较失败的问题
 */
function normalizePresetName(name) {
    return String(name).replace(/\s+/g, ' ').trim();
}

async function switchPreset(presetName) {
    // 始终用 DOM 方式——最稳定，且能处理含换行的预设名
    return switchPresetViaDOM(presetName);
}

/**
 * 通过操作 DOM 下拉框切换预设
 * 比较时对 option text/value 和 presetName 都做 normalize，
 * 避免换行符、多余空白导致匹配失败。
 */
function switchPresetViaDOM(presetName) {
    const targetNorm = normalizePresetName(presetName);

    const SELECTORS = [
        '#settings_preset',
        '#openai_preset_name',
        '#textgenerationwebui_preset',
        'select[name="settings_preset"]',
    ];

    let selectEl = null;
    let matchedOption = null;

    for (const sel of SELECTORS) {
        const el = document.querySelector(sel);
        if (el && el.tagName === 'SELECT') {
            const opt = Array.from(el.options).find(o =>
                normalizePresetName(o.text) === targetNorm ||
                normalizePresetName(o.value) === targetNorm
            );
            if (opt) { selectEl = el; matchedOption = opt; break; }
        }
    }

    if (!selectEl) {
        const allSelects = document.querySelectorAll('select');
        for (const sel of allSelects) {
            const opt = Array.from(sel.options).find(o =>
                normalizePresetName(o.text) === targetNorm ||
                normalizePresetName(o.value) === targetNorm
            );
            if (opt) { selectEl = sel; matchedOption = opt; break; }
        }
    }

    if (!selectEl) {
        console.warn(`[${MODULE}] 找不到预设下拉框，无法切换到 "${presetName}"`);
        return false;
    }

    // 找到对应 option
    if (!selectEl || !matchedOption) {
        // 调试：打印页面上所有 select 的信息
        const debugSelects = document.querySelectorAll('select');
        console.group(`[${MODULE}] 调试：找不到预设 "${targetNorm}"，页面共 ${debugSelects.length} 个 select`);
        debugSelects.forEach((s, i) => {
            if (s.options.length > 0) {
                const optTexts = Array.from(s.options).slice(0, 5).map(o => `"${normalizePresetName(o.text)}"`).join(', ');
                console.log(`[${i}] id="${s.id}" name="${s.name}" options(前5): ${optTexts}`);
            }
        });
        console.groupEnd();
        console.warn(`[${MODULE}] 找不到预设 "${presetName}"（normalized: "${targetNorm}"）`);
        return false;
    }

    selectEl.value = matchedOption.value;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`[${MODULE}] 预设切换成功 → "${presetName}"`);
    return true;
}

// ─── 快照：捕获 ──────────────────────────────────────────────────────────────

function captureSnapshot() {
    const context = ctx();

    // 1. 预设名
    const pm = context.getPresetManager ? context.getPresetManager() : null;
    const rawPresetName = pm ? pm.getSelectedPresetName() : null;
    const presetName = rawPresetName ? normalizePresetName(rawPresetName) : null;

    // 2. API类型
    const apiType = context.main_api || null;

    // 3. 提示词开关——读取 DOM 中 toggle span 的 class 判断开/关
    //    ST 用 fa-toggle-on / fa-toggle-off 表示状态，没有 checkbox
    let promptOrder = null;
    try {
        const rows = document.querySelectorAll('[data-pm-identifier]');
        if (rows.length > 0) {
            promptOrder = [];
            rows.forEach(row => {
                const identifier = row.getAttribute('data-pm-identifier');
                if (!identifier) return;
                const toggle = row.querySelector('.prompt-manager-toggle-action');
                // fa-toggle-on = 启用，fa-toggle-off = 禁用
                const enabled = toggle ? toggle.classList.contains('fa-toggle-on') : true;
                promptOrder.push({ identifier, enabled });
            });
            console.log(`[${MODULE}] 捕获提示词状态: ${promptOrder.length} 条`);
        }
    } catch (e) {
        console.warn(`[${MODULE}] 捕获 promptOrder 失败:`, e);
    }

    // 4. 生成参数
    let genSettings = null;
    try {
        const GEN_PARAM_KEYS = [
            'temperature', 'max_tokens', 'max_length',
            'top_p', 'top_k', 'top_a', 'min_p', 'tfs', 'epsilon_cutoff', 'eta_cutoff',
            'typical_p', 'rep_pen', 'rep_pen_range', 'rep_pen_slope',
            'no_repeat_ngram_size', 'penalty_alpha', 'guidance_scale',
            'mirostat_mode', 'mirostat_tau', 'mirostat_eta',
            'seed', 'add_bos_token', 'ban_eos_token', 'skip_special_tokens',
            'streaming', 'dynamic_temp_enabled', 'dynatemp_low', 'dynatemp_high',
            'smoothing_factor', 'smoothing_curve',
            'temp', 'freq_pen', 'pres_pen', 'top_p_openai', 'max_context',
            'openai_max_tokens', 'stream_openai',
        ];

        const apiMap = {
            'openai':              window.oai_settings,
            'claude':              window.oai_settings,
            'textgenerationwebui': window.textgenerationwebui_settings,
            'kobold':              window.koboldai_settings,
            'novel':               window.nai_settings,
        };
        const srcSettings = (apiType && apiMap[apiType]) || {};
        const apiSettings = {};
        GEN_PARAM_KEYS.forEach(key => {
            if (key in srcSettings) apiSettings[key] = srcSettings[key];
        });
        genSettings = Object.keys(apiSettings).length > 0 ? apiSettings : null;
    } catch (e) {
        console.warn(`[${MODULE}] 捕获 genSettings 失败:`, e);
    }

    return { presetName, apiType, promptOrder, genSettings, capturedAt: Date.now() };
}

// ─── 快照：恢复 ──────────────────────────────────────────────────────────────

/**
 * 等待 Prompt Manager DOM 稳定后恢复开关状态。
 * 原理：轮询检查 .prompt_manager_prompt 数量是否与快照一致，
 * 连续两次一致视为渲染完成，最多等 5 秒。
 */
function waitForPromptManagerReady(expectedCount, callback, timeout = 5000) {
    const interval = 150;
    let elapsed = 0;
    let lastCount = -1;
    let stableCount = 0;

    const timer = setInterval(() => {
        const rows = document.querySelectorAll('.prompt_manager_prompt');
        const count = rows.length;

        if (count === lastCount && count > 0) {
            stableCount++;
        } else {
            stableCount = 0;
        }
        lastCount = count;

        // 连续2次稳定（约300ms不变）且数量接近预期，视为就绪
        if (stableCount >= 2 && (expectedCount <= 0 || Math.abs(count - expectedCount) <= 2)) {
            clearInterval(timer);
            callback();
            return;
        }

        elapsed += interval;
        if (elapsed >= timeout) {
            clearInterval(timer);
            console.warn(`[${MODULE}] waitForPromptManagerReady 超时，强制执行恢复`);
            callback();
        }
    }, interval);
}

async function applySnapshot(snapshot) {
    if (!snapshot) return;

    const needsPresetSwitch = snapshot.presetName && (() => {
        const context = ctx();
        const pm = context.getPresetManager ? context.getPresetManager() : null;
        const rawCurrent = pm ? pm.getSelectedPresetName() : null;
        const currentPreset = rawCurrent ? normalizePresetName(rawCurrent) : null;
        return currentPreset !== snapshot.presetName;
    })();

    // 如果需要切换预设，先注册 PRESET_CHANGED 监听，再触发切换
    // PRESET_CHANGED 触发后 ST 已完成预设加载，此时再恢复开关状态
    if (needsPresetSwitch) {
        const { eventSource, event_types } = ctx();

        // 一次性监听 PRESET_CHANGED
        const onPresetChanged = () => {
            eventSource.removeListener(event_types.PRESET_CHANGED, onPresetChanged);
            // 预设已切换，等 Prompt Manager DOM 重新渲染完再恢复
            restorePromptOrderAndGen(snapshot);
        };
        eventSource.once
            ? eventSource.once(event_types.PRESET_CHANGED, onPresetChanged)
            : eventSource.on(event_types.PRESET_CHANGED, onPresetChanged);

        const ok = await switchPreset(snapshot.presetName);
        if (!ok) {
            eventSource.removeListener(event_types.PRESET_CHANGED, onPresetChanged);
            toastr.warning(`未能切换到预设「${snapshot.presetName}」，请确认该预设存在`, '聊天预设绑定');
        }
        // 保险：3秒内 PRESET_CHANGED 没触发则强制执行
        setTimeout(() => {
            eventSource.removeListener(event_types.PRESET_CHANGED, onPresetChanged);
        }, 3000);
    } else {
        // 预设不需要切换，直接恢复
        restorePromptOrderAndGen(snapshot);
    }
}

/** 恢复提示词开关 + 生成参数（预设已就位后调用） */
function restorePromptOrderAndGen(snapshot) {
    // 恢复提示词开关——点击 .prompt-manager-toggle-action span
    // ST 用 fa-toggle-on/fa-toggle-off class 表示状态，点击 span 触发 ST 内部事件
    if (snapshot.promptOrder && snapshot.promptOrder.length > 0) {
        // 等预设渲染完后再操作
        setTimeout(async () => {
            try {
                // 检查 Prompt Manager 列表是否可见（是否已展开）
                const pmList = document.getElementById('completion_prompt_manager_list');
                let needCollapse = false;

                if (!pmList || pmList.closest('.inline-drawer-content[style*="display: none"]') !== null || !document.querySelector('[data-pm-identifier]')) {
                    // PM 列表不可见，找展开按钮点击
                    const drawerToggle = document.querySelector('#completion_prompt_manager')
                        ?.closest('.inline-drawer')
                        ?.querySelector('.inline-drawer-toggle');
                    if (drawerToggle) {
                        drawerToggle.click();
                        needCollapse = true;
                        // 等待展开动画
                        await new Promise(r => setTimeout(r, 600));
                    }
                }

                let adjusted = 0;
                snapshot.promptOrder.forEach(({ identifier, enabled }) => {
                    const row = document.querySelector(`[data-pm-identifier="${CSS.escape(identifier)}"]`);
                    if (!row) return;
                    const toggle = row.querySelector('.prompt-manager-toggle-action');
                    if (!toggle) return;
                    const currentlyOn = toggle.classList.contains('fa-toggle-on');
                    if (currentlyOn !== enabled) {
                        toggle.click();
                        adjusted++;
                    }
                });

                // 如果我们强制展开了，操作完收回去
                if (needCollapse) {
                    await new Promise(r => setTimeout(r, 300));
                    const drawerToggle = document.querySelector('#completion_prompt_manager')
                        ?.closest('.inline-drawer')
                        ?.querySelector('.inline-drawer-toggle');
                    if (drawerToggle) drawerToggle.click();
                }

                console.log(`[${MODULE}] 提示词开关恢复完成，共调整 ${adjusted} 项`);
            } catch (e) {
                console.warn(`[${MODULE}] 恢复 promptOrder 失败:`, e);
            }
        }, 800);
    }

    // 恢复生成参数
    if (snapshot.genSettings) {
        setTimeout(() => {
            try { restoreGenSettings(snapshot.genSettings, snapshot.apiType); }
            catch (e) { console.warn(`[${MODULE}] 恢复 genSettings 失败:`, e); }
        }, 300);
    }
}

function restoreGenSettings(settings, apiType) {
    if (!settings || typeof settings !== 'object') return;
    const resolvedApi = apiType || ctx().main_api;
    const apiMap = {
        'openai':              window.oai_settings,
        'claude':              window.oai_settings,
        'textgenerationwebui': window.textgenerationwebui_settings,
        'kobold':              window.koboldai_settings,
        'novel':               window.nai_settings,
    };
    const target = (resolvedApi && apiMap[resolvedApi]) || null;
    if (!target) return;

    let changed = false;
    Object.entries(settings).forEach(([key, val]) => {
        if (key in target && target[key] !== val) {
            target[key] = val;
            changed = true;
            const el = document.getElementById(key)
                     || document.querySelector(`[name="${key}"]`)
                     || document.querySelector(`[data-setting="${key}"]`);
            if (el) {
                if (el.type === 'checkbox') el.checked = !!val;
                else el.value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    });
    if (changed) {
        const { saveSettingsDebounced } = ctx();
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
    }
}

// ─── chatMetadata 操作 ────────────────────────────────────────────────────────

function loadSnapshot() {
    const { chatMetadata } = ctx();
    return chatMetadata?.[META_KEY] || null;
}

async function saveSnapshot(snapshot) {
    const context = ctx();
    context.chatMetadata[META_KEY] = snapshot;
    await context.saveMetadata();
}

async function deleteSnapshot() {
    const context = ctx();
    delete context.chatMetadata[META_KEY];
    await context.saveMetadata();
}

// ─── UI 面板 ──────────────────────────────────────────────────────────────────

function buildPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'cpb-panel';
    panel.innerHTML = `
        <div class="cpb-header">
            <span class="cpb-title"><i class="fa-solid fa-link"></i> 聊天预设绑定</span>
            <div class="cpb-header-right">
                <span class="cpb-version">v1.0.1</span>
                <button class="cpb-close-btn" id="cpb_btn_close" title="关闭">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
        <div class="cpb-body">
            <div class="cpb-status-block" id="cpb_status"></div>

            <div class="cpb-actions">
                <button id="cpb_btn_bind" class="cpb-btn cpb-btn-primary" title="将当前预设+设置绑定到此聊天">
                    <i class="fa-solid fa-floppy-disk"></i> <span id="cpb_btn_bind_label">绑定当前配置</span>
                </button>
                <button id="cpb_btn_unbind" class="cpb-btn cpb-btn-danger" title="解除此聊天的绑定">
                    <i class="fa-solid fa-link-slash"></i> 解除绑定
                </button>
            </div>

            <div class="cpb-divider"></div>
            <div class="cpb-detail-title">已绑定内容</div>
            <div id="cpb_detail" class="cpb-detail"></div>
            <div class="cpb-divider"></div>

            <div class="cpb-option-row">
                <label class="cpb-checkbox-label">
                    <input type="checkbox" id="cpb_opt_auto_apply" />
                    <span>切换聊天时自动应用</span>
                </label>
            </div>
            <div class="cpb-option-row">
                <label class="cpb-checkbox-label">
                    <input type="checkbox" id="cpb_opt_save_gen" />
                    <span>包含生成参数（温度等）</span>
                </label>
            </div>
            <div class="cpb-option-row">
                <label class="cpb-checkbox-label">
                    <input type="checkbox" id="cpb_opt_save_prompt" />
                    <span>包含提示词开关状态</span>
                </label>
            </div>
        </div>
    `;

    return panel;
}

function refreshPanel() {
    const statusEl = document.getElementById('cpb_status');
    const detailEl = document.getElementById('cpb_detail');
    if (!statusEl || !detailEl) return;

    const snapshot  = loadSnapshot();
    const chatId    = getCurrentChatId();
    const unbindBtn = document.getElementById('cpb_btn_unbind');

    if (!snapshot) {
        statusEl.innerHTML = `<span class="cpb-badge cpb-badge-none">未绑定</span>
            <span class="cpb-chat-id">${chatId ? escHtml(shortId(chatId)) : '无活动聊天'}</span>`;
        detailEl.innerHTML = '<div class="cpb-empty">此聊天暂无绑定配置</div>';
        if (unbindBtn) unbindBtn.disabled = true;
        return;
    }

    statusEl.innerHTML = `<span class="cpb-badge cpb-badge-bound">已绑定</span>
        <span class="cpb-chat-id">${chatId ? escHtml(shortId(chatId)) : ''}</span>`;
    if (unbindBtn) unbindBtn.disabled = false;

    const lines = [];
    if (snapshot.presetName) {
        lines.push(`<div class="cpb-detail-item">
            <i class="fa-solid fa-sliders cpb-icon"></i>
            <span class="cpb-detail-key">预设</span>
            <span class="cpb-detail-val">${escHtml(snapshot.presetName)}</span>
        </div>`);
    }
    if (snapshot.apiType) {
        lines.push(`<div class="cpb-detail-item">
            <i class="fa-solid fa-plug cpb-icon"></i>
            <span class="cpb-detail-key">API</span>
            <span class="cpb-detail-val">${escHtml(snapshot.apiType)}</span>
        </div>`);
    }
    if (snapshot.promptOrder) {
        const total   = snapshot.promptOrder.length;
        const enabled = snapshot.promptOrder.filter(p => p.enabled).length;
        lines.push(`<div class="cpb-detail-item">
            <i class="fa-solid fa-list-check cpb-icon"></i>
            <span class="cpb-detail-key">提示词</span>
            <span class="cpb-detail-val">${enabled}/${total} 已启用</span>
        </div>`);
    }
    if (snapshot.genSettings) {
        const count = Object.keys(snapshot.genSettings).length;
        lines.push(`<div class="cpb-detail-item">
            <i class="fa-solid fa-temperature-half cpb-icon"></i>
            <span class="cpb-detail-key">生成参数</span>
            <span class="cpb-detail-val">${count} 项</span>
        </div>`);
    }
    if (snapshot.capturedAt) {
        const d = new Date(snapshot.capturedAt);
        lines.push(`<div class="cpb-detail-item cpb-detail-time">
            <i class="fa-solid fa-clock cpb-icon"></i>
            <span class="cpb-detail-key">绑定时间</span>
            <span class="cpb-detail-val">${d.toLocaleString('zh-CN')}</span>
        </div>`);
    }

    detailEl.innerHTML = lines.join('') || '<div class="cpb-empty">快照内容为空</div>';

    // 同步绑定按钮文案
    const bindLabel = document.getElementById('cpb_btn_bind_label');
    if (bindLabel) bindLabel.textContent = snapshot ? '更新当前配置' : '绑定当前配置';
    const bindBtn = document.getElementById('cpb_btn_bind');
    if (bindBtn) bindBtn.title = snapshot ? '用当前配置覆盖已绑定的快照' : '将当前预设+设置绑定到此聊天';
}

function syncOptions() {
    const settings = getSettings();
    const autoEl   = document.getElementById('cpb_opt_auto_apply');
    const genEl    = document.getElementById('cpb_opt_save_gen');
    const prmEl    = document.getElementById('cpb_opt_save_prompt');
    if (autoEl) autoEl.checked = settings.autoApply;
    if (genEl)  genEl.checked  = settings.saveGen;
    if (prmEl)  prmEl.checked  = settings.savePrompt;
}

// ─── 插件设置 ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = Object.freeze({ autoApply: true, saveGen: true, savePrompt: true });

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(DEFAULT_SETTINGS);
    const s = extensionSettings[MODULE];
    for (const k of Object.keys(DEFAULT_SETTINGS)) { if (!(k in s)) s[k] = DEFAULT_SETTINGS[k]; }
    return s;
}

function saveExtSettings() {
    const { saveSettingsDebounced } = ctx();
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
}

// ─── 事件绑定 ─────────────────────────────────────────────────────────────────

function bindPanelEvents() {
    // 关闭按钮
    document.getElementById('cpb_btn_close')?.addEventListener('click', () => {
        const panel = document.getElementById(PANEL_ID);
        if (panel) panel.style.display = 'none';
    });

    // 拖拽支持（桌面鼠标 + 移动端触摸）
    makeDraggable(document.getElementById(PANEL_ID), document.querySelector('.cpb-header'));

    // 绑定
    document.getElementById('cpb_btn_bind')?.addEventListener('click', async () => {
        const settings = getSettings();
        const snapshot = captureSnapshot();
        if (!settings.saveGen)    snapshot.genSettings = null;
        if (!settings.savePrompt) snapshot.promptOrder = null;

        await saveSnapshot(snapshot);
        refreshPanel();
        toastr.success(`已绑定预设「${snapshot.presetName || '未知'}」到当前聊天`, '聊天预设绑定');
    });

    // 解绑
    document.getElementById('cpb_btn_unbind')?.addEventListener('click', async () => {
        await deleteSnapshot();
        refreshPanel();
        toastr.info('已解除此聊天的配置绑定', '聊天预设绑定');
    });

    // 选项
    document.getElementById('cpb_opt_auto_apply')?.addEventListener('change', (e) => {
        getSettings().autoApply = e.target.checked; saveExtSettings();
    });
    document.getElementById('cpb_opt_save_gen')?.addEventListener('change', (e) => {
        getSettings().saveGen = e.target.checked; saveExtSettings();
    });
    document.getElementById('cpb_opt_save_prompt')?.addEventListener('change', (e) => {
        getSettings().savePrompt = e.target.checked; saveExtSettings();
    });
}

// ─── 菜单入口 ─────────────────────────────────────────────────────────────────

function injectMenuEntry() {
    if (document.getElementById(ENTRY_ID)) return;

    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;

    const item = document.createElement('div');
    item.id        = ENTRY_ID;
    item.className = 'list-group-item flex-container flexGap5';
    item.innerHTML = `<i class="fa-solid fa-link extensionsMenuExtensionButton"></i>
        <span>聊天预设绑定</span>`;

    item.addEventListener('click', () => {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const isHidden = panel.style.display === 'none' || panel.style.display === '';
        if (isHidden) {
            // 先显示（不可见状态）以便获取真实尺寸
            panel.style.transform = 'none';
            panel.style.left = '-9999px';
            panel.style.top  = '-9999px';
            panel.style.display = 'block';
            refreshPanel();
            syncOptions();
            // 用 requestAnimationFrame 确保 DOM 已渲染，再计算居中坐标
            requestAnimationFrame(() => {
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const pw = panel.offsetWidth;
                const ph = panel.offsetHeight;
                const left = Math.max(8, Math.round((vw - pw) / 2));
                const top  = Math.max(8, Math.round((vh - ph) / 2));
                panel.style.left = left + 'px';
                panel.style.top  = top  + 'px';
            });
        } else {
            panel.style.display = 'none';
        }
    });

    try {
        const children = menu.children;
        if (children.length > 15) children[15].after(item);
        else menu.appendChild(item);
    } catch { menu.appendChild(item); }

    const panel = buildPanel();
    document.body.appendChild(panel);
    bindPanelEvents();
    syncOptions();
}

// ─── 核心逻辑 ─────────────────────────────────────────────────────────────────

async function onChatChanged() {
    refreshPanel();
    const settings = getSettings();
    const snapshot = loadSnapshot();
    if (!snapshot || !settings.autoApply) return;
    await applySnapshot(snapshot);
}

// ─── 拖拽 ─────────────────────────────────────────────────────────────────────

function makeDraggable(panel, handle) {
    if (!panel || !handle) return;

    let startX, startY, startLeft, startTop;
    let isDragging = false;

    function getPos() {
        const rect = panel.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
    }

    // 拖拽前确保 transform 已清除（新逻辑打开时已用px定位，无需额外处理）
    function initPosition() {
        panel.style.transform = 'none';
    }

    function clampToViewport(left, top) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pw = panel.offsetWidth;
        const ph = panel.offsetHeight;
        return {
            left: Math.max(0, Math.min(left, vw - pw)),
            top:  Math.max(0, Math.min(top,  vh - ph)),
        };
    }

    function onStart(clientX, clientY) {
        initPosition();
        isDragging = true;
        startX = clientX;
        startY = clientY;
        startLeft = parseFloat(panel.style.left);
        startTop  = parseFloat(panel.style.top);
        panel.style.userSelect = 'none';
    }

    function onMove(clientX, clientY) {
        if (!isDragging) return;
        const dx = clientX - startX;
        const dy = clientY - startY;
        const { left, top } = clampToViewport(startLeft + dx, startTop + dy);
        panel.style.left = left + 'px';
        panel.style.top  = top  + 'px';
    }

    function onEnd() {
        isDragging = false;
        panel.style.userSelect = '';
    }

    // 鼠标
    handle.addEventListener('mousedown', e => {
        if (e.target.closest('.cpb-close-btn')) return;
        onStart(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
    document.addEventListener('mouseup',   onEnd);

    // 触摸
    handle.addEventListener('touchstart', e => {
        if (e.target.closest('.cpb-close-btn')) return;
        const t = e.touches[0];
        onStart(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchmove', e => {
        if (!isDragging) return;
        e.preventDefault();
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
    }, { passive: false });
    document.addEventListener('touchend', onEnd);
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

(function init() {
    const { eventSource, event_types } = SillyTavern.getContext();

    eventSource.on(event_types.APP_READY, () => {
        injectMenuEntry();
        refreshPanel();
    });

    eventSource.on(event_types.CHAT_CHANGED, debounce(onChatChanged, 400));
})();
