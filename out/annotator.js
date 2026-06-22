'use strict';
const vscode = require('vscode');
const https   = require('https');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');

// ─── 正则：从 Lua 文件提取任务骨架 ───────────────────────────────────────────

// 作者行：-- 作者：XXX
const AUTHOR_RE     = /^--\s*作者[：:]\s*(.+)/;
// 功能行：-- 功能：XXX
const FUNC_RE       = /^--\s*功能[：:]\s*(.+)/;
// 描述行：-- 描述：XXX
const DESC_RE       = /^--\s*描述[：:]\s*(.+)/;
// initPromote / initTask 块开始
const PROMOTE_RE    = /^\s*Mission\.\w+:initPromote/;
const TASK_RE       = /^\s*Mission\.\w+:initTask/;
// 节点 id
const ID_RE         = /^\s*id\s*=\s*['"](\w+)['"]/;
// prev 单行
const PREV_INLINE_RE = /prev\s*=\s*\{([^}]*)\}/;
const QUOTED_RE      = /['"]([\w]+)['"]/g;
// TA_* 动作类型
const TA_RE          = /TA_(\w+)\s*\(/g;
// MissionMgr:Accept 调用
const ACCEPT_RE      = /MissionMgr\s*:\s*Accept\s*\(\s*['"](\w+)['"]\s*\)/g;
// 计数器 / 标志变量
const COUNTER_RE     = /^local\s+(\w+)\s*=\s*(\d+)\s*--\s*(.+)/;

// ─── API Key 解析（优先级：环境变量 > ~/.claude/settings.json > VSCode 设置）──

function resolveApiKey() {
  // 1. Claude Code 主要方式：ANTHROPIC_API_KEY 环境变量
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  // 2. Claude Code 配置文件：~/.claude/settings.json
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw);
    if (settings.apiKey) return settings.apiKey;
  } catch (_) {}
  // 3. 降级：VSCode 扩展设置 luaRegion.annotate.apiKey
  return vscode.workspace.getConfiguration('luaRegion').get('annotate.apiKey') || '';
}

// ─── 提取器 ──────────────────────────────────────────────────────────────────

/**
 * 从文档文本中提取结构化摘要，供 LLM 生成注释头使用。
 * 返回格式：{ fileName, author, func, desc, counters, nodes, existingHeader }
 */
function extractSummary(document) {
  const lines        = [];
  for (let i = 0; i < document.lineCount; i++) {
    lines.push(document.lineAt(i).text);
  }

  let author   = '';
  let func     = '';
  let desc     = '';
  const counters = [];

  // 扫描文件头注释（前 30 行）
  for (let i = 0; i < Math.min(30, lines.length); i++) {
    const l = lines[i];
    let m;
    if (!author && (m = AUTHOR_RE.exec(l)))  author = m[1].trim();
    if (!func   && (m = FUNC_RE.exec(l)))    func   = m[1].trim();
    if (!desc   && (m = DESC_RE.exec(l)))    desc   = m[1].trim();
  }

  // 扫描计数器变量（全文前 60 行）
  for (let i = 0; i < Math.min(60, lines.length); i++) {
    const m = COUNTER_RE.exec(lines[i]);
    if (m) counters.push({ name: m[1], init: m[2], comment: m[3].trim() });
  }

  // 是否已有 dep 图注释头
  const existingHeader = lines.slice(0, 5).some(l => /Task 依赖图/.test(l));

  // 收集节点信息
  const nodes = [];
  let section  = 'promote'; // promote | task
  let currentNode = null;

  const flushNode = () => {
    if (currentNode) nodes.push(currentNode);
    currentNode = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    if (PROMOTE_RE.test(l)) { flushNode(); section = 'promote'; continue; }
    if (TASK_RE.test(l))    { flushNode(); section = 'task';    continue; }

    // 节点 id
    const idM = ID_RE.exec(l);
    if (idM) {
      flushNode();
      currentNode = {
        id:      idM[1],
        section,
        prev:    [],
        actions: [],
        accepts: [],
      };
      continue;
    }

    if (!currentNode) continue;

    // prev 单行
    const prevM = PREV_INLINE_RE.exec(l);
    if (prevM) {
      QUOTED_RE.lastIndex = 0;
      let qm;
      while ((qm = QUOTED_RE.exec(prevM[1])) !== null) {
        currentNode.prev.push(qm[1]);
      }
    }

    // TA_* 动作
    TA_RE.lastIndex = 0;
    let taM;
    while ((taM = TA_RE.exec(l)) !== null) {
      const name = taM[1];
      if (!currentNode.actions.includes(name)) {
        currentNode.actions.push(name);
      }
    }

    // MissionMgr:Accept
    ACCEPT_RE.lastIndex = 0;
    let accM;
    while ((accM = ACCEPT_RE.exec(l)) !== null) {
      if (!currentNode.accepts.includes(accM[1])) {
        currentNode.accepts.push(accM[1]);
      }
    }
  }
  flushNode();

  return {
    fileName:       document.fileName.split(/[\\/]/).pop(),
    author,
    func,
    desc,
    counters,
    nodes,
    existingHeader,
  };
}

/**
 * 将摘要序列化为紧凑的文本，发给 LLM。
 * 节省 token：不发原始代码，只发结构。
 */
function serializeSummary(s) {
  const lines = [];
  lines.push(`文件：${s.fileName}`);
  if (s.author) lines.push(`作者：${s.author}`);
  if (s.func)   lines.push(`功能：${s.func}`);
  if (s.desc)   lines.push(`描述：${s.desc}`);

  if (s.counters.length > 0) {
    lines.push('计数器变量：');
    for (const c of s.counters) {
      lines.push(`  ${c.name} = ${c.init}  -- ${c.comment}`);
    }
  }

  const promoteNodes = s.nodes.filter(n => n.section === 'promote');
  const taskNodes    = s.nodes.filter(n => n.section === 'task');

  const fmtNode = n => {
    let str = `  ${n.id}`;
    if (n.prev.length)    str += `  prev:[${n.prev.join(', ')}]`;
    if (n.actions.length) str += `  action:${n.actions.join('+')}`;
    if (n.accepts.length) str += `  accepts:${n.accepts.join(', ')}`;
    return str;
  };

  if (promoteNodes.length > 0) {
    lines.push('--- initPromote 节点（接取阶段）---');
    promoteNodes.forEach(n => lines.push(fmtNode(n)));
  }
  if (taskNodes.length > 0) {
    lines.push('--- initTask 节点（任务主体）---');
    taskNodes.forEach(n => lines.push(fmtNode(n)));
  }

  return lines.join('\n');
}

// ─── LLM 调用 ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是 Lua 任务注释头生成器。根据提供的任务节点结构，生成符合规范的文件头注释。

输出规范：
1. 作者行：在原作者后追加 ", Claude@KAFKA"（若已包含则不重复）
2. 整体用 "-- ============================================================" 边框包裹
3. 节点之间用 "──►" 表示依赖（A ──► B 表示 B 依赖 A 完成后触发）
4. 并行节点用 "├─" / "└─" 分支
5. 门节点（无 action、只用于 prev 控制流程）标注为"门节点"
6. 按逻辑阶段用 region / endregion 分组：
   格式：-- region 阶段名 | prev: ID或无 | 简短说明
         ...节点 dep 图...
         -- endregion
7. 只输出注释文本本身，不要输出代码块或任何额外解释
8. 注释行全部以 "-- " 开头
9. 不要超过 40 行`;

/**
 * 调用 Claude API，返回生成的注释文本 Promise<string>
 */
function callClaudeAPI(apiKey, model, summaryText) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: summaryText }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            return;
          }
          const text = parsed?.content?.[0]?.text ?? '';
          resolve(text.trim());
        } catch (e) {
          reject(new Error('API 响应解析失败：' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── 注释头写入 ───────────────────────────────────────────────────────────────

/**
 * 将生成的注释头写入文档。
 * 如果文件已有注释头（前 N 行均为 -- 开头或空行），则替换；否则插入到第 1 行。
 */
async function applyHeader(document, editor, newHeader) {
  // 找到现有注释头的结束行（连续 -- 行 + 空行块）
  let headerEndLine = 0;
  for (let i = 0; i < Math.min(50, document.lineCount); i++) {
    const t = document.lineAt(i).text.trim();
    if (t === '' || t.startsWith('--')) {
      headerEndLine = i;
    } else {
      break;
    }
  }

  // 新注释头末尾加一个空行，与代码分隔
  const insertText = newHeader + '\n\n';

  await editor.edit(editBuilder => {
    const replaceRange = new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(headerEndLine, document.lineAt(headerEndLine).text.length)
    );
    editBuilder.replace(replaceRange, insertText.trimEnd());
  });
}

// ─── 主命令入口 ──────────────────────────────────────────────────────────────

async function runAutoAnnotate() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('请先打开一个 Lua 文件');
    return;
  }
  if (editor.document.languageId !== 'lua') {
    vscode.window.showWarningMessage('当前文件不是 Lua 文件');
    return;
  }

  // 读取配置
  const cfg    = vscode.workspace.getConfiguration('luaRegion');
  const apiKey = resolveApiKey();
  const model  = cfg.get('annotate.model') || 'claude-haiku-4-5-20251001';

  if (!apiKey) {
    const action = await vscode.window.showErrorMessage(
      'Lua Region Enhancer: 未找到 Claude API Key。\n' +
      '可通过以下任一方式配置：\n' +
      '① 环境变量 ANTHROPIC_API_KEY\n' +
      '② Claude Code（~/.claude/settings.json）\n' +
      '③ VSCode 设置 luaRegion.annotate.apiKey',
      '打开设置'
    );
    if (action === '打开设置') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'luaRegion.annotate.apiKey');
    }
    return;
  }

  const document = editor.document;
  const summary  = extractSummary(document);

  // 如果节点数为 0，文件可能不是 Mission 脚本
  if (summary.nodes.length === 0) {
    const go = await vscode.window.showWarningMessage(
      '未检测到 Mission initPromote/initTask 节点，仍要继续生成？',
      '继续', '取消'
    );
    if (go !== '继续') return;
  }

  const summaryText = serializeSummary(summary);

  // 进度提示
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '生成注释头中…', cancellable: false },
    async () => {
      let generated;
      try {
        generated = await callClaudeAPI(apiKey, model, summaryText);
      } catch (e) {
        vscode.window.showErrorMessage('API 调用失败：' + e.message);
        return;
      }

      if (!generated) {
        vscode.window.showErrorMessage('API 返回内容为空，请重试');
        return;
      }

      // diff 预览：把生成内容显示给用户确认
      const preview = generated.split('\n').slice(0, 15).join('\n')
        + (generated.split('\n').length > 15 ? '\n-- ...' : '');

      const action = await vscode.window.showInformationMessage(
        `预览（前15行）：\n${preview}`,
        { modal: true },
        '写入文件', '取消'
      );

      if (action !== '写入文件') return;

      await applyHeader(document, editor, generated);
      vscode.window.showInformationMessage('注释头已写入');
    }
  );
}

module.exports = { runAutoAnnotate };
