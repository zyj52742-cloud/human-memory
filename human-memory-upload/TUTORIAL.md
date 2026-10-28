# 使用教程

从零开始，5 分钟让它跑起来，然后学会日常怎么用。

---

## 第一部分：装好它

### 1. 确认环境

打开 PowerShell，输一句：

```powershell
python --version
```

显示 `Python 3.10` 或更高就行。没有的话去 python.org 装一个。

**不需要装任何第三方包**，这个项目只用 Python 自带的库。

### 2. 选一种用法

| 你想怎么用 | 选哪种 |
|---|---|
| 让 AI 自动记住对话内容 | **AI skill**（推荐，零配置） |
| 自己用命令管记忆 | **命令行** |
| 挂到 Claude Desktop / Cursor | **MCP 服务** |

三种可以同时用，共用同一个记忆库。

#### 方案 A：装成 AI skill（推荐）

把仓库里的 `skills/memory/` 整个文件夹复制到你 AI 的技能目录。以 DSH 为例：

```
C:\Users\<你的用户名>\.dsh\skills\memory\
```

复制完不用配置。下次开新对话时，AI 会自动读到它。

验证：看 AI 的技能列表里有没有出现 `memory`。

#### 方案 B：直接用命令行

不用装，进到项目目录就能用：

```powershell
cd human-memory
python memcli.py add "我讨厌香菜"
```

#### 方案 C：挂到 Claude Desktop

编辑 `%APPDATA%\Claude\claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "human-memory": {
      "command": "python",
      "args": ["C:\\完整路径\\human-memory\\mcp_server.py"]
    }
  }
}
```

改完重启 Claude。

### 3. 试一下

```powershell
python memcli.py add "我叫小林，我讨厌香菜，闻到就想吐"
python memcli.py add "我今天加班到十点，累死了"
```

然后：

```powershell
python memcli.py recall "我讨厌什么"
```

应该看到：

```
- [偏好·0.81·刚刚] 我叫小林，我讨厌香菜，闻到就想吐
```

**这就通了。** 换一天再问，它还记得。

---

## 第二部分：日常怎么用

### 场景一：它自己记住你说的话

装了 skill 之后，你正常聊天就行。比如：

> 你：我女儿今年五岁了，在学钢琴。
> 你：今天特别累，感觉要崩溃。

AI 会自动把这两句分别记下来，**不需要你说"记住"**。

它判断的标准是：这句话是不是在说你自己。问句、语气词、"帮我查一下"这类不会记。

### 场景二：它想起来你以前说过的

几天后：

> 你：我最近状态怎么样？
> AI：（会先查一遍记忆，再结合最近的情绪记录回答）

或者直接问：

```powershell
python memcli.py recall "我女儿多大"
```

```
- [关系·0.72·5天前] 我女儿叫小满，今年五岁，在学钢琴
```

### 场景三：看情绪轨迹

这是它比较特别的地方——不是记流水账，而是攒出趋势。

```powershell
python memcli.py mood
```

```
最近 14 天共 8 条情绪记录，整体偏负面（平均效价 -0.58）
已经连续 7 天状态偏低，不是单日波动
心结（还没过去，强度 0.82）：4天前「我还在生我妈的气」
仍在余波中：2 天前「被老板当众羞辱」，可能还要影响约 8 天
```

四种信息：

- **连续性**：连续几天低，不是"今天心情不好"
- **趋势**：最近 3 天比之前更差还是好转
- **心结**：赌气、过不去的事，靠时间去平，不靠一句话
- **余波**：激烈的事会持续影响一段时间

### 场景四：手动管记忆

它默认自动干活，但你想干预时：

```powershell
python memcli.py list           # 看全部记忆
python memcli.py stats          # 多少条
python memcli.py explain 3      # 第3条为什么是这个分
python memcli.py sleep 3        # 让它沉下去（不删除）
python memcli.py wake 3         # 手动叫回来
python memcli.py pin 3          # 钉住，永远不忘
```

---

## 第三部分：命令参考

| 命令 | 作用 | 例子 |
|---|---|---|
| `add "内容"` | 记一条 | `add "我讨厌香菜"` |
| `recall "问题"` | 按话题召回 | `recall "我讨厌什么"` |
| `mood` | 情绪轨迹 | `mood` |
| `context "话题"` | 记忆+状态一起给 | `context "今天好累"` |
| `list` | 列全部 | `list` |
| `stats` | 条数统计 | `stats` |
| `explain 编号` | 看评分明细 | `explain 3` |
| `sleep 编号` | 休眠 | `sleep 3` |
| `wake 编号` | 唤醒 | `wake 3` |
| `pin 编号` | 钉住 | `pin 3` |

完整路径写法（在别的目录也能跑）：

```powershell
python "C:\Users\你的用户名\.dsh\skills\memory\scripts\memcli.py" stats
```

---

## 第四部分：常见问题

**Q：它会不会什么都记，越记越乱？**

不会。只有"关于你自己的陈述"才记，问句和语气词会被自动拦掉。而且不重要的记忆分数低，时间久了会沉底，不会一直占地方。

**Q：记忆存在哪？**

`C:\Users\<你的用户名>\.human-memory\memory.db`

一个 SQLite 文件，44 KB 起步。想备份就拷这个文件。

**Q：怎么删掉某条记忆？**

```powershell
python memcli.py sleep 3       # 软删除：沉下去，不再主动想起
```

真要彻底清空就删 `memory.db`（会丢全部记忆，慎用）。

**Q：为什么它没想起我说过的话？**

三个常见原因：

1. **话说得太隐晦**——它靠词匹配，"说不上来哪里不对"这种识别不了
2. **话题对不上**——问"我周末去哪"不会调出"我讨厌香菜"
3. **那条记忆休眠了**——试试 `python memcli.py list` 看还在不在

**Q：换台电脑怎么办？**

拷 `~/.human-memory/memory.db` 过去就行，格式通用。

**Q：它会把我的话传到网上吗？**

不会。纯本地，零联网。唯一的例外是你主动配了外部 API（默认关闭）。

---

## 第五部分：进阶

### 想让它更聪明（可选，要花钱或要好显卡）

默认的规则版靠词典识别情绪，理解不了太隐晦的表达。想提升可以接一个 OpenAI 兼容的 API：

```powershell
set MEMORY_LLM_BASE_URL=https://api.deepseek.com/v1
set MEMORY_LLM_API_KEY=你的密钥
set MEMORY_LLM_MODEL=deepseek-chat
```

- 支持 DeepSeek、通义、Ollama、vLLM 等
- 调用失败会自动回退规则版，不会丢记忆
- **代价**：会联网、按量收费、对话内容会发给服务商

> 本地跑模型不推荐：实测在 8 GB 显存的机器上，1.5B 太笨（抄示例）、3B/7B 输出退化。大显存机器可以试 14B 以上。

### 想调分数

所有权重都在 `scoring.py` 和 `memory_core.py` 顶部，改完跑 `python selftest.py` 确认没坏。

```powershell
python tune.py                 # 用合成数据看参数影响
python tune.py --db 你的库.db   # 用真实记忆库调
```

### 想接进自己的程序

```python
import memory_core as mc

mc.remember("用户说的话")
items = mc.recall("当前话题", top_k=3)
text = mc.render_for_prompt(items)   # 直接塞进系统提示
```

---

## 一页速查

```
装：把 skills/memory 复制到 AI 技能目录
记：python memcli.py add "内容"
取：python memcli.py recall "问题"
看：python memcli.py mood
库：~/.human-memory/memory.db
```
