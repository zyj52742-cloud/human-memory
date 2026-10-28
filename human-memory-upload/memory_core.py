# -*- coding: utf-8 -*-
"""
memory_core.py — 类人脑记忆引擎 v0.2

相对 v0.1 的变化：
1. 评判标准从"规则加分表"换成 scoring.py 的六因子模型（有心理学依据）
2. 情绪从单值改成 效价 × 唤醒度 两维，记忆强度看 |效价|×唤醒度
3. 衰减按记忆类型分开（身份十年、偏好一年、事件十天），情绪冲击强的翻倍
4. 每条记忆可解释：存了评分明细，能查"为什么它是这个分"
5. 旧库自动迁移，原有数据不丢

仍然：零第三方依赖、跨会话、休眠可唤醒、手动可抢救。
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import extractor
import scoring

# --------------------------------------------------------------------------
# 路径与时间
# --------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent


def _default_db() -> Path:
    """源码目录下跑就用本地 data/；安装成包之后用用户目录。"""
    env = os.environ.get("MEMORY_DB")
    if env:
        return Path(env)
    local_dir = HERE / "data"
    if local_dir.exists():
        return local_dir / "memory.db"
    return Path.home() / ".human-memory" / "memory.db"


DEFAULT_DB = _default_db()

CST = timezone(timedelta(hours=8))


def now_dt() -> datetime:
    return datetime.now(CST)


def now_iso() -> str:
    return now_dt().isoformat(timespec="seconds")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=CST)
    except ValueError:
        return None


def human_age(iso: str | None) -> str:
    d = parse_iso(iso)
    if not d:
        return "未知时间"
    days = (now_dt() - d).total_seconds() / 86400.0
    if days < 0.04:
        return "刚刚"
    if days < 1:
        return f"{int(days * 24)}小时前"
    if days < 30:
        return f"{int(days)}天前"
    if days < 365:
        return f"{int(days / 30)}个月前"
    return f"{days / 365:.1f}年前"


# --------------------------------------------------------------------------
# 分词
# --------------------------------------------------------------------------

STOP_CHARS = set(
    "的了是在和与及也就都而及其之于吗呢吧啊呀哦嗯哈这那哪什么怎么如何是否"
    "可以我们你们他们她他它我你您一有不没个些让被把给对向从到很太更最"
)
STOP_GRAMS = {
    "什么", "怎么", "如何", "是否", "可以", "我们", "你们", "他们", "这个", "那个",
    "还是", "就是", "没有", "一个", "这样", "那样", "然后", "因为", "所以", "但是",
    "如果", "现在", "今天", "明天", "昨天", "时候", "知道", "觉得", "应该", "可能",
    "自己", "大家", "一下", "一点", "有点", "真的", "非常", "比较", "已经", "一直",
}

_ASCII_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9_]{1,}|[0-9]+")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")

# 情绪单字：中文 2-gram 会把「累/怕/烦」这类单字切没，单独补进索引
# 只收几乎不会出现在普通词里的字，避免「天气」的「气」、「爱好」的「爱」误命中
EMOTION_CHARS = set("累饿疼怕烦恨哭恼怒焦急忧羞悔爽苦")


def tokenize(text: str) -> set[str]:
    text = (text or "").lower()
    toks: set[str] = set(_ASCII_RE.findall(text))
    for seg in _CJK_RE.findall(text):
        if len(seg) == 1:
            if seg not in STOP_CHARS:
                toks.add(seg)
            continue
        for i in range(len(seg) - 1):
            g = seg[i:i + 2]
            if g in STOP_GRAMS:
                continue
            if g[0] in STOP_CHARS and g[1] in STOP_CHARS:
                continue
            toks.add(g)
        for ch in seg:
            if ch in EMOTION_CHARS:
                toks.add(ch)
    return toks


# --------------------------------------------------------------------------
# 噪声判断
# --------------------------------------------------------------------------

NOISE_ONLY = {"嗯", "哦", "好", "好的", "好吧", "行", "哈哈", "哈哈哈", "在吗",
              "你好", "谢谢", "收到", "ok", "okay", "嗯嗯", "对对"}


def is_noise(text: str) -> bool:
    t = (text or "").strip()
    if len(t) < 4:
        return True
    return t.lower() in NOISE_ONLY


OBJECT_RE = re.compile(
    r"(?:喜欢|讨厌|爱吃|不爱吃|最怕|受不了|过敏|养了?|叫|住在|工作在)([\u4e00-\u9fffA-Za-z0-9]{1,10})"
)


def extract_trigger_terms(text: str) -> list[str]:
    terms: list[str] = []
    for m in OBJECT_RE.finditer(text):
        t = m.group(1).strip()
        if t and t not in STOP_GRAMS:
            terms.append(t)
    grams = [g for g in tokenize(text) if len(g) == 2 and g not in STOP_GRAMS]
    for g in grams[:8]:
        if g not in terms:
            terms.append(g)
    seen, out = set(), []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out[:12]


# --------------------------------------------------------------------------
# 数据库
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    profile        TEXT    NOT NULL DEFAULT 'default',
    content        TEXT    NOT NULL,
    kind           TEXT    NOT NULL DEFAULT 'fact',
    importance     REAL    NOT NULL DEFAULT 0.25,
    weight         REAL    NOT NULL DEFAULT 0.25,
    status         TEXT    NOT NULL DEFAULT 'active',
    pinned         INTEGER NOT NULL DEFAULT 0,
    trigger_terms  TEXT    NOT NULL DEFAULT '',
    emotion        REAL    NOT NULL DEFAULT 0.0,
    entity         TEXT    NOT NULL DEFAULT '',
    source_session TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    last_recalled  TEXT,
    recall_count   INTEGER NOT NULL DEFAULT 0,
    valence        REAL    NOT NULL DEFAULT 0.0,
    arousal        REAL    NOT NULL DEFAULT 0.0,
    salience       REAL    NOT NULL DEFAULT 0.0,
    decay_class    TEXT    NOT NULL DEFAULT 'fact',
    half_life      REAL    NOT NULL DEFAULT 120.0,
    aftermath      REAL    NOT NULL DEFAULT 0.0,
    resolved       INTEGER NOT NULL DEFAULT 0,
    resolve_signals INTEGER NOT NULL DEFAULT 0,
    breakdown      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mem_profile_status ON memories(profile, status);
CREATE INDEX IF NOT EXISTS idx_mem_profile_kind_status ON memories(profile, kind, status);

CREATE TABLE IF NOT EXISTS aliases (
    canonical TEXT NOT NULL,
    alias     TEXT NOT NULL,
    PRIMARY KEY (canonical, alias)
);

-- 倒排索引：term -> memory_id，让召回不用扫全库
CREATE TABLE IF NOT EXISTS memory_terms (
    term      TEXT    NOT NULL,
    memory_id INTEGER NOT NULL,
    profile   TEXT    NOT NULL,
    PRIMARY KEY (term, memory_id, profile)
);
CREATE INDEX IF NOT EXISTS idx_terms_lookup ON memory_terms(profile, term);

CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id  INTEGER,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
"""

