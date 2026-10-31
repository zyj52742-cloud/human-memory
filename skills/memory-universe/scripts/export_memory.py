#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""记忆宇宙 · 只读数据导出器（随 skills/memory-universe 分发的副本）

相对原视图原型的改动：数据库仅处理显式传入路径；允许没有星图快照时
只导出记忆库。除这两处外逻辑保持一致。

把两路真实数据合成一个前端可直接加载的 JS 数据文件：

  1) 记忆星图快照（window.__STAR_DATA__ = {...}）—— 对话节点
  2) 类人脑记忆库（memory_core.py 生成的 SQLite）—— 记忆 / 实体节点

约束（实现层面硬保证）：
  * 只用 Python 标准库；
  * SQLite 一律以 URI ``mode=ro`` + ``PRAGMA query_only=1`` 打开，只执行 SELECT；
    文件不存在时直接跳过，绝不创建空库、绝不触发建表/迁移；
  * 不 eval 解析输入，data.js 用 JSONDecoder.raw_decode 取 JSON 对象；
  * 输出文件原子写（同目录临时文件 + os.replace），不写目标以外的位置；
  * 标题 / 内容 / excerpt / 实体名做基础脱敏（sk-、api_key/token/password 赋值、Bearer）；
  * 输出 JS 时把 ``<`` ``>`` ``&`` U+2028 U+2029 转成 \\uXXXX，避免 </script> 注入；
  * 一个库损坏不影响对话节点导出。

JSON 契约（version 1，新增字段向后兼容）::

    {"version": 1, "generatedAt": ISO8601, "nodes": [], "edges": [],
     "events": [], "profiles": [], "metadata": {}}

节点共同字段：id / type / label / group / source
  - conversation : id=conv:<原始sessionId>，source=星图文件绝对路径（字符串）
  - memory       : id=mem:<db路径短sha256>:<profile>:<库内id>，source=库绝对路径（字符串）
  - entity       : id=entity:<profile>:<实体名稳定hash>，source=来源库绝对路径数组
  - project      : id=project:<项目名稳定hash>，source=星图文件绝对路径（字符串）
  - kind         : id=kind:<profile>:<kind名稳定hash>，source=来源库绝对路径数组

边：id 稳定（type+source+target 的 sha256），字段 source/target/type/confidence/basis
  conversation->project (project) / conversation->父对话 (parent)
  memory->conversation (source，仅 source_session 精确命中星图 sessionId)
  memory->entity (entity) / memory->kind (kind)

事件（events，真实过程记录，不伪造）：
  - 只来自各库 ``events`` 表，每库最近 ``EVENTS_PER_DB``（200）条，按
    (created_at, 库内 id) 升序输出，再跨库按 (created_at, databaseId, id) 排序；
  - 字段：id（跨库稳定 ``ev:<dbhash>:<库内id>``）、eventId（库内 id）、
    databaseId、source（库路径）、memory_id、action、detail（脱敏纯文本）、
    created_at、profile（由 memory_id 关联 memories 派生，可能为 null）、
    memoryNodeId（匹配到的稳定记忆节点 id，否则 null）、matched、attribution；
  - events 表无 profile 列：profile 只能由关联记忆派生；memory_id 为空
    （全局事件）或指向已不存在记忆时，保留事件但 attribution=global/missing_memory，
    不猜测、不归入任何 profile；
  - 缺 events 表时 events=[]，并在 memorySources 里给出 eventsStatus="missing_table"；
  - 绝不用 memories.recall_count / last_recalled 反推或补造过程事件。

记忆节点额外字段：profile / status / importance / weight / lastRecalled / recallCount /
sourceSession / missingSource（"来源"=source_session 与 source 库路径）。

profiles（顶层，可由节点派生）：按记忆节点聚合的 profile 清单，字段 profile /
memories / statuses / entities / kinds / events / sources，供界面按 profile 筛选。

明确不做的事：不从标题相似度猜关系、不做 LLM 抽取、不伪造记忆/事件、不写原始库、
不声称事件属于哪个 DSH 会话或轮次（事件只有 memory_id/action/detail/created_at）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------

