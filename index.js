/**
 * user-polish 润色插件
 * 功能:收集用户历史输出 → 生成偏好画像 → 依据画像润色输入框中的提示词并替换
 * - 魔法棒菜单 3 个入口:润色输入框 / 更新画像 / 润色插件配置
 * - 润色模板可配置(占位符 {{profile}} {{globalProfile}} {{chatProfile}} {{char}} {{input}})
 * - API 预设(OpenAI 兼容接口,可选经 ST 代理转发),默认使用酒馆当前 API
 * - 原文备份区(恢复原文 / 重新润色 / 删除)
 * - 画像更新:手动为主,可开自动(每 N 条新用户消息触发)
 * - 斜杠命令 /polish
 */
import {
    chat_metadata,
    saveSettingsDebounced,
    generateQuietPrompt,
    generateRaw,
    eventSource,
    event_types,
} from '../../../../script.js';
import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { callGenericPopup, POPUP_RESULT } from '../../../popup.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const DEFAULT_TEMPLATE = {
    id: 'tpl_default',
    name: '默认润色',
    active: true,
    builtin: true,
    systemPrompt: '你是一位文字润色助手。你会收到一份"用户偏好画像"和一段待润色的文字。请在不改变原意的前提下,根据画像中描述的偏好(语气风格、用词习惯、人称方式、标点与篇幅等)润色这段文字,使其更符合用户的口吻与喜好。只输出润色后的文字本身,不要任何解释、前言、标记或引号。',
    userTemplate: '【用户偏好画像】\n{{profile}}\n\n【当前角色】{{char}}\n\n【待润色文字】\n{{input}}\n\n请按照以上偏好润色【待润色文字】,只输出润色结果。',
};

const DEFAULTS = {
    templates: [JSON.parse(JSON.stringify(DEFAULT_TEMPLATE))],
    activeTemplateId: 'tpl_default',
    presets: [],
    activePresetId: '',
    useCurrentModel: true,
    profileMessageCount: 30,
    globalProfile: { text: '', updatedAt: 0 },
    autoUpdateEnabled: false,
    autoUpdateInterval: 20,
    backups: [],
};

const BACKUP_LIMIT = 50;
const PICK_LIST_LIMIT = 150; // 指定楼层列表最多展示最近多少条消息

/* ---------------- 工具函数 ---------------- */

function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function fmtTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ---------------- 设置 ---------------- */

function getSettings() {
    return extension_settings.userPolish;
}

function loadSettings() {
    if (!extension_settings.userPolish || typeof extension_settings.userPolish !== 'object') {
        extension_settings.userPolish = {};
    }
    const s = extension_settings.userPolish;

    if (!Array.isArray(s.templates) || s.templates.length === 0) {
        s.templates = [JSON.parse(JSON.stringify(DEFAULT_TEMPLATE))];
    }
    if (!s.templates.some(t => t && t.id === 'tpl_default' && t.builtin)) {
        s.templates.unshift(JSON.parse(JSON.stringify(DEFAULT_TEMPLATE)));
    }
    s.templates = s.templates.filter(t => t && typeof t === 'object' && t.id);
    s.templates.forEach(t => {
        if (typeof t.systemPrompt !== 'string') t.systemPrompt = '';
        if (typeof t.userTemplate !== 'string') t.userTemplate = '';
        if (typeof t.name !== 'string' || !t.name) t.name = '未命名模板';
    });
    if (!s.templates.some(t => t.id === s.activeTemplateId)) {
        s.activeTemplateId = s.templates[0].id;
    }
    s.templates.forEach(t => { t.active = t.id === s.activeTemplateId; });

    s.presets = Array.isArray(s.presets) ? s.presets.filter(p => p && typeof p === 'object' && p.id) : [];
    if (!s.presets.some(p => p.id === s.activePresetId)) s.activePresetId = '';
    s.useCurrentModel = s.useCurrentModel !== false;
    s.profileMessageCount = Number.isFinite(s.profileMessageCount) && s.profileMessageCount >= 1 ? s.profileMessageCount : DEFAULTS.profileMessageCount;
    if (!s.globalProfile || typeof s.globalProfile !== 'object') s.globalProfile = { text: '', updatedAt: 0 };
    if (typeof s.globalProfile.text !== 'string') s.globalProfile.text = '';
    if (!Number.isFinite(s.globalProfile.updatedAt)) s.globalProfile.updatedAt = 0;
    s.autoUpdateEnabled = !!s.autoUpdateEnabled;
    s.autoUpdateInterval = Number.isFinite(s.autoUpdateInterval) && s.autoUpdateInterval >= 1 ? s.autoUpdateInterval : DEFAULTS.autoUpdateInterval;
    s.backups = Array.isArray(s.backups) ? s.backups.filter(b => b && typeof b === 'object' && b.id) : [];
}

/* ---------------- 对话级元数据 ---------------- */

function getChatMeta() {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        return { profile: '', lastUpdateCount: 0, updatedAt: 0, pickMode: false, pickedIds: [], likedText: '' };
    }
    if (!chat_metadata.userPolish) {
        chat_metadata.userPolish = { profile: '', lastUpdateCount: 0, updatedAt: 0, pickMode: false, pickedIds: [], likedText: '' };
    }
    const meta = chat_metadata.userPolish;
    if (typeof meta.pickMode !== 'boolean') meta.pickMode = false;
    if (!Array.isArray(meta.pickedIds)) meta.pickedIds = [];
    if (typeof meta.likedText !== 'string') meta.likedText = '';
    return meta;
}

/**
 * 收集画像素材消息。启用"指定楼层"时只取用户勾选的楼层(任意角色,AI 发言作为上下文参考);
 * 否则取最近 n 条用户消息。
 * @returns {{text:string, isUser:boolean, name:string}[]}
 */
function collectProfileMessages(n) {
    const context = getContext();
    const chat = context && Array.isArray(context.chat) ? context.chat : [];
    const meta = getChatMeta();
    const isPick = meta.pickMode && Array.isArray(meta.pickedIds) && meta.pickedIds.length > 0;
    const picked = new Set(meta.pickedIds);
    const result = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m) continue;
        if (!isPick && (!m.is_user || m.is_system)) continue;
        if (isPick && !picked.has(m.id)) continue;
        const text = (Array.isArray(m.swipes) && m.swipes.length > 0)
            ? String(m.swipes[m.swipes.length - 1] ?? '')
            : String(m.mes ?? '');
        if (!text.trim()) continue;
        result.push({
            text: text,
            isUser: !!m.is_user,
            name: m.name ? String(m.name) : (m.is_user ? '用户' : 'AI'),
            floor: i + 1,
        });
        if (!isPick && result.length >= n) break;
    }
    return result;
}