# v0.1 -> v0.2 需要补的列
NEW_COLUMNS = [
    ("valence", "REAL NOT NULL DEFAULT 0"),
    ("arousal", "REAL NOT NULL DEFAULT 0"),
    ("salience", "REAL NOT NULL DEFAULT 0"),
    ("decay_class", "TEXT NOT NULL DEFAULT 'fact'"),
    ("half_life", "REAL NOT NULL DEFAULT 120"),
    ("aftermath", "REAL NOT NULL DEFAULT 0"),
    ("resolved", "INTEGER NOT NULL DEFAULT 0"),
    ("resolve_signals", "INTEGER NOT NULL DEFAULT 0"),
    ("breakdown", "TEXT NOT NULL DEFAULT ''"),
]


_INITIALIZED: set[str] = set()


def _tables_exist(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
    ).fetchone()
    return row is not None


def connect(db_path: str | Path | None = None) -> sqlite3.Connection:
    path = Path(db_path) if db_path else DEFAULT_DB
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=15)
    conn.row_factory = sqlite3.Row
    key = str(path.resolve())
    # 建表/迁移每个进程只做一次；但文件被删掉要能重建（否则同进程删库会崩）
    if key not in _INITIALIZED or not _tables_exist(conn):
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        _migrate(conn)
        _ensure_terms_index(conn)
        _INITIALIZED.add(key)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """给 v0.1 的旧库补列，原有记忆不丢。"""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(memories)")}
    added = False
    for name, ddl in NEW_COLUMNS:
        if name not in cols:
            conn.execute(f"ALTER TABLE memories ADD COLUMN {name} {ddl}")
            added = True
    if added:
        # 旧数据补算相似度与衰减类型
        for row in conn.execute("SELECT id, content, kind FROM memories WHERE breakdown=''"):
            try:
                d = scoring.score_text(row["content"])
                conn.execute(
                    "UPDATE memories SET valence=?, arousal=?, salience=?, decay_class=?, half_life=?,"
                    " aftermath=?, breakdown=? WHERE id=?",
                    (d["valence"], d["arousal"], d["salience"], d["decay_class"],
                     d["half_life"], d["aftermath"],
                     json.dumps(d["breakdown"], ensure_ascii=False), row["id"]),
                )
            except Exception:
                pass
        conn.commit()


def _index_terms(conn: sqlite3.Connection, memory_id: int, profile: str,
                 content: str, extra_terms: list[str] | None = None) -> None:
    """把一条记忆的词条写进倒排索引。"""
    toks = tokenize(content)
    if extra_terms:
        toks |= {t for t in extra_terms if t}
    conn.executemany(
        "INSERT OR IGNORE INTO memory_terms(term, memory_id, profile) VALUES (?,?,?)",
        [(t, memory_id, profile) for t in toks],
    )


def _ensure_terms_index(conn: sqlite3.Connection) -> None:
    """老库升级：索引表为空但记忆非空时，全量补建一次。"""
    n_terms = conn.execute("SELECT COUNT(*) c FROM memory_terms").fetchone()["c"]
    if n_terms:
        return
    rows = conn.execute("SELECT id, profile, content, trigger_terms FROM memories").fetchall()
    for r in rows:
        extra = [t for t in (r["trigger_terms"] or "").split(",") if t]
        _index_terms(conn, r["id"], r["profile"], r["content"], extra)
    if rows:
        conn.commit()