VERSION = 1
HERE = Path(__file__).resolve().parent
# 默认输出：脚本父目录的 ../_lib/network-data.js（显式调用者可用 --output 覆盖）
DEFAULT_OUTPUT = HERE.parent / "_lib" / "network-data.js"
EXCERPT_LIMIT = 180
LABEL_LIMIT = 32
SHORT_HASH_LEN = 12
ERROR_SUMMARY_LIMIT = 160
# 每个库最多导出的最近事件条数（真实过程记录，不是从 recall_count 反推）
EVENTS_PER_DB = 200
# 事件 detail / action 的纯文本上限
DETAIL_LIMIT = 300
ACTION_LIMIT = 40
# events 表状态
EVENTS_OK = "ok"
EVENTS_MISSING_TABLE = "missing_table"
EVENTS_ERROR = "error"

# 公开导出器只使用显式指定的数据库，不探测环境变量或个人默认库。

# 基础脱敏（按顺序执行，Bearer 先于赋值型规则）
REDACTIONS = [
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{6,}"), "Bearer ***"),
    (
        re.compile(
            r"(?i)\b(api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token"
            r"|token|password|passwd|pwd|secret|client[_-]?secret)\b"
            r"(\s*[:=]\s*)([\"']?)([^\s\"',;]{3,})"
        ),
        r"\1\2\3***",
    ),
    (re.compile(r"sk-[A-Za-z0-9_\-]{6,}"), "sk-***"),
]

CONVERSATION = "conversation"
MEMORY = "memory"
ENTITY = "entity"
PROJECT = "project"
KIND = "kind"


class StarsError(Exception):
    """星图快照读取/解析失败。"""


class UsageError(Exception):
    """命令行参数或输出路径不合法。"""


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def short_hash(text: str, length: int = SHORT_HASH_LEN) -> str:
    """稳定短 hash（sha256 十六进制前缀）。"""
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()[:length]


def db_key(path: str | Path) -> str:
    """库路径的稳定键：绝对化 + Windows 大小写归一后取短 sha256。

    用于 memory 节点 id，保证同一库重复导出一致。
    """
    p = os.path.normcase(os.path.abspath(os.fspath(path)))
    return short_hash(p)


def abs_path(path: str | Path) -> str:
    """绝对路径（不要求存在）。"""
    return os.path.abspath(os.fspath(path))


def redact(text) -> str:
    """对文本做基础脱敏；非字符串按空串处理。"""
    if text is None:
        return ""
    s = str(text)
    for pattern, repl in REDACTIONS:
        s = pattern.sub(repl, s)
    return s


def clip(text: str, limit: int) -> str:
    """脱敏后按字符截断（不切坏 Unicode）。"""
    return text[:limit]


def plain_text(value, limit: int) -> str:
    """脱敏 + 压平换行/制表符 + 截断，输出纯文本（可用于事件 detail）。"""
    text = redact(value)
    text = re.sub(r"[\r\n\t\u2028\u2029]+", " ", text)
    text = re.sub(r" {2,}", " ", text).strip()
    return clip(text, limit)


def excerpt_of(first_user) -> str:
    return clip(redact(first_user).strip(), EXCERPT_LIMIT)


def clean_label(value, fallback: str) -> str:
    label = redact(value).strip()
    return label or fallback


def to_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def to_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _error_summary(exc: BaseException) -> str:
    msg = redact(str(exc)).replace("\n", " ").strip()
    msg = re.sub(r"\s+", " ", msg)
    return clip(msg, ERROR_SUMMARY_LIMIT) or exc.__class__.__name__


# --------------------------------------------------------------------------
# 星图快照读取（不 eval）
# --------------------------------------------------------------------------

def load_stars_file(path: str | Path) -> dict:
    """读取 data.js / json，返回顶层对象。任何失败抛 StarsError。"""
    p = Path(path)
    if not p.is_file():
        raise StarsError(f"星图快照不存在：{abs_path(p)}")
    try:
        raw = p.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise StarsError(f"星图快照无法读取：{abs_path(p)}（{_error_summary(exc)}）") from exc

    marker = raw.find("window.__STAR_DATA__")
    start = raw.find("{", marker + 1) if marker != -1 else raw.find("{")
    if start == -1:
        raise StarsError(f"星图快照未找到 JSON 对象：{abs_path(p)}")
    try:
        # raw_decode 只解析一个 JSON 值，等价于 JSON.parse；不执行任何代码
        obj, _end = json.JSONDecoder().raw_decode(raw, start)
    except ValueError as exc:
        raise StarsError(f"星图快照 JSON 解析失败：{abs_path(p)}（{_error_summary(exc)}）") from exc
    if not isinstance(obj, dict):
        raise StarsError(f"星图快照顶层不是对象：{abs_path(p)}")
    return obj


