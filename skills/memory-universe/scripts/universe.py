#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""universe.py — 记忆宇宙便携 CLI（skills/memory-universe）

子命令
------
  demo     生成一套虚构示例：SQLite 记忆库 + 星图快照 + 两个可离线打开的页面
  export   从真实的 human-memory SQLite 库和/或星图快照只读导出两个页面
  open     打开已生成的本地页面（浏览器不可用会如实报告路径，不谎报成功）
  remember 写一条记忆（显式 --db / --profile，不动默认库）
  recall   召回相关记忆（显式 --db / --profile，不动默认库）

设计约束
--------
* 只用 Python 标准库；不需要 DSH、不需要联网、不需要安装第三方包。
* demo 全程使用显式临时库，绝不读写 ``~/.human-memory/memory.db``。
* export 只对显式 ``--db`` 使用 SQLite URI ``mode=ro`` + ``PRAGMA query_only=1``，
  不建库、不迁移、不唤醒、不写回。
* 默认剥离可选的模型抽取环境变量（MEMORY_LLM_*），避免 demo / 测试误联网；
  用户显式传 ``--enable-llm`` 或设置 ``MEMORY_ALLOW_LLM=1`` 时才保留。
* 页面里的演示横幅与「演示·虚构」前缀只由 demo 注入，export 不注入。

用法示例（在本技能目录内）::

    python scripts/universe.py demo
    python scripts/universe.py open
    python scripts/universe.py export --db "C:/path/memory.db" \
        --stars "C:/path/data.js" --output "C:/path/out"
    python scripts/universe.py remember "我讨厌香菜" --db "C:/tmp/t.db" --profile demo
    python scripts/universe.py recall "晚饭吃什么" --db "C:/tmp/t.db" --profile demo
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent          # .../skills/memory-universe/scripts
SKILL_DIR = HERE.parent                          # .../skills/memory-universe
ASSETS = SKILL_DIR / "assets"
LIB = ASSETS / "_lib"
DEMO_DIR = SKILL_DIR / "demo"

PAGES = {
    "network": "01-记忆宇宙.html",
    "stars": "02-记忆星图.html",
}
STATIC_ASSETS = (
    "atlas.js",
    "atlas.css",
    "atlas-groups.js",
    "atlas-memory.js",
    "body-guide.js",
    "body-catalog.png",
    "three.min.js",
    "memory-webgl.js",
    "tex_procedural.js",
)
DEMO_DB_NAME = "demo-memory.db"

VERSION = "0.6.0a2"

LLM_ENV_KEYS = ("MEMORY_LLM_BASE_URL", "MEMORY_LLM_API_KEY", "MEMORY_LLM_MODEL")


def _disable_optional_llm() -> None:
    """把可选模型抽取的配置从当前进程环境里移除（不写回系统环境）。"""
    for key in LLM_ENV_KEYS:
        os.environ.pop(key, None)


# 必须在 import memory_core 之前处理：extractor 在调用时读取环境变量
if "--enable-llm" not in sys.argv and os.environ.get("MEMORY_ALLOW_LLM") != "1":
    _disable_optional_llm()

sys.path.insert(0, str(HERE))
import export_memory as exporter  # noqa: E402
import memory_core as mc  # noqa: E402


# --------------------------------------------------------------------------
# 通用小工具
# --------------------------------------------------------------------------

def _now_ms() -> int:
    return int(time.time() * 1000)


def _iso_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _write_text(path: Path, text: str) -> None:
    exporter.atomic_write_text(path, text)