function countUserMessages() {
    const context = getContext();
    const chat = context && Array.isArray(context.chat) ? context.chat : [];
    return chat.filter(m => m && m.is_user && !m.is_system).length;
}

/* ---------------- 并发控制(润色与画像更新互斥,同类型排队任务合并) ---------------- */

const taskQueue = [];
let taskRunning = false;

function enqueue(type, fn) {
    const existing = taskQueue.find(t => t.type === type);
    if (existing) {
        return new Promise((resolve, reject) => {
            existing.theners.push({ resolve, reject });
        });
    }
    const task = { type, fn, theners: [] };
    taskQueue.push(task);
    const promise = new Promise((resolve, reject) => {
        task.theners.push({ resolve, reject });
    });
    pumpQueue();
    return promise;
}

async function pumpQueue() {
    if (taskRunning || taskQueue.length === 0) return;
    taskRunning = true;
    const task = taskQueue.shift();
    setBusy(true);
    try {
        const result = await task.fn();
        task.theners.forEach(t => t.resolve(result));
    } catch (err) {
        task.theners.forEach(t => t.reject(err));
    } finally {
        setBusy(false);
        taskRunning = false;
        pumpQueue();
    }
}

function runExclusive(type, fn) {
    return enqueue(type, fn);
}

function setBusy(busy) {
    $('#user_polish_container, #user_polish_wand_container').toggleClass('up-disabled', busy);
}

/* ---------------- 进度条 ---------------- */

function injectProgressBar() {
    if ($('#up_progress').length) return;
    const wrap = document.createElement('div');
    wrap.id = 'up_progress';
    wrap.className = 'up-progress';
    wrap.style.display = 'none';
    wrap.innerHTML = `
    <div class="up-progress-track"><div class="up-progress-fill"></div></div>
    <div class="up-progress-text">准备中…</div>`;
    const sendForm = document.getElementById('send_form');
    if (sendForm && sendForm.parentNode) {
        sendForm.parentNode.insertBefore(wrap, sendForm);
    } else {
        document.body.appendChild(wrap);
    }
}

/** 显示进度条。pct 传 null 表示不确定进度(扫描动画),传数字表示百分比 */
function showProgress(text, pct) {
    const wrap = $('#up_progress');
    if (!wrap.length) return;
    const fill = wrap.find('.up-progress-fill');
    if (pct == null) {
        fill.removeClass('determinate').addClass('indeterminate');
    } else {
        fill.removeClass('indeterminate').addClass('determinate');
        fill.css('width', Math.max(0, Math.min(100, pct)) + '%');
    }
    wrap.find('.up-progress-text').text(text || '');
    wrap.css('display', 'flex');
}

function setProgress(pct, text) {
    showProgress(text, pct);
}

function hideProgress() {
    $('#up_progress').css('display', 'none');
}

/* ---------------- 模板渲染 ---------------- */

function renderPlaceholders(tpl, vars) {
    return String(tpl || '')
        .replaceAll('{{profile}}', String(vars.profile ?? ''))
        .replaceAll('{{globalProfile}}', String(vars.globalProfile ?? ''))
        .replaceAll('{{chatProfile}}', String(vars.chatProfile ?? ''))
        .replaceAll('{{char}}', String(vars.char ?? ''))
        .replaceAll('{{input}}', String(vars.input ?? ''));
}

/* ---------------- API 调用 ---------------- */

async function callPreset(preset, userPrompt, systemPrompt) {
    const endpoint = String(preset.base || '').replace(/\/+$/, '') + '/chat/completions';
    const url = preset.useProxy ? '/proxy/' + encodeURIComponent(endpoint) : endpoint;
    const headers = { 'Content-Type': 'application/json' };
    if (preset.key) headers['Authorization'] = 'Bearer ' + preset.key;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });
    const body = {
        model: preset.model || 'deepseek-chat',
        messages: messages,
        temperature: 0.8,
        max_tokens: 2000,
        stream: false,
    };
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`预设 API 请求失败: HTTP ${resp.status} ${truncate(text, 300)}`);
    }
    const data = await resp.json().catch(() => null);
    const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
    return content;
}

/** 流式读取失败标记:由调用方捕获后回退非流式 */
class StreamReadError extends Error {}

/** 流式调用预设 API(SSE),onToken(fullText) 提供实时进度;流式不可用时回退到 JSON 解析 */
async function callPresetStream(preset, userPrompt, systemPrompt, onToken) {
    const endpoint = String(preset.base || '').replace(/\/+$/, '') + '/chat/completions';
    const url = preset.useProxy ? '/proxy/' + encodeURIComponent(endpoint) : endpoint;
    const headers = { 'Content-Type': 'application/json' };
    if (preset.key) headers['Authorization'] = 'Bearer ' + preset.key;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });
    const body = {
        model: preset.model || 'deepseek-chat',
        messages: messages,
        temperature: 0.8,
        max_tokens: 2000,
        stream: true,
    };
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`预设 API 请求失败: HTTP ${resp.status} ${truncate(text, 300)}`);
    }
    if (!resp.body || typeof resp.body.getReader !== 'function') {
        // 服务端未返回 SSE 流(直接返回 JSON)→ 按非流式解析
        const data = await resp.json().catch(() => null);
        const content = data && data.choices && data.choices[0] && data.choices[0].message
            ? data.choices[0].message.content
            : '';
        return String(content || '');
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let sawData = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                const t = String(line).trim();
                if (!t.startsWith('data:')) continue;
                sawData = true;
                const data = t.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                try {
                    const j = JSON.parse(data);
                    const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
                    if (typeof delta === 'string' && delta) {
                        full += delta;
                        if (onToken) onToken(full);
                    }
                } catch { /* 忽略非 JSON 行 */ }
            }
        }
    } catch (err) {
        throw new StreamReadError('流式读取中断: ' + (err && err.message ? err.message : err));
    }
    // 收到 SSE 但无 delta 内容:尝试把残留数据按 JSON 解析(部分实现最后一块是完整 JSON)
    if (sawData && !full && buf.trim()) {
        try {
            const j = JSON.parse(buf);
            const content = j.choices && j.choices[0] && j.choices[0].message
                ? j.choices[0].message.content : '';
            if (typeof content === 'string') return content;
        } catch { /* 忽略 */ }
    }
    return full;
}