def iter_stars(obj: dict):
    stars = obj.get("stars")
    if isinstance(stars, list):
        return stars
    return []


# --------------------------------------------------------------------------
# 记忆库只读读取
# --------------------------------------------------------------------------

def open_readonly(path: str | Path) -> sqlite3.Connection:
    """以 URI mode=ro + query_only 打开；调用方负责 close。"""
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=1")
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    rows = conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    return [str(r["name"]) for r in rows]


def read_memories(db_path: str | Path) -> tuple[list[dict], str | None]:
    """读取 memories 表全部行，返回 (行列表, 错误摘要)。

    只读、只 SELECT；缺表/坏文件返回错误摘要而不是抛异常。
    未知列忽略，缺列用默认值，日期原样保留（ISO 字符串）。
    """
    p = Path(db_path)
    conn = None
    try:
        conn = open_readonly(p)
        columns = _table_columns(conn, "memories")
        if not columns:
            return [], "数据库中没有 memories 表"
        rows = conn.execute("SELECT * FROM memories").fetchall()
        names = set(columns)
    except sqlite3.Error as exc:
        return [], _error_summary(exc)
    finally:
        if conn is not None:
            conn.close()

    def pick(row: sqlite3.Row, *candidates, default=None):
        for name in candidates:
            if name in names:
                value = row[name]
                if value is not None:
                    return value
        return default

    out: list[dict] = []
    for row in rows:
        mem_id = pick(row, "id", "memory_id", "memoryId")
        if mem_id is None:
            continue
        out.append(
            {
                "memoryId": mem_id,
                "profile": str(pick(row, "profile", default="default") or "default"),
                "kind": str(pick(row, "kind", default="fact") or "fact"),
                "content": str(pick(row, "content", default="") or ""),
                "importance": to_float(pick(row, "importance", default=0.25), 0.25),
                "weight": to_float(pick(row, "weight", default=0.25), 0.25),
                "status": str(pick(row, "status", default="active") or "active"),
                "pinned": to_int(pick(row, "pinned", default=0), 0),
                "entity": str(pick(row, "entity", default="") or ""),
                "sourceSession": str(
                    pick(row, "source_session", "sourceSession", default="") or ""
                ),
                "created": pick(row, "created_at", "created", "createdAt"),
                "updated": pick(row, "updated_at", "updated", "updatedAt"),
                "recallCount": to_int(
                    pick(row, "recall_count", "recallCount", default=0), 0
                ),
                "lastRecalled": pick(row, "last_recalled", "lastRecalled"),
            }
        )
    out.sort(key=lambda m: (str(type(m["memoryId"])), str(m["memoryId"])))
    return out, None


def _mid_key(value) -> str | None:
    """把 memories.id / events.memory_id 归一成可比较的字符串键。"""
    if value is None:
        return None
    try:
        return str(int(value))
    except (TypeError, ValueError):
        text = str(value).strip()
        return text or None


def read_events(
    db_path: str | Path, *, limit: int = EVENTS_PER_DB
) -> tuple[list[dict], str, str | None]:
    """只读读取 events 表最近 ``limit`` 条，返回 (事件列表, 状态, 错误摘要)。

    * 先按 (created_at DESC, id DESC) 取最近 limit 条，反转为时间正序；
    * 缺 events 表：``([], EVENTS_MISSING_TABLE, 可读说明)``，不抛异常、不建表；
    * 坏文件 / 查询错误：``([], EVENTS_ERROR, 摘要)``；
    * 未知列忽略；缺 memory_id/detail 用默认值；缺 action/created_at 视为不可读。
    """
    p = Path(db_path)
    conn = None
    try:
        conn = open_readonly(p)
        columns = _table_columns(conn, "events")
        if not columns:
            return [], EVENTS_MISSING_TABLE, "数据库中没有 events 表（旧库或尚未产生过程事件）"
        names = set(columns)
        if "action" not in names or "created_at" not in names:
            return [], EVENTS_ERROR, "events 表缺少 action 或 created_at 列，无法安全导出"
        selected = [c for c in ("id", "memory_id", "action", "detail", "created_at") if c in names]
        order = ["created_at DESC"]
        if "id" in names:
            order.append("id DESC")
        sql = "SELECT {} FROM events ORDER BY {} LIMIT ?".format(
            ", ".join(selected), ", ".join(order)
        )
        rows = conn.execute(sql, (int(limit),)).fetchall()
    except sqlite3.Error as exc:
        return [], EVENTS_ERROR, _error_summary(exc)
    finally:
        if conn is not None:
            conn.close()

    out: list[dict] = []
    for index, row in enumerate(reversed(rows)):
        event_id = to_int(row["id"], None) if "id" in names else None
        memory_id = row["memory_id"] if "memory_id" in names else None
        out.append(
            {
                "eventId": event_id,
                "order": index,
                "memory_id": memory_id,
                "action": str(row["action"] or "") if row["action"] is not None else "",
                "detail": str(row["detail"] or "") if "detail" in names else "",
                "created_at": row["created_at"],
            }
        )
    return out, EVENTS_OK, None


