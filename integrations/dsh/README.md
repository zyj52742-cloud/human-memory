# DSH 原生适配器 · 第二版

这是记忆宇宙在 DSH 中的可选入口。便携技能独立使用，不需要本目录。

## 能力和依赖

- DSH 左侧、聊天视图与右栏入口，真实记录/虚构示例和关联网络/真实行星切换。
- 手动保存记忆、从对话摘录、取消保存，稳定 profile 隔离；取消保存是停止召回的软删除，原始对话保留。
- 本地读取用户消息、增量内容索引、依据原文推测话题关系；不调用模型或外网。
- iframe 判源、卸载资源释放、隐藏页调度与 GPU 尺寸限制。
- 需要可加载本地插件的 DSH、Python 3.14+（`compression.zstd`）和 Node.js 18+。不安装依赖、不修改 DSH 配置的准备命令如下。

## 准备文件

在仓库根目录运行：

```powershell
python integrations/dsh/prepare.py
# 可明确选择已有数据库或星图；不会创建不存在的 --db
python integrations/dsh/prepare.py --db "D:/my-memory/memory.db" --stars "D:/my-stars/data.js" --force
```

只生成本目录被 Git 忽略的 `_runtime/`：`network/`、`planets/` 与虚构 `_demo/`，不安装插件、不扫描会话、不改现有 DSH。运行时文件包含私有数据时不要上传。

## 手动接入

将 `dsh-plugin/` 作为本地包 `local-memory-universe` 接入你自己的 DSH profile；可以使用 profile 的 `node_modules/local-memory-universe` 目录链接，或其支持的本地包依赖。保留原 profile 的依赖和 patch 条目，只追加本插件的 `cordis.patch.yml` 中 insert 条目。安装方式由 DSH 的版本和 profile 位置决定，本仓库不自动编辑全局配置。

插件默认使用旁边 `_runtime/network`；可在启动 DSH 的进程环境中用 `MEMORY_UNIVERSE_ROOT` 指定同布局运行目录。`python` 和 `node` 需要在 PATH。重新启动并新建会话后，检查左侧“记忆宇宙”及 `memory_universe_open`、`memory_universe_memory` 两个工具。`skills/starmap/` 是可选的工具路由技能，复制到 DSH 的 skills 目录即可；不覆盖已有同名技能。

点击“刷新数据”才扫描本地 DSH 会话目录；默认 `~/.dsh/sessions`，可用 `DSH_SESSIONS_DIR` 指定。索引只使用用户消息建立关系，内容关系是可核对、可忽略的自动推测，不是记忆库中的确认事实。无可读会话时保留已有快照并报告失败。

已明确选择 `--db` 时只操作所选库；否则真实快照只读已有的引擎默认库。首次明确保存时可创建引擎默认库，遵循 `MEMORY_DB` 或引擎默认路径。适配器会关闭可选模型抽取，不因为继承环境变量而联网。

## 发布验证范围

第二版在隔离运行目录核验准备命令、保存/取消后的召回与节点计数、跨对象隔离、HTTP 判源与路径限制，并验证便携视图。没有重新安装或重启作者的生产 DSH，也没有在本次发布副本重跑 30 分钟稳定性测试。普通浏览器快照只读；保存与取消保存需要 DSH 的鉴权服务。