function showPolishError(err) {
    console.error('[润色插件]', err);
    const msg = String(err && err.message ? err.message : err);
    if (err instanceof TypeError) {
        toastr.error(`润色失败: ${msg}(若为跨域网络错误,请在 API 预设中开启"经 ST 代理转发",或在 config.yaml 开启 enableCorsProxy)`);
    } else {
        toastr.error(`润色失败: ${msg}`);
    }
}

/* ---------------- 画像 ---------------- */

async function updateProfiles() {
    return runExclusive('profile', async () => {
        const s = getSettings();
        const meta = getChatMeta();
        const isPick = meta.pickMode && Array.isArray(meta.pickedIds) && meta.pickedIds.length > 0;
        const messages = collectProfileMessages(s.profileMessageCount);
        if (messages.length === 0) {
            throw new Error(isPick ? '未选择任何楼层,请先打开配置界面勾选要截取的楼层' : '当前对话还没有用户消息,无法生成画像');
        }
        // 更新范围:配置界面中按勾选写入;自动更新(无配置界面)时保持两个都更新
        const hasUi = $('#up_update_global').length > 0;
        const wantGlobal = hasUi ? $('#up_update_global').prop('checked') : true;
        const wantChat = hasUi ? $('#up_update_chat').prop('checked') : true;
        if (hasUi && !wantGlobal && !wantChat) {
            throw new Error('请至少勾选一个更新目标(全局画像 / 当前会话画像)');
        }
        const lines = isPick
            ? messages.map(m => `[楼层${m.floor}] (${m.isUser ? '用户' : 'AI'}) ${m.name}: ${m.text}`)
            : messages.map(m => `[${m.floor}] ${m.text}`);
        const liked = String(meta.likedText || '').trim();
        const promptParts = [
            isPick
                ? '以下是用户指定的聊天楼层内容(标注了发言者。用户发言是分析重点;AI 发言仅作为理解语境的参考):'
                : '以下是用户与角色对话时,用户最近发送的消息记录(按时间顺序):',
            '',
            lines.join('\n'),
        ];
        if (liked) {
            promptParts.push(
                '',
                '以下是用户额外提供的偏好参考段落(用户声明自己喜欢这样的内容与风格,请作为重要参考):',
                '',
                liked,
            );
        }
        promptParts.push(
            '',
            '请结合以上所有内容,分析并总结用户的偏好画像,包括:语气风格、表达方式、人称习惯、常用词汇、标点与篇幅偏好、感兴趣的话题等。',
            '用第三人称、以"用户偏好"开头,不超过300字。只输出画像文本,不要任何解释或额外内容。',
        );
        const quietPrompt = promptParts.join('\n');
        let text;
        try {
            text = await generateQuietPrompt({ quietPrompt, quietToLoud: false });
        } catch (err) {
            if (err && String(err).includes('No message generated')) {
                throw new Error('当前 API 未生成画像,请检查 API 连接');
            }
            throw err;
        }
        text = String(text || '').trim();
        if (!text) throw new Error('画像生成失败:未返回任何内容');

        const targets = [];
        if (wantGlobal) {
            s.globalProfile = { text, updatedAt: Date.now() };
            saveSettingsDebounced();
            targets.push('全局画像');
        }
        const context = getContext();
        if (wantChat && context && context.chatId) {
            const m = getChatMeta();
            m.profile = text;
            m.lastUpdateCount = isPick ? messages.length : countUserMessages();
            m.updatedAt = Date.now();
            chat_metadata.userPolish = m;
            saveMetadataDebounced();
            targets.push('当前会话画像');
        }
        renderProfileSection();
        return targets;
    });
}

/* ---------------- 润色主流程 ---------------- */

async function polishText(original, opts) {
    return runExclusive('polish', async () => {
        let ok = false;
        try {
            showProgress('正在准备…', 5);
            const s = getSettings();
            const tpl = s.templates.find(t => t.id === s.activeTemplateId) || s.templates[0];
            if (!tpl) throw new Error('没有可用的润色模板,请在配置界面创建');
            const context = getContext();
            const meta = getChatMeta();
            const parts = [];
            if (meta.profile) parts.push(meta.profile);
            if (s.globalProfile.text) parts.push(s.globalProfile.text);
            const vars = {
                profile: parts.join('\n') || '(暂无画像,按通用风格润色)',
                globalProfile: s.globalProfile.text || '(暂无全局画像)',
                chatProfile: meta.profile || '(暂无当前对话画像)',
                char: (context && (context.name2 || (context.character && context.character.name))) || '(无角色)',
                input: original,
            };
            const systemPrompt = renderPlaceholders(tpl.systemPrompt || '', vars);
            let userPrompt = renderPlaceholders(tpl.userTemplate || '', vars);
            if (!userPrompt.includes(original)) {
                userPrompt += '\n\n【待润色文字】\n' + original;
            }
            // 参考内容注入(确认框中勾选"给出参考"后:手动输入优先,其次所选 AI 楼层)
            let refText = '';
            if (opts && opts.giveRef) {
                refText = opts.refText ? String(opts.refText).trim() : '';
                if (!refText && opts.floor) refText = getMessageTextByFloor(opts.floor);
            }
            if (refText) {
                userPrompt += '\n\n【参考内容(仅参考其语气、风格与表达方式,内容与润色目标无关)】\n' + refText;
            }
            showProgress('正在组装提示词…', 15);

            let polished;
            const preset = s.presets.find(p => p.id === s.activePresetId);
            if (s.useCurrentModel || !preset) {
                // 当前 API 路径:generateRaw 无流回调,用不确定进度(扫描动画)
                showProgress('正在调用当前 API…', null);
                try {
                    polished = await generateRaw({ prompt: userPrompt, systemPrompt: systemPrompt, quietToLoud: false });
                } catch (err) {
                    if (err && String(err).includes('No message generated')) {
                        throw new Error('当前 API 未生成任何内容,请检查 API 连接或模板配置');
                    }
                    throw err;
                }
            } else {
                // 预设 API 路径:流式请求,按已接收字数实时推进进度
                showProgress('正在请求预设 API…', 25);
                try {
                    polished = await callPresetStream(preset, userPrompt, systemPrompt, (full) => {
                        const len = String(full).length;
                        setProgress(Math.min(95, 30 + len * 0.03), `AI 生成中… 已接收 ${len} 字`);
                    });
                } catch (err) {
                    if (err instanceof StreamReadError) {
                        showProgress('流式失败,改用普通请求…', 25);
                        polished = await callPreset(preset, userPrompt, systemPrompt);
                    } else {
                        throw err;
                    }
                }
            }
            polished = String(polished || '').trim();
            if (!polished) throw new Error('未生成任何内容,请检查 API 连接或模板配置');

            setProgress(100, '完成');
            pushBackup({ original, polished, templateId: tpl.id, templateName: tpl.name });
            renderBackupSection();
            ok = true;
            return polished;
        } finally {
            if (!ok) hideProgress();
            else setTimeout(hideProgress, 600);
        }
    });
}