def resolve_db_paths(explicit_db: list[str]) -> tuple[list[dict], list[str]]:
    """决定本次要查哪些库。

    返回 (sources, default_probe_paths)。
    sources 条目：{"path", "explicit", "status", "count", "error"}（status 由调用方补全）
    只查显式 --db 路径；未提供时仅导出已指定的对话快照。
    """
    sources: list[dict] = []
    probes: list[str] = []
    seen: set[str] = set()

    for raw in explicit_db:
        path = abs_path(raw)
        key = os.path.normcase(path)
        if key in seen:
            continue
        seen.add(key)
        sources.append({"path": path, "explicit": True, "status": "missing",
                        "count": 0, "error": None})
    return sources, probes


# --------------------------------------------------------------------------
# 图构建
# --------------------------------------------------------------------------

def _node(node_id, node_type, label, group, source, **extra) -> dict:
    node = {
        "id": node_id,
        "type": node_type,
        "label": label,
        "group": group,
        "source": source,
    }
    node.update(extra)
    return node


def _edge(source, target, edge_type, basis, confidence=1.0) -> dict:
    edge_id = "e:" + short_hash("|".join([edge_type, source, target, basis]))
    return {
        "id": edge_id,
        "source": source,
        "target": target,
        "type": edge_type,
        "confidence": confidence,
        "basis": basis,
    }


