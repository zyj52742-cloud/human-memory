# -*- coding: utf-8 -*-
"""memcli.py — 记忆命令行的便携副本（skills/memory-universe/scripts）

与仓库根目录的 memcli.py 行为一致，另外支持全局参数：
    --db PATH         指定 SQLite 库（默认沿用引擎默认库）
    --profile NAME    指定记忆分区（默认 default）

这两个参数可以放在子命令前后任意位置，例如：
    python scripts/memcli.py add "我讨厌香菜" --db ./demo-data.db --profile demo
    python scripts/memcli.py --profile demo recall "晚饭吃什么" --db ./demo-data.db

默认剥离可选模型抽取（MEMORY_LLM_*）环境变量，避免误联网；显式加
--enable-llm（或设置 MEMORY_ALLOW_LLM=1）才保留原项目的可选模型抽取。
"""

import os
import sys
from pathlib import Path

for _key in ("MEMORY_LLM_BASE_URL", "MEMORY_LLM_API_KEY", "MEMORY_LLM_MODEL"):
    if "--enable-llm" not in sys.argv and os.environ.get("MEMORY_ALLOW_LLM") != "1":
        os.environ.pop(_key, None)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_core as mc  # noqa: E402

PROFILE = "default"
DB_PATH = None


def _parse_globals(argv: list[str]) -> list[str]:
    global PROFILE, DB_PATH
    rest: list[str] = []
    i = 0
    while i < len(argv):
        item = argv[i]
        if item == "--db" and i + 1 < len(argv):
            DB_PATH = argv[i + 1]
            i += 2
            continue
        if item.startswith("--db="):
            DB_PATH = item.split("=", 1)[1]
            i += 1
            continue
        if item == "--profile" and i + 1 < len(argv):
            PROFILE = argv[i + 1]
            i += 2
            continue
        if item.startswith("--profile="):
            PROFILE = item.split("=", 1)[1]
            i += 1
            continue
        rest.append(item)
        i += 1
    return rest


def _text(args: list[str]) -> str:
    return " ".join(a for a in args if a != "--enable-llm").strip()


def _db():
    return DB_PATH


def main() -> int:
    argv = _parse_globals(sys.argv[1:])
    cmd = argv[0].lower() if argv else "help"
    args = argv[1:]

    if cmd in ("-h", "--help", "help"):
        print(__doc__)
        return 0

    if cmd == "add":
        text = _text(args)
        if not text:
            print('用法: add "要记住的话" [--db 路径] [--profile 名称]')
            return 1
        r = mc.remember(text, profile=PROFILE, db_path=_db())
        if not r.get("ok"):
            print(f"未记忆：{r.get('reason')}")
            return 0
        if r["action"] == "strengthened":
            print(f"[加深] 这条已有印象（#{r['id']}）")
        elif r["action"] == "resolve_signal":
            print(f"[化解信号] 影响 {r.get('affected', 0)} 个心结，但还没清零")
        else:
            print(f"[记住] #{r['id']} 重要度 {r['importance']:.2f} 类型 {r['kind']}")
        return 0

    if cmd == "recall":
        q = _text(args)
        if not q:
            print('用法: recall "当前话题或用户的话" [--db 路径] [--profile 名称]')
            return 1
        items = mc.recall(q, top_k=3, profile=PROFILE, db_path=_db())
        if not items:
            print("（没有相关记忆）")
            return 0
        print(mc.render_for_prompt(items))
        return 0

    if cmd == "mood":
        print(mc.recent_mood_summary(days=7, profile=PROFILE, db_path=_db()))
        return 0

    if cmd == "list":
        rows = mc.list_memories(profile=PROFILE, limit=20, db_path=_db())
        if not rows:
            print("（记忆库是空的）")
            return 0
        for r in rows:
            flag = "钉住" if r["pinned"] else r["status"]
            print(
                f"#{r['id']} [{flag}] {r['kind_label']}·{r['importance']:.2f} "
                f"{r['age']} | {r['content']}"
            )
        return 0

    if cmd == "stats":
        s = mc.stats(profile=PROFILE, db_path=_db())
        print(
            f"总 {s['total']} 条｜活跃 {s['active']}｜休眠 {s['dormant']}｜"
            f"钉住 {s['pinned']}｜事件 {s['events']}"
        )
        return 0

    if cmd in ("explain", "sleep", "wake", "pin", "delete"):
        if not args:
            print(f"用法: {cmd} 序号")
            return 1
        try:
            mid = int(args[0])
        except ValueError:
            print("序号要填数字")
            return 1
        if cmd == "explain":
            print(mc.explain_memory(mid, db_path=_db()))
        elif cmd == "sleep":
            r = mc.set_status(mid, "dormant", db_path=_db())
            print(f"#{mid} 已休眠" if r.get("ok") else f"失败：{r.get('reason')}")
        elif cmd == "wake":
            r = mc.set_status(mid, "active", db_path=_db())
            print(f"#{mid} 已唤醒" if r.get("ok") else f"失败：{r.get('reason')}")
        elif cmd == "delete":
            r = mc.delete_memory(mid, db_path=_db())
            print(f"#{mid} 已删除（软删除，不再召回）" if r.get("ok") else f"失败：{r.get('reason')}")
        else:
            r = mc.set_pinned(mid, True, db_path=_db())
            print(f"#{mid} 已钉住" if r.get("ok") else f"失败：{r.get('reason')}")
        return 0

    if cmd == "context":
        q = _text(args)
        print(mc.build_context(q, profile=PROFILE, db_path=_db()))
        return 0

    print(f"未知命令: {cmd}（用 help 看用法）")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