/* ---------------- 润色确认框 ---------------- */

/** 收集最近的 AI 发言楼层(供参考选择,最多 30 条)。以楼层号(消息数组索引+1)标识,不依赖消息 id(部分聊天记录无 id 字段) */
function buildAiFloorOptions() {
    const context = getContext();
    const chat = context && Array.isArray(context.chat) ? context.chat : [];
    const opts = [];
    for (let i = chat.length - 1; i >= 0 && opts.length < 30; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        const text = (Array.isArray(m.swipes) && m.swipes.length > 0)
            ? String(m.swipes[m.swipes.length - 1] ?? '')
            : String(m.mes ?? '');
        if (!text.trim()) continue;
        opts.unshift({ floor: i + 1, name: m.name || 'AI', preview: truncate(text, 25) });
    }
    return opts;
}

/** 按楼层号(消息数组索引+1)取消息文本 */
function getMessageTextByFloor(floor) {
    const n = parseInt(floor, 10);
    if (!Number.isFinite(n) || n < 1) return '';
    const context = getContext();
    const chat = context && Array.isArray(context.chat) ? context.chat : [];
    const m = chat[n - 1];
    if (!m) return '';
    return (Array.isArray(m.swipes) && m.swipes.length > 0)
        ? String(m.swipes[m.swipes.length - 1] ?? '')
        : String(m.mes ?? '');
}

/**
 * 润色确认框:确认是否润色 + 是否给出参考 + 选择参考楼层(AI 输出风格)。
 * 返回 { giveRef, refText, floor } 或 null(用户取消)
 */
async function showPolishConfirm() {
    const floors = buildAiFloorOptions();
    const floorOptions = floors.map(f => {
        return `<option value="${f.floor}">#${f.floor} ${escapeHtml(f.name)}: ${escapeHtml(f.preview)}</option>`;
    }).join('');
    const html = `
    <div class="up-confirm">
        <div class="up-hint">将根据偏好画像润色输入框中的文字并替换原文(原文自动备份到配置界面)。</div>
        <label class="checkbox_label">
            <input type="checkbox" id="up_cf_ref" checked>
            <span>给出参考(润色时附带参考内容)</span>
        </label>
        <textarea id="up_cf_ref_text" class="text_pole up-textarea up-cf-ref-text" rows="3" placeholder="手动输入参考内容,如希望的风格、语气或示例文字…(优先于楼层选择)"></textarea>
        <div class="up-row">
            <span class="up-label">或选择参考楼层(AI 输出风格):</span>
            <select id="up_cf_floor" class="text_pole up-cf-select">
                <option value="">(不指定)</option>
                ${floorOptions}
            </select>
        </div>
        <div class="up-hint" id="up_cf_preview"></div>
    </div>`;
    const popupPromise = callGenericPopup(html, 'text', '', {
        okButton: '确认润色',
        cancelButton: '取消',
        allowVerticalScrolling: true,
        animation: 'fast',
        onOpen: () => {
            const $ref = $('#up_cf_ref');
            const $refText = $('#up_cf_ref_text');
            const $floor = $('#up_cf_floor');
            const $preview = $('#up_cf_preview');
            const updatePreview = () => {
                const manual = String($refText.val() || '').trim();
                const floor = parseInt($floor.val(), 10);
                if (!$ref.prop('checked')) {
                    $preview.text('');
                    return;
                }
                if (manual) {
                    $preview.text('参考内容: ' + truncate(manual, 80));
                    return;
                }
                if (Number.isFinite(floor) && floor >= 1) {
                    const text = getMessageTextByFloor(floor);
                    $preview.text(text ? '参考内容: ' + truncate(text, 80) : '');
                    return;
                }
                $preview.text('');
            };
            $floor.off('change').on('change', updatePreview);
            $refText.off('input').on('input', updatePreview);
            $ref.off('change').on('change', function () {
                const enabled = $(this).prop('checked');
                $floor.prop('disabled', !enabled);
                $refText.toggle(enabled);
                if (!enabled) {
                    $floor.val('');
                    $refText.val('');
                }
                updatePreview();
            });
            $refText.toggle($ref.prop('checked'));
            $floor.prop('disabled', !$ref.prop('checked'));
            updatePreview();
        },
    });
    const result = await popupPromise;
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    return {
        giveRef: $('#up_cf_ref').prop('checked'),
        refText: String($('#up_cf_ref_text').val() || '').trim(),
        floor: parseInt($('#up_cf_floor').val(), 10) || 0,
    };
}

async function onPolishClick() {
    const textarea = $('#send_textarea');
    const original = String(textarea.val() || '').trim();
    if (!original) {
        toastr.warning('输入框为空,请先输入要润色的文字');
        return;
    }
    const decision = await showPolishConfirm();
    if (!decision) return; // 用户取消
    try {
        const polished = await polishText(original, decision);
        textarea.val(polished);
        textarea[0].dispatchEvent(new Event('input', { bubbles: true }));
        toastr.success('润色完成,已替换输入框内容(原文已备份)');
    } catch (err) {
        showPolishError(err);
    }
}

async function onProfileClick() {
    try {
        const targets = await updateProfiles();
        toastr.success('偏好画像已更新: ' + (targets && targets.length ? targets.join('、') : '未写入任何位置'));
    } catch (err) {
        console.error('[润色插件]', err);
        toastr.error('画像更新失败: ' + (err && err.message ? err.message : err));
    }
}

/* ---------------- 备份 ---------------- */

function pushBackup(item) {
    const s = getSettings();
    s.backups.unshift({ id: uuid(), time: Date.now(), ...item });
    if (s.backups.length > BACKUP_LIMIT) s.backups.length = BACKUP_LIMIT;
    saveSettingsDebounced();
}

function getBackup(id) {
    return getSettings().backups.find(b => b.id === id);
}

function onBackupRestore(id) {
    const b = getBackup(id);
    if (!b) return;
    const textarea = $('#send_textarea');
    textarea.val(b.original);
    textarea[0].dispatchEvent(new Event('input', { bubbles: true }));
    toastr.info('已恢复原文到输入框');
}

function onBackupRepolish(id) {
    const b = getBackup(id);
    if (!b) return;
    const textarea = $('#send_textarea');
    textarea.val(b.original);
    textarea[0].dispatchEvent(new Event('input', { bubbles: true }));
    onPolishClick();
}

