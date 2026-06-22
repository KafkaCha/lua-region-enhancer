# Lua Region Enhancer

VSCode 扩展，为游戏项目 Lua 任务脚本提供代码折叠、大纲视图、Minimap 染色、Task ID 跳转和自动 Region 注释功能。

发行商：KAFKA · 版本：0.2.0

---

## 功能一览

### 1. Region 折叠

在代码中用以下标记包裹任意代码块，即可在编辑器左侧显示折叠箭头：

```lua
-- region 阶段名称
...
-- endregion
```

也支持 VS Code 原生风格：

```lua
--#region 阶段名称
...
--#endregion
```

两种标记可同时使用，互不干扰。

---

### 2. 大纲视图（Outline）

打开大纲面板（`Ctrl+Shift+O` 或侧边栏 OUTLINE），扩展会自动识别以下结构并分层展示：

| 识别规则 | 大纲显示内容 |
|---------|------------|
| `-- region <名称>` | Region 节点（包含其下所有子项） |
| `Mission.Xxx:initTask` | 任务主体 |
| `Mission.Xxx:initPromote` | 任务接取 |
| `id = 'XxxId'` | Task 节点 |
| `function Xxx(...)` | 函数 |
| `local function Xxx(...)` | 本地函数 |

所有符号自动嵌套到所在 Region 下，形成层级树。

**Title 副标题**：若 Region 开始行上方有 `-- title:xxx --!` 注释行，大纲中该 Region 右侧会自动显示 title 内容作为副标题，方便识别业务含义。

---

### 3. Minimap 与编辑器背景染色

每个 Region 块会被分配一种颜色，同步显示在：

- **编辑器整行背景**：半透明色块覆盖 Region 范围内所有行
- **Minimap**：对应区域显示色块，方便快速定位
- **Overview Ruler**（右侧滚动条）：彩色标记

同名 Region 颜色稳定，插入/删除其他 Region 不影响已有颜色。

**开关与透明度**（VSCode 设置 → 搜索 `luaRegion`）：

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| `luaRegion.showMinimapColors` | 开启/关闭 Minimap 和背景染色 | `true` |
| `luaRegion.regionBackgroundOpacity` | 背景色透明度（0 = 全透明，1 = 不透明） | `0.15` |

---

### 4. Task ID 跳转链接

扩展会扫描以下三类引用，将 Task ID 渲染为**可点击链接**：

| 引用写法 | 说明 |
|---------|------|
| `prev = {'XxxId', 'YyyId'}` | 前置依赖 |
| `MissionMgr:Finish('XxxId')` | 任务完成调用 |
| `MissionMgr:isfinished('XxxId')` | 任务状态检查 |

- **Ctrl+Click** 跳转到该 ID 的 `id = 'XxxId'` 定义行
- **悬停**显示目标行内容预览和行号

> 注意：链接只对非注释行生效，注释中的 ID 是纯文本。

---

### 5. Ghost Text

每个 Region 开始行末尾会显示斜体标签（`◀ 阶段名称`），方便折叠后识别内容。

开关：`luaRegion.showGhostText`（默认 `true`）。

---

### 6. 全文插入 Region 注释

对 Lua 任务文件执行**全量 Region 注释写入**，自动分析 Task 结构并插入规范注释。

**触发方式**：在 Lua 文件编辑器中右键 → **Lua: 全文插入 Region 注释**

**两种模式**：

| 模式 | 说明 |
|------|------|
| 本地模式 | 离线可用，根据 TA 调用类型推断标签，即时完成 |
| Claude 深度注释 | 调用 Claude 对复杂节点生成内嵌注释，消耗 token |

**自动生成内容**：

- 文件头（作者、功能说明）
- 每个 group/node/batch 前的 `-- region`/`-- endregion` 或 `-- xxx --!` 注释
- 若 Config.yaml 中该节点有玩家可见 title，自动在注释上方插入 `-- title:xxx --!`

**清除重写**：命令会先清除文件中已有的 `--!` 和 `-- region`/`-- endregion` 注释，再重新写入，避免重复。

