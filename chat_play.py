# -*- coding: utf-8 -*-
"""
chat_play.py — 交互式体验模式

真的打字聊天，看它怎么记、什么时候想起、什么时候不冒出来。

运行：python chat_play.py
退出：输入 /quit 或按 Ctrl+C

支持多角色：/profile 名字 切换（各自一套记忆，互不干扰）
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_core as mc  # noqa: E402

def _db() -> Path:
    env = os.environ.get("MEMORY_DB")
    if env:
        return Path(env)
    local = Path(__file__).parent / "data" / "play.db"
    if local.parent.exists():
        return local
    return Path.home() / ".human-memory" / "play.db"


DB = _db()

HELP = """
可用命令：
  /list          看当前角色的记忆库（含休眠/被取代/已删除）
  /stats         看统计
  /mood          看最近 7 天的情绪轨迹
  /explain 序号  看这条记忆为什么是这个重要度
  /resolve 序号  人工强制标记心结已化解
  /pin 序号      钉住（永不沉底，手动抢救）
  /sleep 序号    让它休眠（不删除）
  /wake 序号     手动唤醒
  /delete 序号   软删除（还能查到）
  /profile       看当前角色；/profile 名字 切换角色
  /export 文件名 把记忆导出成 JSON
  /help          看这个帮助
  /quit          退出

直接打字就是聊天：它会先"想起"相关记忆，再判断这句话值不值得记。
"""


def show_list(profile: str) -> None:
    rows = mc.list_memories(profile=profile, db_path=DB, limit=100)
    if not rows:
        print("  （记忆库还是空的）")
        return
    for r in rows:
        flag = "钉住" if r["pinned"] else r["status"]
        label = r.get("kind_label", r["kind"])
        emo = f" 情绪{r['salience']:.2f}" if r.get("salience", 0) >= 0.05 else ""
        print(f"  #{r['id']} [{flag}] {label}·重要{r['importance']:.2f}{emo} {r['age']} | {r['content']}")


def main() -> None:
    if "--check" in sys.argv:
        print("chat_play check OK")
        return

    profile = "default"

    print("=" * 58)
    print(" 类人脑记忆 · 体验模式")
    print(" 直接打字聊天。输入 /help 看命令，/quit 退出。")
    print("=" * 58)
    print(" 提示：先说几句关于你自己的话，比如")
    print("       我叫小林，我讨厌香菜；我女儿五岁")
    print("       然后聊点别的，最后再问：我讨厌什么")
    print("=" * 58)
    print()

    while True:
        try:
            line = input(f"[{profile}] 你：").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见。")
            break
        if not line:
            continue
        low = line.lower()

        if low in ("/quit", "/exit", "退出", "再见"):
            print("再见。")
            break
        if low == "/help":
            print(HELP)
            continue
        if low == "/list":
            show_list(profile)
            continue
        if low == "/stats":
            print("  ", mc.stats(profile=profile, db_path=DB))
            continue
        if low == "/mood":
            text = mc.recent_mood_summary(days=7, profile=profile, db_path=DB)
            print("  " + text.replace("\n", "\n  "))
            continue
        if low.startswith("/profile"):
            parts = line.split()
            if len(parts) == 1:
                print(f"  当前角色：{profile}")
            else:
                profile = parts[1]
                print(f"  已切换到角色：{profile}（各自一套记忆）")
            continue
        if low.startswith(("/explain ", "/pin ", "/sleep ", "/wake ", "/delete ", "/resolve ")):
            cmd, _, arg = line.partition(" ")
            try:
                mid = int(arg.strip())
            except ValueError:
                print(f"  用法：{cmd} 序号")
                continue
            if cmd == "/explain":
                print(mc.explain_memory(mid, db_path=DB))
            elif cmd == "/pin":
                print("  ", mc.set_pinned(mid, True, db_path=DB))
            elif cmd == "/sleep":
                print("  ", mc.set_status(mid, "dormant", db_path=DB))
            elif cmd == "/wake":
                print("  ", mc.set_status(mid, "active", db_path=DB))
            elif cmd == "/delete":
                print("  ", mc.delete_memory(mid, db_path=DB))
            elif cmd == "/resolve":
                print("  ", mc.set_resolved(mid, True, db_path=DB))
            continue
        if low.startswith("/export "):
            name = line.split(" ", 1)[1].strip()
            out = Path(__file__).parent / "data" / name
            print("  ", mc.export_json(out, profile=profile, db_path=DB))
            continue

        # 1) 先说出口的话，先看它能不能"想起"相关的事
        items = mc.recall(line, top_k=3, profile=profile, db_path=DB)
        if items:
            print("  [想起]")
            for it in items:
                woke = "  ← 刚从休眠中被唤醒" if it.get("woke") else ""
                print(f"    · {it['content']}   (相关 {it['relevance']:.2f}){woke}")
        else:
            print("  [记忆库里没有相关的]")

        # 2) 再判断这句话值不值得记
        r = mc.remember(line, profile=profile, db_path=DB)
        if r.get("ok"):
            if r["action"] == "strengthened":
                print(f"  [加深] 这条已经有印象了，刚才又深了一点（#{r['id']}）")
            elif r["action"] == "resolve_signal":
                print(f"  [化解信号] 影响 {r['affected']} 个心结，但还没清零")
            else:
                label = mc.scoring.KIND_LABEL.get(r["kind"], r["kind"])
                emo = f"，情绪冲击 {r['salience']:.2f}" if r.get("salience", 0) >= 0.05 else ""
                print(f"  [记住] #{r['id']} {label}·重要度 {r['importance']:.2f}{emo}")
        else:
            print(f"  [没记] {r['reason']}")
        print()


if __name__ == "__main__":
    main()
