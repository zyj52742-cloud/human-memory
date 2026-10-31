# 两个视图的数据格式

两个页面都不请求后端，只读取同目录 `_lib/` 下的两个 JS 文件。字段以当前导出器为准；新增字段向后兼容，旧字段不删除。

## 1. 关联网络：`_lib/network-data.js`

```js
window.__MEMORY_NETWORK__ = {
  version: 1,
  generatedAt: "2026-10-31T21:00:00+08:00",
  nodes: [],
  edges: [],
  events: [],
  profiles: [],
  metadata: {}
};
```

### nodes

公共字段：`id` / `type` / `label` / `group` / `source`。

| type | id 形式 | 说明 |
|---|---|---|
| `conversation` | `conv:<原始 sessionId>` | 一段对话；`parent` 只用于精确匹配的父对话 |
| `memory` | `mem:<库路径短hash>:<profile>:<库内id>` | 一条记忆 |
| `entity` | `entity:<profile>:<实体名hash>` | 实体；不同 profile 的同名实体不合并 |
| `kind` | `kind:<profile>:<kind名hash>` | 记忆类型 hub |
| `project` | `project:<项目名hash>` | 项目 hub |

记忆节点额外字段：`profile` / `kind` / `content` / `importance` / `weight` / `status`（active/dormant/superseded）/ `pinned` / `entity` / `sourceSession` / `created` / `updated` / `recallCount` / `lastRecalled` / `missingSource`。

### edges

字段：`id` / `source` / `target` / `type` / `confidence` / `basis`。

| type | 含义 |
|---|---|
| `parent` | 对话 → 父对话（只来自星图快照 `parent`，不猜） |
| `project` | 对话 → 项目 |
| `source` | 记忆 → 来源对话（仅 `source_session` 精确命中 sessionId） |
| `entity` | 记忆 → 实体 |
| `kind` | 记忆 → 类型 |

### events

只来自记忆库 `events` 表，是引擎真实写入的过程记录（`remember` / `recalled` / `dormant` / `pinned` 等），不从 `recall_count` 反推、不补造。字段：`id` / `eventId` / `databaseId` / `source` / `memory_id` / `action` / `detail` / `created_at` / `profile` / `memoryNodeId` / `matched` / `attribution`。

`attribution` 为 `global` 或 `missing_memory` 时，`profile` 与 `memoryNodeId` 为 `null`，界面保留事件但不猜归属。

### demo 标记

demo 生成的数据额外带 `demo: true`，并且：

- `metadata.notice` 明确说明全部为合成数据；
- 记忆内容以「【演示·虚构】」开头；
- 品牌区有「演示 · 虚构数据」短标识（`{{DEMO_BANNER}}` 占位注入）。

`export` 生成的数据 `demo` 为 `false`，不注入演示标识。

---

## 2. 真实行星：`_lib/data.js`

```js
window.__STAR_DATA__ = {
  generatedAt: 1792419198317,      // 毫秒时间戳
  source: "demo://synthetic",
  count: 12,
  mainCount: 11,
  subCount: 1,
  projects: {"演示项目 · 花园改造": 3},
  stars: [],
  archived: [],
  demo: true
};
```

`stars` 每项是一段对话：

```json
{
  "id": "demo-session-01",
  "title": "【演示·虚构】给阳台换一盆香草",
  "cwd": "demo://演示项目 · 花园改造",
  "project": "演示项目 · 花园改造",
  "created": 1792419198317,
  "last": 1792419558317,
  "turns": 6,
  "u": 3,
  "a": 3,
  "lines": 72,
  "firstUser": "……",
  "firstAsst": "……",
  "sub": 0,
  "parent": "",
  "depth": 0,
  "tk": "demo"
}
```

`sub=1` 表示子代理派生会话，在行星页显示为卫星。`archived` 只用于在行星页把已消失的会话画成暗星，当前导出器默认为空。

### 输入兼容

`export --stars` 接受：

1. 浏览器直接可用的 `data.js`（含 `window.__STAR_DATA__ =` 前缀）；
2. 同结构纯 JSON 文件；
3. 只包含 `{"stars": [...]}` 的最小快照。

解析用 `JSONDecoder.raw_decode`，不 `eval` 任何输入。
