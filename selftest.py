# -*- coding: utf-8 -*-
"""
selftest.py — 自动化验收 v0.2（30 项）

分五组：
  A. 基础行为（过滤、持久化）
  B. 情绪评判（两维模型：效价 × 唤醒度）
  C. 六因子重要性
  D. 分类型衰减
  E. 召回与状态（休眠、唤醒、钉住、别名）
  F. 可解释性
  G. 旧库迁移
"""

import sqlite3
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_core as mc  # noqa: E402
import scoring  # noqa: E402

DB = Path(__file__).parent / "data" / "_test.db"
OLD_DB = Path(__file__).parent / "data" / "_old.db"

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, bool(cond), detail))
    print(f"  {'✅' if cond else '❌'} {name}" + (f"    {detail}" if detail else ""))


def group(title: str) -> None:
    print(f"\n{title}")


def reset() -> None:
    for f in (DB, Path(str(DB) + "-wal"), Path(str(DB) + "-shm")):
        f.unlink(missing_ok=True)
    mc.connect(DB).close()


def main() -> int:
    reset()
    print("=" * 66)
    print("类人脑记忆引擎 v0.2 · 自动化验收")
    print("=" * 66)

    # ===================== A. 基础行为 =====================
    group("[A] 基础行为")
    check("语气词不入库", not mc.remember("好的", db_path=DB)["ok"])
    check("短句不入库", not mc.remember("嗯嗯", db_path=DB)["ok"])
    check("问句不入库（带问号）", not mc.remember("我讨厌什么？", db_path=DB)["ok"])
    check("问句不入库（无标点）", not mc.remember("我叫小林，你叫什么", db_path=DB)["ok"])

    mc.remember("我叫林小满，我讨厌香菜，闻到就想吐", db_path=DB)
    mc.remember("我女儿叫小满，今年五岁，在学钢琴", db_path=DB)
    mc.remember("今天加班到十点，累死了", db_path=DB)
    check("换新连接能读到全部记忆", len(mc.list_memories(db_path=DB)) == 3)

    # ===================== B. 情绪两维模型 =====================
    group("[B] 情绪评判（效价 × 唤醒度）")

    d = scoring.score_text("我特别愤怒")
    check("负情绪也有高冲击力", d["salience"] >= 0.5,
          f"salience={d['salience']}（v={d['valence']}, a={d['arousal']}）")

    d_hi = scoring.score_text("我特别激动")
    d_lo = scoring.score_text("我有点满足")
    check("高唤醒 > 低唤醒", d_hi["salience"] > d_lo["salience"],
          f"{d_hi['salience']} vs {d_lo['salience']}")

    d_calm = scoring.score_text("今天心情还算平静")
    check("平静几乎不留痕", d_calm["salience"] < 0.1, f"salience={d_calm['salience']}")

    d_neg = scoring.score_text("我不开心")
    check("否定能反转效价", d_neg["valence"] < 0,
          f"valence={d_neg['valence']}（{'不' + '开心'}）")

    d_up = scoring.score_text("我非常生气")
    d_down = scoring.score_text("我有点生气")
    check("程度副词调节唤醒度", d_up["arousal"] > d_down["arousal"],
          f"非常={d_up['arousal']} vs 有点={d_down['arousal']}")

    # ===================== C. 六因子 =====================
    group("[C] 六因子重要性")

    a1 = scoring.score_text("今天吃了火锅")
    a2 = scoring.score_text("我今天吃了火锅")
    check("自我参照加分", a2["importance"] > a1["importance"],
          f"{a1['importance']} → {a2['importance']}")

    b1 = scoring.score_text("陪女儿去医院")["breakdown"]["social"]
    b2 = scoring.score_text("去医院")["breakdown"]["social"]
    check("社会关系因子生效", b1 > b2, f"{b2} → {b1}")

    c1 = scoring.score_text("我第一次去北京")["breakdown"]["novelty"]
    check("新奇意外因子生效", c1 == 1.0, f"novelty={c1}")

    e1 = scoring.score_text("我特别焦虑")["breakdown"]["emotional"]
    check("情绪冲击因子生效", e1 >= 0.5, f"emotional={e1}")

    f1 = scoring.score_text("我叫张三")["breakdown"]["identity"]
    check("身份目标因子生效", f1 == 1.0, f"identity={f1}")

    g1 = scoring.score_text("昨天下午我去了一趟市中心的图书馆，借了三本书，还在门口碰到了老同学")["breakdown"]["detail"]
    check("细节丰富度因子生效", g1 >= 0.5, f"detail={g1}")

    # ===================== D. 分类型衰减 =====================
    group("[D] 分类型衰减（半衰期）")

    ident = scoring.score_text("我叫张三")
    event = scoring.score_text("昨天去了趟超市")
    check("身份类比事件类持久得多", ident["half_life"] > event["half_life"] * 50,
          f"身份 {ident['half_life']:.0f} 天 vs 事件 {event['half_life']:.0f} 天")

    strong = scoring.score_text("我特别生气")
    weak = scoring.score_text("我有点生气")
    check("强烈情绪事件比弱情绪状态持久", strong["half_life"] > weak["half_life"],
          f"{strong['half_life']:.0f} 天 vs {weak['half_life']:.0f} 天")

    # ===================== E. 类型识别 =====================
    group("[E] 记忆类型识别")
    cases = [
        ("我叫张三", "identity"),
        ("别问我前任的事，我不想聊", "boundary"),
        ("我想明年去学钢琴", "goal"),
        ("我习惯每天六点起床", "habit"),
        ("我讨厌香菜", "preference"),
    ]
    for text, expect in cases:
        got = scoring.score_text(text)["kind"]
        check(f"识别为 {expect}", got == expect, f"「{text}」→ {got}")

    # ===================== F. 重要度排序 =====================
    group("[F] 重要度排序是否合理")
    rows = mc.list_memories(db_path=DB)
    pref = next(r for r in rows if "香菜" in r["content"])
    daily = next(r for r in rows if "加班" in r["content"])
    check("偏好类 > 日常琐事", pref["importance"] > daily["importance"],
          f"{pref['importance']} vs {daily['importance']}")

    high = scoring.score_text("这是我第一次拿奖学金，太激动了")["importance"]
    low = scoring.score_text("今天有点累")["importance"]
    check("高情绪事件 > 平淡日常", high > low, f"{high} vs {low}")

    # ===================== G. 召回与状态 =====================
    group("[G] 召回与状态")
    items = mc.recall("我讨厌什么？", top_k=3, db_path=DB)
    check("提到讨厌 → 召回香菜", any("香菜" in i["content"] for i in items))
    check("召回数量受控", len(items) <= 3, f"{len(items)} 条")

    items = mc.recall("周末去哪玩比较好？", top_k=3, db_path=DB)
    check("无关话题不塞记忆", len(items) == 0, f"{len(items)} 条")

    before = mc.stats(db_path=DB)["total"]
    r = mc.remember("我叫林小满，我讨厌香菜，闻到就想吐", db_path=DB)
    check("重复内容强化而不重复插入",
          r["action"] == "strengthened" and mc.stats(db_path=DB)["total"] == before)

    mc.remember("我喜欢在雨天听爵士乐", db_path=DB)
    rows = mc.list_memories(db_path=DB)
    jazz = next(r for r in rows if "爵士" in r["content"])
    mc.set_status(jazz["id"], "dormant", db_path=DB)
    check("能转入休眠", mc.stats(db_path=DB)["dormant"] >= 1)

    items = mc.recall("周末去哪玩比较好？", top_k=5, db_path=DB)
    check("休眠记忆在无关话题下不出现", all("爵士" not in i["content"] for i in items))

    items = mc.recall("雨天听什么音乐好？", top_k=5, db_path=DB)
    hit = [i for i in items if "爵士" in i["content"]]
    check("相关线索命中休眠记忆", len(hit) == 1)
    check("被命中后自动唤醒", bool(hit and hit[0].get("woke")))
    check("唤醒后状态变 active", mc.stats(db_path=DB)["dormant"] == 0)

    mc.remember("我养了一只橘猫叫大福", db_path=DB)
    rows = mc.list_memories(db_path=DB)
    cat = next(r for r in rows if "大福" in r["content"])
    mc.set_pinned(cat["id"], True, db_path=DB)
    items = mc.recall("今天天气如何", top_k=5, db_path=DB)
    check("钉住的记忆无关话题也保留", any("大福" in i["content"] for i in items))

    mc.add_alias("香菜", "芫荽", db_path=DB)
    items = mc.recall("芫荽好吃吗", top_k=3, db_path=DB)
    check("同义词映射生效", any("香菜" in i["content"] for i in items))

    # ===================== H. 可解释性 =====================
    group("[H] 可解释性")
    rows = mc.list_memories(db_path=DB)
    target = next(r for r in rows if "香菜" in r["content"])
    text = mc.explain_memory(target["id"], db_path=DB)
    check("explain 输出基础分与合计", "基础分" in text and "合计" in text)
    keys = set(target["breakdown"].keys())
    check("明细含六个因子",
          {"self", "emotional", "social", "identity", "novelty", "detail"} <= keys,
          f"实际 {sorted(keys)}")

    # ===================== I. 旧库迁移 =====================
    group("[I] 旧库迁移（v0.1 → v0.2）")
    for f in (OLD_DB, Path(str(OLD_DB) + "-wal"), Path(str(OLD_DB) + "-shm")):
        f.unlink(missing_ok=True)
    c = sqlite3.connect(str(OLD_DB))
    c.executescript("""
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL DEFAULT 'default',
            content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fact',
            importance REAL NOT NULL DEFAULT 0.5, weight REAL NOT NULL DEFAULT 0.5,
            status TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0,
            trigger_terms TEXT NOT NULL DEFAULT '', emotion REAL NOT NULL DEFAULT 0,
            entity TEXT NOT NULL DEFAULT '', source_session TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_recalled TEXT,
            recall_count INTEGER NOT NULL DEFAULT 0
        );
    """)
    c.execute("INSERT INTO memories(content, importance, weight, created_at, updated_at, trigger_terms) "
              "VALUES ('我讨厌香菜', 0.75, 0.75, '2026-01-01T00:00:00+08:00', '2026-01-01T00:00:00+08:00', '香菜')")
    c.commit()
    c.close()
    old_rows = mc.list_memories(db_path=OLD_DB)
    check("旧库能读出", len(old_rows) == 1, f"{len(old_rows)} 条")
    check("自动补算评分明细", bool(old_rows[0]["breakdown"]),
          f"kind={old_rows[0]['kind']}")
    check("自动补算半衰期", old_rows[0]["half_life"] > 0, f"{old_rows[0]['half_life']:.0f} 天")

    # ===================== J. 情绪状态（日常疲惫） =====================
    group("[J] 情绪状态：日常疲惫也要记住，作为判断依据")
    m1 = scoring.score_text("我今天加班到十点，累死了")
    check("日常疲惫归为情绪状态", m1["kind"] == "mood", f"kind={m1['kind']}")
    check("状态持续性因子生效", m1["breakdown"].get("state") == 1.0,
          f"state={m1['breakdown'].get('state')}")
    check("日常疲惫不再被当低价值琐事", m1["importance"] >= 0.60,
          f"importance={m1['importance']}（v0.1 只有 0.42）")

    m1b = scoring.score_text("今天加班到十点，累死了")["importance"]
    m1c = scoring.score_text("明天要交周报，还没写完")["importance"]
    check("就算不带「我」，疲惫也比普通待办重", m1b > m1c,
          f"疲惫 {m1b} vs 待办 {m1c}")

    m2 = scoring.score_text("我特别焦虑，感觉要崩溃了")
    check("强烈情绪仍归为情绪事件", m2["kind"] == "emotion", f"kind={m2['kind']}")

    m3 = scoring.score_text("今天心情还算平静")
    check("平静归为情绪状态", m3["kind"] == "mood", f"kind={m3['kind']}")

    trend = mc.recent_mood_summary(days=30, db_path=DB)
    check("能汇总近期情绪轨迹", "情绪记录" in trend and "累" in trend,
          trend.split("\n")[0])

    ctx = mc.build_context("我最近状态怎么样", db_path=DB)
    check("上下文能带上近期状态", "【近期状态】" in ctx)

    # ===================== K. 时间维度 =====================
    group("[K] 时间维度：连续低迷、余波期、心结")
    MD = Path(__file__).parent / "data" / "_mood.db"
    for f in (MD, Path(str(MD) + "-wal"), Path(str(MD) + "-shm")):
        f.unlink(missing_ok=True)

    def backdate(mid: int, days_ago: int) -> None:
        d = (mc.now_dt() - timedelta(days=days_ago)).isoformat(timespec="seconds")
        c = mc.connect(MD)
        c.execute("UPDATE memories SET created_at=? WHERE id=?", (d, mid))
        c.commit()
        c.close()

    # 情绪状态不去重，所以同一句话可以记录多个时间点
    for days_ago in (0, 1, 2):
        r = mc.remember("我今天很难过", db_path=MD)
        backdate(r["id"], days_ago)
    for days_ago in (3, 4, 5):
        r = mc.remember("我今天挺开心", db_path=MD)
        backdate(r["id"], days_ago)

    a = mc.analyze_mood(days=14, db_path=MD)
    check("情绪状态不被去重", a["total"] == 6, f"{a['total']} 条（6 个时间点）")
    check("能识别连续低迷", a["consecutive_low"] == 3, f"{a['consecutive_low']} 天")
    check("能判断趋势走低", a["trend"] == "持续走低", f"{a['trend']}，变化 {a['delta']:+.2f}")
    check("按天聚合有 6 天", len(a["daily"]) == 6, f"{len(a['daily'])} 天")

    # 余波期
    hard = scoring.score_text("我被老板当众羞辱，特别羞耻")
    check("高冲击事件有余波期", hard["aftermath"] >= 5, f"{hard['aftermath']} 天")
    mild = scoring.score_text("我今天有点烦")
    check("低冲击事件没有余波", mild["aftermath"] == 0, f"{mild['aftermath']} 天")

    r = mc.remember("我被老板当众羞辱，特别羞耻", db_path=MD)
    a2 = mc.analyze_mood(days=30, db_path=MD)
    check("余波中的事件能被列出", len(a2["aftermath"]) >= 1,
          f"{len(a2['aftermath'])} 条")

    # 心结
    g = scoring.score_text("我还在生他的气，好几天没理他了")
    check("赌气识别为心结", g["kind"] == "grudge", f"kind={g['kind']}")
    check("心结几乎不衰减", g["half_life"] >= 30000, f"{g['half_life']:.0f} 天")

    mg = mc.remember("我还在生他的气，好几天没理他了", db_path=MD)
    a3 = mc.analyze_mood(days=30, db_path=MD)
    check("未化解的心结被列出", len(a3["unresolved"]) == 1,
          f"{a3['unresolved'][0]['content'] if a3['unresolved'] else '无'}")

    r = mc.remember("算了，都过去了，不气了", db_path=MD)
    check("化解表达记为信号而非直接清零", r.get("action") == "resolve_signal",
          str(r.get("action")))
    a4 = mc.analyze_mood(days=30, db_path=MD)
    check("一句话不足以让心结消失", len(a4["unresolved"]) == 1,
          f"{len(a4['unresolved'])} 条")
    check("化解表达确实降低了强度",
          bool(a4["unresolved"]) and a4["unresolved"][0]["strength"] < 0.9,
          f"强度 {a4['unresolved'][0]['strength'] if a4['unresolved'] else 'N/A'}")

    # 再多几次表达 + 时间推进，多路证据齐了才算过去
    mc.remember("真的想开了", db_path=MD)
    mc.remember("气消了，翻篇了", db_path=MD)
    c = mc.connect(MD)
    c.execute("UPDATE memories SET created_at=? WHERE kind='grudge'",
              ((mc.now_dt() - timedelta(days=12)).isoformat(timespec="seconds"),))
    c.commit()
    c.close()
    a5 = mc.analyze_mood(days=30, db_path=MD)
    check("多路证据齐了心结才消失", len(a5["unresolved"]) == 0,
          f"{len(a5['unresolved'])} 条")

    # ===================== L. 记忆生命周期 =====================
    group("[L] 记忆生命周期：冲突取代、编辑、删除、导入导出")
    LD = Path(__file__).parent / "data" / "_life.db"
    for f in (LD, Path(str(LD) + "-wal"), Path(str(LD) + "-shm")):
        f.unlink(missing_ok=True)

    r1 = mc.remember("我讨厌香菜，闻到就想吐", db_path=LD)
    check("先记下讨厌香菜", r1["ok"] and r1["kind"] == "preference")

    r2 = mc.remember("我现在爱吃香菜了，真香", db_path=LD)
    rows = mc.list_memories(db_path=LD)
    old = [r for r in rows if "讨厌" in r["content"]]
    new = [r for r in rows if "爱吃" in r["content"]]
    check("态度反转时旧记忆被取代",
          bool(old) and old[0]["status"] == "superseded",
          f"status={old[0]['status'] if old else 'N/A'}")
    check("新记忆正常写入", bool(new) and new[0]["status"] == "active")

    items = mc.recall("香菜", top_k=5, db_path=LD)
    check("被取代的不再被召回", all("讨厌" not in i["content"] for i in items))

    r3 = mc.remember("我养了一只猫", db_path=LD)
    mc.update_memory(r3["id"], content="我养了一只橘猫叫大福，特别黏人", db_path=LD)
    updated = next(r for r in mc.list_memories(db_path=LD) if r["id"] == r3["id"])
    check("编辑后内容更新", "大福" in updated["content"])
    check("编辑后重新评分", updated["importance"] >= r3["importance"],
          f"{r3['importance']} → {updated['importance']}")

    mc.delete_memory(r3["id"], db_path=LD)
    got = next(r for r in mc.list_memories(db_path=LD) if r["id"] == r3["id"])
    check("软删除后状态为 deleted", got["status"] == "deleted")
    items = mc.recall("大福", top_k=5, db_path=LD)
    check("软删除后不再召回", all("大福" not in i["content"] for i in items))

    mc.delete_memory(r3["id"], hard=True, db_path=LD)
    check("硬删除后彻底消失",
          all(r["id"] != r3["id"] for r in mc.list_memories(db_path=LD)))

    exp = Path(__file__).parent / "data" / "_export.json"
    mc.export_json(exp, db_path=LD)
    check("导出为 JSON 成功", exp.exists() and exp.stat().st_size > 0,
          f"{exp.stat().st_size} 字节")

    LD2 = Path(__file__).parent / "data" / "_life2.db"
    for f in (LD2, Path(str(LD2) + "-wal"), Path(str(LD2) + "-shm")):
        f.unlink(missing_ok=True)
    res = mc.import_json(exp, db_path=LD2)
    check("导入成功", res["imported"] >= 2, f"{res['imported']} 条")
    items = mc.recall("香菜", top_k=5, db_path=LD2)
    check("导入后能正常召回", len(items) >= 1, f"{len(items)} 条")

    # ===================== 汇总 =====================
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print("\n" + "=" * 66)
    print(f"结果：{passed}/{total} 通过")
    if passed != total:
        print("失败项：")
        for name, ok, detail in results:
            if not ok:
                print(f"  - {name}  {detail}")
    print("=" * 66)
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
