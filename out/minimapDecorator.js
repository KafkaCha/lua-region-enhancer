'use strict';
const vscode = require('vscode');
const { DEFAULT_MARKERS, DEFAULT_COLORS } = require('./defaults');

function getCfg() {
  const cfg = vscode.workspace.getConfiguration('luaRegion');
  const markers   = cfg.get('regionMarkers');
  const colors    = cfg.get('minimapColors');
  const showGhost = cfg.get('showGhostText');

  const validMarkers = Array.isArray(markers)
    ? markers.filter(m => m && typeof m.start === 'string' && m.start.length > 0
                           && typeof m.end === 'string' && m.end.length > 0)
    : [];
  const validColors = Array.isArray(colors)
    ? colors.filter(c => typeof c === 'string' && c.length > 0)
    : [];

  return {
    markers:     validMarkers.length > 0 ? validMarkers : DEFAULT_MARKERS,
    colors:      validColors.length  > 0 ? validColors  : DEFAULT_COLORS,
    showGhost:   showGhost !== false,
    showMinimap: cfg.get('showMinimapColors') !== false,
    bgOpacity:   Math.min(1, Math.max(0, Number(cfg.get('regionBackgroundOpacity')) || 0.15)),
  };
}

class MinimapRegionDecorator {
  constructor() {
    // 按 document URI 存储各文件当前应用的 decorationType 列表
    this._typesByUri = new Map();
    this._debounceTimer = null;
    // 编译后的正则缓存，配置未变时跨调用复用
    this._cachedCfgKey = null;
    this._cachedMarkerPatterns = null;
  }

  activate(context) {
    const apply = (editor) => {
      if (editor && editor.document.languageId === 'lua') {
        this._applyDecorations(editor);
      }
    };

    vscode.window.onDidChangeActiveTextEditor(editor => {
      apply(editor);
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument(e => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || e.document !== editor.document || editor.document.languageId !== 'lua') return;
      // debounce：150ms 内的连续输入只触发一次渲染
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        const cur = vscode.window.activeTextEditor;
        if (cur && cur.document === e.document) {
          this._applyDecorations(cur);
        }
      }, 150);
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('luaRegion')) {
        // 配置变更时清除正则缓存，下次渲染时重新编译
        this._cachedCfgKey = null;
        this._cachedMarkerPatterns = null;
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'lua') {
          this._applyDecorations(editor);
        }
      }
    }, null, context.subscriptions);

    // 文件关闭时释放该文件的所有 decorationType，避免内存泄漏
    vscode.workspace.onDidCloseTextDocument(doc => {
      this._disposeForUri(doc.uri.toString());
    }, null, context.subscriptions);

    if (vscode.window.activeTextEditor) {
      apply(vscode.window.activeTextEditor);
    }

    // 返回 Disposable，确保扩展停用时清除挂起的 debounce 定时器和所有装饰类型
    return {
      dispose: () => {
        if (this._debounceTimer) {
          clearTimeout(this._debounceTimer);
          this._debounceTimer = null;
        }
        // 释放所有文件的 decorationType，避免扩展停用后资源泄漏
        for (const types of this._typesByUri.values()) {
          types.forEach(t => t.dispose());
        }
        this._typesByUri.clear();
      }
    };
  }

  _disposeForUri(uriKey) {
    const types = this._typesByUri.get(uriKey);
    if (types) {
      types.forEach(t => t.dispose());
      this._typesByUri.delete(uriKey);
    }
  }

  _applyDecorations(editor) {
    const uriKey = editor.document.uri.toString();

    // 清除该文件上一次的装饰
    const oldTypes = this._typesByUri.get(uriKey) || [];
    oldTypes.forEach(t => {
      editor.setDecorations(t, []);
      t.dispose();
    });

    const newTypes = [];
    this._typesByUri.set(uriKey, newTypes);

    const { markers, colors, showGhost, showMinimap, bgOpacity } = getCfg();

    // 用配置序列化串做缓存 key，避免每次重新编译正则
    const cfgKey = JSON.stringify(markers);
    if (cfgKey !== this._cachedCfgKey) {
      this._cachedCfgKey = cfgKey;
      this._cachedMarkerPatterns = markers.map(m => ({
        startRe: new RegExp(`^\\s*${escapeRe(m.start)}\\s*(.*)`, 'i'),
        endRe:   new RegExp(`^\\s*${escapeRe(m.end)}`, 'i'),
      }));
    }
    const markerPatterns = this._cachedMarkerPatterns;

    const doc = editor.document;
    const regions = [];
    const stack = [];

    for (let i = 0; i < doc.lineCount; i++) {
      const lineText = doc.lineAt(i).text;
      let matched = false;

      for (const { startRe, endRe } of markerPatterns) {
        const m = startRe.exec(lineText);
        if (m) {
          const label = m[1].trim() || 'Region';
          // 用标签 hash 取色，相同名字颜色稳定
          const colorIdx = labelHash(label) % colors.length;
          stack.push({ startLine: i, label, colorIdx, endRe });
          matched = true;
          break;
        }
      }
      if (matched) continue;

      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].endRe.test(lineText)) {
          // 只关闭匹配的那一项，不强制关闭它上方的其他项
          const entry = stack.splice(s, 1)[0];
          regions.push({ startLine: entry.startLine, endLine: i, label: entry.label, colorIdx: entry.colorIdx });
          break;
        }
      }
    }

    // 容错：未闭合的 region 延伸到文件末尾
    while (stack.length > 0) {
      const entry = stack.pop();
      regions.push({ startLine: entry.startLine, endLine: doc.lineCount - 1, label: entry.label, colorIdx: entry.colorIdx });
    }

    // ghost text：每个 region 独立标签，必须单独创建 decorationType
    if (showGhost) {
      for (const region of regions) {
        const ghostType = vscode.window.createTextEditorDecorationType({
          after: {
            contentText: `  ◀ ${region.label}`,
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            margin: '0',
            fontStyle: 'italic',
          },
        });
        newTypes.push(ghostType);
        editor.setDecorations(ghostType, [doc.lineAt(region.startLine).range]);
      }
    }

    // minimap / overview ruler：按颜色分组，同色 region 共用一个 decorationType
    if (showMinimap) {
      const byColor = new Map();
      for (const region of regions) {
        const color = colors[region.colorIdx] || '#4FC3F7';
        if (!byColor.has(color)) byColor.set(color, []);
        byColor.get(color).push(new vscode.Range(
          new vscode.Position(region.startLine, 0),
          doc.lineAt(region.endLine).range.end
        ));
      }
      for (const [color, ranges] of byColor) {
        const blockType = vscode.window.createTextEditorDecorationType({
          backgroundColor: colorWithAlpha(color, bgOpacity),
          isWholeLine: true,  // 整行染色，与 Colored Regions 行为一致
          minimap: { color, position: 1 },
          overviewRulerColor: color,
          overviewRulerLane: vscode.OverviewRulerLane.Right,
        });
        newTypes.push(blockType);
        editor.setDecorations(blockType, ranges);
      }
    }
  }
}

// 将 #RRGGBB 或 #RGB 颜色加上 alpha 通道，返回 #RRGGBBAA 格式
function colorWithAlpha(hex, opacity) {
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255)
    .toString(16).padStart(2, '0');
  // 将 #RGB 展开为 #RRGGBB
  const full = hex.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3');
  return full.length === 7 ? full + alpha : hex;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

module.exports = { MinimapRegionDecorator };
