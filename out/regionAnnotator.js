'use strict';
const vscode = require('vscode');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');

// ─── NPC 中文名映射（从 Config.yaml 懒加载）────────────────────────────────────
let _npcNameMap = null; // Map<string, string>  NPC.xxx 的 xxx → 中文名

function getNpcNameMap() {
  if (_npcNameMap) return _npcNameMap;
  _npcNameMap = new Map();
  // 在工作区里找 AutoGen/Config.yaml
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return _npcNameMap;
  for (const folder of folders) {
    const yamlPath = path.join(folder.uri.fsPath, '..', 'AutoGen', 'Config.yaml');
    if (!fs.existsSync(yamlPath)) continue;
    try {
      const text = fs.readFileSync(yamlPath, 'utf8');
      // 简单行级解析 avgNPCConfigs 下的 id / name 对
      let inSection = false;
      let currentId = null;
      for (const line of text.split('\n')) {
        if (/^avgNPCConfigs:/.test(line)) { inSection = true; continue; }
        if (inSection && /^[a-zA-Z]/.test(line) && !/^- /.test(line)) { inSection = false; }
        if (!inSection) continue;
        const idM = line.match(/^\s*-?\s*id:\s*['"]?([^'":\s]+)['"]?/);
        if (idM) { currentId = idM[1]; continue; }
        const nameM = line.match(/^\s*name:\s*['"]?([^'"]+)['"]?/);
        if (nameM && currentId) {
          _npcNameMap.set(currentId, nameM[1].trim());
          currentId = null;
        }
      }
    } catch (_) {}
    break;
  }
  return _npcNameMap;
}

function npcDisplayName(npcId) {
  const map = getNpcNameMap();
  return map.get(npcId) || npcId;
}

// ─── 任务 title 映射（从 Config.yaml 按任务名懒加载）────────────────────────────
const _titleCache = new Map(); // missionName → Map<id, title>

function getTaskTitleMap(missionName) {
  if (_titleCache.has(missionName)) return _titleCache.get(missionName);
  const result = new Map();
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) { _titleCache.set(missionName, result); return result; }
  let loaded = false;
  for (const folder of folders) {
    const yamlPath = path.join(folder.uri.fsPath, '..', 'AutoGen', 'Config.yaml');
    if (!fs.existsSync(yamlPath)) continue;
    try {
      const text = fs.readFileSync(yamlPath, 'utf8');
      let curId = null, curParent = null, curTitle = null;
      for (const line of text.split('\n')) {
        const idM = line.match(/^- id: '(.+)'/);
        if (idM) {
          // 上一个条目收尾
          if (curId && curParent === missionName && curTitle && curTitle.trim()) {
            result.set(curId, curTitle.trim());
          }
          curId = idM[1]; curParent = null; curTitle = null;
          continue;
        }
        if (!curId) continue;
        const parentM = line.match(/^\s+parent: '(.+)'/);
        if (parentM) { curParent = parentM[1]; continue; }
        const titleM = line.match(/^\s+title: '(.+)'/);
        if (titleM) { curTitle = titleM[1]; }
      }
      // 最后一个条目
      if (curId && curParent === missionName && curTitle && curTitle.trim()) {
        result.set(curId, curTitle.trim());
      }
      loaded = true;
    } catch (_) {}
    break;
  }
  // 只在成功读取 Config.yaml 后才缓存，避免因路径异常缓存空结果
  if (loaded) _titleCache.set(missionName, result);
  return result;
}

// ─── 输出面板（进度日志）────────────────────────────────────────────────────────
let _outputChannel = null;
function getOutput() {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('Lua Region Enhancer');
  }
  return _outputChannel;
}
function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  getOutput().appendLine(`[${ts}] ${msg}`);
}

// ─── API Key 检测（仅用于判断是否有直接 HTTP 能力，vscode.lm 不需要）──────────

function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    const s = JSON.parse(raw);
    if (s.apiKey) return s.apiKey;
  } catch (_) {}
  return vscode.workspace.getConfiguration('luaRegion').get('annotate.apiKey') || '';
}

// ─── LLM 调用（优先 vscode.lm，降级本地）────────────────────────────────────

// 注释规则基于 SecretPass.lua 提炼：
//   1. region 标签：功能短语（≤12字），不重复 id
//   2. 门控节点：region 头部集中说明无 actions 节点的触发方式
//   3. subTask 前注释：说明意图/路线，而不是重复 id
//   4. callBack key 注释：写"为什么"，尤其是隐藏约束、互锁、副作用
//   5. NoSave 行尾注释：说明重启后行为
//   6. 双重门控互锁：两个互相查询的节点旁注明防误触发原因
const LLM_REGION_SYSTEM = `你是 Lua 任务脚本的 region 标签生成器。

## 核心规则
1. label 必须是纯中文功能描述短语，≤12字
2. **严禁**在 label 中出现 id 字段的任何部分、prev 字段内容、或 action 类型名
3. 描述"这段代码做什么"，不描述"这段代码是什么"

## 字段说明
- **hint**：节点定义行前紧邻的原有注释，是作者对该节点的业务说明，**应优先作为 label 来源**，直接提炼其中的功能短语

## 按节点类型生成策略

**group**（有 subTasks 的容器节点）
→ 描述整个阶段的功能，如"张通引路教学阶段"、"首次进入上林苑"、"战斗结束多路检测"

**node**（叶节点，无子节点）
→ 描述单个动作的目的，如"踩入触发区播放开场CG"、"与王康对话解锁秘密选项"、"初始化战斗场景"

**batch**（同质并列节点组，如多个 NpcDead 检测）
→ 描述整组的共同目的，如"NPCGroup8 全员死亡检测"、"三名逃兵战斗击杀检测"
→ batchIds 字段列出了组内所有节点 id，可从中推断数量和对象

## 无法推断语义时的处理
- 若仅凭 id 和 actions 列表**无法判断节点的业务语义**（例如 id 是字母序列如 A/B/C/D，actions 只有 ManualAction 或 TriggerEnter 无法区分），则将该节点的 label 设为 **null**
- null 表示"交由本地模式生成"，不要输出 action 类型名、id 名、或任何英文单词作为标签
- 只在**确实能用中文功能短语概括业务含义**时才输出非 null 值，宁缺毋滥

## 参考示例（来自 SecretPass.lua）
- SecretPass_TalkWithWangKangCollection（group，两路汇合）→ "与王康对话两路汇合"
- SecretPass_Fight_ChangeCaoFen（node，初始化）→ "激活围墙设曹奋可击败"
- SecretPass_Fight_CaoFenCheck + SpawnCheck（双门控）→ "战斗结束双重门控检测"

## 输出格式
严格 JSON 对象，不输出任何其他内容：
{
  "regionLabels": [
    { "id": "节点id或batch的公共前缀", "label": "纯功能短语" }
  ]
}`;

function buildLlmInput(regions, lines, fileName) {
  // 只发 depth <= 1 的节点，超过 60 个截断
  const filtered = regions.filter(r => r.depth === undefined || r.depth <= 1);
  const capped   = filtered.slice(0, 60);
  const truncated = capped.length < filtered.length;

  const items = capped.map(r => {
    const base = { id: r.id, type: r.type };
    if (r.depth  !== undefined)          base.depth    = r.depth;
    if (r.prev    && r.prev.length)      base.prev     = r.prev;
    if (r.actions && r.actions.length)   base.actions  = r.actions;
    if (r.subIds  && r.subIds.length)    base.subIds   = r.subIds.slice(0, 8);
    if (r.batchIds && r.batchIds.length) base.batchIds = r.batchIds;

    // 提取节点前紧邻的原有注释行作为语义提示（最多向上扫 4 行）
    if (lines) {
      const hints = [];
      const startLine = r.insertBefore;
      for (let i = startLine - 1; i >= Math.max(0, startLine - 4); i--) {
        const t = lines[i].trim();
        if (t === '') continue; // 跳过空行
        // 只收集纯注释行，排除 region/endregion 标记本身
        if (/^--/.test(t) && !/^--\s*(region|endregion)\b/.test(t)) {
          // 去掉前导 -- 和多余空格，提取注释文本
          const text = t.replace(/^--+\s*/, '').trim();
          if (text) hints.unshift(text);
        } else {
          break; // 遇到代码行就停
        }
      }
      if (hints.length) base.hint = hints.join(' / ');
    }

    return base;
  });
  const note = truncated ? `\n（节点过多，已截断至前 ${capped.length} 个）` : '';
  return `文件：${fileName}${note}\n\n节点结构：\n${JSON.stringify(items, null, 2)}`;
}

/**
 * 通过 vscode.lm（Claude Code / Copilot）生成注释计划。
 * 返回 { regionLabels: [{id, label}], nodeComments: [{id, beforeComment}] }
 */
async function callVscodeLm(regions, fileName, lines) {
  let models = await vscode.lm.selectChatModels({ vendor: 'anthropic' });
  if (!models || models.length === 0) {
    models = await vscode.lm.selectChatModels();
  }
  if (!models || models.length === 0) {
    throw new Error('vscode.lm 无可用模型');
  }
  const model = models[0];

  const messages = [
    vscode.LanguageModelChatMessage.User(LLM_REGION_SYSTEM + '\n\n' + buildLlmInput(regions, lines, fileName)),
  ];

  // 最多重试 2 次（空响应或格式异常时）
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let text = '';
    for await (const chunk of response.text) text += chunk;

    if (!text.trim()) {
      if (attempt < 2) continue; // 空响应，重试
      throw new Error('返回格式异常：空响应');
    }

    const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      if (attempt < 2) continue; // 格式异常，重试
      throw new Error('返回格式异常：' + text.slice(0, 300));
    }
    let result;
    try { result = JSON.parse(jsonMatch[0]); }
    catch (e) { throw new Error('JSON解析失败：' + e.message + '\n原始：' + text.slice(0, 300)); }

    return {
      regionLabels: Array.isArray(result.regionLabels)
        ? result.regionLabels.filter(r => r.id && r.label != null)
        : [],
    };
  }
}


/**
 * 解析 Lua 文件，返回需要插入的 region 边界列表。
 * 每个条目：{ insertBefore: number, endBefore: number, id: string, type: string }
 * insertBefore / endBefore 均为 0-based 行号。
 * 返回 { regions, hasExisting }
 */
