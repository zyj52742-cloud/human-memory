# -*- coding: utf-8 -*-
"""
demo_a_write.py — 模拟「第一段对话」（会话 A）

跑完这个进程退出，代表用户关掉了应用。
记忆已经落进 data/demo.db，下一个进程（会话 B）能看到 —— 这就是跨会话。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_core as mc  # noqa: E402

DB = Path(__file__).parent / "data" / "demo.db"
SESSION = "session-A"


def clean_db() -> None:
    for p in [DB, DB.with_name(DB.name + "-wal"), DB.with_name(DB.name + "-shm")]:
        try:
            p.unlink()
        except FileNotFoundError:
            pass


def main() -> None:
    clean_db()
    print("=" * 62)
    print("会话 A：用户和 AI 聊了一段，期间产生这些信息")
    print("=" * 62)

    utterances = [
        "我叫林小满，我讨厌香菜，闻到就想吐",
        "我女儿叫小满，今年五岁，在学钢琴",
        "今天加班到十点，累死了",
        "明天要交周报，还没写完",
        "好的",  # 噪声，应被过滤
    ]

    for u in utterances:
        r = mc.remember(u, session_id=SESSION, db_path=DB)
        if r.get("ok"):
            print(f"  + [{r['action']:11s}] {u}  (重要度 {r['importance']:.2f}, 类型 {r['kind']})")
        else:
            print(f"  - [跳过       ] {u}  ({r['reason']})")

    print()
    print("会话 A 结束，进程退出。此刻记忆库里：")
    for m in mc.list_memories(db_path=DB):
        print(f"  #{m['id']} [{m['status']}] 重要{m['importance']:.2f} | {m['content']}")
    print()
    print("统计：", mc.stats(db_path=DB))


if __name__ == "__main__":
    main()
