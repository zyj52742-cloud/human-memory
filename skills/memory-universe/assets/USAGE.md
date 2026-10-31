# 记忆宇宙 · 使用说明

本目录由 `skills/memory-universe/scripts/universe.py` 生成，模式：**{{MODE}}**。

## 打开

直接双击同目录的 `01-记忆宇宙.html`（关联网络）或 `02-记忆星图.html`（真实行星）。
页面只加载本目录 `_lib/` 下的本地文件，不联网。

也可以用命令（在技能目录下）：

```powershell
python scripts/universe.py open --output "<本目录>" --page network
python scripts/universe.py open --output "<本目录>" --page stars
```

浏览器不可用时，命令会打印本地文件绝对路径，不会谎报打开成功。

## 数据

- `_lib/network-data.js`：`window.__MEMORY_NETWORK__`，关联网络数据。
- `_lib/data.js`：`window.__STAR_DATA__`，行星页数据。
- `data/`：仅 demo 模式包含虚构记忆库与虚构对话快照。

## 重新生成

```powershell
# 虚构演示
python scripts/universe.py demo --output "<本目录>" --force

# 真实数据（只读导出，不修改任何数据库）
python scripts/universe.py export --db "<memory.db>" --stars "<data.js>" --output "<本目录>" --force
```

## 边界

- 页面只读，不能从页面修改记忆库。
- demo 数据全部是虚构的，可整目录删除。
- export 不会建库、迁移、唤醒或写回数据库。
- 记忆不会自动跨轮召回；是否调用取决于宿主 AI 的技能选择。