def _render_stars_js(payload: dict) -> str:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    body = (
        body.replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    return (
        "/* 自动生成，勿手改。由 skills/memory-universe/scripts/universe.py 生成。 */\n"
        "window.__STAR_DATA__ = " + body + ";\n"
    )


BANNER_HTML = (
    '<span class="demo-chip" '
    'title="本页对话、记忆、事件均为合成示例，不是真实数据">'
    "演示 · 虚构数据</span>"
)
TITLE_SUFFIX_DEMO = "（演示·虚构）"


# --------------------------------------------------------------------------
# 页面输出
# --------------------------------------------------------------------------

def _copy_static(out_dir: Path) -> None:
    lib = out_dir / "_lib"
    lib.mkdir(parents=True, exist_ok=True)
    for name in STATIC_ASSETS:
        source = LIB / name
        if not source.is_file():
            raise SystemExit(f"技能资产缺失：{source}（请重新获取完整的 skills/memory-universe）")
        shutil.copyfile(source, lib / name)


def _write_pages(out_dir: Path, demo: bool) -> None:
    replacements = {
        "{{DEMO_BANNER}}": BANNER_HTML if demo else "",
        "{{TITLE_SUFFIX}}": TITLE_SUFFIX_DEMO if demo else "",
        "{{DEMO_FLAG}}": "<script>window.__MEMORY_DEMO__=true;</script>" if demo else "",
    }
    for template_name, page_name in (
        ("memory-universe.html", PAGES["network"]),
        ("memory-starmap.html", PAGES["stars"]),
    ):
        template = ASSETS / template_name
        if not template.is_file():
            raise SystemExit(f"技能资产缺失：{template}")
        text = template.read_text(encoding="utf-8")
        for key, value in replacements.items():
            text = text.replace(key, value)
        _write_text(out_dir / page_name, text)


def _copy_usage(out_dir: Path, demo: bool) -> None:
    source = ASSETS / "USAGE.md"
    if not source.is_file():
        return
    text = source.read_text(encoding="utf-8")
    if demo:
        text = text.replace("{{MODE}}", "demo（虚构示例）")
    else:
        text = text.replace("{{MODE}}", "export（你的真实数据）")
    _write_text(out_dir / "USAGE.md", text)


def _prepare_out_dir(out_dir: Path, *, force: bool) -> None:
    if out_dir.exists() and any(out_dir.iterdir()) and not force:
        raise SystemExit(
            f"输出目录已存在且非空：{out_dir}\n"
            "为避免覆盖，请换一个目录，或显式加 --force 覆盖同名生成文件（不会删除其他文件）。"
        )
    out_dir.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------
# 星图快照
# --------------------------------------------------------------------------

STAR_FIELDS = (
    "id", "title", "cwd", "project", "created", "last", "turns", "u", "a",
    "lines", "firstUser", "firstAsst", "sub", "parent", "depth", "tk",
)


def build_stars_payload(stars_paths: list[str], *, demo: bool = False) -> dict:
    """把 data.js / JSON 快照整理成页面要的 __STAR_DATA__ 结构。"""
    stars: list[dict] = []
    seen: set[str] = set()
    sources: list[str] = []
    for raw_path in stars_paths:
        path = exporter.abs_path(raw_path)
        obj = exporter.load_stars_file(path)  # 失败抛 StarsError
        sources.append(path)
        for star in exporter.iter_stars(obj):
            if not isinstance(star, dict):
                continue
            sid = star.get("id")
            if sid is None or str(sid).strip() == "":
                continue
            sid = str(sid)
            if sid in seen:
                continue
            seen.add(sid)
            item = {key: star.get(key) for key in STAR_FIELDS if key in star}
            item["id"] = sid
            stars.append(item)

    projects: dict[str, int] = {}
    for star in stars:
        project = str(star.get("project") or "未分组")
        projects[project] = projects.get(project, 0) + 1

    main_count = sum(1 for s in stars if not s.get("sub"))
    return {
        "generatedAt": _now_ms(),
        "source": sources[0] if sources else ("demo://synthetic" if demo else "未提供星图快照"),
        "count": len(stars),
        "mainCount": main_count,
        "subCount": len(stars) - main_count,
        "projects": dict(sorted(projects.items(), key=lambda kv: -kv[1])),
        "stars": stars,
        "archived": [],
        "demo": bool(demo),
    }


def write_stars(out_dir: Path, payload: dict) -> Path:
    target = out_dir / "_lib" / "data.js"
    _write_text(target, _render_stars_js(payload))
    return target


# --------------------------------------------------------------------------
# 网络数据
# --------------------------------------------------------------------------

def build_network(
    stars_paths: list[str], db_paths: list[str], *, demo: bool = False
) -> dict:
    payload = exporter.build_export(list(stars_paths), list(db_paths))
    counts = payload["metadata"]["counts"]
    if demo:
        payload["demo"] = True
        payload["metadata"]["demo"] = True
        payload["metadata"]["notice"] = (
            "演示模式：对话、记忆、实体与事件全部由 universe.py demo 合成，"
            "不是任何真实用户的数据。"
        )
        payload["metadata"]["stars"] = [
            {
                "path": "demo://synthetic",
                "generatedAt": payload.get("generatedAt"),
                "source": "demo",
            }
        ]
        payload["metadata"]["dataBoundary"] = (
            "演示数据只写入本次显式指定的临时库和输出目录；不读取、不写入 "
            "~/.human-memory/memory.db。"
        )
    else:
        payload["demo"] = False
    payload["metadata"]["counts"] = counts
    return payload


def write_network(out_dir: Path, payload: dict) -> Path:
    target = out_dir / "_lib" / "network-data.js"
    _write_text(target, exporter.render_js(payload))
    return target


def summarize_network(payload: dict) -> str:
    meta = payload["metadata"]
    counts = meta["counts"]
    return (
        f"{counts['conversations']} 个对话 / {counts['memories']} 条记忆 / "
        f"{counts['entities']} 个实体 / {counts['projects']} 个项目 / "
        f"{counts['edges']} 条关系 / {len(payload.get('events') or [])} 条真实过程事件"
    )


# --------------------------------------------------------------------------
# demo：虚构数据
# --------------------------------------------------------------------------

DEMO_PROFILE_A = "演示·小满"
DEMO_PROFILE_B = "演示·阿岚"

# (profile, session_id, kind, entity, content)
DEMO_MEMORIES = [
    (DEMO_PROFILE_A, "demo-session-01", "preference", "香菜", "【演示·虚构】我讨厌香菜，闻到就想吐。"),
    (DEMO_PROFILE_A, "demo-session-01", "preference", "香草", "【演示·虚构】我喜欢在阳台上种薄荷和罗勒。"),
    (DEMO_PROFILE_A, "demo-session-02", "goal", "拿手菜", "【演示·虚构】明年想学会做三道拿手菜。"),
    (DEMO_PROFILE_A, "demo-session-03", "event", "采购清单", "【演示·虚构】上周的采购清单还差两样没买。"),
    (DEMO_PROFILE_A, "demo-session-05", "identity", "杭州", "【演示·虚构】我住在杭州，周末常去河边散步。"),
    (DEMO_PROFILE_A, "demo-session-05", "fact", "花粉", "【演示·虚构】我对花粉过敏，春天出门要戴口罩。"),
    (DEMO_PROFILE_A, "demo-session-05", "boundary", "", "【演示·虚构】我把每周三晚上留给自己，不安排工作。"),
    (DEMO_PROFILE_A, "demo-session-07", "relationship", "小满", "【演示·虚构】我女儿叫小满，今年五岁，在学钢琴。"),
    (DEMO_PROFILE_A, "demo-session-08", "event", "外婆", "【演示·虚构】外婆的相册里有张 1987 年的合影。"),
    (DEMO_PROFILE_A, "demo-session-10", "preference", "纸质书", "【演示·虚构】我更喜欢纸质书，不太习惯看电子书。"),
    (DEMO_PROFILE_A, "demo-session-12", "mood", "", "【演示·虚构】今天加班到十点，累死了。"),
    (DEMO_PROFILE_A, "demo-session-12", "mood", "", "【演示·虚构】最近连续几天睡不好，心里有点闷。"),
    (DEMO_PROFILE_A, "demo-session-12", "grudge", "同事", "【演示·虚构】我还在生同事的气，上周开会他当众打断我。"),
    (DEMO_PROFILE_B, "demo-session-05", "identity", "阿岚", "【演示·虚构】我叫阿岚，在做城市植物观察。"),
    (DEMO_PROFILE_B, "demo-session-05", "preference", "门牌", "【演示·虚构】我喜欢拍老房子的门牌。"),
    (DEMO_PROFILE_B, "demo-session-05", "goal", "苏州", "【演示·虚构】下周要去苏州看园林。"),
    (DEMO_PROFILE_B, "demo-session-10", "mood", "", "【演示·虚构】今天被雨淋了，有点烦。"),
    (DEMO_PROFILE_B, "demo-session-11", "relationship", "豆豆", "【演示·虚构】我养了一只叫豆豆的橘猫。"),
    (DEMO_PROFILE_B, "demo-session-11", "habit", "早睡", "【演示·虚构】我习惯在十一点前关灯睡觉。"),
]

DEMO_RECALLS = [
    (DEMO_PROFILE_A, "晚饭做点什么"),
    (DEMO_PROFILE_A, "小满最近怎么样"),
    (DEMO_PROFILE_A, "我最近状态"),
    (DEMO_PROFILE_B, "周末去哪里"),
    (DEMO_PROFILE_B, "豆豆"),
]


def _demo_stars(now_ms: int) -> list[dict]:
    day = 86400 * 1000

    def conv(sid, title, project, days_ago, parent="", sub=0, depth=0, turns=6):
        created = now_ms - days_ago * day
        return {
            "id": sid,
            "title": "【演示·虚构】" + title,
            "cwd": "demo://" + project,
            "project": project,
            "created": created,
            "last": created + 3600 * 1000,
            "turns": turns,
            "u": turns // 2,
            "a": turns - turns // 2,
            "lines": turns * 12,
            "firstUser": "这是虚构示例对话，用于演示「记忆宇宙」的两个视图。",
            "firstAsst": "示例回答：数据全部为合成内容，可安全删除。",
            "sub": sub,
            "parent": parent,
            "depth": depth,
            "tk": "demo",
        }

    projects = [
        ("演示项目 · 花园改造", 1),
        ("演示项目 · 城市漫步", 2),
        ("演示项目 · 家庭相册", 1),
        ("演示项目 · 生活节奏", 1),
    ]
    stars = [
        conv("demo-session-01", "给阳台换一盆香草", projects[0][0], 3),
        conv("demo-session-02", "周末菜谱候选", projects[0][0], 3, turns=8),
        conv("demo-session-03", "整理上周的采购清单", projects[0][0], 4),
        conv("demo-session-04", "把清单做成表格", projects[0][0], 4,
             parent="demo-session-03", sub=1, depth=1, turns=3),
        conv("demo-session-05", "周三下班后的散步路线", projects[1][0], 2, turns=10),
        conv("demo-session-06", "沿河那条路有没有长椅", projects[1][0], 2),
        conv("demo-session-07", "给旧照片写说明", projects[2][0], 6),
        conv("demo-session-08", "外婆的相册顺序", projects[2][0], 6, turns=7),
        conv("demo-session-09", "把照片按年份归档", projects[2][0], 5,
             parent="demo-session-07", sub=1, depth=1, turns=4),
        conv("demo-session-10", "雨天在家听的歌单", projects[1][0], 1),
        conv("demo-session-11", "下周想早睡三天", projects[3][0], 1),
        conv("demo-session-12", "记一下今天的心情", projects[3][0], 0, turns=5),
    ]
    return stars


def _seed_demo_db(db_path: Path) -> dict:
    """用引擎真实 API 写入虚构记忆，返回统计。事件由引擎真实产生。"""
    stats = {"memories": 0, "events": 0, "ids": []}
    for profile, session_id, kind, entity, content in DEMO_MEMORIES:
        result = mc.remember(
            content,
            kind=kind,
            entity=entity,
            profile=profile,
            session_id=session_id,
            db_path=db_path,
        )
        if result.get("ok") and result.get("id"):
            stats["ids"].append((profile, result["id"]))

    # 真实调用 recall / sleep / wake / pin，让 events 表出现真实过程事件
    for profile, query in DEMO_RECALLS:
        try:
            mc.recall(query, top_k=3, profile=profile, db_path=db_path)
        except Exception as exc:  # 演示不应因单次召回失败而中断
            print(f"[demo] 召回示例跳过：{exc}", file=sys.stderr)

    ids = stats["ids"]
    if ids:
        try:
            mc.set_pinned(ids[0][1], True, db_path=db_path)
            mc.set_status(ids[-1][1], "dormant", db_path=db_path)
            mc.set_status(ids[-1][1], "active", db_path=db_path)
        except Exception as exc:
            print(f"[demo] 状态示例跳过：{exc}", file=sys.stderr)

    conn = sqlite3.connect(str(db_path))
    try:
        stats["memories"] = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        stats["events"] = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        stats["profiles"] = [
            row[0]
            for row in conn.execute(
                "SELECT DISTINCT profile FROM memories ORDER BY profile"
            ).fetchall()
        ]
    finally:
        conn.close()
    return stats


def _copy_db(src: Path, dst: Path) -> None:
    """用 SQLite backup API 拷一份干净的单文件库，避免把 -wal/-shm 带出去。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    source_conn = sqlite3.connect(str(src))
    dest_conn = sqlite3.connect(str(dst))
    try:
        source_conn.backup(dest_conn)
        dest_conn.execute("PRAGMA journal_mode=DELETE")
        dest_conn.commit()
    finally:
        dest_conn.close()
        source_conn.close()


def cmd_demo(args: argparse.Namespace) -> int:
    _disable_optional_llm()  # demo 永远离线、可复现
    out_dir = Path(args.output).expanduser().resolve() if args.output else DEMO_DIR.resolve()
    _prepare_out_dir(out_dir, force=args.force)

    now_ms = _now_ms()
    stars = _demo_stars(now_ms)

    # 临时库放在输出目录内：显式、可删除、不依赖系统临时目录权限。
    build_dir = out_dir / ".demo-build"
    if build_dir.exists():
        shutil.rmtree(build_dir, ignore_errors=True)
    build_dir.mkdir(parents=True)
    try:
        tmp_db = build_dir / "demo.db"
        stats = _seed_demo_db(tmp_db)

        data_dir = out_dir / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        _copy_db(tmp_db, data_dir / DEMO_DB_NAME)
        _write_text(
            data_dir / "demo-stars.json",
            json.dumps(
                {
                    "generatedAt": now_ms,
                    "source": "demo://synthetic",
                    "note": "虚构示例对话，供演示与测试；不是真实用户数据。",
                    "stars": stars,
                    "archived": [],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
        )
    finally:
        shutil.rmtree(build_dir, ignore_errors=True)

    # 用输出目录里最终落盘的两份数据做导出：来源路径稳定、可复查，
    # 也顺带验证“导出的就是随 demo 一起交付的那份库”。
    network = build_network(
        [str(out_dir / "data" / "demo-stars.json")],
        [str(out_dir / "data" / DEMO_DB_NAME)],
        demo=True,
    )
    _copy_static(out_dir)
    write_network(out_dir, network)
    stars_payload = build_stars_payload(
        [str(out_dir / "data" / "demo-stars.json")], demo=True
    )
    write_stars(out_dir, stars_payload)
    _write_pages(out_dir, demo=True)
    _copy_usage(out_dir, demo=True)

    print("记忆宇宙 · 演示数据已生成（全部为虚构内容）")
    print(f"  输出目录：{out_dir}")
    print(f"  记忆库：  {out_dir / 'data' / DEMO_DB_NAME}")
    print(f"  关联网络：{out_dir / PAGES['network']}")
    print(f"  真实行星：{out_dir / PAGES['stars']}")
    print(
        "  数据规模：{}；profile：{}；事件 {} 条（由引擎真实写入）".format(
            summarize_network(network),
            " / ".join(stats.get("profiles") or []),
            stats["events"],
        )
    )
    print("  提示：demo 不会读取或写入 ~/.human-memory/memory.db。")
    if args.open:
        return _open_page(out_dir, "network", print_only=False)
    print(f"  打开：python scripts/universe.py open --output \"{out_dir}\"")
    return 0


# --------------------------------------------------------------------------
# export：真实数据
# --------------------------------------------------------------------------

def cmd_export(args: argparse.Namespace) -> int:
    if not args.db and not args.stars:
        print("错误：至少给一个 --db 记忆库或 --stars 星图快照（不会自动探测默认库）",
              file=sys.stderr)
        return 2
    if not args.output:
        print("错误：--output 是必填项", file=sys.stderr)
        return 2

    out_dir = Path(args.output).expanduser().resolve()
    _prepare_out_dir(out_dir, force=args.force)

    for raw in args.db:
        path = Path(raw).expanduser()
        if not path.is_file():
            print(f"提示：数据库不存在，将只标注缺失、不创建：{path.resolve()}", file=sys.stderr)

    try:
        network = build_network(args.stars, args.db, demo=False)
        stars_payload = build_stars_payload(args.stars, demo=False)
    except exporter.StarsError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    except exporter.UsageError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    _copy_static(out_dir)
    network_path = write_network(out_dir, network)
    stars_path = write_stars(out_dir, stars_payload)
    if args.json_output:
        _write_text(
            Path(args.json_output).expanduser().resolve(),
            json.dumps(network, ensure_ascii=False, indent=2) + "\n",
        )
    _write_pages(out_dir, demo=False)
    _copy_usage(out_dir, demo=False)

    print("记忆宇宙 · 导出完成（只读，未修改任何数据库）")
    print(f"  {summarize_network(network)}")
    print(f"  网络数据：{network_path}")
    print(f"  星图数据：{stars_path}")
    print(f"  关联网络：{out_dir / PAGES['network']}")
    print(f"  真实行星：{out_dir / PAGES['stars']}")
    if args.json_output:
        print(f"  JSON 副本：{Path(args.json_output).expanduser().resolve()}")
    if args.open:
        return _open_page(out_dir, "network", print_only=False)
    return 0


# --------------------------------------------------------------------------
# open
# --------------------------------------------------------------------------

def _open_page(out_dir: Path, page: str, *, print_only: bool) -> int:
    target = (out_dir / PAGES[page]).resolve()
    if not target.is_file():
        print(f"错误：页面不存在：{target}", file=sys.stderr)
        print("先运行：python scripts/universe.py demo", file=sys.stderr)
        return 2
    if print_only:
        print(target)
        return 0
    try:
        opened = webbrowser.open(target.as_uri())
    except Exception as exc:  # 无浏览器、无桌面环境等
        print(f"无法自动打开浏览器：{exc}", file=sys.stderr)
        opened = False
    if not opened:
        print("无法自动打开浏览器。请手动打开下面这个本地文件：", file=sys.stderr)
        print(target)
        return 3
    print(f"已在默认浏览器打开：{target}")
    return 0


def cmd_open(args: argparse.Namespace) -> int:
    out_dir = Path(args.output).expanduser().resolve() if args.output else DEMO_DIR.resolve()
    return _open_page(out_dir, args.page, print_only=args.print_only)


# --------------------------------------------------------------------------
# remember / recall
# --------------------------------------------------------------------------

def _db_arg(args: argparse.Namespace) -> Path | None:
    if not args.db:
        return None
    return Path(args.db).expanduser().resolve()


def cmd_remember(args: argparse.Namespace) -> int:
    text = " ".join(args.text).strip()
    if not text:
        print('用法：remember "要记住的话" --db <库路径> [--profile 名称]', file=sys.stderr)
        return 2
    result = mc.remember(
        text,
        profile=args.profile,
        db_path=_db_arg(args),
    )
    if "--enable-llm" in sys.argv:
        print("提示：已显式允许可选模型抽取（需要 MEMORY_LLM_* 环境变量）。",
              file=sys.stderr)
    if not result.get("ok"):
        print(f"未记忆：{result.get('reason')}")
        return 0
    action = result.get("action")
    if action == "strengthened":
        print(f"[加深] 这条已有印象（#{result['id']}）")
    elif action == "resolve_signal":
        print(f"[化解信号] 影响 {result.get('affected', 0)} 个心结，但还没清零")
    else:
        print(
            f"[记住] #{result['id']} 重要度 {result['importance']:.2f} "
            f"类型 {result['kind']}"
        )
    return 0


def cmd_recall(args: argparse.Namespace) -> int:
    query = " ".join(args.query).strip()
    if not query:
        print('用法：recall "当前话题" --db <库路径> [--profile 名称]', file=sys.stderr)
        return 2
    items = mc.recall(
        query,
        top_k=args.top_k,
        profile=args.profile,
        db_path=_db_arg(args),
    )
    if not items:
        print("（没有相关记忆）")
        return 0
    print(mc.render_for_prompt(items))
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _add_output(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--output", default=None, metavar="DIR",
        help="输出目录（demo 默认：技能目录下的 demo/；export 必填）",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="输出目录非空时仍写入同名生成文件（不删除其他文件）",
    )


def _add_db_profile(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--db", default=None, metavar="PATH",
        help="显式 SQLite 库路径（不传则用引擎默认库，仅供旧用法兼容）",
    )
    parser.add_argument(
        "--profile", default="default", metavar="NAME",
        help="聊天对象 / 记忆分区（默认 default）",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="universe.py",
        description="记忆宇宙：类人脑记忆 + 两个离线三维视图（便携 CLI）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python scripts/universe.py demo\n"
            "  python scripts/universe.py open\n"
            "  python scripts/universe.py export --db C:/tmp/memory.db "
            "--stars C:/tmp/data.js --output C:/tmp/universe\n"
        ),
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_demo = sub.add_parser("demo", help="生成虚构示例并导出两个页面（默认离线）")
    _add_output(p_demo)
    p_demo.add_argument("--open", action="store_true", help="生成后尝试打开关联网络页")
    p_demo.set_defaults(func=cmd_demo)

    p_export = sub.add_parser("export", help="从真实库 / 星图快照只读导出两个页面")
    p_export.add_argument("--db", action="append", default=[], metavar="PATH",
                          help="human-memory SQLite 库，可重复指定")
    p_export.add_argument("--stars", action="append", default=[], metavar="PATH",
                          help="星图快照 data.js 或 JSON，可重复指定")
    p_export.add_argument("--output", required=True, metavar="DIR", help="输出目录")
    p_export.add_argument("--json-output", default=None, metavar="PATH",
                          help="可选：另存一份网络数据 JSON")
    p_export.add_argument("--force", action="store_true",
                          help="目录非空时仍写入同名生成文件（不删除其他文件）")
    p_export.add_argument("--open", action="store_true", help="导出后尝试打开关联网络页")
    p_export.set_defaults(func=cmd_export)

    p_open = sub.add_parser("open", help="打开已生成的本地页面")
    p_open.add_argument("--output", default=None, metavar="DIR",
                        help="页面所在目录（默认：技能目录下的 demo/）")
    p_open.add_argument("--page", choices=("network", "stars"), default="network",
                        help="network=关联网络，stars=真实行星")
    p_open.add_argument("--print-only", action="store_true",
                        help="只打印页面绝对路径，不调用浏览器")
    p_open.set_defaults(func=cmd_open)

    p_remember = sub.add_parser("remember", help="写一条记忆（显式库/分区）")
    p_remember.add_argument("text", nargs="+", help="要记住的话")
    _add_db_profile(p_remember)
    p_remember.add_argument("--enable-llm", action="store_true",
                            help="显式允许原项目的可选模型抽取（默认关闭）")
    p_remember.set_defaults(func=cmd_remember)

    p_recall = sub.add_parser("recall", help="召回相关记忆（显式库/分区）")
    p_recall.add_argument("query", nargs="+", help="当前话题或用户的话")
    _add_db_profile(p_recall)
    p_recall.add_argument("--top-k", type=int, default=3, metavar="N")
    p_recall.add_argument("--enable-llm", action="store_true",
                          help="显式允许原项目的可选模型抽取（默认关闭）")
    p_recall.set_defaults(func=cmd_recall)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
