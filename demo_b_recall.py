# -*- coding: utf-8 -*-
"""
demo_b_recall.py — 模拟「第二段对话」（会话 B），全新进程

关键验收：
1. 进程完全重启后仍能读到会话 A 的记忆（跨会话）
2. 提到相关话题才召回，不相关话题不塞无关记忆
3. 只注入少量记忆，比全量注入省很多 token
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_core as mc  # noqa: E402

DB = Path(__file__).parent / "data" / "demo.db"


def est_tokens(s: str) -> int:
    """粗估 token：中文约 1.6 字/token。"""
    return max(1, int(len(s) / 1.6))


def main() -> None:
    if not DB.exists():
        print("找不到 data/demo.db，请先运行 demo_a_write.py")
        raise SystemExit(1)

    print("=" * 62)
    print("会话 B：全新进程启动，用户换了话题")
    print("=" * 62)

    all_mem = mc.list_memories(db_path=DB)
    full_text = "\n".join(m["content"] for m in all_mem)
    full_tokens = est_tokens(full_text)
    print(f"库里共有 {len(all_mem)} 条记忆；如果全部塞进上下文约 {full_tokens} tokens")
    print()

    queries = [
        "我讨厌什么？",
        "我女儿多大了？",
        "今天好累啊",
        "周末去哪玩比较好？",
    ]

    injected_total = 0
    for q in queries:
        items = mc.recall(q, top_k=3, db_path=DB)
        rendered = mc.render_for_prompt(items)
        tok = est_tokens(rendered) if rendered else 0
        injected_total += tok
        print(f"用户：{q}")
        if items:
            for it in items:
                woke = "  ← 从休眠中被唤醒" if it.get("woke") else ""
                print(f"    · 分数{it['score']:.3f} 相关{it['relevance']:.2f} | {it['content']}{woke}")
            print(f"    实际注入 ≈ {tok} tokens")
        else:
            print("    （无相关记忆，不注入任何内容）")
        print()

    print("-" * 62)
    print(f"四轮对话累计注入 ≈ {injected_total} tokens")
    print(f"全量注入则需要 ≈ {full_tokens * 4} tokens")
    if injected_total:
        print(f"本段对话节省 ≈ {100 - injected_total * 100 // max(1, full_tokens * 4)}%")
    print()
    print("会话 B 结束。注意：会话 A 写的记忆还在，只是没被提起的不会冒出来。")


if __name__ == "__main__":
    main()