def _log(conn: sqlite3.Connection, memory_id: int | None, action: str, detail: str = "") -> None:
    conn.execute(
        "INSERT INTO events(memory_id, action, detail, created_at) VALUES (?,?,?,?)",
        (memory_id, action, detail, now_iso()),
    )


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["pinned"] = bool(d["pinned"])
    d["trigger_terms"] = [t for t in (d["trigger_terms"] or "").split(",") if t]
    try:
        d["breakdown"] = json.loads(d["breakdown"]) if d["breakdown"] else {}
    except json.JSONDecodeError:
        d["breakdown"] = {}
    return d


# --------------------------------------------------------------------------
# 写入
# --------------------------------------------------------------------------

DUP_JACCARD = 0.72


def _candidate_rows(conn, profile: str, kind: str, terms: list[str]):
    """粗筛候选：只取触发词有交集的记忆，避免大规模下全表逐条比对。"""
    if not terms:
        return []
    like = " OR ".join(["trigger_terms LIKE ?"] * len(terms))
    params = [profile, kind] + [f"%{t}%" for t in terms]
    return conn.execute(
        f"SELECT * FROM memories WHERE profile=? AND status='active' AND kind=? AND ({like})",
        params,
    ).fetchall()


def remember(
    content: str,
    kind: str | None = None,
    importance: float | None = None,
    trigger_terms: list[str] | None = None,
    entity: str = "",
    profile: str = "default",
    session_id: str = "",
    db_path: str | Path | None = None,
) -> dict:
    """写入一条记忆。重复内容会被强化而不是重复插入。"""
    text = (content or "").strip()
    if not text:
        return {"ok": False, "reason": "空内容"}
    if is_noise(text):
        return {"ok": False, "reason": "噪声内容，未记忆"}
    stripped = text.rstrip("。.？?！!")
    if (text.rstrip("。.").endswith(("？", "?"))
            or text.endswith(("吗", "呢"))
            or re.search(r"(什么|怎么|为什么|哪里|哪个|谁|多少|怎么办|是不是)$", stripped)):
        return {"ok": False, "reason": "问句不作为记忆"}

    # "放下了"这类表达只是一个信号，不直接清零心结；强度由四路证据共同决定
    if scoring.RESOLVE_PAT.search(text):
        conn = connect(db_path)
        try:
            cur = conn.execute(
                "UPDATE memories SET resolve_signals=resolve_signals+1, updated_at=? "
                "WHERE profile=? AND kind='grudge' AND resolved=0",
                (now_iso(), profile),
            )
            n = cur.rowcount
            if n:
                _log(conn, None, "resolve_signal", f"化解表达，影响 {n} 个心结")
            conn.commit()
        finally:
            conn.close()
        if n:
            return {"ok": True, "action": "resolve_signal", "affected": n,
                    "importance": 0.5, "kind": "resolve"}

    s = extractor.extract(text)
    imp = s["importance"] if importance is None else max(0.0, min(1.0, float(importance)))
    kind = kind or s["kind"]
    terms = trigger_terms if trigger_terms else (
        s.get("trigger_terms") or extract_trigger_terms(text)
    )
    terms = [t.strip() for t in terms if t and t.strip()][:12]

    conn = connect(db_path)
    try:
        new_toks = tokenize(text)
        # 情绪状态、情绪事件、心结都不去重：每一条代表一个时间点，合并掉就没法看趋势了
        dedup_rows = (
            _candidate_rows(conn, profile, kind, terms)
            if kind not in ("mood", "emotion", "grudge")
            else []
        )
        for row in dedup_rows:
            old_toks = tokenize(row["content"])
            if not new_toks or not old_toks:
                continue
            union = len(new_toks | old_toks)
            jac = len(new_toks & old_toks) / union if union else 0.0
            if jac >= DUP_JACCARD:
                new_w = round(min(1.0, row["weight"] + 0.08), 3)
                new_imp = max(row["importance"], imp)
                merged = sorted(set(row["trigger_terms"].split(",") + terms) - {""})
                conn.execute(
                    "UPDATE memories SET weight=?, importance=?, trigger_terms=?, updated_at=? WHERE id=?",
                    (new_w, new_imp, ",".join(merged), now_iso(), row["id"]),
                )
                _log(conn, row["id"], "strengthened", f"jaccard={jac:.2f}")
                conn.commit()
                return {"ok": True, "action": "strengthened", "id": row["id"],
                        "importance": new_imp, "kind": kind}

        # 冲突取代：聊的是同一个对象，但态度反了 → 旧的标记为被取代
        # 例：「我讨厌香菜」→「我现在爱吃香菜了」，旧的退出召回但保留历史
        new_terms = set(terms)
        if new_terms and kind in ("preference", "identity", "relationship", "fact", "goal"):
            for row in _candidate_rows(conn, profile, kind, terms):
                old_terms = set(row["trigger_terms"].split(",")) - {""}
                if not (old_terms & new_terms):
                    continue
                if row["valence"] * s["valence"] < -0.05:
                    conn.execute(
                        "UPDATE memories SET status='superseded', updated_at=? WHERE id=?",
                        (now_iso(), row["id"]),
                    )
                    _log(conn, row["id"], "superseded", f"被新记忆取代：{text[:20]}")

        cur = conn.execute(
            """INSERT INTO memories
               (profile, content, kind, importance, weight, status, pinned, trigger_terms,
                emotion, entity, source_session, created_at, updated_at,
                valence, arousal, salience, decay_class, half_life, aftermath, resolved, breakdown)
               VALUES (?,?,?,?,?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)""",
            (profile, text, kind, imp, imp, ",".join(terms), s["valence"], entity,
             session_id, now_iso(), now_iso(),
             s["valence"], s["arousal"], s["salience"], s["decay_class"],
             s["half_life"], s["aftermath"], json.dumps(s["breakdown"], ensure_ascii=False)),
        )
        mid = cur.lastrowid
        _index_terms(conn, mid, profile, text, terms)
        _log(conn, mid, "created", f"kind={kind} imp={imp} sal={s['salience']}")
        conn.commit()
        return {
            "ok": True, "action": "created", "id": mid, "importance": imp, "kind": kind,
            "trigger_terms": terms, "salience": s["salience"], "valence": s["valence"],
            "arousal": s["arousal"], "emotion_word": s["emotion_word"],
            "half_life": s["half_life"], "breakdown": s["breakdown"],
        }
    finally:
        conn.close()


