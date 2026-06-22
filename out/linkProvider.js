'use strict';
const vscode = require('vscode');

// 匹配 id = 'XxxId' 或 id = "XxxId" 定义行
const ID_DEF_RE = /^\s*id\s*=\s*['"](\w+)['"]/;

// 匹配 prev = {'A', 'B', ...} 单行形式
const PREV_ENTRY_RE = /prev\s*=\s*\{([^}]*)\}/g;
const QUOTED_ID_RE  = /['"]([\w]+)['"]/g;

// 匹配 MissionMgr:Finish('XxxId') / MissionMgr:isfinished("XxxId") 等调用
const MGRCALL_RE = /MissionMgr\s*:\s*\w+\s*\(\s*['"](\w+)['"]\s*\)/g;

class LuaTaskLinkProvider {
  provideDocumentLinks(document, _token) {
    // 第一遍：收集所有 id 定义位置，建符号表 id -> line
    const idLines = new Map();
    for (let i = 0; i < document.lineCount; i++) {
      const lineText = document.lineAt(i).text;
      // 跳过注释行，避免注释中的 id = '...' 被误识别为定义
      if (/^\s*--/.test(lineText)) continue;
      const m = ID_DEF_RE.exec(lineText);
      if (m) idLines.set(m[1], i);
    }

    if (idLines.size === 0) return [];

    const links = [];

    // 第二遍：扫描引用，生成 DocumentLink
    for (let i = 0; i < document.lineCount; i++) {
      const lineText = document.lineAt(i).text;

      // 跳过注释行，避免为注释中的引用生成无效链接
      if (/^\s*--/.test(lineText)) continue;

      // prev = { 'A', 'B' } 引用
      PREV_ENTRY_RE.lastIndex = 0;
      let prevMatch;
      while ((prevMatch = PREV_ENTRY_RE.exec(lineText)) !== null) {
        const block = prevMatch[1];
        const blockOffset = prevMatch.index + prevMatch[0].indexOf(block);
        QUOTED_ID_RE.lastIndex = 0;
        let idMatch;
        while ((idMatch = QUOTED_ID_RE.exec(block)) !== null) {
          const id = idMatch[1];
          if (!idLines.has(id)) continue;
          const startChar = blockOffset + idMatch.index + 1; // +1 跳过开头引号
          const endChar   = startChar + id.length;
          links.push(makeLink(document, i, startChar, endChar, idLines.get(id)));
        }
      }

      // MissionMgr:Finish('XxxId') 等调用引用
      MGRCALL_RE.lastIndex = 0;
      let callMatch;
      while ((callMatch = MGRCALL_RE.exec(lineText)) !== null) {
        const id = callMatch[1];
        if (!idLines.has(id)) continue;
        // 从匹配串内部找引号偏移，比 indexOf 在整行中查找更可靠
        const fullMatch = callMatch[0];
        const quoteInFull = fullMatch.search(/['"]/);
        if (quoteInFull === -1) continue;
        const startChar = callMatch.index + quoteInFull + 1; // +1 跳过引号
        const endChar   = startChar + id.length;
        links.push(makeLink(document, i, startChar, endChar, idLines.get(id)));
      }
    }

    return links;
  }
}

function makeLink(document, line, startChar, endChar, targetLine) {
  const range = new vscode.Range(line, startChar, line, endChar);
  const uri   = document.uri.with({ fragment: `L${targetLine + 1}` });
  const link  = new vscode.DocumentLink(range, uri);
  // 悬停提示：显示目标行内容 + 行号，方便预览无需跳转
  const targetRaw = document.lineAt(targetLine).text;
  const inlineComment = targetRaw.match(/--\s*(.+)$/);
  link.tooltip = inlineComment ? inlineComment[1].trim() : targetRaw.trim();
  return link;
}

module.exports = { LuaTaskLinkProvider };
