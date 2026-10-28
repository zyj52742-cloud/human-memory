# -*- coding: utf-8 -*-
"""
memcli.py — 记忆插件的命令行入口（给 skill 用）

AI 读 SKILL.md 后按指令执行这些命令。输出是给 AI 看的精简文本。

用法：
    python memcli.py add "我今天加班到十点，累死了"
    python memcli.py recall "用户刚才说的话"
    python memcli.py mood
    python memcli.py list
    python memcli.py stats
    python memcli.py explain 3
    python memcli.py sleep 3
    python memcli.py wake 3
    python memcli.py pin 3
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_core as mc  # noqa: E402

PROFILE = "default"


def _text(args: list[str]) -> str:
    return " ".join(args).strip()


def main() -> int:
    argv = sys.argv[1:]
    cmd = argv[0].lower() if argv else "help"
    args = argv[1:]

    if cmd in ("-h", "--help", "help"):
        print(__doc__)
        return 0

    if cmd == "add":
        text = _text(args)
        if not text:
            print("用法: add \"要记住的话\"")
            return 1
        r = mc.remember(text, profile=PROFILE)
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
            print("用法: recall \"当前话题或用户的话\"")
            return 1
        items = mc.recall(q, top_k=3, profile=PROFILE)
        if not items:
            print("（没有相关记忆）")
            return 0
        print(mc.render_for_prompt(items))
        return 0

    if cmd == "mood":
        print(mc.recent_mood_summary(days=7, profile=PROFILE))
        return 0

    if cmd == "list":
        rows = mc.list_memories(profile=PROFILE, limit=20)
        if not rows:
            print("（记忆库是空的）")
            return 0
        for r in rows:
            flag = "钉住" if r["pinned"] else r["status"]
            print(f"#{r['id']} [{flag}] {r['kind_label']}·{r['importance']:.2f} {r['age']} | {r['content']}")
        return 0

    if cmd == "stats":
        s = mc.stats(profile=PROFILE)
        print(f"总 {s['total']} 条｜活跃 {s['active']}｜休眠 {s['dormant']}｜钉住 {s['pinned']}")
        return 0

    if cmd in ("explain", "sleep", "wake", "pin"):
        if not args:
            print(f"用法: {cmd} 序号")
            return 1
        try:
            mid = int(args[0])
        except ValueError:
            print("序号要填数字")
            return 1
        if cmd == "explain":
            print(mc.explain_memory(mid))
        elif cmd == "sleep":
            r = mc.set_status(mid, "dormant")
            print(f"#{mid} 已休眠" if r.get("ok") else f"失败：{r.get('reason')}")
        elif cmd == "wake":
            r = mc.set_status(mid, "active")
            print(f"#{mid} 已唤醒" if r.get("ok") else f"失败：{r.get('reason')}")
        else:
            r = mc.set_pinned(mid, True)
            print(f"#{mid} 已钉住" if r.get("ok") else f"失败：{r.get('reason')}")
        return 0

    if cmd == "context":
        # 一次性给出：相关记忆 + 近期状态，适合直接注入回复
        q = _text(args)
        print(mc.build_context(q, profile=PROFILE))
        return 0

    print(f"未知命令: {cmd}（用 help 看用法）")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