# --------------------------------------------------------------------------
# 召回打分
# --------------------------------------------------------------------------

REL_MIN = 0.10
DORMANT_FACTOR = 0.35
PINNED_BONUS = 0.25
AUTO_WAKE_REL = 0.25

W_REL = 0.45
W_IMP = 0.25
W_REC = 0.12
W_WEIGHT = 0.10
W_SALIENCE = 0.08

_DEFAULT_WEIGHTS = {"rel": W_REL, "imp": W_IMP, "rec": W_REC,
                    "weight": W_WEIGHT, "salience": W_SALIENCE}


def _relevance(q: set[str], m: set[str]) -> float:
    if not q or not m:
        return 0.0
    inter = len(q & m)
    if inter == 0:
        return 0.0
    forward = inter / len(q)
    backward = inter / min(len(q), len(m))
    return 0.6 * forward + 0.4 * backward


def _recency(created_at: str | None, half_life: float, ref: datetime) -> float:
    d = parse_iso(created_at)
    if not d:
        return 0.0
    days = max(0.0, (ref - d).total_seconds() / 86400.0)
    hl = half_life if half_life and half_life > 0 else 120.0
    return math.exp(-math.log(2) * days / hl)


def _expand_query(q: set[str], conn: sqlite3.Connection) -> set[str]:
    out = set(q)
    for row in conn.execute("SELECT canonical, alias FROM aliases"):
        if row["alias"] in q or row["canonical"] in q:
            out.add(row["canonical"])
            out.add(row["alias"])
    return out


def recall(
    query: str,
    top_k: int = 5,
    profile: str = "default",
    db_path: str | Path | None = None,
    touch: bool = True,
    include_dormant: bool = True,
    threshold: float = REL_MIN,
    weights: dict | None = None,
) -> list[dict]:
    """按需召回：只返回真的相关、且值得进上下文的少量记忆。

    weights 可覆盖默认召回权重，供 tune.py 做参数搜索。
    """
    w = dict(_DEFAULT_WEIGHTS)
    if weights:
        w.update(weights)
    ref = now_dt()
    conn = connect(db_path)
    try:
        q = _expand_query(tokenize(query), conn)
        statuses = ("active", "dormant") if include_dormant else ("active",)
        st_ph = ",".join("?" * len(statuses))

        # 倒排粗筛 + 候选上限：优先用出现较少的词，避免「累/烦」这类高频词撑爆候选
        cand_ids: list[int] = []
        if q:
            df = {}
            for t in q:
                df[t] = conn.execute(
                    "SELECT COUNT(*) c FROM memory_terms WHERE profile=? AND term=?",
                    (profile, t),
                ).fetchone()["c"]
            useful = sorted((t for t in q if df[t] > 0), key=lambda t: df[t])[:6]
            if useful:
                term_ph = ",".join("?" * len(useful))
                cand_rows = conn.execute(
                    f"SELECT memory_id, COUNT(*) AS hits FROM memory_terms "
                    f"WHERE profile=? AND term IN ({term_ph}) GROUP BY memory_id "
                    f"ORDER BY hits DESC LIMIT 800",
                    (profile, *useful),
                ).fetchall()
                cand_ids = [r["memory_id"] for r in cand_rows]

        rows = []
        if cand_ids:
            ids = list(cand_ids)
            id_ph = ",".join("?" * len(ids))
            rows = conn.execute(
                f"SELECT * FROM memories WHERE status IN ({st_ph}) AND id IN ({id_ph})",
                (*statuses, *ids),
            ).fetchall()

        # 钉住的记忆即使没有词命中也要参与
        seen = {r["id"] for r in rows}
        for r in conn.execute(
            f"SELECT * FROM memories WHERE profile=? AND status IN ({st_ph}) AND pinned=1",
            (profile, *statuses),
        ).fetchall():
            if r["id"] not in seen:
                rows.append(r)

        scored: list[dict] = []
        for row in rows:
            m_toks = tokenize(row["content"]) | set(t for t in row["trigger_terms"].split(",") if t)
            rel = _relevance(q, m_toks)
            pinned = bool(row["pinned"])
            if rel < threshold and not pinned:
                continue
            rec = _recency(row["created_at"], row["half_life"], ref)
            score = (
                w["rel"] * rel
                + w["imp"] * row["importance"]
                + w["rec"] * rec
                + w["weight"] * row["weight"]
                + w["salience"] * row["salience"]
            )
            if row["status"] == "dormant":
                score *= DORMANT_FACTOR
            if pinned:
                score += PINNED_BONUS
            d = _row_to_dict(row)
            d["relevance"] = round(rel, 4)
            d["score"] = round(score, 4)
            d["age"] = human_age(row["created_at"])
            d["kind_label"] = scoring.KIND_LABEL.get(row["kind"], row["kind"])
            scored.append(d)

        scored.sort(key=lambda x: x["score"], reverse=True)
        top = scored[:top_k]

        if touch and top:
            ts = now_iso()
            for it in top:
                conn.execute(
                    "UPDATE memories SET last_recalled=?, recall_count=recall_count+1, "
                    "weight=MIN(1.0, weight+0.03) WHERE id=?",
                    (ts, it["id"]),
                )
                _log(conn, it["id"], "recalled", f"score={it['score']}")
                if it["status"] == "dormant" and it["relevance"] >= AUTO_WAKE_REL:
                    conn.execute("UPDATE memories SET status='active' WHERE id=?", (it["id"],))
                    _log(conn, it["id"], "woke", "被强命中的线索唤醒")
                    it["status"] = "active"
                    it["woke"] = True
            conn.commit()
        return top
    finally:
        conn.close()


