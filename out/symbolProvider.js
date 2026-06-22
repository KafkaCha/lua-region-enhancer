'use strict';
const vscode = require('vscode');
const { DEFAULT_MARKERS, DEFAULT_RULES } = require('./defaults');

const KIND_MAP = {
  File:        vscode.SymbolKind.File,
  Module:      vscode.SymbolKind.Module,
  Namespace:   vscode.SymbolKind.Namespace,
  Class:       vscode.SymbolKind.Class,
  Method:      vscode.SymbolKind.Method,
  Function:    vscode.SymbolKind.Function,
  Variable:    vscode.SymbolKind.Variable,
  Constant:    vscode.SymbolKind.Constant,
  String:      vscode.SymbolKind.String,
  Key:         vscode.SymbolKind.Key,
  Object:      vscode.SymbolKind.Object,
  Field:       vscode.SymbolKind.Field,
  Interface:   vscode.SymbolKind.Interface,
  EnumMember:  vscode.SymbolKind.EnumMember,
};

function validMarkers(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const ok = v.filter(m => m && typeof m.start === 'string' && m.start.length > 0
                             && typeof m.end === 'string' && m.end.length > 0);
  return ok.length > 0 ? ok : null;
}

function validRules(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const ok = v.filter(r => r && typeof r.pattern === 'string' && r.pattern.length > 0
                             && typeof r.symbolKind === 'string');
  return ok.length > 0 ? ok : null;
}

function getCfg() {
  const cfg = vscode.workspace.getConfiguration('luaRegion');
  return {
    markers:  validMarkers(cfg.get('regionMarkers'))  ?? DEFAULT_MARKERS,
    rawRules: validRules(cfg.get('outlineRules'))     ?? DEFAULT_RULES,
  };
}

class LuaRegionSymbolProvider {
  provideDocumentSymbols(document, _token) {
    if (document.lineCount === 0) return [];

    const { markers, rawRules } = getCfg();

    const markerPatterns = markers.map(m => ({
      startRe: new RegExp(`^\\s*${escapeRe(m.start)}\\s*(.*)`, 'i'),
      endRe:   new RegExp(`^\\s*${escapeRe(m.end)}`, 'i'),
    }));

    const rules = rawRules.map(r => {
      try {
        return {
          re:          new RegExp(r.pattern),
          kind:        KIND_MAP[r.symbolKind] ?? vscode.SymbolKind.Variable,
          description: r.description ?? '',
          isContainer: r.symbolKind === 'Module',  // Module 规则作为容器收纳子节点
        };
      } catch (e) {
        console.warn(`[lua-region] Invalid rule pattern "${r.pattern}":`, e.message);
        return null;
      }
    }).filter(r => r !== null);

    const rootSymbols = [];
    const regionStack = [];

    for (let i = 0; i < document.lineCount; i++) {
      const lineText  = document.lineAt(i).text;
      const lineRange = document.lineAt(i).range;

      // --- Region 开始 ---
      let isRegionStart = false;
      for (const { startRe, endRe } of markerPatterns) {
        const m = startRe.exec(lineText);
        if (m) {
          const label = m[1].trim() || `Region (line ${i + 1})`;
          // 往上扫最多 3 行，找 -- title:xxx --! 作为 detail 附加到大纲
          // 允许跳过空行和普通注释行（-- endregion、-- xxx --! 等），遇到代码行才停止
          let titleDetail = '';
          for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
            const t = document.lineAt(j).text.trim();
            if (t === '') continue;
            const tm = t.match(/^--\s*title:(.+?)\s*--!$/);
            if (tm) { titleDetail = tm[1].trim(); break; }
            if (/^--/.test(t)) continue;  // 其他注释行跳过继续往上扫
            break;  // 非注释代码行，停止
          }
          const sym = makeSymbol(label, titleDetail, vscode.SymbolKind.Module, lineRange, lineRange);
          attachToParent(sym, regionStack, rootSymbols);
          regionStack.push({ sym, endRe });
          isRegionStart = true;
          break;
        }
      }
      if (isRegionStart) continue;

      // --- Region 结束 ---
      const endIdx = findEndMatch(regionStack, lineText);
      if (endIdx !== -1) {
        // 只关闭匹配的那一项，不强制关闭它上方的其他项
        const { sym } = regionStack.splice(endIdx, 1)[0];
        extendRange(sym, lineRange.end);
        continue;
      }

      // --- 自定义符号规则 ---
      for (const rule of rules) {
        const m = rule.re.exec(lineText);
        if (m) {
          const label = (m[1] !== undefined ? m[1] : m[0]).trim();
          if (!label) continue;

          // EnumMember（taskid）：往上扫最多 5 行，找 -- xxx --! 注释作为 detail
          let detail = rule.description ?? '';
          if (rule.kind === vscode.SymbolKind.EnumMember) {
            for (let back = i - 1; back >= Math.max(0, i - 5); back--) {
              const t = document.lineAt(back).text.trim();
              if (t === '') continue;
              // 匹配 -- 任意内容 --! 格式
              const cm = t.match(/^--\s+(.+?)\s+--!$/);
              if (cm) { detail = cm[1]; break; }
              // 跳过单纯的开括号行（节点开始 {），继续往上
              if (/^\{$/.test(t)) continue;
              // 遇到 }、},、),、) 等关闭行说明跨越了节点边界，停止
              if (/^[}\)],?$/.test(t)) break;
              // 遇到其他代码行或普通注释行，停止
              break;
            }
          }

          const sym = makeSymbol(label, detail, rule.kind, lineRange, lineRange);

          // Module 类型（initTask / initPromote）作为容器：
          // 先弹出栈顶所有同为 MODULE_RULE 压入的条目（同级互斥），再压栈
          if (rule.kind === vscode.SymbolKind.Module && rule.isContainer) {
            while (regionStack.length > 0 && regionStack[regionStack.length - 1].isRuleContainer) {
              const { sym: s } = regionStack.pop();
              extendRange(s, lineRange.start);  // 结束到下一个同级开始前
            }
            attachToParent(sym, regionStack, rootSymbols);
            regionStack.push({ sym, endRe: null, isRuleContainer: true });
          } else {
            attachToParent(sym, regionStack, rootSymbols);
          }
          break;
        }
      }
    }

    // 容错：未闭合的 region 延伸到文件末尾
    const lastLine = document.lineAt(document.lineCount - 1);
    while (regionStack.length > 0) {
      const { sym } = regionStack.pop();
      extendRange(sym, lastLine.range.end);
    }

    return rootSymbols;
  }
}

function attachToParent(sym, regionStack, roots) {
  if (regionStack.length > 0) {
    regionStack[regionStack.length - 1].sym.children.push(sym);
  } else {
    roots.push(sym);
  }
}

function findEndMatch(stack, lineText) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].endRe && stack[i].endRe.test(lineText)) return i;
  }
  return -1;
}

function extendRange(sym, endPos) {
  sym.range = new vscode.Range(sym.range.start, endPos);
}

function makeSymbol(label, detail, kind, range, selectionRange) {
  return new vscode.DocumentSymbol(label, detail, kind, range, selectionRange);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { LuaRegionSymbolProvider, DEFAULT_MARKERS, DEFAULT_RULES };