function parseRegionBounds(document) {
  const lines = [];
  for (let i = 0; i < document.lineCount; i++) {
    lines.push(document.lineAt(i).text);
  }

  const hasExisting = lines.some(l => /^\s*--\s*region\b/.test(l));
  const regions = [];

  // ── 1. 变量定义区 ──
  // 识别：文件头注释结束后，连续的 local / Mission.Xxx.cast 行（含多行 Table）
  let headerEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('--')) { headerEnd = i; } else { break; }
  }

  let varStart = -1, varEnd = -1;
  {
    let i = headerEnd + 1;
    let inBlockComment = false;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t === '' || (!inBlockComment && t.startsWith('--') && !t.startsWith('--[['))) { i++; continue; }
      if (/^local\s+/.test(t) || /^Mission\.\w+\.cast\s*=/.test(t)) {
        if (varStart === -1) varStart = i;
        let braceDepth = 0;
        for (let j = i; j < lines.length; j++) {
          const line = lines[j];
          let inStr = false, strChar = '';
          for (let c = 0; c < line.length; c++) {
            if (inBlockComment) {
              if (line[c] === ']' && line[c + 1] === ']') { inBlockComment = false; c++; }
              continue;
            }
            if (line[c] === '-' && line[c + 1] === '-' && line[c + 2] === '[' && line[c + 3] === '[') {
              inBlockComment = true; c += 3; continue;
            }
            const ch = line[c];
            if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strChar = ch; continue; }
            if (inStr && ch === strChar) { inStr = false; continue; }
            if (inStr) continue;
            if (ch === '-' && line[c + 1] === '-') break;
            if (ch === '{') braceDepth++;
            else if (ch === '}') braceDepth--;
          }
          if (braceDepth <= 0) { varEnd = j; i = j + 1; break; }
        }
      } else {
        break;
      }
    }
  }
  if (varStart !== -1) {
    regions.push({ type: 'vars', id: '变量定义', insertBefore: varStart, endBefore: varEnd + 1 });
  }

  // ── 2. initPromote 块 ──
  const promoteStart = lines.findIndex(l => /^\s*Mission\.\w+:initPromote\s*\(/.test(l));
  if (promoteStart !== -1) {
    const promoteEnd = findBlockEnd(lines, promoteStart);
    // 收集 promote 节点 id
    const promoteNodes = collectNodeIds(lines, promoteStart, promoteEnd);
    regions.push({
      type:         'promote',
      id:           'initPromote',
      nodes:        promoteNodes,
      insertBefore: promoteStart,
      endBefore:    promoteEnd + 1,
    });
  }

  // ── 3. initTask 块及其内部各 Task 节点 ──
  const taskStart = lines.findIndex(l => /^\s*Mission\.\w+:initTask\s*\(/.test(l));
  if (taskStart !== -1) {
    const taskEnd   = findBlockEnd(lines, taskStart);
    const taskNodes = collectNodeIds(lines, taskStart, taskEnd);
    regions.push({
      type:         'task',
      id:           'initTask',
      nodes:        taskNodes,
      insertBefore: taskStart,
      endBefore:    taskEnd + 1,
    });

    // initTask( ... ) 的直接子级 Table 范围
    // findBlockEnd 只追踪圆括号；这里需要拿到 initTask(...) 内部的 {} 内容范围
    // 做法：找到 taskStart 行之后第一个 {，即 initTask( 后面紧跟的内容开始
    // 实际上 initTask( \n  { ... }, { ... } \n)，内容就是 taskStart+1 ~ taskEnd-1
    const nodeRanges = collectNodeRangesRecursive(lines, taskStart + 1, taskEnd - 1, 0, 4);
    for (const nr of nodeRanges) {
      regions.push({
        type:         nr.type,
        id:           nr.id,
        nodes:        nr.subIds,
        prev:         nr.prev,
        actions:      nr.actions,
        depth:        nr.depth,
        siblingIdx:   nr.siblingIdx,
        batchIds:     nr.batchIds,
        insertBefore: nr.start,
        endBefore:    nr.end + 1,
      });
    }
  }

  return { regions, hasExisting };
}

/**
 * 从 startLine 找到 initTask/initPromote 外层 () 闭合的行。
 * 只追踪圆括号深度，跳过字符串和多行注释。
 */
function findBlockEnd(lines, startLine) {
  let depth = 0;
  let inBlockComment = false;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    let inStr = false;
    let strChar = '';
    for (let c = 0; c < line.length; c++) {
      // 多行注释结束
      if (inBlockComment) {
        if (line[c] === ']' && line[c + 1] === ']') { inBlockComment = false; c++; }
        continue;
      }
      // 多行注释开始
      if (line[c] === '-' && line[c + 1] === '-' && line[c + 2] === '[' && line[c + 3] === '[') {
        inBlockComment = true; c += 3; continue;
      }
      const ch = line[c];
      if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strChar = ch; continue; }
      if (inStr && ch === strChar) { inStr = false; continue; }
      if (inStr) continue;
      if (ch === '-' && line[c + 1] === '-') break;
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return i; }
    }
  }
  return lines.length - 1;
}

/**
 * 在给定行范围内，找所有"直接子级"Table 对象的行范围。
 * 直接子级 = 该范围内 {} 深度为 1 的顶层 { ... } 块。
 * 跳过字符串、单行注释、多行注释 --[[ ... ]]。
 * 返回 [{ start, end }]（均为 0-based 行号）
 */
function findDirectChildTables(lines, rangeStart, rangeEnd) {
  const results = [];
  let braceDepth = 0;
  let tableStart = -1;
  let inBlockComment = false;

  for (let i = rangeStart; i <= rangeEnd; i++) {
    const line = lines[i];
    let inStr = false;
    let strChar = '';
    for (let c = 0; c < line.length; c++) {
      // 多行注释结束
      if (inBlockComment) {
        if (line[c] === ']' && line[c + 1] === ']') { inBlockComment = false; c++; }
        continue;
      }
      // 多行注释开始 --[[
      if (line[c] === '-' && line[c + 1] === '-' && line[c + 2] === '[' && line[c + 3] === '[') {
        inBlockComment = true; c += 3; continue;
      }
      const ch = line[c];
      if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strChar = ch; continue; }
      if (inStr && ch === strChar) { inStr = false; continue; }
      if (inStr) continue;
      // 跳过单行注释
      if (ch === '-' && line[c + 1] === '-') break;
      if (ch === '{') {
        braceDepth++;
        if (braceDepth === 1) tableStart = i;
      } else if (ch === '}') {
        if (braceDepth === 1 && tableStart !== -1) {
          results.push({ start: tableStart, end: i });
          tableStart = -1;
        }
        braceDepth--;
      }
    }
  }
  return results;
}

/**
 * 递归收集 Task 节点，支持任意嵌套深度的 subTasks。
 *
 * 规则：
 * - 有 subTasks 的节点 → type:'group'，作为容器 region，包住子节点
 * - 无 subTasks 的节点 → type:'node'，独立叶节点 region
 * - 同质并列叶节点（id 去掉末尾 _N 后缀相同）→ 归并为一个 type:'batch' region
 *
 * 返回 [{ id, start, end, prev, actions, subIds, depth, type:'node'|'group'|'batch', batchIds? }]
 */
function collectNodeRangesRecursive(lines, rangeStart, rangeEnd, depth, maxDepth, parentId) {
  const results = [];
  const tables  = findDirectChildTables(lines, rangeStart, rangeEnd);

  // ── 先收集本层所有节点信息 ──
  const nodes = [];
  for (const tbl of tables) {
    const id = extractFirstId(lines, tbl.start, tbl.end);
    if (!id) continue;
    const prev          = extractPrev(lines, tbl.start, tbl.end);
    const actions       = extractActions(lines, tbl.start, tbl.end);
    const subTasksRange = findSubTasksRange(lines, tbl.start, tbl.end);
    nodes.push({ id, start: tbl.start, end: tbl.end, prev, actions, subTasksRange, depth });
  }

  // ── 同질归并：末尾 _数字 相同前缀的相邻叶节点合并为 batch ──
  const used = new Set();
  // 预先计算每个节点在同层中是第几个（用于 group 的分支编号）
  let groupCounter = 0;
  const nodeSiblingIdx = new Map(); // node index → groupIdx（1-based，仅 group 节点有值）
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].subTasksRange) {
      groupCounter++;
      nodeSiblingIdx.set(i, groupCounter);
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    if (used.has(i)) continue;
    const n   = nodes[i];
    const base = n.id.replace(/_\d+$/, '');
    const isSerialized = base !== n.id; // 末尾有数字后缀

    if (isSerialized && !n.subTasksRange) {
      // 找同前缀的相邻节点
      const group = [i];
      for (let j = i + 1; j < nodes.length; j++) {
        if (used.has(j)) break;
        const m = nodes[j];
        if (m.subTasksRange) break;
        if (m.id.replace(/_\d+$/, '') === base) { group.push(j); }
        else break;
      }
      // batch id 与父 group id 相同时跳过归并，避免重复 region
      if (group.length >= 2 && base !== parentId) {
        group.forEach(idx => used.add(idx));
        const first = nodes[group[0]];
        const last  = nodes[group[group.length - 1]];
        const batchIds = group.map(idx => nodes[idx].id);
        const batchActions = [...new Set(group.flatMap(idx => nodes[idx].actions))];
        results.push({
          type:         'batch',
          id:           base,
          batchIds,
          start:        first.start,
          end:          last.end,
          prev:         first.prev,
          actions:      batchActions,
          subIds:       [],
          depth,
          insertBefore: first.start,
          endBefore:    last.end + 1,
        });
        continue;
      }
    }

    used.add(i);

    if (n.subTasksRange && depth < maxDepth) {
      // 有 subTasks → 作为 group 容器，子节点递归展开，传入本节点 id 作为子层 parentId
      const subTables = findDirectChildTables(
        lines, n.subTasksRange.start + 1, n.subTasksRange.end - 1
      );
      const subIds = subTables.map(st => extractFirstId(lines, st.start, st.end)).filter(Boolean);
      const children = collectNodeRangesRecursive(
        lines, n.subTasksRange.start + 1, n.subTasksRange.end - 1,
        depth + 1, maxDepth, n.id  // ← 传入当前 group id
      );
      results.push({
        type:         'group',
        id:           n.id,
        start:        n.start,
        end:          n.end,
        prev:         n.prev,
        actions:      n.actions,
        subIds,
        depth,
        siblingIdx:   nodeSiblingIdx.get(i),
        insertBefore: n.start,
        endBefore:    n.end + 1,
      });
      results.push(...children);
    } else {
      // 无 subTasks（或已到最大深度）→ 叶节点
      const subIds = n.subTasksRange
        ? findDirectChildTables(lines, n.subTasksRange.start + 1, n.subTasksRange.end - 1)
            .map(st => extractFirstId(lines, st.start, st.end)).filter(Boolean)
        : [];
      results.push({
        type:         'node',
        id:           n.id,
        start:        n.start,
        end:          n.end,
        prev:         n.prev,
        actions:      n.actions,
        subIds,
        depth,
        siblingIdx:   nodeSiblingIdx.get(i),
        insertBefore: n.start,
        endBefore:    n.end + 1,
      });
    }
  }

  return results;
}

