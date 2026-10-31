# 可选模型抽取：启用方式与边界

在没有配置 `MEMORY_LLM_*` 环境变量时，记忆引擎使用**规则版抽取**：纯本地、零第三方依赖、不联网。规则版靠情绪词表、代词/自我参照、句式与词频打分，能稳定给出「重要度 / 类型 / 情绪两维 / 衰减类」，但对隐晦表达（例如“说不上来哪里不对”）识别有限。

原项目另外提供一个**可选**的 OpenAI 兼容接口抽取层（`extractor.py`）。它只改因子分，重要度仍由公式计算；任何网络、超时、JSON 坏、字段缺失都会自动回退规则版，不会丢记忆。

## 先分清入口：哪些默认屏蔽，哪些没有开关

| 入口 | 没有 `MEMORY_LLM_*` 时 | 三个变量齐全时 |
|---|---|---|
| `skills/memory-universe/scripts/universe.py` | 规则版，本地 | 仍默认屏蔽；要加 `--enable-llm` 或 `MEMORY_ALLOW_LLM=1` 才启用 |
| `skills/memory-universe/scripts/memcli.py` | 规则版，本地 | 同上 |
| 仓库根 `memcli.py` | 规则版，本地 | **直接启用**（原项目行为，无开关） |
| 仓库根 `mcp_server.py` / MCP 服务 | 规则版，本地 | **直接启用**（原项目行为，无开关） |
| 旧 `skills/memory/scripts/memcli.py` | 规则版，本地 | **直接启用**（原项目行为，无开关） |

也就是说：**“默认离线”只承诺新 `memory-universe` 的两个入口**。旧根 CLI、MCP 和旧 `memory` 技能保留原接口行为，没有加屏蔽；只要环境里三个变量齐全，它们就会联网调用你配置的接口。

## 新技能入口：默认屏蔽

`skills/memory-universe/scripts/universe.py` 与 `scripts/memcli.py` 默认在进程内剥离以下环境变量：

- `MEMORY_LLM_BASE_URL`
- `MEMORY_LLM_API_KEY`
- `MEMORY_LLM_MODEL`

所以即使系统里残留这些变量，新技能入口的 `demo`、`remember`、`recall` 也不会调用外部接口。`demo` 无论环境如何都强制离线；`export` 只读数据库、不重新抽取。

## 新技能入口：显式启用

两种方式，任选其一：

```powershell
# 方式 A：命令行开关（仅对本次 remember / recall 生效）
python scripts/universe.py remember "说不上来哪里不对" --db "D:\tmp\m.db" --enable-llm

# 方式 B：进程级开关
$env:MEMORY_ALLOW_LLM = "1"
python scripts/memcli.py add "说不上来哪里不对" --db "D:\tmp\m.db"
```

启用后仍需三个变量齐全，否则引擎自动回退规则版：

```powershell
$env:MEMORY_LLM_BASE_URL = "https://你的接口/v1"
$env:MEMORY_LLM_API_KEY  = "你的密钥"
$env:MEMORY_LLM_MODEL    = "模型名"
```

## 旧入口：保持原行为

根目录 `memcli.py`、`mcp_server.py`、旧 `skills/memory/` 没有开关；三个变量齐全就启用，和原项目文档一致。不需要模型抽取时，不设置这三个变量即可，它们只走本地规则版。

## 注意

1. 启用后请求会发往你配置的接口；密钥只从环境变量读取，不写进代码、日志或页面。
2. 失败会自动回退规则版，不会因为接口不可用而拒绝记忆。
3. 新技能不会为你安装依赖、不会偷偷联网、不会替你填密钥。
4. 两个视图（关联网络 / 真实行星）只读本地数据，不调用任何抽取接口。