def render_for_prompt(items: list[dict], max_chars: int = 700) -> str:
    """把召回结果压成可直接注入系统提示的短文本。"""
    if not items:
        return ""
    lines, used = [], 0
    for it in items:
        mark = "📌" if it["pinned"] else ""
        label = it.get("kind_label") or scoring.KIND_LABEL.get(it["kind"], it["kind"])
        line = f"- {mark}[{label}·{it['importance']:.2f}·{it['age']}] {it['content']}"
        if used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 可解释：为什么这条是这个分
# --------------------------------------------------------------------------

def explain_memory(memory_id: int, db_path: str | Path | None = None) -> str:
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchone()
        if not row:
            return f"没有 #{memory_id} 这条记忆"
        d = _row_to_dict(row)
        b = d.get("breakdown") or {}
        if not b:
            return f"#{memory_id} 是 v0.1 的旧数据，没有评分明细"

        w = b.get("weights", {})
        label = scoring.KIND_LABEL.get(d["kind"], d["kind"])
        parts = [
            f"#{d['id']} [{label}] 重要度 {d['importance']:.3f} | {d['content']}",
            f"  基础分  {b.get('base', 0):.2f}",
            f"  自我    {b.get('self', 0):.2f} × {w.get('self', 0):.2f} = {b.get('self', 0) * w.get('self', 0):.3f}",
            f"  情绪    {b.get('emotional', 0):.2f} × {w.get('emotional', 0):.2f} = {b.get('emotional', 0) * w.get('emotional', 0):.3f}",
            f"  社会    {b.get('social', 0):.2f} × {w.get('social', 0):.2f} = {b.get('social', 0) * w.get('social', 0):.3f}",
            f"  身份    {b.get('identity', 0):.2f} × {w.get('identity', 0):.2f} = {b.get('identity', 0) * w.get('identity', 0):.3f}",
            f"  新奇    {b.get('novelty', 0):.2f} × {w.get('novelty', 0):.2f} = {b.get('novelty', 0) * w.get('novelty', 0):.3f}",
            f"  细节    {b.get('detail', 0):.2f} × {w.get('detail', 0):.2f} = {b.get('detail', 0) * w.get('detail', 0):.3f}",
            f"  状态    {b.get('state', 0):.2f} × {w.get('state', 0):.2f} = {b.get('state', 0) * w.get('state', 0):.3f}",
            f"  = 合计 {d['importance']:.3f}（封顶 1.0）",
            f"  情绪：效价 {d['valence']:+.2f} / 唤醒 {d['arousal']:.2f} / 冲击力 {d['salience']:.2f}",
            f"  衰减：{d['decay_class']} 类，半衰期 {d['half_life']:.0f} 天",
            f"  状态：{d['status']}{'（钉住）' if d['pinned'] else ''}，被回忆 {d['recall_count']} 次，权重 {d['weight']:.2f}",
        ]
        return "\n".join(parts)
    finally:
        conn.close()


# --------------------------------------------------------------------------
# 状态操作
# --------------------------------------------------------------------------

def set_status(memory_id: int, status: str, db_path: str | Path | None = None) -> dict:
    if status not in ("active", "dormant"):
        return {"ok": False, "reason": "status 只能是 active/dormant"}
    conn = connect(db_path)
    try:
        if not conn.execute("SELECT id FROM memories WHERE id=?", (memory_id,)).fetchone():
            return {"ok": False, "reason": "记忆不存在"}
        conn.execute("UPDATE memories SET status=?, updated_at=? WHERE id=?", (status, now_iso(), memory_id))
        _log(conn, memory_id, "slept" if status == "dormant" else "woke", "手动")
        conn.commit()
        return {"ok": True, "id": memory_id, "status": status}
    finally:
        conn.close()