---

## 注释规范

扩展使用以下注释格式，清除/重写时按此识别：

**文件头**：

```lua
-- 作者：Claude@KAFKA
-- 功能：XxxMission 任务管理脚本
```

**Region 标题**（group/可折叠阶段）：

```lua
-- title:玩家可见的子任务标题 --!   ← 来自 Config.yaml，有则自动插入
-- region 【分支1】
{
    id = 'XxxGroup',
    ...
-- endregion
```

**节点注释**（leaf node）：

```lua
-- title:玩家可见标题 --!   ← 有则自动插入
-- 与NPC对话 --!            ← TA 推断标签
{
    id = 'XxxNode',
    ...
```

> `--!` 结尾的行是扩展管理的注释，全量清除时会被删除并重新生成。

---

## 配置项完整列表

在 VSCode 设置中搜索 `luaRegion` 可查看和修改所有配置：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `luaRegion.regionMarkers` | array | `[{start, end}×2]` | Region 标记对，支持多组并存 |
| `luaRegion.outlineRules` | array | 见默认值 | 自定义大纲识别规则（正则 + 图标类型） |
| `luaRegion.minimapColors` | array | 8 种颜色 | Minimap 色块颜色池 |
| `luaRegion.showGhostText` | boolean | `true` | 是否显示 Region 标题 Ghost Text |
| `luaRegion.showMinimapColors` | boolean | `true` | 是否开启 Minimap / 背景染色 |
| `luaRegion.regionBackgroundOpacity` | number | `0.15` | 背景色透明度（0~1） |

---

### 自定义大纲规则（`luaRegion.outlineRules`）

打开 **设置（JSON）**（`Ctrl+Shift+P` → `Open User Settings JSON`），添加 `luaRegion.outlineRules` 字段。

> **注意**：写入此字段后，默认规则不再自动加载——需要将默认规则一并复制进去，再追加自定义规则。

```json
"luaRegion.outlineRules": [
  { "name": "Function",            "pattern": "^\\s*function\\s+([\\w\\.\\:]+)\\s*\\(",  "symbolKind": "Function",   "description": "" },
  { "name": "Local Function",      "pattern": "^\\s*local\\s+function\\s+(\\w+)\\s*\\(", "symbolKind": "Function",   "description": "" },
  { "name": "Mission initTask",    "pattern": "^\\s*Mission\\.(\\w+):initTask",           "symbolKind": "Module",     "description": "任务主体" },
  { "name": "Mission initPromote", "pattern": "^\\s*Mission\\.(\\w+):initPromote",        "symbolKind": "Module",     "description": "任务接取" },
  { "name": "Task ID",             "pattern": "^\\s*id\\s*=\\s*'([\\w]+)'",              "symbolKind": "EnumMember", "description": "taskid" },

  { "name": "NPC Define",          "pattern": "^\\s*NPC\\.(\\w+)\\s*=",                  "symbolKind": "Object",     "description": "NPC定义" }
]
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| `name` | 规则名称，仅用于标识，不显示在大纲中 |
| `pattern` | 正则表达式，**捕获组 `(...)` 的内容**作为大纲条目的显示文本 |
| `symbolKind` | 大纲图标类型，见下表 |
| `description` | 条目右侧副标题（可留空 `""`） |

**`symbolKind` 可选值：**

| 值 | 图标 |
|----|------|
| `Function` | 函数（ƒ） |
| `Module` | 模块（▦） |
| `EnumMember` | 枚举成员 |
| `Key` | 键（🔑） |
| `Object` | 对象（{}） |
| `Class` | 类 |
| `Variable` | 变量 |
| `Constant` | 常量 |
| `Field` | 字段 |

---

## 安装

1. 下载 `lua-region-enhancer-x.x.x.vsix`
2. VSCode → 扩展面板 → `···` 菜单 → **从 VSIX 安装**
3. 选择文件，重载窗口

扩展仅对 `.lua` 文件激活，不影响其他语言。
