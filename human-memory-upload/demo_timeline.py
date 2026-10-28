# -*- coding: utf-8 -*-
"""
demo_timeline.py — 一键演示，不需要任何输入

预置一个人连续两周的低谷，展示：
1. 每条记忆被怎么评判
2. 现在的情绪档案（连续低迷、余波、心结）
3. 心结化解：一句话不够，要证据累积
"""

import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_core as mc  # noqa: E402

DB = Path(__file__).parent / "data" / "_timeline.db"


def backdate(mid: int, days_ago: int) -> None:
    ts = (mc.now_dt() - timedelta(days=days_ago)).isoformat(timespec="seconds")
    c = mc.connect(DB)
    c.execute("UPDATE memories SET created_at=? WHERE id=?", (ts, mid))
    c.commit()
    c.close()


def lineup(title: str) -> None:
    print()
    print("=" * 64)
    print(title)
    print("=" * 64)


def main() -> None:
    for f in (DB, Path(str(DB) + "-wal"), Path(str(DB) + "-shm")):
        f.unlink(missing_ok=True)

    lineup("场景：一个人连续两周的低谷（预置，不需要你输入）")
    days = [
        (6, "今天还行，就是有点累"),
        (5, "我今天心情挺低落的"),
        (4, "我跟同事吵了一架，气死了"),
        (4, "我还在生同事的气，一直没搭理他"),
        (2, "我被老板当众羞辱，特别羞耻"),
        (1, "我今天很难过"),
        (0, "今天很累，心累"),
    ]
    for d, text in days:
        r = mc.remember(text, db_path=DB)
        if r.get("ok"):
            backdate(r["id"], d)
            print(f"  {d}天前  [{r['kind']:9s}] 重要度 {r['importance']:.2f}  {text}")

    lineup("现在的情绪档案")
    print(mc.recent_mood_summary(days=14, db_path=DB))

    lineup("心结怎么才算过去：一句话不够，要证据累积")
    a = mc.analyze_mood(days=30, db_path=DB)
    g = a["unresolved"][0] if a["unresolved"] else None
    if g:
        print(f"  初始：强度 {g['strength']:.2f}（{g['stage']}）")
        print(f"        「{g['content']}」")
        print()
        for i, s in enumerate(["算了，都过去了", "真的想开了", "气消了，翻篇了"], 1):
            mc.remember(s, db_path=DB)
            aa = mc.analyze_mood(days=30, db_path=DB)
            if aa["unresolved"]:
                u = aa["unresolved"][0]
                print(f"  说要放下第 {i} 次「{s}」")
                print(f"        → 强度 {u['strength']:.2f}（{u['stage']}）")
            else:
                print(f"  说要放下第 {i} 次「{s}」 → 已化解")

        c = mc.connect(DB)
        c.execute("UPDATE memories SET created_at=? WHERE kind='grudge'",
                  ((mc.now_dt() - timedelta(days=12)).isoformat(timespec="seconds"),))
        c.commit()
        c.close()
        aa = mc.analyze_mood(days=30, db_path=DB)
        print()
        if aa["unresolved"]:
            print(f"  又过了 12 天 → 强度 {aa['unresolved'][0]['strength']:.2f}，仍然没过去")
        else:
            print("  又过了 12 天 → 时间、表达、状态几路证据都到了，才算真的过去")

    lineup("这套机制想说明的三件事")
    print("  1. 情绪状态每次都单独记，才能统计出连续几天")
    print("  2. 一件事的余波会持续一段时间，不是当天就翻篇")
    print("  3. 心结要时间 + 表达 + 状态多方证据才消退，一句话不够")

    lineup("清理演示数据")
    for f in (DB, Path(str(DB) + "-wal"), Path(str(DB) + "-shm")):
        f.unlink(missing_ok=True)
    print("  已清理，不影响你自己的记忆库")


if __name__ == "__main__":
    main()