def set_pinned(memory_id: int, pinned: bool, db_path: str | Path | None = None) -> dict:
    conn = connect(db_path)
    try:
        if not conn.execute("SELECT id FROM memories WHERE id=?", (memory_id,)).fetchone():
            return {"ok": False, "reason": "记忆不存在"}
        conn.execute("UPDATE memories SET pinned=?, updated_at=? WHERE id=?",
                     (1 if pinned else 0, now_iso(), memory_id))
        _log(conn, memory_id, "pinned" if pinned else "unpinned", "")
        conn.commit()
        return {"ok": True, "id": memory_id, "pinned": pinned}
    finally:
        conn.close()


def set_resolved(memory_id: int, resolved: bool = True,
                 db_path: str | Path | None = None) -> dict:
    """手动标记某件心结已化解（或撤销）。"""
    conn = connect(db_path)
    try:
        if not conn.execute("SELECT id FROM memories WHERE id=?", (memory_id,)).fetchone():
            return {"ok": False, "reason": "记忆不存在"}
        conn.execute("UPDATE memories SET resolved=?, updated_at=? WHERE id=?",
                     (1 if resolved else 0, now_iso(), memory_id))
        _log(conn, memory_id, "resolved" if resolved else "unresolved", "手动")
        conn.commit()
        return {"ok": True, "id": memory_id, "resolved": resolved}
    finally:
        conn.close()


def update_memory(memory_id: int, content: str | None = None, kind: str | None = None,
                  importance: float | None = None,
                  db_path: str | Path | None = None) -> dict:
    """手动修改一条记忆，重新评分。"""
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchone()
        if not row:
            return {"ok": False, "reason": "记忆不存在"}
        new_content = (content or row["content"]).strip()
        s = scoring.score_text(new_content)
        conn.execute(
            "UPDATE memories SET content=?, kind=?, importance=?, valence=?, arousal=?, salience=?,"
            " decay_class=?, half_life=?, aftermath=?, breakdown=?, updated_at=? WHERE id=?",
            (new_content, kind or s["kind"],
             importance if importance is not None else s["importance"],
             s["valence"], s["arousal"], s["salience"], s["decay_class"],
             s["half_life"], s["aftermath"],
             json.dumps(s["breakdown"], ensure_ascii=False), now_iso(), memory_id),
        )
        conn.execute("DELETE FROM memory_terms WHERE memory_id=?", (memory_id,))
        _index_terms(conn, memory_id, row["profile"], new_content,
                     [t for t in (row["trigger_terms"] or "").split(",") if t])
        _log(conn, memory_id, "updated", "手动修改")
        conn.commit()
        return {"ok": True, "id": memory_id, "importance": s["importance"], "kind": s["kind"]}
    finally:
        conn.close()


def delete_memory(memory_id: int, hard: bool = False,
                  db_path: str | Path | None = None) -> dict:
    """默认软删除（标记 deleted，仍可查）；hard=True 才真删。"""
    conn = connect(db_path)
    try:
        if not conn.execute("SELECT id FROM memories WHERE id=?", (memory_id,)).fetchone():
            return {"ok": False, "reason": "记忆不存在"}
        if hard:
            conn.execute("DELETE FROM memories WHERE id=?", (memory_id,))
            _log(conn, memory_id, "deleted_hard", "彻底删除")
        else:
            conn.execute("UPDATE memories SET status='deleted', updated_at=? WHERE id=?",
                         (now_iso(), memory_id))
            _log(conn, memory_id, "deleted", "软删除")
        conn.execute("DELETE FROM memory_terms WHERE memory_id=?", (memory_id,))
        conn.commit()
        return {"ok": True, "id": memory_id, "hard": hard}
    finally:
        conn.close()


def export_json(path: str | Path, profile: str | None = None,
                db_path: str | Path | None = None) -> dict:
    """导出记忆库为 JSON（备份 / 迁移 / 换机器）。"""
    conn = connect(db_path)
    try:
        if profile:
            rows = conn.execute("SELECT * FROM memories WHERE profile=? ORDER BY id",
                                (profile,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM memories ORDER BY id").fetchall()
        data = {
            "version": 3,
            "exported_at": now_iso(),
            "profile": profile,
            "memories": [_row_to_dict(r) for r in rows],
        }
        out = Path(path)
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"ok": True, "count": len(rows), "path": str(out)}
    finally:
        conn.close()


def import_json(path: str | Path, profile: str = "default",
                db_path: str | Path | None = None) -> dict:
    """从 JSON 导入记忆（id 会重新分配，避免冲突）。"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    items = data.get("memories", []) if isinstance(data, dict) else data
    conn = connect(db_path)
    n = 0
    try:
        for m in items:
            content = (m.get("content") or "").strip()
            if not content:
                continue
            kind = m.get("kind", "fact")
            imp = float(m.get("importance", 0.25))
            raw_terms = m.get("trigger_terms")
            if isinstance(raw_terms, str):
                terms_list = [t for t in raw_terms.split(",") if t]
            else:
                terms_list = [t for t in (raw_terms or []) if t]
            cur = conn.execute(
                """INSERT INTO memories
                   (profile, content, kind, importance, weight, status, pinned, trigger_terms,
                    emotion, entity, source_session, created_at, updated_at,
                    valence, arousal, salience, decay_class, half_life, aftermath, resolved, breakdown)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (profile, content, kind, imp, float(m.get("weight", imp)),
                 m.get("status", "active"), 1 if m.get("pinned") else 0,
                 ",".join(terms_list),
                 m.get("emotion", 0), m.get("entity", ""), "import",
                 m.get("created_at", now_iso()), m.get("updated_at", now_iso()),
                 m.get("valence", 0), m.get("arousal", 0), m.get("salience", 0),
                 m.get("decay_class", kind), m.get("half_life", 120),
                 m.get("aftermath", 0), 1 if m.get("resolved") else 0,
                 json.dumps(m.get("breakdown", {}), ensure_ascii=False)),
            )
            _index_terms(conn, cur.lastrowid, profile, content, terms_list)
            n += 1
        conn.commit()
        return {"ok": True, "imported": n}
    finally:
        conn.close()


