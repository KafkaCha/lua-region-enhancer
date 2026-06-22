'use strict';
const vscode = require('vscode');
const { LuaFoldingProvider }     = require('./foldingProvider');
const { LuaRegionSymbolProvider } = require('./symbolProvider');
const { MinimapRegionDecorator }  = require('./minimapDecorator');
const { LuaTaskLinkProvider }     = require('./linkProvider');
const { runFullAnnotate, showTaskGraph } = require('./regionAnnotator');

function activate(context) {
  // 折叠 Provider
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(
      { language: 'lua' },
      new LuaFoldingProvider()
    )
  );

  // 大纲 Provider
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      { language: 'lua' },
      new LuaRegionSymbolProvider(),
      { label: 'Regions & Rules' }
    )
  );

  // prev / MissionMgr 调用跳转链接
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      { language: 'lua' },
      new LuaTaskLinkProvider()
    )
  );

  // Minimap / Overview Ruler 装饰
  const decorator = new MinimapRegionDecorator();
  context.subscriptions.push(decorator.activate(context));

  // 全文插入 Region 注释命令
  context.subscriptions.push(
    vscode.commands.registerCommand('luaRegion.fullAnnotate', () => runFullAnnotate())
  );

  // 任务拓扑图命令
  context.subscriptions.push(
    vscode.commands.registerCommand('luaRegion.showTaskGraph', () => showTaskGraph())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