/**
 * 找 subTasks = { ... } 块的行范围，返回 { start, end } 或 null。
 */
function findSubTasksRange(lines, tableStart, tableEnd) {
  const subTasksRe = /^\s*subTasks\s*=/;
  for (let i = tableStart; i <= tableEnd; i++) {
    if (!subTasksRe.test(lines[i])) continue;
    let braceDepth = 0;
    let blockStart = -1;
    let inBlockComment = false;
    for (let j = i; j <= tableEnd; j++) {
      const line = lines[j];
      let inStr = false; let strChar = '';
      for (let c = 0; c < line.length; c++) {
        if (inBlockComment) {
          if (line[c] === ']' && line[c + 1] === ']') { inBlockComment = false; c++; }
          continue;
        }
        if (line[c] === '-' && line[c + 1] === '-' && line[c + 2] === '[' && line[c + 3] === '[') {
          inBlockComment = true; c += 3; continue;
        }
        const ch = line[c];
        if (!inStr && (ch === "'" || ch === '"')) { inStr = true; strChar = ch; continue; }
        if (inStr && ch === strChar) { inStr = false; continue; }
        if (inStr) continue;
        if (ch === '-' && line[c + 1] === '-') break;
        if (ch === '{') {
          braceDepth++;
          if (braceDepth === 1) blockStart = j;
        } else if (ch === '}') {
          braceDepth--;
          if (braceDepth === 0 && blockStart !== -1) return { start: blockStart, end: j };
        }
      }
    }
  }
  return null;
}

/**
 * 收集指定行范围内所有 id = '...' 的值。
 */