def list_memories(status: str | None = None, profile: str = "default", limit: int = 50,
                  db_path: str | Path | None = None) -> list[dict]:
    conn = connect(db_path)
    try:
        if status:
            rows = conn.execute(
                "SELECT * FROM memories WHERE profile=? AND status=? ORDER BY importance DESC, updated_at DESC LIMIT ?",
                (profile, status, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM memories WHERE profile=? ORDER BY importance DESC, updated_at DESC LIMIT ?",
                (profile, limit),
            ).fetchall()
        out = []
        for r in rows:
            d = _row_to_dict(r)
            d["age"] = human_age(r["created_at"])
            d["kind_label"] = scoring.KIND_LABEL.get(r["kind"], r["kind"])
            out.append(d)
        return out
    finally:
        conn.close()


LOW_MOOD_THRESHOLD = -0.15


def grudge_strength(row, ref: datetime | None = None, mood_avg_after: float = 0.0) -> float:
    """心结强度 0~1，越低越接近化解。

    四路证据共同决定，任何单独一路都不足以让它消失：
      1. 时间流逝          每天 -0.02（最多 -0.60）
      2. 明确表达放下了    每次 -0.18（说一句不等于清零）
      3. 之后整体情绪转正  -0.12
      4. 反复提起          每次 +0.08（越想越气）
    """
    ref = ref or now_dt()
    created = parse_iso(row["created_at"])
    days = max(0.0, (ref - created).total_seconds() / 86400.0) if created else 0.0

    s = 1.0
    s -= 0.02 * min(days, 30.0)
    s -= 0.18 * int(row["resolve_signals"] or 0)
    if mood_avg_after > 0.15:
        s -= 0.12
    s += 0.08 * min(3, int(row["recall_count"] or 0))
    return round(max(0.0, min(1.0, s)), 3)


def analyze_mood(days: int = 14, profile: str = "default",
                 db_path: str | Path | None = None) -> dict:
    """按天分析情绪轨迹：连续低迷、趋势、未化解的心结、仍在余波中的事。"""
    conn = connect(db_path)
    try:
        ref = now_dt()
        since = (ref - timedelta(days=days)).isoformat(timespec="seconds")
        rows = conn.execute(
            "SELECT * FROM memories WHERE profile=? AND kind IN ('mood','emotion') "
            "AND created_at >= ? ORDER BY created_at",
            (profile, since),
        ).fetchall()

        by_day: dict[str, list] = {}
        for r in rows:
            d = parse_iso(r["created_at"])
            if d:
                by_day.setdefault(d.strftime("%Y-%m-%d"), []).append(r)

        daily = []
        for day in sorted(by_day):
            rs = by_day[day]
            daily.append({
                "date": day,
                "valence": round(sum(x["valence"] for x in rs) / len(rs), 3),
                "arousal": round(sum(x["arousal"] for x in rs) / len(rs), 3),
                "count": len(rs),
            })

        # 连续低迷：从最近一天往前推，日期不断档且效价低于阈值
        consecutive_low = 0
        prev_date = None
        for d in reversed(daily):
            cur = datetime.strptime(d["date"], "%Y-%m-%d").date()
            if d["valence"] < LOW_MOOD_THRESHOLD:
                if prev_date is None or (prev_date - cur).days <= 1:
                    consecutive_low += 1
                    prev_date = cur
                else:
                    break
            else:
                break

        # 趋势：最近 3 天 vs 之前 3 天
        recent = daily[-3:]
        earlier = daily[-6:-3]
        trend, delta = "数据不足", 0.0
        if recent:
            rv = sum(d["valence"] for d in recent) / len(recent)
            if earlier:
                ev = sum(d["valence"] for d in earlier) / len(earlier)
                delta = round(rv - ev, 3)
                if delta <= -0.15:
                    trend = "持续走低"
                elif delta >= 0.15:
                    trend = "回升"
                else:
                    trend = "基本平稳"
            else:
                trend = "偏负面" if rv < LOW_MOOD_THRESHOLD else ("偏正面" if rv > 0.15 else "基本平稳")

        raw_grudges = conn.execute(
            "SELECT * FROM memories WHERE profile=? AND kind='grudge' AND resolved=0 "
            "ORDER BY created_at", (profile,)).fetchall()

        unresolved = []
        for g in raw_grudges:
            created = parse_iso(g["created_at"])
            after = [r for r in rows
                     if created and parse_iso(r["created_at"]) and parse_iso(r["created_at"]) > created]
            avg_after = (sum(x["valence"] for x in after) / len(after)) if after else 0.0
            st = grudge_strength(g, ref, avg_after)
            if st < 0.25:
                continue  # 多路证据都指向"过去了"，不再算未化解
            d = dict(g)
            d["strength"] = st
            d["stage"] = "快过去了" if st < 0.5 else "还没过去"
            unresolved.append(d)

        aftermath = []
        for r in conn.execute(
            "SELECT * FROM memories WHERE profile=? AND kind='emotion' AND aftermath > 0",
            (profile,)).fetchall():
            created = parse_iso(r["created_at"])
            if not created:
                continue
            elapsed = (ref - created).total_seconds() / 86400.0
            remaining = r["aftermath"] - elapsed
            if remaining > 0:
                aftermath.append({
                    "id": r["id"], "content": r["content"],
                    "elapsed": round(elapsed, 1), "remaining": round(remaining, 1),
                    "salience": r["salience"],
                })

        return {
            "days": days, "daily": daily, "total": len(rows),
            "consecutive_low": consecutive_low, "trend": trend, "delta": delta,
            "unresolved": unresolved, "aftermath": aftermath,
            "latest": ({"content": rows[-1]["content"], "age": human_age(rows[-1]["created_at"])}
                       if rows else None),
        }
    finally:
        conn.close()


def recent_mood_summary(days: int = 7, profile: str = "default",
                        db_path: str | Path | None = None) -> str:
    """把零散的情绪记录攒成一句判断依据。"""
    a = analyze_mood(days=days, profile=profile, db_path=db_path)
    if a["total"] == 0 and not a["unresolved"] and not a["aftermath"]:
        return f"最近 {days} 天没有情绪记录"

    lines = []
    if a["daily"]:
        avg_v = sum(d["valence"] for d in a["daily"]) / len(a["daily"])
        if avg_v <= -0.35:
            tone = "整体偏负面"
        elif avg_v < -0.10:
            tone = "略偏负面"
        elif avg_v >= 0.35:
            tone = "整体偏正面"
        elif avg_v > 0.10:
            tone = "略偏正面"
        else:
            tone = "基本中性"
        lines.append(f"最近 {days} 天共 {a['total']} 条情绪记录，{tone}（平均效价 {avg_v:+.2f}）")

    if a["consecutive_low"] >= 2:
        lines.append(f"已经连续 {a['consecutive_low']} 天状态偏低，不是单日波动")
    if a["trend"] not in ("数据不足", "基本平稳"):
        lines.append(f"趋势：{a['trend']}（变化 {a['delta']:+.2f}）")

    for g in a["unresolved"]:
        lines.append(
            f"心结（{g.get('stage', '')}，强度 {g.get('strength', 1):.2f}）："
            f"{human_age(g['created_at'])}「{g['content']}」"
        )
    for x in a["aftermath"]:
        lines.append(
            f"仍在余波中：{x['elapsed']:.0f} 天前「{x['content']}」，"
            f"可能还要影响约 {x['remaining']:.0f} 天"
        )
    if a.get("latest"):
        lines.append(f"最近一次：{a['latest']['age']}「{a['latest']['content']}」")
    return "\n".join(lines)


def build_context(query: str, profile: str = "default", top_k: int = 5,
                  days: int = 7, db_path: str | Path | None = None) -> str:
    """一次性给出：相关记忆 + 近期情绪轨迹。可直接注入系统提示。"""
    parts = []
    items = recall(query, top_k=top_k, profile=profile, db_path=db_path)
    if items:
        parts.append(render_for_prompt(items))
    mood = recent_mood_summary(days=days, profile=profile, db_path=db_path)
    if mood and "没有情绪记录" not in mood:
        parts.append("【近期状态】\n" + mood)
    return "\n".join(parts)


def stats(profile: str = "default", db_path: str | Path | None = None) -> dict:
    conn = connect(db_path)
    try:
        total = conn.execute("SELECT COUNT(*) c FROM memories WHERE profile=?", (profile,)).fetchone()["c"]
        active = conn.execute("SELECT COUNT(*) c FROM memories WHERE profile=? AND status='active'", (profile,)).fetchone()["c"]
        dormant = conn.execute("SELECT COUNT(*) c FROM memories WHERE profile=? AND status='dormant'", (profile,)).fetchone()["c"]
        pinned = conn.execute("SELECT COUNT(*) c FROM memories WHERE profile=? AND pinned=1", (profile,)).fetchone()["c"]
        ev = conn.execute("SELECT COUNT(*) c FROM events").fetchone()["c"]
        return {"total": total, "active": active, "dormant": dormant, "pinned": pinned, "events": ev}
    finally:
        conn.close()


def add_alias(canonical: str, alias: str, db_path: str | Path | None = None) -> None:
    conn = connect(db_path)
    try:
        conn.execute("INSERT OR IGNORE INTO aliases(canonical, alias) VALUES (?,?)", (canonical, alias))
        conn.commit()
    finally:
        conn.close()


def reset(db_path: str | Path | None = None) -> None:
    conn = connect(db_path)
    try:
        conn.executescript("DELETE FROM memories; DELETE FROM events; DELETE FROM aliases;")
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    p = HERE / "data" / "selfcheck.db"
    for f in (p, Path(str(p) + "-wal"), Path(str(p) + "-shm")):
        f.unlink(missing_ok=True)
    print(remember("我叫林小满，我讨厌香菜，闻到就难受", db_path=p))
    print(remember("今天加班到十点，累死了", db_path=p))
    print(render_for_prompt(recall("我讨厌什么", top_k=3, db_path=p)))
    print(explain_memory(1, db_path=p))
    print(stats(db_path=p))
