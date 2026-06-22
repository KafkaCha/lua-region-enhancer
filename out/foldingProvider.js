'use strict';
const vscode = require('vscode');
const { DEFAULT_MARKERS } = require('./defaults');

function getMarkers() {
  const cfg = vscode.workspace.getConfiguration('luaRegion');
  const v = cfg.get('regionMarkers');
  if (!Array.isArray(v) || v.length === 0) return DEFAULT_MARKERS;
  const valid = v.filter(m => m && typeof m.start === 'string' && m.start.length > 0
                               && typeof m.end === 'string' && m.end.length > 0);
  return valid.length > 0 ? valid : DEFAULT_MARKERS;
}

class LuaFoldingProvider {
  provideFoldingRanges(document, _context, _token) {
    const markers = getMarkers();

    const patterns = markers.map(m => ({
      startRe: new RegExp(`^\\s*${escapeRe(m.start)}`, 'i'),
      endRe:   new RegExp(`^\\s*${escapeRe(m.end)}`, 'i'),
    }));

    const ranges = [];
    const stacks = patterns.map(() => []);

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;

      for (let p = 0; p < patterns.length; p++) {
        const { startRe, endRe } = patterns[p];
        if (startRe.test(line)) {
          stacks[p].push(i);
          break;
        }
        if (endRe.test(line) && stacks[p].length > 0) {
          const start = stacks[p].pop();
          ranges.push(new vscode.FoldingRange(start, i, vscode.FoldingRangeKind.Region));
          break;
        }
      }
    }

    // 未闭合的 region 延伸到文件末尾
    for (let p = 0; p < stacks.length; p++) {
      while (stacks[p].length > 0) {
        const start = stacks[p].pop();
        ranges.push(new vscode.FoldingRange(start, document.lineCount - 1, vscode.FoldingRangeKind.Region));
      }
    }

    return ranges;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { LuaFoldingProvider };