function onBackupDelete(id) {
    const s = getSettings();
    s.backups = s.backups.filter(b => b.id !== id);
    saveSettingsDebounced();
    renderBackupSection();
}

function onBackupClear() {
    const s = getSettings();
    if (s.backups.length === 0) return;
    if (!confirm(`确定清空全部 ${s.backups.length} 条备份?`)) return;
    s.backups = [];
    saveSettingsDebounced();
    renderBackupSection();
}

/* ---------------- 魔法棒菜单 ---------------- */

function injectWandMenu() {
    if (!$('#extensionsMenu').length) {
        setTimeout(injectWandMenu, 500);
        return;
    }
    if ($('#user_polish_wand_container').length) return;
    const html = `
    <div id="user_polish_wand_container" class="extension_container">
        <div id="up_polish_btn" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div>
            <span>润色输入框</span>
        </div>
        <div id="up_profile_btn" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-user-pen extensionsMenuExtensionButton"></div>
            <span>更新画像</span>
        </div>
        <div id="up_settings_btn" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-gear extensionsMenuExtensionButton"></div>
            <span>润色插件配置</span>
        </div>
    </div>`;
    $('#extensionsMenu').append(html);
    $('#up_polish_btn').on('click', onPolishClick);
    $('#up_profile_btn').on('click', onProfileClick);
    $('#up_settings_btn').on('click', onSettingsClick);
}

function onSettingsClick() {
    openSettingsPopup();
}

/* ---------------- 设置面板渲染 ---------------- */

function settingsPanelHTML() {
    return `
    <div id="user_polish_container">
        <h3 class="up-title">润色插件配置</h3>
        <div id="user_polish_settings">
            <div class="up-section">
                <div class="up-section-title">润色模板</div>
                <div class="up-hint">占位符: {{profile}} {{globalProfile}} {{chatProfile}} {{char}} {{input}}</div>
                <div id="up_tpl_list" class="up-list"></div>
                <div id="up_tpl_editor"></div>
            </div>
            <div class="up-section">
                <div class="up-section-title">API 预设</div>
                <div id="up_preset_list" class="up-list"></div>
                <div id="up_preset_editor"></div>
                <label class="checkbox_label">
                    <input type="checkbox" id="up_use_current_model">
                    <span>使用酒馆当前 API(开启时忽略 API 预设)</span>
                </label>
                <div class="up-hint">API 密钥将以明文保存于酒馆 settings.json,并同步到所有已登录设备</div>
            </div>
            <div class="up-section">
                <div class="up-section-title">偏好画像</div>
                <div id="up_profile_block"></div>
            </div>
            <div class="up-section">
                <div class="up-section-title">备份区</div>
                <div id="up_backup_block"></div>
            </div>
            <div class="up-section">
                <div class="up-section-title">自动更新</div>
                <div id="up_auto_block"></div>
            </div>
        </div>
    </div>`;
}

function bindSettingsEvents() {
    const root = $('#user_polish_settings');
    if (!root.length) return;
    root.off('click').off('change'); // 防重复打开时重复绑定
    root.on('click', '.up-tpl-add', onAddTemplate);
    root.on('click', '.up-tpl-delete', function () { onDeleteTemplate($(this).data('id')); });
    root.on('click', '.up-tpl-delete-current', function () { onDeleteTemplate(getSettings().activeTemplateId); });
    root.on('click', '.up-tpl-save', onSaveTemplate);
    root.on('change', 'input[name="up_tpl_active"]', function () { onActivateTemplate($(this).val()); });
    root.on('change', '#up_tpl_name, #up_tpl_sys, #up_tpl_usr', onTemplateEditorChange);

    root.on('click', '.up-preset-add', onAddPreset);
    root.on('click', '.up-preset-delete', function () { onDeletePreset($(this).data('id')); });
    root.on('click', '.up-preset-delete-current', function () { onDeletePreset(getSettings().activePresetId); });
    root.on('click', '.up-preset-save', onSavePreset);
    root.on('change', 'input[name="up_preset_active"]', function () { onActivatePreset($(this).val()); });
    root.on('change', '#up_use_current_model', function () {
        const s = getSettings();
        s.useCurrentModel = $(this).prop('checked');
        saveSettingsDebounced();
        renderPresetEditor();
    });

    root.on('click', '.up-profile-update', onProfileClick);
    root.on('click', '.up-global-profile-save', onSaveGlobalProfile);
    root.on('change', '#up_profile_count', function () {
        const v = parseInt($(this).val(), 10);
        if (!isNaN(v) && v >= 1) {
            getSettings().profileMessageCount = v;
            saveSettingsDebounced();
        }
    });
    root.on('change', '#up_pick_mode', onPickModeChange);
    root.on('change', '.up-pick-item input', savePickedIds);
    root.on('click', '.up-pick-all-user', onPickAllUser);
    root.on('click', '.up-pick-clear', onPickClear);
    root.on('input', '#up_liked_text', onLikedTextInput);

    root.on('click', '.up-backup-restore', function () { onBackupRestore($(this).data('id')); });
    root.on('click', '.up-backup-repolish', function () { onBackupRepolish($(this).data('id')); });
    root.on('click', '.up-backup-delete', function () { onBackupDelete($(this).data('id')); });
    root.on('click', '.up-backup-clear', onBackupClear);

    root.on('change', '#up_auto_enabled', function () {
        getSettings().autoUpdateEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        updateAutoStatus();
    });
    root.on('change', '#up_auto_interval', function () {
        const v = parseInt($(this).val(), 10);
        if (!isNaN(v) && v >= 1) {
            getSettings().autoUpdateInterval = v;
            saveSettingsDebounced();
        }
        updateAutoStatus();
    });
}

function openSettingsPopup() {
    callGenericPopup(settingsPanelHTML(), 'text', '', {
        wide: true,
        large: true,
        okButton: false,
        cancelButton: '关闭',
        allowVerticalScrolling: true,
        animation: 'fast',
        onOpen: () => {
            renderAll();
            bindSettingsEvents();
        },
    });
}

/* ---------------- 模板区块 ---------------- */

function renderTemplateList() {
    const s = getSettings();
    const list = $('#up_tpl_list');
    list.empty();
    s.templates.forEach(t => {
        const item = $(`
        <div class="up-list-item" data-id="${t.id}">
            <label class="radio_label">
                <input type="radio" name="up_tpl_active" value="${t.id}" ${t.active ? 'checked' : ''}>
                <span>${escapeHtml(t.name)}${t.builtin ? ' (内置)' : ''}</span>
            </label>
            ${t.builtin ? '' : `<div class="menu_button up-tpl-delete" data-id="${t.id}" title="删除模板">删除</div>`}
        </div>`);
        list.append(item);
    });
    list.append('<div class="menu_button up-tpl-add">＋ 新建模板</div>');
}