function collectNodeIds(lines, start, end) {
  const ids = [];
  const re = /^\s*id\s*=\s*['"](\w+)['"]/;
  for (let i = start; i <= end; i++) {
    const m = re.exec(lines[i]);
    if (m) ids.push(m[1]);
  }
  return ids;
}

function extractFirstId(lines, start, end) {
  const re = /^\s*id\s*=\s*['"](\w+)['"]/;
  for (let i = start; i <= end; i++) {
    const m = re.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

function extractPrev(lines, start, end) {
  // 只扫描到 subTasks = { 之前，避免读入子节点的 prev 字段
  const subTasksRe = /^\s*subTasks\s*=/;
  const re = /prev\s*=\s*\{([^}]*)\}/;
  for (let i = start; i <= end; i++) {
    if (subTasksRe.test(lines[i])) break;
    const m = re.exec(lines[i]);
    if (m) {
      const ids = [];
      const qre = /['"]([\w]+)['"]/g;
      let qm;
      while ((qm = qre.exec(m[1])) !== null) ids.push(qm[1]);
      return ids;
    }
  }
  return [];
}

function extractActions(lines, start, end) {
  // 只扫描到 subTasks = { 之前，避免把子节点的 action 归入父节点
  const subTasksRe = /^\s*subTasks\s*=/;
  const actions = [];
  const re = /TA_(\w+)\s*\(/g;
  for (let i = start; i <= end; i++) {
    if (subTasksRe.test(lines[i])) break;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      if (!actions.includes(m[1])) actions.push(m[1]);
    }
  }
  return actions;
}

// ─── 模式 A：本地生成 region 描述 ────────────────────────────────────────────

// TA 类型 → 业务动词描述
const TA_VERB = {
  TA_NpcGreeting:             (npc)      => `与${npc}对话`,
  TA_NpcsGreeting:            (npc)      => `与多NPC对话`,
  TA_NpcOption:               (npc)      => `与${npc}对话`,
  TA_NpcNear:                 (npc)      => `接近${npc}`,
  TA_NpcDead:                 (npc)      => `击杀${npc}`,
  TA_NpcSurrender:            (npc)      => `击败${npc}`,
  TA_NpcCastSkill:            (npc)      => `与${npc}技能交互`,
  TA_NpcCastSkillTag:         (npc)      => `与${npc}技能交互`,
  TA_OnNpcAttrPerReach:       (npc)      => `${npc}属性触发`,
  TA_TriggerEnter:            ()         => null,  // 走回调推断，前置"进入触发区域，"
  TA_GearInteract:            ()         => null,  // 走回调推断，前置"与机关交互，"
  TA_OnKillAll:               ()         => null,   // 走回调推断，前置"击杀所有敌人，"
  TA_OnEnemyPortalFinished:   ()         => `关闭敌人法阵`,
  TA_ManualAction:            ()         => null,  // 纯逻辑，不生成动词
  TA_ChangeHostile:           (npc)      => `${npc}变为敌对`,
  TA_ChangeIntimate:          (npc)      => `改变${npc}好感`,
  TA_SayCaption:              (npc)      => `${npc}喊话`,
  TA_ShowBubbleDialogue:      (npc)      => `${npc}气泡对话`,
  TA_WalkAlongTrack:          (npc)      => `${npc}沿轨道移动`,
  TA_LockPlayerAttributeUI:   ()         => `锁定装备界面`,
  TA_NpcLevelAI:              (npc)      => `设置${npc}关卡AI`,
  TA_ChangeOverridePhase:     (npc)      => `切换${npc}阶段`,
  TA_TriggerAction:           ()         => null,  // 走回调推断，前置"条件触发，"
  TA_WorldMapActorGreeting:   (npc)      => `大地图与${npc}对话`,
  TA_WorldMapActorShow:       ()         => `显示大地图Actor`,
  TA_WorldMapActorDisapear:   ()         => `隐藏大地图Actor`,
  TA_WorldMapPointShow:       ()         => `显示大地图地点`,
  TA_WorldMapPointDisapear:   ()         => `隐藏大地图地点`,
  TA_WorldMapPointOption:     ()         => `大地图地点选项`,
  TA_CloseWorldMapPointOption:()         => null,
  TA_AddObjectToNpc:          (npc)      => `给${npc}添加物件`,
  TA_RemoveObjectToNpc:       (npc)      => `移除${npc}物件`,
};

// 从 TA_ManualAction 回调内容推断业务语义
function inferManualActionVerb(lines, start, end, withNames = true) {
  let hasAccept         = false;
  let hasArticyHub      = false;
  let hasCutscene       = false;
  let hasChangeBeatable = false;
  let hasSetLocation    = false;
  let hasStartSpawn     = false;
  let hasAddReward      = false;
  let finishId          = null;
  const setActiveList   = [];
  const setUsualNpcs    = []; // [{ npcName: string }]

  for (let i = start; i <= end && i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*--/.test(line)) continue;
    if (/MissionMgr:Accept\(/.test(line))       hasAccept = true;
    if (/StartArticyHub\(/.test(line))           hasArticyHub = true;
    if (/GM\.StartCutscene\(/.test(line))        hasCutscene = true;
    if (/ChangeBeatable\s*\(.*true/.test(line))  hasChangeBeatable = true;
    if (/[:\.]SetLocation\(/.test(line))         hasSetLocation = true;
    if (/StartSpawn\(/.test(line))               hasStartSpawn = true;
    if (/AddReward\(/.test(line))                hasAddReward = true;
    if (!finishId) {
      const fm = line.match(/MissionMgr:Finish\(\s*['"]([^'"]+)['"]/);
      if (fm) finishId = fm[1];
    }
    // 提取 SetUsual：NPC.Xxx:SetUsual(...) 或 NPC.Xxx:SetUsual(...)
    const suRe = /NPC\.(\w+)\s*:\s*SetUsual\(/g;
    let sum;
    while ((sum = suRe.exec(line)) !== null) {
      const npcName = npcDisplayName(sum[1]);
      if (!setUsualNpcs.find(x => x === npcName)) setUsualNpcs.push(npcName);
    }
    // 提取 SetActive 的路径参数和开关值
    // 支持：SetActive('A/Mission_X/B', true)  和  SetActive(Var..'B', true)
    const saRe = /SetActive\(\s*(?:['"]([^'"]+)['"]|\w+\s*\.\.\s*['"]([^'"]+)['"])\s*,\s*(true|false)/g;
    let sam;
    while ((sam = saRe.exec(line)) !== null) {
      const fullPath = sam[1] || null;  // 纯字符串参数
      const suffix   = sam[2] || null;  // 拼接表达式后半段
      const active   = sam[3] === 'true';
      let name;
      if (suffix) {
        // 拼接形式：直接用后缀部分，去掉路径前缀，只取最后一段或两段
        name = suffix.replace(/^\//, '');
      } else {
        // 纯字符串：取 Mission_XXX/ 后面的部分
        const nameM = fullPath.match(/Mission_[^/]+\/(.+)/);
        name = nameM ? nameM[1] : fullPath.split('/').pop();
      }
      setActiveList.push({ name, active });
    }
  }

  const hasSetActive = setActiveList.length > 0;
  const hasSetUsual  = setUsualNpcs.length > 0;
  const setUsualDesc = hasSetUsual
    ? `切换${setUsualNpcs.join('、')}状态`
    : '切换NPC状态';

  if (hasAccept)                          return '接取任务';
  if (hasChangeBeatable)                  return '开始战斗';
  if (hasStartSpawn && hasSetActive)      return '生成敌人，' + formatSetActive(setActiveList, withNames);
  if (hasStartSpawn)                      return '生成敌人';
  if (hasArticyHub && hasCutscene)        return '触发过场对话';
  if (hasArticyHub)                       return '触发剧情对话';
  if (hasCutscene)                        return '触发过场';
  if (hasSetLocation)                     return '调度场景NPC';
  if (hasSetUsual && hasSetActive)        return setUsualDesc + '，' + formatSetActive(setActiveList, withNames);
  if (hasSetUsual)                        return setUsualDesc;
  if (hasSetActive)                       return formatSetActive(setActiveList, withNames);
  if (hasAddReward)                       return '发放奖励';
  if (finishId)                           return '完成流程节点';
  return null;
}

// 将 SetActive 列表格式化
// withNames=true：打开场景物体A、B，关闭场景物体C
// withNames=false：打开场景物体，关闭场景物体（去掉具体名字，用于 region 标签）
function formatSetActive(list, withNames = true) {
  const opens  = list.filter(x => x.active);
  const closes = list.filter(x => !x.active);
  const parts  = [];
  if (opens.length)  parts.push(withNames ? `打开场景物体${opens.map(x => x.name).join('、')}` : '打开场景物体');
  if (closes.length) parts.push(withNames ? `关闭场景物体${closes.map(x => x.name).join('、')}` : '关闭场景物体');
  return parts.join('，');
}

// 从代码行中提取 TA 调用信息，返回 { taName, npcName } 数组
function extractTaCalls(lines, start, end) {
  const results = [];
  const taRe = /\b(TA_\w+)\s*\(\s*(?:NPC\.(\w+)|([^,)]+))?/g;
  for (let i = start; i <= end && i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*--/.test(line)) continue;
    let m;
    taRe.lastIndex = 0;
    while ((m = taRe.exec(line)) !== null) {
      const taName  = m[1];
      const npcId   = m[2] || null;
      const npcName = npcId ? npcDisplayName(npcId) : null;
      results.push({ taName, npcName, taLine: i });
    }
  }
  return results;
}

// 精简拓扑标注（括号内容）
function topoSuffix(region) {
  switch (region.type) {
    case 'batch': return `并列${(region.batchIds || []).length}路`;
    case 'group': {
      // 用同层顺序编号：分支1、分支2...
      const idx = region.siblingIdx;
      return idx ? `分支${idx}` : '分支';
    }
    case 'node': {
      const pc = (region.prev || []).length;
      // 入口标注只对顶层节点（depth===0）有意义；子节点 prev 为空只是并行结构，不标入口
      if (pc === 0 && (region.depth === undefined || region.depth === 0)) return '入口';
      if (pc >= 2)  return `汇合${pc}路`;
      return '';
    }
    default: return '';
  }
}

// 扫描 group 的子节点首层，提取最多 MAX_CHILD_WORDS 个代表性动词
// subTasksLine: subTasks = { 所在行；end: group 整体结束行
function extractGroupChildVerbs(lines, subTasksLine, end, GROUP_VERB) {
  const MAX_CHILD_WORDS = 2;
  const seen  = new Set();
  const words = [];
  // 找到 subTasks = { 后的第一个 { 开始的子节点，逐个扫描其范围
  let depth = 0;
  let inSubTasks = false;
  let childStart = -1;
  let childDepth = 0;

  for (let i = subTasksLine; i <= end && i < lines.length; i++) {
    const t = lines[i];
    // 统计大括号增减
    const opens  = (t.match(/\{/g) || []).length;
    const closes = (t.match(/\}/g) || []).length;

    if (!inSubTasks) {
      // subTasksLine 本行可能含 {，先进入 subTasks 层
      depth += opens - closes;
      inSubTasks = true;
      continue;
    }

    if (childStart === -1) {
      // 等待子节点 { 开始
      if (/\{/.test(t)) {
        childStart = i;
        childDepth = depth + opens - closes;
        depth = childDepth;
        // 扫描这个子节点：从 childStart 到它关闭的行
        // 扫描 actions 内所有层（TA 调用可能嵌在 actions = { ... } 里）
        // 但不进入子节点自己的 subTasks（遇到 subTasks = { 就跳过整个嵌套块）
        const childCalls = [];
        let d = 1; // 相对深度，进入子节点后为1
        let childEnd = childStart;
        let skipDepth = -1; // 跳过 subTasks 块时的起始深度
        for (let j = childStart; j <= end && j < lines.length; j++) {
          const jt = lines[j];
          const jo = (jt.match(/\{/g) || []).length;
          const jc = (jt.match(/\}/g) || []).length;
          if (j > childStart) d += jo - jc;
          if (d <= 0) { childEnd = j; break; } // 子节点结束
          // 进入 subTasks 块后跳过，直到该块关闭
          if (skipDepth >= 0) {
            if (d <= skipDepth) skipDepth = -1; // subTasks 块已关闭
            continue;
          }
          if (!/^\s*--/.test(jt)) {
            if (/^\s*subTasks\s*=/.test(jt)) { skipDepth = d; continue; }
            const taRe = /\b(TA_\w+)\s*\(\s*(?:NPC\.(\w+))?/g;
            let m;
            while ((m = taRe.exec(jt)) !== null) {
              const taName = m[1];
              const npcId  = m[2] || null;
              const base   = GROUP_VERB[taName];
              if (!base) continue;
              const npcName = npcId ? npcDisplayName(npcId) : null;
              const v = npcName && (taName === 'TA_NpcGreeting' || taName === 'TA_NpcOption' ||
                                    taName === 'TA_NpcNear' || taName === 'TA_NpcDead' || taName === 'TA_NpcSurrender')
                ? base.replace('NPC', '') + npcName
                : base;
              childCalls.push(v);
            }
          }
        }
        // 外层继续从子节点结束后扫描下一个子节点
        i = childEnd;
        for (const v of childCalls) {
          if (!seen.has(v)) { seen.add(v); words.push(v); }
        }
        if (words.length >= MAX_CHILD_WORDS) break;
        childStart = -1; // 重置，继续找下一个子节点
      } else {
        depth += opens - closes;
      }
    }
  }
  return words;
}

function localDescription(region, lines) {
  switch (region.type) {
    case 'vars':    return '变量定义';
    case 'promote': return '任务接取';
    case 'task':    return '任务主体';
  }

  const start = region.insertBefore !== undefined ? region.insertBefore : (region.start || 0);
  const end   = region.endBefore   !== undefined ? region.endBefore - 1 : (region.end   || 0);

  // group 类型：扫描到 subTasks = { 之前，避免把子节点的 TA 全部拼进来
  if (region.type === 'group') {
    const GROUP_VERB = {
      TA_NpcGreeting:   '对话',   TA_NpcOption:     '对话',   TA_NpcNear:       '接近NPC',
      TA_NpcDead:       '击杀',   TA_NpcSurrender:  '击败',   TA_TriggerEnter:  '进入触发区域',
      TA_GearInteract:  '与机关交互', TA_OnKillAll: '击杀所有敌人',
      TA_TriggerAction: '条件触发',  TA_ChangeHostile: '切换敌对',
      TA_OnEnemyPortalFinished: '关闭敌人法阵',
    };
    // 只扫到 subTasks = { 之前，不进入子节点
    let groupScanEnd = end;
    let subTasksLine = -1;
    for (let i = start; i <= end; i++) {
      if (/^\s*subTasks\s*=/.test(lines[i])) { groupScanEnd = i - 1; subTasksLine = i; break; }
    }
    const calls = extractTaCalls(lines, start, groupScanEnd);
    const seen  = new Set();
    const words = [];
    for (const { taName, npcName } of calls) {
      const base = GROUP_VERB[taName];
      if (!base) continue;
      // NPC 类型加名字，其他不加
      const v = npcName && (taName === 'TA_NpcGreeting' || taName === 'TA_NpcOption' || taName === 'TA_NpcNear' || taName === 'TA_NpcDead' || taName === 'TA_NpcSurrender')
        ? base.replace('NPC', '') + npcName
        : base;
      if (!seen.has(v)) { seen.add(v); words.push(v); }
    }
    const suffix = topoSuffix(region);
    if (words.length > 0) {
      return suffix ? `${words.join('，')}【${suffix}】` : words.join('，');
    }
    // 无法推断时，纯拓扑标注（分支N）
    return suffix ? `【${suffix}】` : '【分支】';
  }

  // group 类型：只扫到 subTasks = { 之前，避免把子节点的 TA 全拼进来
  let scanEnd = end;
  if (region.type === 'group') {
    for (let i = start; i <= end; i++) {
      if (/^\s*subTasks\s*=/.test(lines[i])) { scanEnd = i - 1; break; }
    }
  }

  const calls = extractTaCalls(lines, start, scanEnd);

  // 按 taName 分组，同类 TA 聚合处理
  // 结构：Map<taName, { npcNames: string[], taLine: number }>
  // 触发型 TA：null 返回值但有前缀描述，回调内容组合
  const TRIGGER_PREFIX = {
    TA_TriggerEnter:  '进入触发区域',
    TA_GearInteract:  '与机关交互',
    TA_TriggerAction: '条件触发',
    TA_OnKillAll:     '击杀所有敌人',
  };

  const taGroups = new Map();
  for (const { taName, npcName, taLine } of calls) {
    if (!taGroups.has(taName)) taGroups.set(taName, { npcNames: [], taLine });
    if (npcName) taGroups.get(taName).npcNames.push(npcName);
  }

  const verbs     = [];
  const seen      = new Set();
  const withNames = region.type !== 'group';

  for (const [taName, { npcNames, taLine }] of taGroups) {
    const fn = TA_VERB[taName];
    if (!fn) continue;

    let v;
    if (taName === 'TA_ManualAction' || TRIGGER_PREFIX[taName]) {
      const inner = inferManualActionVerb(lines, taLine, end, withNames);
      if (TRIGGER_PREFIX[taName]) {
        // 触发型：前缀 + "后，" + 回调内容，如"与机关交互后，生成敌人"
        v = inner ? `${TRIGGER_PREFIX[taName]}后，${inner}` : TRIGGER_PREFIX[taName];
      } else {
        v = inner;
      }
    } else {
      // 同类多个 NPC：去重后聚合
      const uniqueNpcs = [...new Set(npcNames)];
      if (uniqueNpcs.length === 0) {
        v = fn('');
      } else if (uniqueNpcs.length === 1) {
        v = fn(uniqueNpcs[0]);
      } else {
        const base = fn(uniqueNpcs[0]);
        v = base ? base.replace(uniqueNpcs[0], uniqueNpcs.join('、')) : null;
      }
    }

    if (!v || seen.has(v)) continue;
    seen.add(v);
    verbs.push(v);
  }

  // batch 特殊：描述并列的动作 + 路数
  if (region.type === 'batch') {
    const count = (region.batchIds || []).length;
    const base  = verbs[0] || inferManualActionVerb(lines, start, scanEnd);
    return base ? `${base}【${count}路并列】` : `【${count}路并列】`;
  }

  const suffix = topoSuffix(region);
  const inferred = verbs.length > 0
    ? verbs.join('，')
    : inferManualActionVerb(lines, start, scanEnd, withNames);

  if (inferred) {
    // 有业务描述：业务描述 + 【拓扑】
    return suffix ? `${inferred}【${suffix}】` : inferred;
  } else {
    // 纯拓扑 fallback
    const topo = suffix || (region.type === 'group' ? '分支' : '流程节点');
    return `【${topo}】`;
  }
}

// ─── 文件头生成 ───────────────────────────────────────────────────────────────

const LLM_HEADER_SYSTEM = `你是 Lua 任务脚本注释专家。
根据提供的完整 Lua 任务脚本，生成文件头注释块。
目标读者：策划或任务开发，读注释即可理解任务完整流程，无需阅读实现代码。

## 文件头格式（严格按此输出）
-- 作者：Claude@KAFKA
-- 功能：{MissionName}任务管理脚本
-- ============================================================
-- Task 依赖图（ID 在代码中可 Ctrl+Click 跳转定义）
--
--   [接取] {接取方式：触发器/对话/手动，≤15字描述触发条件}
--
--   {RootNode}（{action类型}）{节点职责，≤20字}
--     ──► {ChildNode}（{action类型}）{节点职责，≤20字}
--           {分支关系说明，如：SetValue WeaponStatus 决定后续剑型}
--           {存档策略说明，如：NoSave=true，重启后重新触发}
--     ──► ...
--
-- ============================================================

## 依赖图规则
1. 按 prev 关系绘制 ──► 箭头，体现 Finish 链路
2. 每个节点写：id（不加任务前缀）、action类型、职责描述（≤30字）
3. 有分支状态（SetValue/GetValue）的节点，在其下缩进注明分支含义
4. NoSave=true 的节点，注明"重启后重新触发"或具体恢复策略
5. 门控节点（无action，靠 prev 汇合触发）注明"等待XXX完成后推进"
6. 战斗/剧情切换节点注明切换时机
7. initPromote 只写接取条件，不单独列节点
8. 作者行固定写 Claude@KAFKA
9. 只输出注释文本本身（含 -- 前缀），不输出任何其他内容`;

/** 本地模式文件头：只写作者行，不依赖 LLM */
async function buildLocalFileHeader(lines, fileName) {
  const missionName = fileName.replace(/\.lua$/i, '');
  const existingAuthorLine = lines.find(l => /^--\s*作者[：:]/.test(l));
  const existingAuthor = existingAuthorLine
    ? existingAuthorLine.replace(/^--\s*作者[：:]\s*/, '').trim()
    : null;

  let authorValue;
  if (!existingAuthor) {
    // 没有作者行，提示用户输入
    const input = await vscode.window.showInputBox({
      prompt: '请输入作者名（将与 Lre@Kafka 一并写入）',
      placeHolder: '如：KAFKA',
    });
    authorValue = input ? `${input}, Lre@Kafka` : 'Lre@Kafka';
  } else if (!existingAuthor.includes('Lre@Kafka')) {
    authorValue = `${existingAuthor}, Lre@Kafka`;
  } else {
    authorValue = existingAuthor;
  }
  return `-- 作者：${authorValue}\n-- 功能：${missionName}任务管理脚本`;
}

/**
 * 调用 LLM 生成文件头注释。返回完整注释字符串（多行，每行以 -- 开头）。
 */
async function callVscodeLmHeader(model, lines, fileName) {
  const missionName = fileName.replace(/\.lua$/i, '');
  // 提取文件中已有的作者信息
  const existingAuthorLine = lines.find(l => /^--\s*作者[：:]/.test(l));
  const existingAuthor = existingAuthorLine
    ? existingAuthorLine.replace(/^--\s*作者[：:]\s*/, '').trim()
    : null;
  const code = lines.join('\n');
  const prompt = LLM_HEADER_SYSTEM + `\n\n文件名：${fileName}\n\n代码：\n${code}`;
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
  let text = '';
  for await (const chunk of response.text) text += chunk;
  // 只保留以 -- 开头的行，去除 LLM 可能输出的多余说明
  text = text.split('\n').filter(l => /^--/.test(l.trim()) || l.trim() === '').join('\n').trim();
  // 若文件已有作者且不含 Lre@Kafka，则追加而非覆盖
  if (existingAuthor && !existingAuthor.includes('Lre@Kafka')) {
    text = text.replace(/^(--\s*作者[：:]).*$/m, `$1${existingAuthor}, Lre@Kafka`);
  }
  return text;
}

// ─── 深度注释：筛选 + 分批调用 ────────────────────────────────────────────────

const LLM_DEEP_SYSTEM = `你是 Lua 任务脚本注释专家。
目标读者：策划或任务开发，读注释即可理解任务完整流程，无需阅读实现代码。

## 必须注释的情况
- 节点职责：这个节点在任务流程中做什么、为什么存在
- 门控节点（无 actions 或只有 ManualAction 空逻辑）：说明等待哪些前置完成、何时推进
- 标记节点（SetValue/记录状态）：说明记录了什么、影响后续哪个分支
- 汇合节点（多个 prev）：说明汇合了哪几路、汇合后推进什么
- 战斗/剧情切换：说明切换时机和条件
- NoSave = true：说明为什么不存档，重启后的恢复策略
- 复杂 prev 依赖（3个以上前置）：说明依赖关系的业务含义

## 不要注释的内容
- Callback key 名称（如 FinishTask_Xxx、Remember_Xxx）
- MissionMgr:Finish / Accept 调用
- SetValue / GetValue 调用本身
- 普通条件判断（HasItem、isfinished 等）
- 普通函数调用（AddReward、SetUsual 等）
- Lua 语法实现细节

## 注释风格
- 说明"这段逻辑在任务流程中的作用"，不描述代码做了什么
- 每条注释不超过 50 字，用分号分隔多个要点
- 不重复 id 名称中已有的信息

## 输出格式
严格 JSON 数组，不输出任何其他内容：
[
  {
    "id": "节点id",
    "beforeComment": "插在该节点 { 前的注释，多行用\\n分隔（不含 -- 前缀，输出时统一加）"
  }
]

若节点无需注释（职责已由 id 完全表达），将该节点的 beforeComment 设为 null 或省略该条目。`;

/**
 * 判断节点是否值得深度注释。
 * 条件（满足任一）：
 *   - 节点代码行数 > 15（有足够复杂度）
 *   - 包含 MissionMgr:isfinished（门控/互锁逻辑）
 *   - 含 NoSave = true（存档策略需说明）
 *   - 含 SetValue（状态标记节点，影响分支）
 *   - prev 数量 >= 3（复杂汇合节点）
 */
function isDeepWorthy(lines, region) {
  const start = region.start !== undefined ? region.start : region.insertBefore;
  const end   = region.end   !== undefined ? region.end   : region.endBefore - 1;
  if (end - start > 15) return true;
  for (let i = start; i <= end; i++) {
    const l = lines[i];
    if (/isfinished\s*\(/.test(l))    return true;
    if (/NoSave\s*=\s*true/.test(l))  return true;
    if (/:\s*SetValue\s*\(/.test(l))  return true;
  }
  // 直接使用已解析的 prev 数组
  if ((region.prev || []).length >= 3) return true;
  return false;
}

/**
 * 提取节点的实际代码片段（最多 60 行，超出截断）
 */
function extractCodeSnippet(lines, region) {
  const start = region.start !== undefined ? region.start : region.insertBefore;
  const end   = Math.min(
    region.end !== undefined ? region.end : region.endBefore - 1,
    start + 59
  );
  return lines.slice(start, end + 1).join('\n');
}

/**
 * 深度注释：筛选值得注释的节点，分批并行调用 LLM，返回 commentMap。
 * onProgress(done, total) 在每批完成后回调，用于更新进度显示。
 */
async function callVscodeLmDeep(lines, regions, onProgress, cancelToken) {
  const worthy = regions.filter(r =>
    (r.type === 'node' || r.type === 'group') && isDeepWorthy(lines, r)
  );
  if (worthy.length === 0) return new Map();

  const BATCH = 8;
  const batches = [];
  for (let i = 0; i < worthy.length; i += BATCH) {
    batches.push(worthy.slice(i, i + BATCH));
  }

  let models = await vscode.lm.selectChatModels({ vendor: 'anthropic' });
  if (!models || models.length === 0) models = await vscode.lm.selectChatModels();
  if (!models || models.length === 0) throw new Error('vscode.lm 无可用模型');
  const model = models[0];

  let doneCount = 0;
  const total = batches.length;
  const CONCURRENCY = 4; // vscode.lm 并发上限，超过会排队反而更慢

  // 限并发滑动窗口：最多同时跑 CONCURRENCY 个请求
  const allResults = new Array(batches.length);
  let nextIdx = 0;

  async function runOne(idx) {
    allResults[idx] = []; // 防御初始化，异常时保证可迭代
    const batch = batches[idx];
    if (cancelToken && cancelToken.isCancellationRequested) { return; }
    const payload = batch.map(r => ({
      id:   r.id,
      code: extractCodeSnippet(lines, r),
    }));
    const prompt = LLM_DEEP_SYSTEM + '\n\n' + JSON.stringify(payload, null, 2);
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const token = cancelToken || new vscode.CancellationTokenSource().token;
    const response = await model.sendRequest(messages, {}, token);
    let text = '';
    for await (const chunk of response.text) {
      if (cancelToken && cancelToken.isCancellationRequested) { allResults[idx] = []; return; }
      text += chunk;
    }
    doneCount++;
    if (onProgress) onProgress(doneCount, total);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    allResults[idx] = jsonMatch ? (() => { try { return JSON.parse(jsonMatch[0]); } catch (_) { return []; } })() : [];
  }

  // 启动初始窗口
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, batches.length); i++) {
    workers.push((async () => {
      let idx;
      while ((idx = nextIdx++) < batches.length) {
        await runOne(idx);
      }
    })());
  }
  await Promise.all(workers);

  const results = allResults;

  const commentMap = new Map();
  for (const batch of results) {
    for (const item of batch) {
      if (!item.id || !item.beforeComment) continue;
      commentMap.set(item.id, item.beforeComment);
    }
  }
  return commentMap;
}

// ─── 插入逻辑 ────────────────────────────────────────────────────────────────

/**
 * labelMap: Map<id, string>  region 标签覆盖
 * commentMap: Map<id, string> 节点前插入的注释块（含可选的 __keyComments__: 标记）
 *
 * commentMap 值格式：
 *   "普通注释行1\n普通注释行2\n__keyComments__:[{key,comment},...]"
 *   __keyComments__ 之后的部分会被解析，在节点内部对应 key 行前插入注释
 */
async function applyRegions(document, editor, regions, labelMap, commentMap, fileHeader, lines, titleMap) {
  // promote/task 由 initPromote/initTask 大纲规则覆盖，不插 region
  let toInsert = regions.filter(r =>
    r.type === 'vars' || r.type === 'node' || r.type === 'group' || r.type === 'batch'
  );

  // 去重：同一 (id + insertBefore) 组合只保留一条，优先级 group > node > batch
  const TYPE_PRIO = { group: 0, node: 1, batch: 2, vars: 3 };
  const seen = new Map(); // key: `${id}:${insertBefore}`
  for (const r of toInsert) {
    const key = `${r.id}:${r.insertBefore}`;
    if (!seen.has(key) || TYPE_PRIO[r.type] < TYPE_PRIO[seen.get(key).type]) {
      seen.set(key, r);
    }
  }
  toInsert = Array.from(seen.values());

  // 先生成所有 label，检测同层重复描述，重复时追加 id 短尾
  const labelCache = new Map(); // id → label
  for (const r of toInsert) {
    labelCache.set(r.id, labelMap.get(r.id) || localDescription(r, lines));
  }
  // 统计每个 label 出现次数，用于去重（只对非 group 类型，group 的 id 末尾段已天然唯一）
  const labelCount = new Map();
  for (const [id, lbl] of labelCache) {
    const r = toInsert.find(x => x.id === id);
    if (r && r.type === 'group') continue;  // group 不参与重复计数
    labelCount.set(lbl, (labelCount.get(lbl) || 0) + 1);
  }
  // 对重复的 label 追加 id 短尾：去掉公共前缀后的最后一段
  function shortIdSuffix(id) {
    // 取最后一个 _ 之后的部分，如 _Check_1 → _1，_Check → _Check
    const m = id.match(/_([^_]+)$/);
    return m ? m[1] : id;
  }
  for (const [id, lbl] of labelCache) {
    const r = toInsert.find(x => x.id === id);
    if (r && r.type === 'group') continue;  // group 跳过去重
    if ((labelCount.get(lbl) || 0) > 1) {
      labelCache.set(id, `${lbl}(${shortIdSuffix(id)})`);
    }
  }

  // 收集所有插入操作：{ line: number, text: string }（0-based 行号，在该行前插入）
  // 最后统一倒序写入，避免行号偏移
  const insertions = []; // { line, text }

  for (const r of toInsert) {
    const label = labelCache.get(r.id);

    // 从插入行读取实际缩进
    const indentLine = lines[r.insertBefore] || '';
    const indent     = (indentLine.match(/^(\s*)/) || ['', ''])[1];

    // depth=0 或 depth=1 的 group：生成 -- region / -- endregion（可折叠，为大纲提供层级）
    // depth>0 的 node/batch：单行 --! 注释
    const isTop = (r.depth === undefined || r.depth === 0)
               || (r.type === 'group' && r.depth === 1);

    // 节点前注释块（LLM 生成的 beforeComment），带 --! 标记供清理
    let beforeCommentText = '';
    const raw = commentMap && commentMap.get(r.id);
    if (raw) beforeCommentText = raw;
    const commentBlock = beforeCommentText
      ? beforeCommentText.split('\n').filter(l => l.trim()).map(l => `${indent}-- ${l.replace(/^--+\s*/, '')} --!`).join('\n') + '\n'
      : '';

    if (isTop) {
      const titleTop = titleMap && titleMap.get(r.id);
      const titleTopLine = titleTop ? `${indent}-- title:${titleTop} --!\n` : '';
      insertions.push({ line: r.insertBefore, text: commentBlock + titleTopLine + `${indent}-- region ${label}\n` });
      insertions.push({ line: r.endBefore,    text: `${indent}-- endregion\n` });
    } else {
      // 子节点：若有 Config title 则先插 title 行，再插 TA 推断注释
      const title = titleMap && titleMap.get(r.id);
      const titleLine = title ? `${indent}-- title:${title} --!\n` : '';
      insertions.push({ line: r.insertBefore, text: commentBlock + titleLine + `${indent}-- ${label} --!\n` });
    }
  }

  // 倒序按行号排序，行号相同时 endregion 后插（text 含 endregion 的排在前，插入后在下方）
  insertions.sort((a, b) => {
    if (b.line !== a.line) return b.line - a.line;
    // 同行：endregion 先处理（插入后在下方），其他注释后处理（插入后在上方）
    const aIsEnd = /^\s*-- endregion/.test(a.text);
    const bIsEnd = /^\s*-- endregion/.test(b.text);
    if (aIsEnd && !bIsEnd) return -1;
    if (!aIsEnd && bIsEnd) return 1;
    return 0;
  });

  // 文件头：先单独处理（替换或插入），避免与 region 插入行号混淆
  let headerLineOffset = 0;
  if (fileHeader) {
    const docLines = [];
    for (let i = 0; i < document.lineCount; i++) docLines.push(document.lineAt(i).text);
    let headerEnd = 0;
    for (let i = 0; i < docLines.length; i++) {
      const t = docLines[i].trim();
      if (t === '' || t.startsWith('--')) { headerEnd = i; }
      else { break; }
    }
    const hasHeader = docLines.slice(0, headerEnd + 1).some(l => /^--\s*(作者|功能)[：:]/.test(l));
    const newHeaderText = fileHeader + '\n\n';
    const newHeaderLines = newHeaderText.split('\n').length - 1; // 新头占行数
    await editor.edit(editBuilder => {
      if (hasHeader) {
        const oldHeaderLines = headerEnd + 1;
        editBuilder.replace(new vscode.Range(0, 0, oldHeaderLines, 0), newHeaderText);
        headerLineOffset = newHeaderLines - oldHeaderLines;
      } else {
        editBuilder.insert(new vscode.Position(0, 0), newHeaderText);
        headerLineOffset = newHeaderLines;
      }
    });
  }

  await editor.edit(editBuilder => {
    for (const ins of insertions) {
      const pos = new vscode.Position(ins.line + headerLineOffset, 0);
      editBuilder.insert(pos, ins.text);
    }
  });
}

// ─── 主命令入口 ──────────────────────────────────────────────────────────────

async function runFullAnnotate() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('请先打开一个 Lua 文件');
    return;
  }
  if (editor.document.languageId !== 'lua') {
    vscode.window.showWarningMessage('当前文件不是 Lua 文件');
    return;
  }

  const document = editor.document;
  const fileName = document.fileName.split(/[\\/]/).pop();
  // 从文件名推断任务名（去掉 .lua 后缀）
  const missionName = fileName.replace(/\.lua$/i, '');
  const titleMap = getTaskTitleMap(missionName);
  getOutput().show(true); // 自动切到输出面板
  log(`▶ 开始处理：${fileName}（${document.lineCount} 行，Config title: ${titleMap.size} 条）`);

  const t0 = Date.now();
  const { regions, hasExisting } = parseRegionBounds(document);
  log(`  解析完成：找到 ${regions.length} 个节点（${Date.now() - t0}ms）`);

  if (hasExisting) {
    const action = await vscode.window.showWarningMessage(
      '文件已包含 region 标记，请选择重写方式：',
      { modal: true },
      '覆盖重写', '全量清除重写'
    );
    if (!action) { log('  用户取消（跳过覆盖）'); return; }

    const fullClear = action === '全量清除重写';
    log(`  清理旧注释（${fullClear ? '全量清除所有注释' : '仅删扩展生成行'}）…`);
    const rawLines = [];
    for (let i = 0; i < document.lineCount; i++) rawLines.push(document.lineAt(i).text);

    let cleaned;
    if (fullClear) {
      // 全量清除：删除纯注释行，但保留文件头作者/功能行，以及多行注释块（--[[ ... ]]）整体保留
      const headerLines = new Set();
      for (let i = 0; i < rawLines.length; i++) {
        const t = rawLines[i].trim();
        if (t === '' || /^--\s*(作者|功能)[：:]/.test(t)) { headerLines.add(i); continue; }
        if (/^--/.test(t)) continue;
        break;
      }
      // 追踪多行注释块，块内行全部保留
      const blockLines = new Set();
      let inBlock = false;
      for (let i = 0; i < rawLines.length; i++) {
        const t = rawLines[i].trim();
        if (!inBlock && /^--\[\[/.test(t)) { inBlock = true; blockLines.add(i); }
        else if (inBlock) { blockLines.add(i); if (/\]\]/.test(rawLines[i])) inBlock = false; }
      }
      cleaned = rawLines.filter((l, i) => {
        if (headerLines.has(i)) return true;   // 文件头保留
        if (blockLines.has(i))  return true;   // 多行注释块保留
        if (/^\s*--/.test(l))   return false;  // 其余纯注释行删除
        return true;
      }).join('\n');
    } else {
      // 增量重建：只删扩展生成的行（-- region/endregion 和带 --! 的行）
      cleaned = rawLines
        .filter(l => !/^\s*--\s*(region\b|endregion\b)/.test(l) && !l.includes('--!'))
        .join('\n');
    }
    const fullRange = new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
    await editor.edit(editBuilder => editBuilder.replace(fullRange, cleaned));

    // 等待 VSCode document 内容刷新后再重新解析
    await new Promise(resolve => setTimeout(resolve, 50));

    log('  重新解析（行号已变化）…');
    const reparsed = parseRegionBounds(document);
    log(`  重新解析完成：${reparsed.regions.length} 个节点`);
    if (reparsed.regions.length === 0) {
      vscode.window.showWarningMessage('未检测到可注释的结构（initPromote / initTask）');
      return;
    }
    return runAnnotateWithRegions(editor, document, reparsed.regions, titleMap);
  }

  if (regions.length === 0) {
    vscode.window.showWarningMessage('未检测到可注释的结构（initPromote / initTask）');
    return;
  }

  return runAnnotateWithRegions(editor, document, regions, titleMap);
}

/** 本地模式注释 → 预览 → 写入，供普通路径和覆盖路径共用 */
async function runAnnotateWithRegions(editor, document, regions, titleMap) {
  const lmAvailable = typeof vscode.lm !== 'undefined' && typeof vscode.lm.selectChatModels === 'function';

  const modeOptions = lmAvailable
    ? ['本地模式（快速，离线可用）', 'Claude 模式（深度注释，含节点内嵌注释，消耗更多 token）']
    : ['本地模式（快速，离线可用）'];

  const choice = await vscode.window.showQuickPick(modeOptions, {
    placeHolder: '选择 Region 注释模式',
  });
  if (!choice) { log('  用户取消（未选择模式）'); return; }
  log(`  模式：${choice}`);

  const useDeep  = choice.includes('深度注释');
  const labelMap   = new Map();
  const commentMap = new Map();

  const lines = [];
  for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);

  const fileHeader = await buildLocalFileHeader(lines, document.fileName.split(/[\\/]/).pop());

  if (useDeep) {
    const llmRegions = regions.filter(r =>
      r.type === 'node' || r.type === 'group' || r.type === 'batch' || r.type === 'vars'
    );
    const worthy = llmRegions.filter(r =>
      (r.type === 'node' || r.type === 'group') && isDeepWorthy(lines, r)
    );
    const batchCount = Math.ceil(worthy.length / 5);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Claude 深度注释', cancellable: true },
      async (progress, token) => {
        progress.report({ message: `深度注释（${worthy.length} 节点，${batchCount} 批）…` });
        log(`  深度注释：${worthy.length} 个节点，分 ${batchCount} 批并行调用…`);
        const t3 = Date.now();
        try {
          const deepMap = await callVscodeLmDeep(lines, llmRegions, (done, total) => {
            progress.report({ message: `深度注释 ${done}/${total} 批…` });
            log(`    批次进度：${done}/${total}`);
          }, token);
          for (const [id, val] of deepMap) commentMap.set(id, val);
          log(`  完成：${commentMap.size} 个节点有深度注释（${Date.now() - t3}ms）`);
        } catch (e) {
          log(`  失败（跳过）：${e.message}`);
          vscode.window.showWarningMessage(`深度注释生成失败（跳过）：${e.message}`);
        }
      }
    );
  } else {
    log('  本地模式');
  }

  // 预览
  const targetRegions = regions.filter(r =>
    r.type === 'vars' || r.type === 'node' || r.type === 'group' || r.type === 'batch'
  );
  const previewLines = targetRegions.map(r => {
    const label = localDescription(r, lines);
    log(`  [preview] ${r.type.padEnd(6)} depth=${r.depth||0} ${r.id} → ${label}`);
    return `· ${label}`;
  }).join('\n');

  const confirm = await vscode.window.showInformationMessage(
    `将插入 ${targetRegions.length} 个 Region：\n${previewLines}`,
    { modal: true },
    '写入文件'
  );
  if (confirm !== '写入文件') { log('  用户取消（未确认写入）'); return; }

  log(`  写入文件…`);
  const tWrite = Date.now();
  await applyRegions(document, editor, regions, labelMap, commentMap, fileHeader, lines, titleMap);
  log(`  ✓ 写入完成（${Date.now() - tWrite}ms），共 ${targetRegions.length} 个 region`);
  vscode.window.showInformationMessage('Region 注释已写入');
}

// ─── 任务拓扑图 ───────────────────────────────────────────────────────────────

async function showTaskGraph() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'lua') {
    vscode.window.showWarningMessage('请先打开一个 Lua 任务文件'); return;
  }
  const document = editor.document;
  const fileName = document.fileName.split(/[\\/]/).pop();
  const missionName = fileName.replace(/\.lua$/i, '');
  const lines = [];
  for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);

  // ── 1. 从 Config.yaml 获取有 title 的节点集合 ──
  const titleMap = getTaskTitleMap(missionName); // Map<id, title>
  if (!titleMap.size) {
    vscode.window.showWarningMessage(`Config.yaml 中未找到 parent='${missionName}' 的子任务配置`);
    return;
  }
  const titledIds = new Set(titleMap.keys());

  // ── 2. 全量扫描 Lua：id → prev[]，id → parentId，同时记录行号 ──
  const luaPrevMap   = new Map(); // id → string[]
  const idParentMap  = new Map(); // id → 直接父 group id（通过 subTasks 嵌套推断）
  const idLineObj    = {};
  // 用栈跟踪 subTasks 嵌套层次：每项 = { groupId, closeDepth }
  // closeDepth = 进入 subTasks 的 { 之前的 braceDepth（即该 { 对应的关闭深度）
  const groupStack   = []; // { groupId, closeDepth }[]
  let   scanId       = null;
  let   braceDepth   = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 先弹栈：处理本行之前，检查深度是否已回退到某 subTasks 块的关闭深度
    while (groupStack.length && braceDepth <= groupStack[groupStack.length - 1].closeDepth) {
      groupStack.pop();
    }
    // 检测 subTasks = { 行：压栈（用当前 scanId 作为父 group）
    if (/subTasks\s*=\s*\{/.test(line) && scanId) {
      // closeDepth = 当前 braceDepth（subTasks { 打开前的深度）
      groupStack.push({ groupId: scanId, closeDepth: braceDepth });
    }
    // 更新 braceDepth（处理本行的 { }）
    const opens  = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    braceDepth += opens - closes;
    // 识别 id = 'xxx'
    const idM = line.match(/^\s*id\s*=\s*['"](\w+)['"]/);
    if (idM) {
      scanId = idM[1];
      if (!luaPrevMap.has(scanId)) luaPrevMap.set(scanId, []);
      if (idLineObj[scanId] === undefined) idLineObj[scanId] = i;
      // 记录父 group（栈顶）
      if (groupStack.length) idParentMap.set(scanId, groupStack[groupStack.length - 1].groupId);
    }
    if (scanId) {
      const prevM = line.match(/prev\s*=\s*\{([^}]*)\}/);
      if (prevM) {
        const refs = [...prevM[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
        luaPrevMap.set(scanId, refs);
      }
    }
  }

  // Config 里有 title 但 Lua 里不存在的 id，排除掉（以 Lua 实际内容为准）
  // 注意：只过滤本地 titledIds，不修改缓存里的 titleMap
  for (const id of Array.from(titledIds)) {
    if (!luaPrevMap.has(id)) titledIds.delete(id);
  }

  // ── 3. 全量拓扑排序（Kahn），得到每个 id 的 rank ──
  const allLuaIds = Array.from(luaPrevMap.keys());
  // 建正向图（children）和入度
  const luaChildren = new Map(allLuaIds.map(id => [id, []]));
  const luaInDeg    = new Map(allLuaIds.map(id => [id, 0]));
  for (const [id, prevs] of luaPrevMap) {
    for (const p of prevs) {
      if (!luaChildren.has(p)) { luaChildren.set(p, []); luaInDeg.set(p, 0); }
      luaChildren.get(p).push(id);
      luaInDeg.set(id, (luaInDeg.get(id) || 0) + 1);
    }
  }
  const luaRank = new Map();
  const topoQ   = allLuaIds.filter(id => (luaInDeg.get(id) || 0) === 0);
  topoQ.forEach(id => luaRank.set(id, 0));
  let qi = 0;
  while (qi < topoQ.length) {
    const cur = topoQ[qi++];
    for (const child of (luaChildren.get(cur) || [])) {
      luaRank.set(child, Math.max(luaRank.get(child) || 0, (luaRank.get(cur) || 0) + 1));
      luaInDeg.set(child, (luaInDeg.get(child) || 1) - 1);
      if (luaInDeg.get(child) === 0) topoQ.push(child);
    }
  }
  // 未排到的（环）给 max+1
  const luaMaxRank = Math.max(0, ...Array.from(luaRank.values()));
  allLuaIds.forEach(id => { if (!luaRank.has(id)) luaRank.set(id, luaMaxRank + 1); });

  // 反转 idParentMap：groupId → [直接子 id]（用于向下查找 titled 子任务）
  const idGroupChildrenMap = new Map();
  for (const [childId, parentId] of idParentMap) {
    if (!idGroupChildrenMap.has(parentId)) idGroupChildrenMap.set(parentId, []);
    idGroupChildrenMap.get(parentId).push(childId);
  }

  // ── 4. 构建 titled 节点间的边（穿透非 titled 节点）──
  // 对每个 titled 节点，沿 prev 方向找最近的 titled 祖先
  // 使用缓存避免重复搜索
  const resolveCache = new Map(); // id → titled ancestor id | null
  function resolveToTitled(startId, visited) {
    if (resolveCache.has(startId)) return resolveCache.get(startId);
    if (!visited) visited = new Set();
    if (titledIds.has(startId)) { resolveCache.set(startId, startId); return startId; }
    if (visited.has(startId)) return null;
    visited.add(startId);
    // 先沿 prev 反向查找 titled 祖先
    const prevs = luaPrevMap.get(startId) || [];
    let best = null, bestRank = -1;
    for (const p of prevs) {
      const found = resolveToTitled(p, visited);
      if (found && (luaRank.get(found) || 0) > bestRank) {
        best = found; bestRank = luaRank.get(found) || 0;
      }
    }
    if (best) { resolveCache.set(startId, best); return best; }
    // prev 找不到：向下找该 group 内的 titled 直接子任务（取 rank 最高的）
    const groupChildren = idGroupChildrenMap.get(startId) || [];
    for (const child of groupChildren) {
      if (titledIds.has(child) && (luaRank.get(child) || 0) > bestRank) {
        best = child; bestRank = luaRank.get(child) || 0;
      }
    }
    resolveCache.set(startId, best);
    return best;
  }

  // 沿父链向上找到最近的有效 rank 来源（用于孤立节点继承父 group 位置）
  function resolveParentRank(id, visited) {
    if (!visited) visited = new Set();
    if (visited.has(id)) return null;
    visited.add(id);
    const parent = idParentMap.get(id);
    if (!parent) return null;
    // 直接返回父 group 的 rank（父若也是孤立起点，rank=0，子任务与父同层）
    if (luaRank.has(parent)) return luaRank.get(parent);
    // 父还没有 rank（理论上不会，Kahn 已处理全量），继续向上
    return resolveParentRank(parent, visited);
  }

  const nodeMap  = new Map();
  const edgeList = [];
  const seenEdge = new Set();

  for (const id of titledIds) {
    let rank = luaRank.get(id) || 0;
    // 孤立节点（无 prev）：尝试继承父 group 的拓扑位置
    const prevRefs0 = luaPrevMap.get(id) || [];
    if (prevRefs0.length === 0) {
      const inherited = resolveParentRank(id);
      if (inherited !== null) rank = inherited;
    }
    nodeMap.set(id, { id, title: titleMap.get(id), rank });
  }

  // 沿父链收集父 group 的 titled 前驱（用于孤立节点继承连线）
  function collectParentTitledPrevs(id, visited) {
    if (!visited) visited = new Set();
    if (visited.has(id)) return new Set();
    visited.add(id);
    const parent = idParentMap.get(id);
    if (!parent) return new Set();
    const parentPrevs = luaPrevMap.get(parent) || [];
    const result = new Set();
    for (const p of parentPrevs) {
      const r = resolveToTitled(p);
      if (r && r !== id) result.add(r);
    }
    // 父 group 也无 prev，继续向上
    if (result.size === 0) {
      for (const r of collectParentTitledPrevs(parent, visited)) result.add(r);
    }
    return result;
  }

  for (const id of titledIds) {
    const prevRefs = luaPrevMap.get(id) || [];
    const resolvedPrevs = new Set();
    if (prevRefs.length > 0) {
      for (const p of prevRefs) {
        const r = resolveToTitled(p);
        if (r && r !== id) resolvedPrevs.add(r);
      }
    } else {
      // 孤立节点：继承父 group 的 titled 前驱连线
      for (const r of collectParentTitledPrevs(id)) resolvedPrevs.add(r);
    }
    for (const p of resolvedPrevs) {
      const key = p + '→' + id;
      if (!seenEdge.has(key)) { edgeList.push({ from: p, to: id }); seenEdge.add(key); }
    }
  }

  // ── 5. 用全量 rank 对 titled 节点分层（保留真实拓扑顺序）──
  const allIds = Array.from(nodeMap.keys());
  // 用全量 rank 直接分层
  const rankToLayer = new Map();
  for (const id of allIds) {
    const r = nodeMap.get(id).rank;
    if (!rankToLayer.has(r)) rankToLayer.set(r, []);
    rankToLayer.get(r).push(id);
  }
  // 压缩空层：重新按层序编号
  const sortedRanks = Array.from(rankToLayer.keys()).sort((a, b) => a - b);
  const layers = new Map();
  sortedRanks.forEach((r, i) => layers.set(i, rankToLayer.get(r)));

  // 布局常量：节点两行显示（title + id），高度增加
  const CHAR_W = 7, NODE_H = 64, H_GAP = 28, V_GAP = 56, PAD = 40, MIN_W = 140;
  function nodeWidth(id) {
    const n = nodeMap.get(id);
    // 取 title 和 id 中较长的那个决定宽度
    const titleLen = n ? n.title.length * 9 : 0;  // 中文字符约9px
    const idLen    = id.length * CHAR_W;
    return Math.max(MIN_W, Math.max(titleLen, idLen) + 28);
  }

  // 计算每个节点的 x/y 中心坐标（层内居中对齐）
  const pos = new Map();
  const layerKeys = Array.from(layers.keys()).sort((a, b) => a - b);
  let totalH = PAD;
  for (const r of layerKeys) {
    const layer  = layers.get(r);
    const rowW   = layer.reduce((s, id) => s + nodeWidth(id), 0) + (layer.length - 1) * H_GAP;
    let curX = PAD;
    layer.forEach(id => {
      const w = nodeWidth(id);
      pos.set(id, { x: curX + w / 2, y: totalH + NODE_H / 2, w });
      curX += w + H_GAP;
    });
    totalH += NODE_H + V_GAP;
  }

  // 计算 SVG 画布尺寸
  const maxLayerW = sortedRanks.reduce((max, r) => {
    const layer = layers.get(r);
    const w = layer.reduce((s, id) => s + nodeWidth(id), 0) + (layer.length - 1) * H_GAP;
    return w > max ? w : max;
  }, 0);
  const svgW = maxLayerW + PAD * 2;
  const svgH = totalH + PAD;

  // 序列化传给 Webview
  const graphData = {
    nodes: allIds.map(id => ({
      id,
      title: nodeMap.get(id).title,
      x:     pos.get(id).x,
      y:     pos.get(id).y,
      w:     pos.get(id).w,
      h:     NODE_H,
    })),
    edges: edgeList.map(e => ({
      from: e.from,
      to:   e.to,
      x1:   pos.get(e.from) ? pos.get(e.from).x : 0,
      y1:   pos.get(e.from) ? pos.get(e.from).y + NODE_H / 2 : 0,
      x2:   pos.get(e.to)   ? pos.get(e.to).x   : 0,
      y2:   pos.get(e.to)   ? pos.get(e.to).y   - NODE_H / 2 : 0,
    })),
    svgW,
    svgH,
  };

  const panel = vscode.window.createWebviewPanel(
    'luaTaskGraph', `任务拓扑图 — ${fileName}`,
    vscode.ViewColumn.Beside, { enableScripts: true }
  );
  panel.webview.html = buildGraphHtml(graphData, idLineObj, fileName);

  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type !== 'gotoId') return;
    const line = idLineObj[msg.id];
    if (line === undefined) return;
    vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false })
      .then(ed => {
        const pos   = new vscode.Position(line, 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      });
  });
}

function buildGraphHtml(graphData, idLineObj, fileName) {
  const dataJson   = JSON.stringify(graphData);
  const idLineJson = JSON.stringify(idLineObj);
  const S = 'script';
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-editor-foreground, #ccc);
  font-family: var(--vscode-font-family, monospace);
  overflow: hidden; height: 100vh;
  display: flex; flex-direction: column;
}
#toolbar {
  flex-shrink: 0; padding: 5px 12px; font-size: 11px; opacity: .55;
  border-bottom: 1px solid #333;
}
#viewport { flex: 1; overflow: hidden; position: relative; cursor: grab; }
#viewport.drag { cursor: grabbing; }
#canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
</style>
</head>
<body>
<div id="toolbar">任务拓扑图 — ${fileName} &nbsp;｜&nbsp; 滚轮缩放 · 拖拽平移 · 点击节点跳转</div>
<div id="viewport"><div id="canvas"></div></div>
<${S}>
(function(){
  var data    = ${dataJson};
  var idLines = ${idLineJson};
  var vscode  = acquireVsCodeApi();

  // 颜色方案：统一单色，hover 高亮
  var NODE_FILL   = '#1a2535';
  var NODE_STROKE = '#5b9bd5';

  // 构建 SVG
  var ns  = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width',  data.svgW);
  svg.setAttribute('height', data.svgH);
  svg.setAttribute('xmlns',  ns);

  // 箭头 marker
  var defs   = document.createElementNS(ns, 'defs');
  var marker = document.createElementNS(ns, 'marker');
  marker.setAttribute('id',           'arr');
  marker.setAttribute('markerWidth',  '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('refX',         '6');
  marker.setAttribute('refY',         '3');
  marker.setAttribute('orient',       'auto');
  var arrowPath = document.createElementNS(ns, 'path');
  arrowPath.setAttribute('d',    'M0,0 L0,6 L8,3 z');
  arrowPath.setAttribute('fill', '#666');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // 边
  data.edges.forEach(function(e) {
    var line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', e.x1); line.setAttribute('y1', e.y1);
    line.setAttribute('x2', e.x2); line.setAttribute('y2', e.y2);
    line.setAttribute('stroke',           '#555');
    line.setAttribute('stroke-width',     '1.5');
    line.setAttribute('marker-end',       'url(#arr)');
    svg.appendChild(line);
  });

  // 节点
  data.nodes.forEach(function(n) {
    var x   = n.x - n.w / 2;
    var y   = n.y - n.h / 2;
    var g   = document.createElementNS(ns, 'g');
    g.setAttribute('cursor', 'pointer');
    g.setAttribute('data-id', n.id);

    var rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x',      x);
    rect.setAttribute('y',      y);
    rect.setAttribute('width',  n.w);
    rect.setAttribute('height', n.h);
    rect.setAttribute('rx',     '5');
    rect.setAttribute('fill',   NODE_FILL);
    rect.setAttribute('stroke', NODE_STROKE);
    rect.setAttribute('stroke-width', '1.5');
    g.appendChild(rect);

    // title（上行，主字）
    var t1 = document.createElementNS(ns, 'text');
    t1.setAttribute('x',           n.x);
    t1.setAttribute('y',           n.y - 10);
    t1.setAttribute('text-anchor', 'middle');
    t1.setAttribute('dominant-baseline', 'middle');
    t1.setAttribute('font-size',   '13');
    t1.setAttribute('fill',        '#ddd');
    t1.textContent = n.title;
    var titleEl = document.createElementNS(ns, 'title');
    titleEl.textContent = n.id;
    g.appendChild(titleEl);
    g.appendChild(t1);

    // id（下行，小字，灰色）
    var t2 = document.createElementNS(ns, 'text');
    t2.setAttribute('x',           n.x);
    t2.setAttribute('y',           n.y + 14);
    t2.setAttribute('text-anchor', 'middle');
    t2.setAttribute('dominant-baseline', 'middle');
    t2.setAttribute('font-size',   '10');
    t2.setAttribute('fill',        '#888');
    t2.textContent = n.id;
    g.appendChild(t2);

    g.addEventListener('click', function() {
      vscode.postMessage({ type: 'gotoId', id: n.id });
    });
    svg.appendChild(g);
  });

  document.getElementById('canvas').appendChild(svg);

  // 初始缩放：适配视口
  var viewport = document.getElementById('viewport');
  var vpW = viewport.clientWidth, vpH = viewport.clientHeight;
  var scale = Math.min(vpW / data.svgW, vpH / data.svgH, 1) * 0.95;
  var tx = (vpW - data.svgW * scale) / 2, ty = 20;
  var canvas = document.getElementById('canvas');

  function applyT() {
    canvas.style.transform = 'translate('+tx+'px,'+ty+'px) scale('+scale+')';
  }
  applyT();

  // 滚轮缩放
  viewport.addEventListener('wheel', function(e) {
    e.preventDefault();
    var r = viewport.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    var d  = e.deltaY < 0 ? 1.12 : 0.9;
    tx = mx - (mx - tx) * d;
    ty = my - (my - ty) * d;
    scale *= d;
    applyT();
  }, { passive: false });

  // 拖拽
  var drag = false, sx = 0, sy = 0, stx = 0, sty = 0;
  viewport.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    drag = true; sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
    viewport.classList.add('drag');
  });
  window.addEventListener('mousemove', function(e) {
    if (!drag) return;
    tx = stx + (e.clientX - sx); ty = sty + (e.clientY - sy); applyT();
  });
  window.addEventListener('mouseup', function() { drag = false; viewport.classList.remove('drag'); });
})();
</${S}>
</body>
</html>`;
}

module.exports = { runFullAnnotate, showTaskGraph };
