# -*- coding: utf-8 -*-
"""
tune.py — 召回参数自动调优

没有人工标注数据时，用记忆库自己构造两类评估：

1. 精确召回（测相关性）
   用记忆内容的前半段当 query，看能不能召回它自己。

2. 主次排序（测重要度权重）
   同一个实体词被多条记忆共享时（比如很多条都提到「香菜」），
   query 只给这个词，看最重要的那条是否排在第一位。
   这类样本才会让 W_IMP 起作用。

3. 噪声抑制（测阈值）
   无关对话不应该召回任何记忆。

用法：
    python tune.py                 # 合成库（200 条）
    python tune.py --db 你的库.db   # 用真实记忆库

说明：它只能调「召回质量」，调不了「像不像人」这种主观判断。
"""

import argparse
import random
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_core as mc  # noqa: E402

NEGATIVES = [
    "今天天气怎么样",
    "周末去哪玩比较好",
    "推荐一部电影",
    "最近有什么新闻",
    "明天要开会吗",
]

NAMES = ["林小满", "张三", "李四", "王五"]
THINGS = ["香菜", "葱", "猫", "狗", "钢琴", "咖啡", "火锅", "跑步", "游泳", "电影"]
FEELS = ["很累", "特别开心", "有点烦", "挺难过", "很焦虑", "心情不错", "提不起劲"]
PEOPLE = ["女儿", "儿子", "妈妈", "爸爸", "老公", "朋友", "同事", "老板"]
PLACES = ["公司", "学校", "家里", "公园", "商场"]


def make_corpus(n: int = 200) -> list[str]:
    out = []
    for i in range(n):
        r = random.Random(i * 7919)
        style = i % 7
        if style == 0:
            out.append(f"我叫{r.choice(NAMES)}{i}号，我{r.choice(['喜欢', '讨厌'])}{r.choice(THINGS)}")
        elif style == 1:
            out.append(f"我{r.choice(PEOPLE)}今天{r.choice(FEELS)}")
        elif style == 2:
            out.append(f"我今天在{r.choice(PLACES)}处理第{i}号项目，忙到很晚")
        elif style == 3:
            out.append(f"我{['喜欢', '习惯'][i % 2]}每天六点去{r.choice(PLACES)}")
        elif style == 4:
            out.append(f"我跟{r.choice(PEOPLE)}吵架了，第{i}次了，气死了")
        elif style == 5:
            out.append(f"我想明年去学{r.choice(THINGS)}，第{i}个计划")
        else:
            out.append(f"我养了一只{r.choice(THINGS)}叫{i}号，特别黏人")
    return out