function renderTemplateEditor() {
    const s = getSettings();
    const tpl = s.templates.find(t => t.id === s.activeTemplateId) || s.templates[0];
    const editor = $('#up_tpl_editor');
    if (!tpl) { editor.empty(); return; }
    editor.empty();
    editor.append(`
    <div class="up-editor">
        <div class="up-row">
            <span class="up-label">模板名称</span>
            <input type="text" id="up_tpl_name" class="text_pole" value="${escapeHtml(tpl.name)}">
        </div>
        <div class="up-row up-row-col">
            <span class="up-label">系统提示词</span>
            <textarea id="up_tpl_sys" class="text_pole up-textarea" rows="4">${escapeHtml(tpl.systemPrompt || '')}</textarea>
        </div>
        <div class="up-row up-row-col">
            <span class="up-label">用户提示词</span>
            <textarea id="up_tpl_usr" class="text_pole up-textarea" rows="6">${escapeHtml(tpl.userTemplate || '')}</textarea>
        </div>
        <div class="up-row up-row-buttons">
            <div class="menu_button up-tpl-save">保存模板</div>
            ${tpl.builtin ? '' : '<div class="menu_button up-tpl-delete-current">删除此模板</div>'}
        </div>
    </div>`);
}

function onAddTemplate() {
    const s = getSettings();
    const id = 'tpl_' + uuid();
    s.templates.push({
        id: id,
        name: '新模板',
        active: false,
        builtin: false,
        systemPrompt: '',
        userTemplate: '【用户偏好画像】\n{{profile}}\n\n【当前角色】{{char}}\n\n【待润色文字】\n{{input}}\n\n请按照以上偏好润色【待润色文字】,只输出润色结果。',
    });
    s.activeTemplateId = id;
    s.templates.forEach(t => { t.active = t.id === id; });
    saveSettingsDebounced();
    renderTemplateList();
    renderTemplateEditor();
}

function onDeleteTemplate(id) {
    const s = getSettings();
    const tpl = s.templates.find(t => t.id === id);
    if (!tpl || tpl.builtin) return;
    if (!confirm(`确定删除模板"${tpl.name}"?`)) return;
    s.templates = s.templates.filter(t => t.id !== id);
    if (s.templates.length === 0) {
        s.templates.push(JSON.parse(JSON.stringify(DEFAULT_TEMPLATE)));
    }
    if (s.activeTemplateId === id) s.activeTemplateId = s.templates[0].id;
    s.templates.forEach(t => { t.active = t.id === s.activeTemplateId; });
    saveSettingsDebounced();
    renderTemplateList();
    renderTemplateEditor();
}

function onActivateTemplate(id) {
    const s = getSettings();
    if (!s.templates.some(t => t.id === id)) return;
    s.activeTemplateId = id;
    s.templates.forEach(t => { t.active = t.id === id; });
    saveSettingsDebounced();
    renderTemplateList();
    renderTemplateEditor();
}

function onTemplateEditorChange() {
    const s = getSettings();
    const tpl = s.templates.find(t => t.id === s.activeTemplateId);
    if (!tpl) return;
    const newName = String($('#up_tpl_name').val() || '').trim() || '未命名模板';
    const nameChanged = newName !== tpl.name;
    tpl.name = newName;
    tpl.systemPrompt = String($('#up_tpl_sys').val() || '');
    tpl.userTemplate = String($('#up_tpl_usr').val() || '');
    saveSettingsDebounced();
    if (nameChanged) renderTemplateList();
}

function onSaveTemplate() {
    onTemplateEditorChange();
    toastr.success('模板已保存');
}

/* ---------------- 预设区块 ---------------- */

function renderPresetList() {
    const s = getSettings();
    const list = $('#up_preset_list');
    list.empty();
    if (s.presets.length === 0) {
        list.append('<div class="up-hint">暂无 API 预设,可点击下方"＋ 新建预设"创建(OpenAI 兼容接口,如 DeepSeek / OpenAI / Claude 代理等)</div>');
    }
    s.presets.forEach(p => {
        list.append(`
        <div class="up-list-item" data-id="${p.id}">
            <label class="radio_label">
                <input type="radio" name="up_preset_active" value="${p.id}" ${p.id === s.activePresetId ? 'checked' : ''}>
                <span>${escapeHtml(p.name || '未命名预设')} <span class="up-hint">${escapeHtml(p.model || '')} @ ${escapeHtml(p.base || '')}</span></span>
            </label>
            <div class="menu_button up-preset-delete" data-id="${p.id}" title="删除预设">删除</div>
        </div>`);
    });
    list.append('<div class="menu_button up-preset-add">＋ 新建预设</div>');
}

function renderPresetEditor() {
    const s = getSettings();
    const p = s.presets.find(x => x.id === s.activePresetId);
    const editor = $('#up_preset_editor');
    if (!p) {
        editor.html(`<div class="up-hint">未选择预设(当前${s.useCurrentModel ? '使用酒馆当前 API' : '没有可用预设,将回退到当前 API'})</div>`);
        return;
    }
    editor.empty();
    editor.append(`
    <div class="up-editor">
        <div class="up-row">
            <span class="up-label">预设名称</span>
            <input type="text" id="up_preset_name" class="text_pole" value="${escapeHtml(p.name || '')}">
        </div>
        <div class="up-row">
            <span class="up-label">接口地址</span>
            <input type="text" id="up_preset_base" class="text_pole" value="${escapeHtml(p.base || '')}" placeholder="https://api.deepseek.com/v1">
        </div>
        <div class="up-row">
            <span class="up-label">模型</span>
            <input type="text" id="up_preset_model" class="text_pole" value="${escapeHtml(p.model || '')}" placeholder="deepseek-chat">
        </div>
        <div class="up-row">
            <span class="up-label">API 密钥</span>
            <input type="password" id="up_preset_key" class="text_pole" value="${escapeHtml(p.key || '')}">
        </div>
        <div class="up-row">
            <label class="checkbox_label">
                <input type="checkbox" id="up_preset_proxy" ${p.useProxy ? 'checked' : ''}>
                <span>经 ST 代理转发(解决跨域,需酒馆 config.yaml 开启 enableCorsProxy)</span>
            </label>
        </div>
        <div class="up-row up-row-buttons">
            <div class="menu_button up-preset-save">保存预设</div>
            <div class="menu_button up-preset-delete-current">删除此预设</div>
        </div>
    </div>`);
}

