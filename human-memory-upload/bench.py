# -*- coding: utf-8 -*-
"""
bench.py — 规模与性能验证

写入 1 万条记忆，测召回耗时，看规模上去之后还能不能用。
"""

import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_core as mc  # noqa: E402

DB = Path(__file__).parent / "data" / "_bench.db"

SUBJECTS = ["香菜", "葱", "猫", "狗", "钢琴", "跑步", "加班", "旅行", "咖啡", "电影",
            "游戏", "读书", "游泳", "蛋糕", "火锅"]
VERBS = ["喜欢", "讨厌", "习惯", "想学", "害怕", "爱吃"]
PLACES = ["公司", "学校", "家里", "公园", "商场", "医院"]
TIMES = ["今天", "昨天", "上周", "去年", "最近"]


def gen_sentence(i: int) -> str:
    """每条都带唯一编号，避免被去重机制合并，确保真的测到目标规模。"""
    rnd = random.Random(i * 7919)
    return (
        f"{rnd.choice(TIMES)}我在{rnd.choice(PLACES)}遇到第{i}号{rnd.choice(SUBJECTS)}，"
        f"聊了{rnd.randint(1, 9)}分钟，感觉{rnd.choice(['挺开心', '有点累', '很烦躁', '很平静', '有点焦虑'])}"
    )


def main() -> None:
    for f in (DB, Path(str(DB) + "-wal"), Path(str(DB) + "-shm")):
        f.unlink(missing_ok=True)

    n = 10000
    print("=" * 60)
    print(f"规模测试：写入 {n} 条记忆")
    print("=" * 60)

    t0 = time.perf_counter()
    for i in range(n):
        mc.remember(gen_sentence(i), db_path=DB)
    write_s = time.perf_counter() - t0
    print(f"  写入耗时：{write_s:.1f} 秒（{write_s / n * 1000:.1f} ms/条）")

    s = mc.stats(db_path=DB)
    print(f"  库内条数：{s['total']}")

    size_mb = DB.stat().st_size / 1024 / 1024
    print(f"  库文件：{size_mb:.2f} MB（约 {size_mb * 1024 / max(1, s['total']) * 1000:.1f} KB/条）")

    print()
    print("召回耗时（各测 20 次取平均）")
    queries = ["我讨厌什么", "我喜欢香菜吗", "最近加班很累", "养了只猫", "旅行"]
    for q in queries:
        t0 = time.perf_counter()
        for _ in range(20):
            mc.recall(q, top_k=5, db_path=DB, touch=False)
        avg_ms = (time.perf_counter() - t0) / 20 * 1000
        print(f"  「{q}」  {avg_ms:6.1f} ms")

    print()
    print("情绪分析耗时")
    t0 = time.perf_counter()
    mc.analyze_mood(days=14, db_path=DB)
    print(f"  analyze_mood  {(time.perf_counter() - t0) * 1000:6.1f} ms")

    t0 = time.perf_counter()
    mc.recent_mood_summary(days=14, db_path=DB)
    print(f"  mood_summary  {(time.perf_counter() - t0) * 1000:6.1f} ms")

    for f in (DB, Path(str(DB) + "-wal"), Path(str(DB) + "-shm")):
        f.unlink(missing_ok=True)
    print("\n（测试库已清理）")


if __name__ == "__main__":
    main()
