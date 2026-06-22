'use strict';

const DEFAULT_MARKERS = [
  { start: '--#region', end: '--#endregion' },
  { start: '-- region', end: '-- endregion' },
];

const DEFAULT_RULES = [
  { name: 'Function',           pattern: '^\\s*function\\s+([\\w\\.\\:]+)\\s*\\(',  symbolKind: 'Function',    description: '' },
  { name: 'Local Function',     pattern: '^\\s*local\\s+function\\s+(\\w+)\\s*\\(', symbolKind: 'Function',    description: '' },
  { name: 'Mission initTask',   pattern: '^\\s*Mission\\.(\\w+):initTask',           symbolKind: 'Module',      description: '任务主体' },
  { name: 'Mission initPromote',pattern: '^\\s*Mission\\.(\\w+):initPromote',        symbolKind: 'Module',      description: '任务接取' },
  { name: 'Task ID',            pattern: "^\\s*id\\s*=\\s*['\"]([\\w]+)['\"]",      symbolKind: 'EnumMember',  description: 'taskid' },
];

const DEFAULT_COLORS = [
  '#4FC3F7', '#81C784', '#FFB74D', '#F06292',
  '#CE93D8', '#80DEEA', '#A5D6A7', '#FFF176',
];

module.exports = { DEFAULT_MARKERS, DEFAULT_RULES, DEFAULT_COLORS };