def build_export(
    stars_paths: list[str],
    db_paths: list[str] | None = None,
    *,
    generated_at: str | None = None,
) -> dict:
    """构建导出数据（纯函数，不写文件）。"""
    # 允许只给记忆库：此时没有对话/项目节点，记忆仍可单独浏览
    if not stars_paths and not db_paths:
        raise UsageError("至少需要一个 --stars 或 --db 输入")

    generated = generated_at or datetime.now(timezone.utc).astimezone().isoformat(
        timespec="seconds"
    )
    db_paths = list(db_paths or [])

    nodes: list[dict] = []
    edges: list[dict] = []

    # ---- 对话节点 + 项目 hub -------------------------------------------
    conv_ids: dict[str, str] = {}          # 原始 sessionId -> 节点 id
    conv_by_id: dict[str, dict] = {}       # 原始 sessionId -> 原始 star
    projects: dict[str, str] = {}          # 项目名 -> 节点 id
    stars_meta: list[dict] = []
    skipped = 0

    for raw_path in stars_paths:
        star_file = abs_path(raw_path)
        obj = load_stars_file(star_file)
        stars_meta.append(
            {
                "path": star_file,
                "generatedAt": obj.get("generatedAt"),
                "source": obj.get("source"),
            }
        )
        for star in iter_stars(obj):
            if not isinstance(star, dict):
                skipped += 1
                continue
            session_id = star.get("id")
            if session_id is None or str(session_id).strip() == "":
                skipped += 1
                continue
            session_id = str(session_id)

            title = clean_label(star.get("title"), "（未命名对话）")
            project = redact(star.get("project")).strip()
            group = project or "未分组"

            conv_id = "conv:" + session_id
            if session_id in conv_by_id:  # 重复 id：保留第一条
                skipped += 1
                continue
            conv_by_id[session_id] = star
            conv_ids[session_id] = conv_id
            nodes.append(
                _node(
                    conv_id,
                    CONVERSATION,
                    title,
                    group,
                    star_file,
                    sessionId=session_id,
                    title=title,
                    project=project,
                    created=star.get("created"),
                    last=star.get("last"),
                    turns=star.get("turns"),
                    excerpt=excerpt_of(star.get("firstUser")),
                    sub=star.get("sub"),
                    parent=star.get("parent"),
                )
            )

            if project:
                pid = projects.get(project)
                if pid is None:
                    pid = "project:" + short_hash(project)
                    projects[project] = pid
                    nodes.append(
                        _node(
                            pid,
                            PROJECT,
                            project,
                            "project",
                            star_file,
                            project=project,
                        )
                    )

    # 父对话边（只在父 id 精确存在于快照时建立，不猜）
    for session_id, star in conv_by_id.items():
        parent = star.get("parent")
        if parent is None:
            continue
        parent = str(parent).strip()
        if not parent or parent not in conv_ids:
            continue
        edges.append(
            _edge(conv_ids[session_id], conv_ids[parent], "parent", "stars.parent")
        )

    # 项目边
    for session_id, star in conv_by_id.items():
        project = redact(star.get("project")).strip()
        if project and project in projects:
            edges.append(
                _edge(conv_ids[session_id], projects[project], "project", "stars.project")
            )

    # ---- 记忆节点 + 实体/种类 hub --------------------------------------
    db_sources, probe_paths = resolve_db_paths(db_paths)
    for source in db_sources:
        source.setdefault("eventsStatus", "missing")
        source.setdefault("eventsError", None)
        source.setdefault("eventsCount", 0)

    entity_sources: dict[str, set[str]] = {}
    kind_sources: dict[str, set[str]] = {}
    entity_labels: dict[str, str] = {}
    kind_labels: dict[str, str] = {}
    entity_profile: dict[str, str] = {}
    kind_profile: dict[str, str] = {}
    all_events: list[dict] = []
    mem_total = 0

    for source in db_sources:
        path = source["path"]
        if not Path(path).is_file():
            source["status"] = "missing"
            source["error"] = (
                "显式指定的数据库不存在（未创建）"
                if source["explicit"]
                else "默认路径未发现数据库文件"
            )
            source["eventsStatus"] = "missing"
            source["eventsError"] = "数据库文件不存在（未创建），无事件可导出"
            continue
        rows, error = read_memories(path)
        source["count"] = len(rows)
        if error:
            source["status"] = "error"
            source["error"] = error
            source["eventsStatus"] = EVENTS_ERROR
            source["eventsError"] = "记忆库不可读，未读取事件"
            continue
        source["status"] = "ok"
        source["error"] = None
        mem_total += len(rows)

        db_hash = db_key(path)
        memory_index: dict[str, dict] = {}  # 库内 id -> {id, profile, status}
        for mem in rows:
            profile = mem["profile"]
            mem_id = f"mem:{db_hash}:{profile}:{mem['memoryId']}"
            content = redact(mem["content"])
            label = clean_label(clip(content.strip(), LABEL_LIMIT), "（无内容）")
            kind = mem["kind"]
            entity = redact(mem["entity"]).strip()
            session_id = str(mem["sourceSession"]).strip()
            matched_conv = conv_ids.get(session_id)
            missing_source = matched_conv is None
            key = _mid_key(mem["memoryId"])
            if key is not None:
                memory_index[key] = {
                    "id": mem_id,
                    "profile": profile,
                    "status": mem["status"],
                }

            nodes.append(
                _node(
                    mem_id,
                    MEMORY,
                    label,
                    profile,
                    path,
                    memoryId=mem["memoryId"],
                    profile=profile,
                    kind=kind,
                    content=content,
                    importance=mem["importance"],
                    weight=mem["weight"],
                    status=mem["status"],
                    pinned=mem["pinned"],
                    entity=entity,
                    sourceSession=session_id,
                    created=mem["created"],
                    updated=mem["updated"],
                    recallCount=mem["recallCount"],
                    lastRecalled=mem["lastRecalled"],
                    missingSource=missing_source,
                )
            )

            # 来源边：仅精确命中原始 sessionId
            if matched_conv is not None:
                edges.append(
                    _edge(mem_id, matched_conv, "source", "memories.source_session")
                )

            # 实体边：节点 id 带 profile，不同 profile 的同名实体绝不合并
            if entity:
                ent_id = "entity:{}:{}".format(profile, short_hash(entity))
                if ent_id not in entity_labels:
                    entity_labels[ent_id] = entity
                    entity_profile[ent_id] = profile
                    entity_sources[ent_id] = set()
                entity_sources[ent_id].add(path)
                edges.append(
                    _edge(mem_id, ent_id, "entity", "memories.entity")
                )

            # 种类 hub：同样按 profile 隔离
            if kind:
                kind_id = "kind:{}:{}".format(profile, short_hash(kind))
                if kind_id not in kind_labels:
                    kind_labels[kind_id] = kind
                    kind_profile[kind_id] = profile
                    kind_sources[kind_id] = set()
                kind_sources[kind_id].add(path)
                edges.append(_edge(mem_id, kind_id, "kind", "memories.kind"))

        # ---- 真实过程事件（只来自 events 表） -------------------------
        events, ev_status, ev_error = read_events(path)
        source["eventsStatus"] = ev_status
        source["eventsError"] = ev_error
        source["eventsCount"] = len(events)
        for ev in events:
            key = _mid_key(ev["memory_id"])
            target = memory_index.get(key) if key is not None else None
            if target is not None:
                profile = target["profile"]
                memory_node_id = target["id"]
                attribution = "memory"
                matched = True
            elif key is None:
                # memory_id 为空：如 resolve_signal 这类全局事件，无法归属到 profile
                profile = None
                memory_node_id = None
                attribution = "global"
                matched = False
            else:
                # memory_id 指向已被硬删除/不存在的记忆：保留事件，不猜归属
                profile = None
                memory_node_id = None
                attribution = "missing_memory"
                matched = False

            event_id = ev.get("eventId")
            row_key = event_id if event_id is not None else "row{}".format(ev["order"])
            all_events.append(
                {
                    "id": "ev:{}:{}".format(db_hash, row_key),
                    "eventId": event_id,
                    "databaseId": db_hash,
                    "source": path,
                    "memory_id": ev["memory_id"],
                    "action": plain_text(ev["action"], ACTION_LIMIT),
                    "detail": plain_text(ev["detail"], DETAIL_LIMIT),
                    "created_at": ev["created_at"],
                    "profile": profile,
                    "memoryNodeId": memory_node_id,
                    "matched": matched,
                    "attribution": attribution,
                }
            )

    # 跨库事件排序：时间 → 库 → 库内 id（同库内已按时间正序）
    def _event_sort_key(event: dict):
        event_id = event.get("eventId")
        if isinstance(event_id, int):
            id_key = (0, event_id)
        else:
            id_key = (1, str(event_id))
        return (str(event.get("created_at") or ""), event["databaseId"], id_key)

    all_events.sort(key=_event_sort_key)

    for ent_id, label in entity_labels.items():
        nodes.append(
            _node(
                ent_id,
                ENTITY,
                label,
                "entity",
                sorted(entity_sources[ent_id]),
                entity=label,
                profile=entity_profile[ent_id],
            )
        )
    for kind_id, label in kind_labels.items():
        nodes.append(
            _node(
                kind_id,
                KIND,
                label,
                "kind",
                sorted(kind_sources[kind_id]),
                kind=label,
                profile=kind_profile[kind_id],
            )
        )

    # ---- 去重 + 稳定排序 ------------------------------------------------
    unique_nodes: dict[str, dict] = {}
    for node in nodes:
        unique_nodes.setdefault(node["id"], node)
    node_list = sorted(unique_nodes.values(), key=lambda n: (n["type"], n["id"]))

    unique_edges: dict[str, dict] = {}
    for edge in edges:
        if edge["source"] not in unique_nodes or edge["target"] not in unique_nodes:
            continue  # 悬空边一律丢弃
        unique_edges.setdefault(edge["id"], edge)
    edge_list = sorted(unique_edges.values(), key=lambda e: (e["type"], e["id"]))

    counts = {
        "conversations": sum(1 for n in node_list if n["type"] == CONVERSATION),
        "memories": sum(1 for n in node_list if n["type"] == MEMORY),
        "entities": sum(1 for n in node_list if n["type"] == ENTITY),
        "edges": len(edge_list),
        "projects": sum(1 for n in node_list if n["type"] == PROJECT),
        "kinds": sum(1 for n in node_list if n["type"] == KIND),
    }

    ok_sources = [s for s in db_sources if s["status"] == "ok"]
    memory_available = bool(ok_sources)
    if not memory_available:
        notice = (
            "未发现已保存的记忆数据库；当前展示的是真实对话（星图快照）内容，"
            "没有导入、生成或伪造任何记忆。"
        )
    elif counts["memories"] == 0:
        notice = (
            f"已发现 {len(ok_sources)} 个本地记忆库（只读），但库中没有记忆记录；"
            "当前仅展示真实对话内容。"
        )
    else:
        notice = (
            f"已从 {len(ok_sources)} 个本地记忆库只读导出 {counts['memories']} 条记忆，"
            "对话数据来自真实星图快照。"
        )

    # ---- profiles 汇总（由节点/事件派生，供界面筛选） -------------------
    profile_stats: dict[str, dict] = {}

    def _bucket(name: str) -> dict:
        item = profile_stats.get(name)
        if item is None:
            item = {
                "profile": name,
                "memories": 0,
                "statuses": {},
                "entities": 0,
                "kinds": 0,
                "events": 0,
                "sources": set(),
            }
            profile_stats[name] = item
        return item

    for node in node_list:
        if node["type"] == MEMORY:
            item = _bucket(node["profile"])
            item["memories"] += 1
            status = str(node.get("status") or "active")
            item["statuses"][status] = item["statuses"].get(status, 0) + 1
            if isinstance(node.get("source"), str):
                item["sources"].add(node["source"])
        elif node["type"] in (ENTITY, KIND):
            item = _bucket(node["profile"])
            if node["type"] == ENTITY:
                item["entities"] += 1
            else:
                item["kinds"] += 1
            for source_path in node.get("source") or []:
                item["sources"].add(source_path)

    for event in all_events:
        if event["profile"] is not None:
            _bucket(event["profile"])["events"] += 1

    profiles = []
    for name in sorted(profile_stats):
        item = profile_stats[name]
        profiles.append(
            {
                "profile": name,
                "memories": item["memories"],
                "statuses": dict(sorted(item["statuses"].items())),
                "entities": item["entities"],
                "kinds": item["kinds"],
                "events": item["events"],
                "sources": sorted(item["sources"]),
            }
        )

    # ---- 事件统计 -------------------------------------------------------
    matched_events = sum(1 for e in all_events if e["matched"])
    global_events = sum(1 for e in all_events if e["attribution"] == "global")
    missing_events = sum(1 for e in all_events if e["attribution"] == "missing_memory")
    databases_with_events = sum(
        1
        for s in db_sources
        if s.get("eventsStatus") == EVENTS_OK and s.get("eventsCount", 0) > 0
    )
    event_meta = {
        "perDatabaseLimit": EVENTS_PER_DB,
        "total": len(all_events),
        "matched": matched_events,
        "global": global_events,
        "missingMemory": missing_events,
        "unmatched": global_events + missing_events,
        "databasesWithEvents": databases_with_events,
        "note": (
            "事件仅来自各库 events 表最近 {} 条，按 (created_at, 库内 id) 正序；"
            "不读取 recall_count 反推过程。events 表没有 profile 列，profile 由 memory_id "
            "关联 memories 派生；memory_id 为空或指向不存在记忆的事件保留但不归属 profile。"
            "事件不含 DSH 会话/轮次信息，无法据此断定属于哪次会话。"
        ).format(EVENTS_PER_DB),
    }

    metadata = {
        "version": VERSION,
        "counts": counts,
        "memorySources": db_sources,
        "memoryAvailable": memory_available,
        "notice": notice,
        "stars": stars_meta,
        "defaultDbCandidates": probe_paths,
        "starsSkipped": skipped,
        "extensions": [
            "events",
            "profiles",
            "profileScopedEntityIds",
            "memoryRecallFields",
        ],
        "events": event_meta,
        "profiles": [p["profile"] for p in profiles],
        "profileIsolation": (
            "entity / kind 节点 id 带 profile（entity:<profile>:<hash>），不同 profile 的"
            "同名实体不会合并；同 profile 跨库同名实体仍合并，id 跨库稳定。"
        ),
        "dataBoundary": (
            "事件字段只有 memory_id/action/detail/created_at；不声称事件属于哪个 DSH "
            "会话或轮次，也不写入 DSH 会话。"
        ),
        "redaction": (
            "标题/内容/excerpt/实体名/事件 detail 已做基础脱敏："
            "sk-、api_key/token/password 等赋值、Bearer。"
        ),
        "idScheme": (
            "conversation=conv:<原始sessionId>; "
            "memory=mem:<库路径短sha256>:<profile>:<库内id>; "
            "entity=entity:<profile>:<实体名短sha256>; "
            "kind=kind:<profile>:<kind名短sha256>; "
            "project=project:<项目名短sha256>; "
            "event=ev:<库路径短sha256>:<库内事件id>; "
            "edge=sha256(type|source|target|basis)"
        ),
        "datePolicy": (
            "对话 created/last 保留原始毫秒时间戳；记忆 created/updated/lastRecalled "
            "保留库内 ISO 字符串；事件 created_at 原样保留。"
        ),
    }

    return {
        "version": VERSION,
        "generatedAt": generated,
        "nodes": node_list,
        "edges": edge_list,
        "events": all_events,
        "profiles": profiles,
        "metadata": metadata,
    }


# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------

def render_js(payload: dict) -> str:
    """序列化成可安全嵌入 <script> 的 JS 赋值语句。"""
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    # JSON 字符串内的 < > & 与 Unicode 行分隔符转义，防止提前闭合脚本/换行注入
    body = (
        body.replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    return (
        "/* 自动生成，勿手改。由 exporter/export_memory.py 只读导出。 */\n"
        "window.__MEMORY_NETWORK__ = " + body + ";\n"
    )


def render_json(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def atomic_write_text(path: str | Path, text: str) -> None:
    """同目录临时文件 + os.replace 原子写；失败不留半成品。"""
    target = Path(path)
    if target.is_dir():
        raise UsageError(f"输出路径是目录而不是文件：{abs_path(target)}")
    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=".tmp-", suffix=".part", dir=str(parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, target)
    except BaseException:
        try:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
        finally:
            raise


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="记忆宇宙只读导出器：os 星图快照 + 记忆库 → network-data.js",
        epilog=(
            "示例：python export_memory.py "
            "--stars C:/path/stars/data.js "
            "--db %%USERPROFILE%%\\.human-memory\\memory.db "
            "--output ..\\_lib\\network-data.js"
        ),
    )
    parser.add_argument(
        "--stars", action="append", default=[], metavar="PATH",
        help="星图快照 data.js 路径，可重复指定",
    )
    parser.add_argument(
        "--db", action="append", default=[], metavar="PATH",
        help="记忆库 SQLite 路径，可重复指定；缺省则探测默认路径（不存在即跳过，不创建）",
    )
    parser.add_argument(
        "--output", default=str(DEFAULT_OUTPUT), metavar="PATH",
        help=f"输出 JS 路径（默认：{DEFAULT_OUTPUT}）",
    )
    parser.add_argument(
        "--json-output", default=None, metavar="PATH",
        help="可选：另存一份纯 JSON",
    )
    parser.add_argument(
        "--quiet", action="store_true", help="不打印摘要",
    )
    return parser


def summarize(payload: dict) -> str:
    meta = payload["metadata"]
    counts = meta["counts"]
    lines = [
        f"导出完成：{counts['conversations']} 个对话 / {counts['memories']} 条记忆 / "
        f"{counts['entities']} 个实体 / {counts['edges']} 条边",
        f"memoryAvailable={meta['memoryAvailable']}  {meta['notice']}",
    ]
    event_meta = meta.get("events") or {}
    if event_meta:
        lines.append(
            "事件：{} 条（匹配记忆 {} / 全局 {} / 记忆已不存在 {}；每库最近上限 {}）".format(
                event_meta.get("total", 0),
                event_meta.get("matched", 0),
                event_meta.get("global", 0),
                event_meta.get("missingMemory", 0),
                event_meta.get("perDatabaseLimit", EVENTS_PER_DB),
            )
        )
    for src in meta["memorySources"]:
        state = src["status"]
        detail = f"（{src['error']}）" if src.get("error") else ""
        events_state = src.get("eventsStatus", "missing")
        events_count = src.get("eventsCount", 0)
        lines.append(
            f"  库[{state}] {src['path']} 条数={src['count']}"
            f"{' 显式' if src['explicit'] else ' 默认'}{detail}"
            f" 事件[{events_state}]={events_count}"
        )
    if not meta["memorySources"]:
        lines.append("  （没有找到任何记忆库，仅导出对话）")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not args.stars:
        parser.error("至少需要一个 --stars 路径")

    output = abs_path(args.output)
    json_output = abs_path(args.json_output) if args.json_output else None
    if json_output and os.path.normcase(json_output) == os.path.normcase(output):
        parser.error("--output 与 --json-output 不能是同一个文件")
    if Path(output).is_dir():
        parser.error(f"--output 指向目录：{output}")

    try:
        payload = build_export(args.stars, args.db)
        atomic_write_text(output, render_js(payload))
        if json_output:
            atomic_write_text(json_output, render_json(payload))
    except StarsError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    except UsageError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    if not args.quiet:
        print(summarize(payload))
        print(f"已写入：{output}")
        if json_output:
            print(f"已写入：{json_output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