function onAddPreset() {
    const s = getSettings();
    const id = 'p_' + uuid();
    s.presets.push({ id: id, name: '新预设', base: 'https://api.deepseek.com/v1', key: '', model: 'deepseek-chat', useProxy: false });
    s.activePresetId = id;
    s.useCurrentModel = false;
    $('#up_use_current_model').prop('checked', false);
    saveSettingsDebounced();
    renderPresetList();
    renderPresetEditor();
}

function onDeletePreset(id) {
    const s = getSettings();
    const p = s.presets.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`确定删除预设"${p.name || '未命名预设'}"?`)) return;
    s.presets = s.presets.filter(x => x.id !== id);
    if (s.activePresetId === id) s.activePresetId = s.presets.length > 0 ? s.presets[0].id : '';
    saveSettingsDebounced();
    renderPresetList();
    renderPresetEditor();
}

function onActivatePreset(id) {
    const s = getSettings();
    if (!s.presets.some(x => x.id === id)) return;
    s.activePresetId = id;
    s.useCurrentModel = false;
    $('#up_use_current_model').prop('checked', false);
    saveSettingsDebounced();
    renderPresetList();
    renderPresetEditor();
}

function onSavePreset() {
    const s = getSettings();
    const p = s.presets.find(x => x.id === s.activePresetId);
    if (!p) return;
    p.name = String($('#up_preset_name').val() || '').trim() || '未命名预设';
    p.base = String($('#up_preset_base').val() || '').trim();
    p.model = String($('#up_preset_model').val() || '').trim();
    p.key = String($('#up_preset_key').val() || '');
    p.useProxy = $('#up_preset_proxy').prop('checked');
    saveSettingsDebounced();
    renderPresetList();
    toastr.success('预设已保存');
}

/* ---------------- 画像区块 ---------------- */

function renderProfileSection() {
    const s = getSettings();
    const meta = getChatMeta();
    const count = countUserMessages();
    const block = $('#up_profile_block');
    block.empty();
    block.append(`
    <div class="up-row">
        <span class="up-label">取最近</span>
        <input type="number" id="up_profile_count" class="text_pole up-num" value="${s.profileMessageCount}" min="1" max="500">
        <span class="up-label">条用户消息生成画像</span>
    </div>
    <div class="up-row">
        <label class="checkbox_label">
            <input type="checkbox" id="up_pick_mode" ${meta.pickMode ? 'checked' : ''}>
            <span>使用指定楼层更新画像(勾选后 AI 只从下方选中的楼层截取内容)</span>
        </label>
    </div>
    <div id="up_pick_wrap" class="up-pick-wrap" ${meta.pickMode ? '' : 'style="display:none"'}>
        <div class="up-row up-row-buttons">
            <div class="menu_button up-pick-all-user">全选用户消息</div>
            <div class="menu_button up-pick-clear">清空选择</div>
        </div>
        <div class="up-hint">仅显示最近 ${PICK_LIST_LIMIT} 条;勾选后更新画像时 AI 将从这些楼层截取内容(用户发言为重点,AI 发言作为语境参考)</div>
        <div id="up_pick_list" class="up-list up-pick-list"></div>
    </div>
    <div class="up-row"><span class="up-label">喜欢的段落(可选,AI 更新画像时将结合这些内容与你以往的输入)</span></div>
    <textarea id="up_liked_text" class="text_pole up-textarea" rows="3" placeholder="粘贴或输入你喜欢的段落、文风示例、表达习惯…">${escapeHtml(meta.likedText || '')}</textarea>
    <div class="up-row"><span class="up-label">全局画像(所有对话共享,可手动编辑)</span></div>
    <textarea id="up_global_profile" class="text_pole up-textarea" rows="5">${escapeHtml(s.globalProfile.text || '')}</textarea>
    <div class="up-hint" id="up_global_profile_time">${s.globalProfile.updatedAt ? '上次更新: ' + fmtTime(s.globalProfile.updatedAt) : '尚未生成'}</div>
    <div class="up-row"><span class="up-label">当前对话画像(仅本对话,随聊天记录保存)</span></div>
    <textarea id="up_chat_profile" class="text_pole up-textarea" rows="4" readonly>${escapeHtml(meta.profile || '')}</textarea>
    <div class="up-hint" id="up_profile_status">${meta.updatedAt ? '上次更新: ' + fmtTime(meta.updatedAt) + ' | ' : ''}已收集用户消息 ${count} 条 / 画像基于其中 ${meta.lastUpdateCount || 0} 条</div>
    <div class="up-row">
        <span class="up-label">更新范围:</span>
        <label class="checkbox_label">
            <input type="checkbox" id="up_update_global">
            <span>全局画像</span>
        </label>
        <label class="checkbox_label">
            <input type="checkbox" id="up_update_chat" checked>
            <span>当前会话画像</span>
        </label>
    </div>
    <div class="up-row up-row-buttons">
        <div class="menu_button up-profile-update">更新画像</div>
        <div class="menu_button up-global-profile-save">保存全局画像</div>
    </div>`);
    renderPickList();
}

/* ---------------- 指定楼层截取 ---------------- */

function renderPickList() {
    const meta = getChatMeta();
    const list = $('#up_pick_list');
    if (!list.length) return;
    const context = getContext();
    const chat = context && Array.isArray(context.chat) ? context.chat : [];
    const slice = chat.slice(-PICK_LIST_LIMIT);
    const picked = new Set(Array.isArray(meta.pickedIds) ? meta.pickedIds : []);
    list.empty();
    if (slice.length === 0) {
        list.append('<div class="up-hint">当前对话暂无消息</div>');
        return;
    }
    const startFloor = chat.length - slice.length + 1;
    slice.forEach((m, idx) => {
        if (!m) return;
        const floor = startFloor + idx;
        const name = m.is_user ? (m.name || '用户') : (m.name || 'AI');
        const text = (Array.isArray(m.swipes) && m.swipes.length > 0)
            ? String(m.swipes[m.swipes.length - 1] ?? '')
            : String(m.mes ?? '');
        if (!text.trim()) return;
        const id = m.id ? String(m.id) : '';
        list.append(`
        <label class="up-pick-item ${m.is_user ? 'up-pick-user' : 'up-pick-ai'}">
            <input type="checkbox" data-id="${escapeHtml(id)}" ${id && picked.has(id) ? 'checked' : ''}>
            <span class="up-pick-floor">#${floor}</span>
            <span class="up-pick-name">${escapeHtml(name)}</span>
            <span class="up-pick-preview">${escapeHtml(truncate(text, 40))}</span>
        </label>`);
    });
}

