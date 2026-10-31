# -*- coding: utf-8 -*-
"""tests/test_universe.py — 记忆宇宙技能回归测试。

覆盖：
  1. 干净目录跑 demo，能导出两个页面，有非零合成记忆与来源边；
  2. export 前后数据库文件与表内容保持不变，且不创建缺失的库；
  3. 不同 profile 隔离（universe.py 与 memcli.py 两条入口）；
  4. 路径含中文与空格；
  5. 把技能目录单独复制走、没有 DSH / 没有真实 HOME 时可运行；
  6. open 在页面缺失时如实报错，--print-only 只打印路径。

运行：python -m unittest discover -s tests -v
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import unittest
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SKILL = REPO / "skills" / "memory-universe"
UNIVERSE = SKILL / "scripts" / "universe.py"
MEMCLI = SKILL / "scripts" / "memcli.py"
TMP_ROOT = REPO / "tests" / "_tmp"

LLM_KEYS = ("MEMORY_LLM_BASE_URL", "MEMORY_LLM_API_KEY", "MEMORY_LLM_MODEL")


def _clean_env(extra: dict | None = None) -> dict:
    env = os.environ.copy()
    for key in LLM_KEYS + ("MEMORY_DB", "MEMORY_ALLOW_LLM", "DSH_HOME"):
        env.pop(key, None)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    if extra:
        env.update(extra)
    return env


def run_cli(
    script: Path,
    *args: str,
    cwd: Path | None = None,
    env: dict | None = None,
    timeout: int = 180,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(script), *map(str, args)],
        cwd=str(cwd or REPO),
        env=_clean_env(env),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def read_js_object(path: Path) -> dict:
    """读取 window.__XXX__ = {...}; 形式的生成本地 JS 数据。"""
    text = path.read_text(encoding="utf-8")
    start = text.index("{")
    end = text.rindex("}")
    return json.loads(text[start:end + 1])


def ro_connect(path: Path) -> sqlite3.Connection:
    uri = path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def db_snapshot(path: Path) -> dict:
    """只读快照：文件字节 hash + 每张表的行数与内容 hash。"""
    conn = ro_connect(path)
    try:
        tables = [
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
            if not str(row[0]).startswith("sqlite_")
        ]
        detail = {}
        for table in tables:
            rows = conn.execute(f'SELECT * FROM "{table}" ORDER BY 1').fetchall()
            payload = json.dumps(
                [list(row) for row in rows], ensure_ascii=False, sort_keys=True
            ).encode("utf-8")
            detail[table] = {
                "count": len(rows),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
    finally:
        conn.close()
    return {
        "bytes": hashlib.sha256(path.read_bytes()).hexdigest(),
        "tables": detail,
    }


def checkpoint(db: Path) -> None:
    """把 WAL 合并回主库，便于做字节级前后对比。"""
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.commit()
    finally:
        conn.close()


class UniverseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        TMP_ROOT.mkdir(parents=True, exist_ok=True)
        cls.base = TMP_ROOT / ("run-" + uuid.uuid4().hex[:8])
        cls.base.mkdir(parents=True)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.base, ignore_errors=True)
        try:
            TMP_ROOT.rmdir()
        except OSError:
            pass

    def path(self, *parts: str) -> Path:
        return self.base.joinpath(*parts)

    # ------------------------------------------------------------------
    # 1. demo：两页、合成数据、来源边、演示标记
    # ------------------------------------------------------------------
    def test_demo_builds_two_views_with_synthetic_data(self) -> None:
        out = self.path("demo 输出")
        sentinel = self.path("不应被创建的库.db")
        proc = run_cli(
            UNIVERSE,
            "demo",
            "--output", str(out),
            env={"MEMORY_DB": str(sentinel)},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(sentinel.exists(), "demo 不得读取/创建 MEMORY_DB 指向的库")

        for rel in (
            "01-记忆宇宙.html",
            "02-记忆星图.html",
            "USAGE.md",
            "_lib/network-data.js",
            "_lib/data.js",
            "_lib/atlas.js",
            "_lib/atlas.css",
            "_lib/memory-webgl.js",
            "_lib/three.min.js",
            "_lib/tex_procedural.js",
            "data/demo-memory.db",
            "data/demo-stars.json",
        ):
            self.assertTrue((out / rel).is_file(), f"缺少生成文件：{rel}")

        net = read_js_object(out / "_lib" / "network-data.js")
        self.assertTrue(net.get("demo") is True)
        counts = net["metadata"]["counts"]
        self.assertGreaterEqual(counts["conversations"], 8)
        self.assertGreaterEqual(counts["memories"], 10)
        self.assertGreaterEqual(counts["entities"], 3)
        self.assertGreaterEqual(counts["projects"], 2)
        self.assertGreaterEqual(counts["edges"], 10)

        types = {edge["type"] for edge in net["edges"]}
        self.assertIn("source", types, "合成记忆必须有来源边")
        self.assertIn("entity", types)

        memory_nodes = [n for n in net["nodes"] if n["type"] == "memory"]
        self.assertTrue(
            all(str(n.get("content", "")).startswith("【演示·虚构】") for n in memory_nodes),
            "每条演示记忆都要带虚构标记",
        )
        self.assertTrue(net.get("events"), "events 应包含引擎真实写入的过程事件")
        self.assertGreaterEqual(len(net.get("profiles") or []), 2, "demo 应覆盖两个 profile")

        # 页面里的数据库行数必须与导出节点数一致
        conn = ro_connect(out / "data" / "demo-memory.db")
        try:
            rows = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(rows, counts["memories"])

        stars = read_js_object(out / "_lib" / "data.js")
        self.assertTrue(stars.get("demo") is True)
        self.assertGreaterEqual(stars["count"], 8)
        self.assertGreaterEqual(stars["subCount"], 1, "应含派生会话（卫星）")
        star_ids = {s["id"] for s in stars["stars"]}
        self.assertTrue(
            any(s.get("parent") in star_ids for s in stars["stars"] if s.get("parent")),
            "应有能解析到父对话的父子关系",
        )

        network_html = (out / "01-记忆宇宙.html").read_text(encoding="utf-8")
        star_html = (out / "02-记忆星图.html").read_text(encoding="utf-8")
        for html in (network_html, star_html):
            self.assertIn("演示 · 虚构数据", html, "页面必须显示演示标识")
            self.assertIn("demo-chip", html)
            self.assertIn('href="0', html)  # 两页互相链接
            self.assertNotIn("真实数据请用", html, "演示标识不应包含命令提示")
        self.assertIn("tex_procedural.js", star_html)
        self.assertNotIn("tex_atlas.js", star_html)
        self.assertIn("_lib/data.js", star_html)
        self.assertIn("_lib/network-data.js", network_html)

        # 关联网络详情里的“定位到行星”必须指向同目录页面，不能残留旧工程相对路径
        atlas_js = (out / "_lib" / "atlas.js").read_text(encoding="utf-8")
        self.assertIn("02-记忆星图.html?star=", atlas_js)
        self.assertNotIn("../18-", atlas_js)

    # ------------------------------------------------------------------
    # 2. export：只读、不建库、不碰 MEMORY_DB
    # ------------------------------------------------------------------
    def test_export_is_readonly_and_never_creates_db(self) -> None:
        room = self.path("中文 空格 目录")
        room.mkdir()
        db = room / "真实 记忆.db"
        for text in ("我讨厌香菜，闻到就想吐", "我女儿叫小满，今年五岁"):
            r = run_cli(
                UNIVERSE, "remember", text, "--db", str(db), "--profile", "真实"
            )
            self.assertEqual(r.returncode, 0, r.stderr)
        checkpoint(db)
        before = db_snapshot(db)

        stars = room / "星图 快照.json"
        stars.write_text(
            json.dumps(
                {
                    "generatedAt": 1700000000000,
                    "stars": [
                        {"id": "s1", "title": "示例对话", "project": "示例项目"},
                        {"id": "s2", "title": "派生会话", "project": "示例项目",
                         "parent": "s1", "sub": 1},
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        out = room / "导出 结果"
        untouched_default = self.path("默认库不应出现.db")
        proc = run_cli(
            UNIVERSE,
            "export",
            "--db", str(db),
            "--stars", str(stars),
            "--output", str(out),
            env={"MEMORY_DB": str(untouched_default)},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(untouched_default.exists(), "export 不得探测/创建默认库")

        after = db_snapshot(db)
        self.assertEqual(before, after, "导出前后库文件与各表内容必须完全一致")

        net = read_js_object(out / "_lib" / "network-data.js")
        self.assertFalse(net.get("demo"))
        self.assertEqual(net["metadata"]["counts"]["memories"], 2)
        self.assertEqual(net["metadata"]["counts"]["conversations"], 2)
        self.assertTrue((out / "01-记忆宇宙.html").is_file())
        self.assertTrue((out / "02-记忆星图.html").is_file())
        self.assertNotIn("演示 · 虚构数据", (out / "01-记忆宇宙.html").read_text(encoding="utf-8"))

        # 显式指定的库不存在：只标注缺失，不创建
        missing = room / "不存在 的库.db"
        out2 = room / "导出 缺失库"
        proc2 = run_cli(
            UNIVERSE, "export", "--db", str(missing), "--stars", str(stars),
            "--output", str(out2),
        )
        self.assertEqual(proc2.returncode, 0, proc2.stderr)
        self.assertFalse(missing.exists(), "export 不得为缺失的 --db 创建空库")
        self.assertTrue((out2 / "01-记忆宇宙.html").is_file())

        # 只给 --db、不给 --stars：网络页仍导出记忆，行星页为空但不报错
        out3 = room / "仅 数据库"
        proc3 = run_cli(UNIVERSE, "export", "--db", str(db), "--output", str(out3))
        self.assertEqual(proc3.returncode, 0, proc3.stderr)
        net3 = read_js_object(out3 / "_lib" / "network-data.js")
        self.assertEqual(net3["metadata"]["counts"]["memories"], 2)
        self.assertEqual(net3["metadata"]["counts"]["conversations"], 0)
        stars3 = read_js_object(out3 / "_lib" / "data.js")
        self.assertEqual(stars3["count"], 0)
        self.assertTrue((out3 / "02-记忆星图.html").is_file())

    def test_stars_only_export_does_not_read_default_db(self) -> None:
        db = self.path("不应被自动导出的默认库.db")
        write = run_cli(
            UNIVERSE, "remember", "我喜欢紫色风铃花", "--db", str(db)
        )
        self.assertEqual(write.returncode, 0, write.stderr)
        checkpoint(db)
        before = db_snapshot(db)
        stars = self.path("仅星图输入.json")
        stars.write_text(json.dumps({"stars": [
            {"id": "explicit-conversation", "title": "显式选择的对话"}
        ]}, ensure_ascii=False), encoding="utf-8")
        out = self.path("只导出指定星图")
        exported = run_cli(
            UNIVERSE, "export", "--stars", str(stars), "--output", str(out),
            env={"MEMORY_DB": str(db)},
        )
        self.assertEqual(exported.returncode, 0, exported.stderr)
        payload = read_js_object(out / "_lib" / "network-data.js")
        self.assertEqual(payload["metadata"]["counts"]["conversations"], 1)
        self.assertEqual(payload["metadata"]["counts"]["memories"], 0,
                         "只指定星图时不得顺带读入默认个人记忆库")
        self.assertEqual(before, db_snapshot(db))

    # ------------------------------------------------------------------
    # 3. profile 隔离：universe.py 与 memcli.py
    # ------------------------------------------------------------------
    def test_profile_isolation_on_both_clis(self) -> None:
        db = self.path("隔离 测试.db")
        a_text = "【测试】我只喝乌龙茶"
        b_text = "【测试】我只喝普洱茶"
        self.assertEqual(
            run_cli(UNIVERSE, "remember", a_text, "--db", str(db), "--profile", "甲").returncode, 0
        )
        self.assertEqual(
            run_cli(UNIVERSE, "remember", b_text, "--db", str(db), "--profile", "乙").returncode, 0
        )

        a = run_cli(UNIVERSE, "recall", "乌龙茶", "--db", str(db), "--profile", "甲")
        b = run_cli(UNIVERSE, "recall", "普洱茶", "--db", str(db), "--profile", "乙")
        self.assertEqual(a.returncode, 0, a.stderr)
        self.assertEqual(b.returncode, 0, b.stderr)
        self.assertIn("乌龙茶", a.stdout)
        self.assertNotIn("普洱茶", a.stdout, "甲的召回不应串到乙")
        self.assertIn("普洱茶", b.stdout)
        self.assertNotIn("乌龙茶", b.stdout, "乙的召回不应串到甲")

        sa = run_cli(MEMCLI, "--db", str(db), "--profile", "甲", "stats")
        sb = run_cli(MEMCLI, "--db", str(db), "--profile", "乙", "stats")
        self.assertEqual(sa.returncode, 0, sa.stderr)
        self.assertIn("总 1 条", sa.stdout)
        self.assertIn("总 1 条", sb.stdout)

    # ------------------------------------------------------------------
    # 4. 技能单独复制走 + 没有 DSH / 真实 HOME
    # ------------------------------------------------------------------
    def test_standalone_skill_copy_without_dsh(self) -> None:
        skill_copy = self.path("独立 技能", "memory-universe")
        shutil.copytree(
            SKILL,
            skill_copy,
            ignore=shutil.ignore_patterns("demo", "__pycache__", "*.pyc"),
        )
        fake_home = self.path("假 HOME 目录")
        fake_home.mkdir()
        out = self.path("独立 输出")
        env = {
            "HOME": str(fake_home),
            "USERPROFILE": str(fake_home),
            "APPDATA": str(fake_home),
            "LOCALAPPDATA": str(fake_home),
        }
        proc = run_cli(
            skill_copy / "scripts" / "universe.py",
            "demo",
            "--output", str(out),
            cwd=fake_home,
            env=env,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((out / "02-记忆星图.html").is_file())
        self.assertTrue((out / "_lib" / "network-data.js").is_file())
        self.assertTrue((skill_copy / "LICENSE").is_file(), "技能单独复制时必须带 LICENSE")
        self.assertTrue(
            (skill_copy / "THIRD_PARTY_NOTICES.md").is_file(),
            "技能单独复制时必须带第三方许可说明",
        )
        self.assertFalse(
            (fake_home / ".human-memory" / "memory.db").exists(),
            "独立运行 demo 不得创建默认记忆库",
        )

        # 复制走的技能里不能残留作者本机路径或 DSH 安装路径
        # 关键词拆开拼接，避免本测试文件自身被同一扫描误报。
        forbidden = (
            str(Path.home()),
            "." + "dsh/skills",
            "~/" + ".dsh",
            "DeepSeek-" + "DSH桌面版",
        )
        for path in skill_copy.rglob("*"):
            if path.suffix.lower() not in {".py", ".md", ".js", ".html", ".css"}:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for token in forbidden:
                self.assertNotIn(token, text, f"{path.name} 残留本机路径：{token}")

    # ------------------------------------------------------------------
    # 5. open：只打印 / 页面缺失如实报错
    # ------------------------------------------------------------------
    def test_open_print_only_and_missing_page(self) -> None:
        out = self.path("open 演示")
        proc = run_cli(UNIVERSE, "demo", "--output", str(out))
        self.assertEqual(proc.returncode, 0, proc.stderr)

        printed = run_cli(UNIVERSE, "open", "--output", str(out), "--print-only")
        self.assertEqual(printed.returncode, 0, printed.stderr)
        target = Path(printed.stdout.strip())
        self.assertTrue(target.is_file())
        self.assertEqual(target.name, "01-记忆宇宙.html")

        stars = run_cli(
            UNIVERSE, "open", "--output", str(out), "--page", "stars", "--print-only"
        )
        self.assertEqual(stars.returncode, 0, stars.stderr)
        self.assertEqual(Path(stars.stdout.strip()).name, "02-记忆星图.html")

        missing = run_cli(UNIVERSE, "open", "--output", str(self.path("没有 页面")))
        self.assertNotEqual(missing.returncode, 0, "页面不存在时不能返回成功")
        self.assertIn("页面不存在", missing.stderr)

    # ------------------------------------------------------------------
    # 6. 技能内引擎可独立完成一轮读写
    # ------------------------------------------------------------------
    def test_bundled_engine_roundtrip(self) -> None:
        db = self.path("引擎 独立.db")
        w = run_cli(
            UNIVERSE, "remember", "我习惯在周末整理书架", "--db", str(db), "--profile", "独立"
        )
        self.assertEqual(w.returncode, 0, w.stderr)
        self.assertIn("[记住]", w.stdout)
        r = run_cli(UNIVERSE, "recall", "整理书架", "--db", str(db), "--profile", "独立")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("整理书架", r.stdout)


    def test_deleted_memory_stays_excluded_on_all_clis(self) -> None:
        for index, script in enumerate((
            REPO / "memcli.py",
            REPO / "skills" / "memory" / "scripts" / "memcli.py",
            MEMCLI,
        )):
            with self.subTest(script=str(script)):
                db = self.path(f"忘记命令-{index}.db")
                env = {"MEMORY_DB": str(db)}
                written = run_cli(script, "add", "我喜欢紫色风铃花", env=env)
                self.assertEqual(written.returncode, 0, written.stderr)
                conn = sqlite3.connect(db)
                try:
                    mid = conn.execute("SELECT id FROM memories").fetchone()[0]
                finally:
                    conn.close()
                deleted = run_cli(script, "delete", str(mid), env=env)
                self.assertEqual(deleted.returncode, 0, deleted.stdout + deleted.stderr)
                recalled = run_cli(script, "recall", "紫色风铃花", env=env)
                self.assertEqual(recalled.returncode, 0, recalled.stderr)
                self.assertNotIn("紫色风铃花", recalled.stdout)
                conn = ro_connect(db)
                try:
                    status = conn.execute("SELECT status FROM memories WHERE id=?", (mid,)).fetchone()[0]
                    self.assertEqual(status, "deleted")
                finally:
                    conn.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