def build_exact_set(db_path: Path, limit: int = 40) -> list[dict]:
    """精确召回样本：用内容前半段当 query。"""
    out = []
    for r in mc.list_memories(db_path=db_path, limit=300):
        content = (r.get("content") or "").strip()
        if len(content) < 8:
            continue
        cut = min(len(content) - 2, max(6, len(content) // 2))
        out.append({"query": content[:cut], "target_id": r["id"]})
        if len(out) >= limit:
            break
    return out


def build_rank_set(db_path: Path, limit: int = 40) -> list[dict]:
    """主次样本：同一实体词共享时，最重要的那条应该排第一。"""
    conn = mc.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT id, trigger_terms, importance FROM memories WHERE status='active'"
        ).fetchall()
    finally:
        conn.close()

    groups: dict[str, list] = defaultdict(list)
    for r in rows:
        for t in (r["trigger_terms"] or "").split(","):
            if 2 <= len(t) <= 6 and t not in mc.STOP_GRAMS:
                groups[t].append(r)

    out = []
    for term, rs in groups.items():
        if len(rs) < 2:
            continue
        best = max(rs, key=lambda x: x["importance"])
        out.append({"query": term, "target_id": best["id"], "competitors": len(rs)})
        if len(out) >= limit:
            break
    return out


def evaluate(db_path: Path, weights: dict, threshold: float,
             exact: list[dict], rank: list[dict]) -> tuple[float, float, float, float]:
    hit = 0
    for p in exact:
        items = mc.recall(p["query"], top_k=3, db_path=db_path,
                          touch=False, weights=weights, threshold=threshold)
        if any(i["id"] == p["target_id"] for i in items):
            hit += 1
    exact_rate = hit / len(exact) if exact else 0.0

    rank_hit = 0
    for p in rank:
        items = mc.recall(p["query"], top_k=1, db_path=db_path,
                          touch=False, weights=weights, threshold=threshold)
        if items and items[0]["id"] == p["target_id"]:
            rank_hit += 1
    rank_rate = rank_hit / len(rank) if rank else 0.0

    noise = 0
    for q in NEGATIVES:
        items = mc.recall(q, top_k=3, db_path=db_path,
                          touch=False, weights=weights, threshold=threshold)
        noise += len(items)
    max_noise = len(NEGATIVES) * 3
    precision = 1 - noise / max_noise if max_noise else 1.0

    combined = 0.35 * exact_rate + 0.40 * rank_rate + 0.25 * precision
    return exact_rate, rank_rate, precision, combined


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="", help="用自己的记忆库；不填则用合成库")
    args = ap.parse_args()

    if args.db:
        db_path = Path(args.db)
        if not db_path.exists():
            print(f"找不到库：{db_path}")
            return 1
        print(f"用你的库评估：{db_path}")
    else:
        db_path = Path(__file__).parent / "data" / "_tune.db"
        for f in (db_path, Path(str(db_path) + "-wal"), Path(str(db_path) + "-shm")):
            f.unlink(missing_ok=True)
        print("用合成库评估（200 条，覆盖各种类型）")
        for s in make_corpus(200):
            mc.remember(s, db_path=db_path)

    exact = build_exact_set(db_path)
    rank = build_rank_set(db_path)
    if len(exact) < 5:
        print(f"可评估的记忆太少（{len(exact)} 条），先多记点东西再调")
        return 1
    print(f"评估集：精确 {len(exact)} 条 / 主次 {len(rank)} 条 / 噪声 {len(NEGATIVES)} 条")

    grid = []
    for rel in (0.30, 0.35, 0.40, 0.45, 0.50):
        for imp in (0.15, 0.20, 0.25, 0.30, 0.40):
            grid.append({"rel": rel, "imp": imp, "rec": 0.12,
                         "weight": 0.10, "salience": 0.08})

    print()
    print(f"{'相关性':<8}{'重要度':<8}{'精确召回':<10}{'主次排序':<10}{'精确率':<9}{'综合':<8}")
    print("-" * 60)
    rows = []
    for w in grid:
        e, r, p, c = evaluate(db_path, w, mc.REL_MIN, exact, rank)
        rows.append((w, e, r, p, c))
    rows.sort(key=lambda x: x[4], reverse=True)

    for w, e, r, p, c in rows[:12]:
        mark = "  ← 当前" if (w["rel"] == 0.45 and w["imp"] == 0.25) else ""
        print(f"{w['rel']:<8.2f}{w['imp']:<8.2f}{e:<10.3f}{r:<10.3f}{p:<9.3f}{c:<8.3f}{mark}")

    best = rows[0]
    cur = next(r for r in rows if r[0]["rel"] == 0.45 and r[0]["imp"] == 0.25)
    print()
    print(f"当前（0.45 / 0.25）：精确 {cur[1]:.3f}，主次 {cur[2]:.3f}，噪声 {cur[3]:.3f}，综合 {cur[4]:.3f}")
    print(f"最佳（{best[0]['rel']:.2f} / {best[0]['imp']:.2f}）：精确 {best[1]:.3f}，主次 {best[2]:.3f}，噪声 {best[3]:.3f}，综合 {best[4]:.3f}")

    # 自检：故意用离谱参数，确认评估器真的在起作用
    bad = {"rel": 0.0, "imp": 0.0, "rec": 0.12, "weight": 0.10, "salience": 0.08}
    be, br, _, _ = evaluate(db_path, bad, mc.REL_MIN, exact, rank)
    print()
    print(f"自检（把相关性权重设为 0）：精确召回 {be:.3f}，主次排序 {br:.3f}")
    print("  → 评估器有效" if be < 0.5 else "  → 警告：评估器可能失效")

    if best[4] > cur[4] + 0.01:
        print("建议：按最佳组合调高/调低对应权重（改 memory_core.py 里的 W_REL / W_IMP）")
    else:
        print("说明：这组网格参数结果接近，不代表参数不重要——")
        print("      合成数据里「重要度」和「权重」初始同值，排序方向一致，所以放大权重不改变先后。")
        print("      用 --db 传你自己的真实记忆库（用久了权重会分化）才测得出差异。")

    if not args.db:
        for f in (db_path, Path(str(db_path) + "-wal"), Path(str(db_path) + "-shm")):
            f.unlink(missing_ok=True)
        print("\n（合成库已清理）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