function onPickModeChange() {
    const meta = getChatMeta();
    meta.pickMode = $('#up_pick_mode').prop('checked');
    chat_metadata.userPolish = meta;
    saveMetadataDebounced();
    $('#up_pick_wrap').toggle(meta.pickMode);
    updateProfileStatus();
}

function savePickedIds() {
    const meta = getChatMeta();
    const ids = [];
    $('#up_pick_list .up-pick-item input:checked').each(function () {
        const id = $(this).data('id');
        if (id) ids.push(id);
    });
    meta.pickedIds = ids;
    chat_metadata.userPolish = meta;
    saveMetadataDebounced();
    updateProfileStatus();
}

function onPickAllUser() {
    $('#up_pick_list .up-pick-item.up-pick-user input').prop('checked', true);
    savePickedIds();
}

function onPickClear() {
    $('#up_pick_list .up-pick-item input').prop('checked', false);
    savePickedIds();
}

function updateProfileStatus() {
    const meta = getChatMeta();
    const count = countUserMessages();
    const el = $('#up_profile_status');
    if (el.length) {
        const src = meta.pickMode && Array.isArray(meta.pickedIds) && meta.pickedIds.length > 0
            ? `指定楼层模式 / 画像基于其中 ${meta.lastUpdateCount || 0} 条`
            : `已收集用户消息 ${count} 条 / 画像基于其中 ${meta.lastUpdateCount || 0} 条`;
        el.text(`${meta.updatedAt ? '上次更新: ' + fmtTime(meta.updatedAt) + ' | ' : ''}${src}`);
    }
}

function onSaveGlobalProfile() {
    const s = getSettings();
    const text = String($('#up_global_profile').val() || '').trim();
    s.globalProfile = { text: text, updatedAt: Date.now() };
    saveSettingsDebounced();
    $('#up_global_profile_time').text(text ? '上次更新: ' + fmtTime(s.globalProfile.updatedAt) : '尚未生成');
    toastr.success('全局画像已保存');
}

/* 喜欢的段落:输入后防抖保存到 chat_metadata(随聊天记录保存) */
let likedTextSaveTimer = null;
function onLikedTextInput() {
    const meta = getChatMeta();
    meta.likedText = String($('#up_liked_text').val() || '');
    chat_metadata.userPolish = meta;
    clearTimeout(likedTextSaveTimer);
    likedTextSaveTimer = setTimeout(saveMetadataDebounced, 500);
}

/* ---------------- 备份区块 ---------------- */

function renderBackupSection() {
    const s = getSettings();
    const block = $('#up_backup_block');
    block.empty();
    if (s.backups.length === 0) {
        block.append('<div class="up-hint">暂无备份。点击魔法棒菜单的"润色输入框"后,被替换的原文会自动备份到这里。</div>');
        return;
    }
    block.append('<div class="up-row up-row-buttons"><div class="menu_button up-backup-clear">清空备份</div></div>');
    s.backups.forEach(b => {
        block.append(`
        <div class="up-list-item up-backup-item" data-id="${b.id}">
            <div class="up-backup-meta">${fmtTime(b.time)} | 模板: ${escapeHtml(b.templateName || '')}</div>
            <div class="up-backup-text" title="${escapeHtml(b.original)}">原文: ${escapeHtml(truncate(b.original, 60))}</div>
            <div class="up-backup-text" title="${escapeHtml(b.polished)}">润色: ${escapeHtml(truncate(b.polished, 60))}</div>
            <div class="up-row up-row-buttons">
                <div class="menu_button up-backup-restore" data-id="${b.id}">恢复原文</div>
                <div class="menu_button up-backup-repolish" data-id="${b.id}">重新润色</div>
                <div class="menu_button up-backup-delete" data-id="${b.id}">删除</div>
            </div>
        </div>`);
    });
}

/* ---------------- 自动更新区块 ---------------- */

function renderAutoSection() {
    const s = getSettings();
    const block = $('#up_auto_block');
    block.empty();
    block.append(`
    <div class="up-row">
        <label class="checkbox_label">
            <input type="checkbox" id="up_auto_enabled" ${s.autoUpdateEnabled ? 'checked' : ''}>
            <span>自动更新画像</span>
        </label>
        <span class="up-label">每</span>
        <input type="number" id="up_auto_interval" class="text_pole up-num" value="${s.autoUpdateInterval}" min="1" max="1000">
        <span class="up-label">条新用户消息更新一次</span>
    </div>
    <div class="up-hint up-auto-status"></div>`);
    updateAutoStatus();
}

function updateAutoStatus() {
    const s = getSettings();
    const meta = getChatMeta();
    const count = countUserMessages();
    const sinceLast = Math.max(0, count - (meta.lastUpdateCount || 0));
    const el = $('.up-auto-status');
    if (el.length) {
        el.text(`自动更新: ${s.autoUpdateEnabled ? '开启' : '关闭'} | 上次更新后新增用户消息 ${sinceLast} 条 / 阈值 ${s.autoUpdateInterval} 条`);
    }
}

/* ---------------- 事件 ---------------- */

function onMessageSent() {
    const s = getSettings();
    updateProfileStatus();
    updateAutoStatus();
    if (!s.autoUpdateEnabled) return;
    const meta = getChatMeta();
    const count = countUserMessages();
    if (count - (meta.lastUpdateCount || 0) >= s.autoUpdateInterval) {
        updateProfiles()
            .then(() => toastr.info('偏好画像已自动更新'))
            .catch(err => console.error('[润色插件] 自动更新画像失败:', err));
    }
}

function onChatChanged() {
    renderProfileSection();
    updateAutoStatus();
}

/* ---------------- 斜杠命令 ---------------- */

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'polish',
        helpString: '用法: /polish 要润色的文字 —— 返回润色结果并替换命令文本;润色整个输入框请用魔法棒菜单的"润色输入框"',
        namedArgumentList: [],
        callback: async (args, value) => {
            const text = String(value || '').trim();
            if (!text) {
                toastr.info('用法: /polish 要润色的文字(润色整段输入请用魔法棒菜单的"润色输入框")');
                return '';
            }
            try {
                return await polishText(text);
            } catch (err) {
                showPolishError(err);
                return text;
            }
        },
    }));
}

/* ---------------- 初始化 ---------------- */

function renderAll() {
    renderTemplateList();
    renderTemplateEditor();
    renderPresetList();
    renderPresetEditor();
    renderProfileSection();
    renderBackupSection();
    renderAutoSection();
}

export async function init() {
    loadSettings();
    injectProgressBar();
    injectWandMenu();
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    registerSlashCommands();
    console.log('[润色插件] 已加载');
}
