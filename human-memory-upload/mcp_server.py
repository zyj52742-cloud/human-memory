# -*- coding: utf-8 -*-
"""
mcp_server.py — 手写 MCP stdio 服务（零 SDK、零第三方依赖）

为什么手写：不装任何包，纯标准库实现 JSON-RPC 2.0 over stdio，
三个必需方法（initialize / tools/list / tools/call）加 ping 即可被
Claude Desktop、Cline、Cursor、DSH 等 MCP 客户端识别。

启动：
    python mcp_server.py
    （或指定库路径：set MEMORY_DB=.../memory.db 后启动）

铁律：stdout 只能输出 JSON-RPC 报文，任何日志/调试一律走 stderr，
否则客户端解析会失败。
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_core as mc  # noqa: E402

SERVER_INFO = {"name": "human-like-memory", "version": "0.1.0"}
PROTOCOL_VERSION = "2024-11-05"

# ---------------------------------------------------------------------------
# 工具定义
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "name": "memory_remember",
        "description": "把一条值得长期记住的信息写入记忆库（分主次存储，重复内容会强化而非重复）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "要记住的内容，一句自然语言"},
                "kind": {"type": "string", "enum": ["fact", "preference", "event", "emotion", "persona"],
                         "description": "记忆类型，可省略，自动判断"},
                "importance": {"type": "number", "description": "重要度 0~1，可省略，自动估算"},
                "trigger_terms": {"type": "array", "items": {"type": "string"},
                                  "description": "唤醒线索词，被提到时更容易想起，可省略"},
                "entity": {"type": "string", "description": "涉及的人或物，可省略"},
                "profile": {"type": "string", "description": "角色/用户分区，默认 default"},
            },
            "required": ["content"],
        },
    },
    {
        "name": "memory_recall",
        "description": "按当前话题召回相关记忆（只返回少量高度相关的，不返回全部历史）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "当前用户说的话或话题"},
                "top_k": {"type": "integer", "description": "最多返回几条，默认 5"},
                "profile": {"type": "string", "description": "角色/用户分区，默认 default"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "memory_list",
        "description": "列出记忆条目（含休眠中的），用于查看记忆库全貌。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["active", "dormant"], "description": "筛选状态，可省略表示全部"},
                "limit": {"type": "integer", "description": "最多列几条，默认 30"},
                "profile": {"type": "string", "description": "角色/用户分区，默认 default"},
            },
        },
    },
    {
        "name": "memory_pin",
        "description": "钉住/取消钉住一条记忆。钉住的记忆永不沉底，每次召回都会考虑它（手动抢救）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "integer", "description": "记忆 id"},
                "pinned": {"type": "boolean", "description": "true 钉住，false 取消，默认 true"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "memory_sleep",
        "description": "手动让一条记忆进入休眠（不删除，只是平时不被唤起）。",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer", "description": "记忆 id"}},
            "required": ["id"],
        },
    },
    {
        "name": "memory_wake",
        "description": "手动把一条休眠记忆救回来（对应“想起来”）。",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer", "description": "记忆 id"}},
            "required": ["id"],
        },
    },
    {
        "name": "memory_stats",
        "description": "查看记忆库统计：总数、活跃、休眠、钉住。",
        "inputSchema": {
            "type": "object",
            "properties": {"profile": {"type": "string", "description": "角色/用户分区，默认 default"}},
        },
    },
    {
        "name": "memory_alias",
        "description": "添加同义词映射，让召回不漏（如 香菜 ↔ 芫荽）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "canonical": {"type": "string", "description": "标准词"},
                "alias": {"type": "string", "description": "同义词"},
            },
            "required": ["canonical", "alias"],
        },
    },
    {
        "name": "memory_explain",
        "description": "查看某条记忆为什么是这个重要度（六个因子的明细）。",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer", "description": "记忆 id"}},
            "required": ["id"],
        },
    },
    {
        "name": "memory_mood",
        "description": "查看近期情绪轨迹：连续低迷天数、趋势、未化解的心结、仍在余波中的事件。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "回看多少天，默认 14"},
                "profile": {"type": "string", "description": "角色/用户分区，默认 default"},
            },
        },
    },
    {
        "name": "memory_update",
        "description": "修改一条记忆的内容，会自动重新评分。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "integer", "description": "记忆 id"},
                "content": {"type": "string", "description": "新内容"},
                "kind": {"type": "string", "description": "新类型，可省略"},
            },
            "required": ["id", "content"],
        },
    },
    {
        "name": "memory_delete",
        "description": "删除一条记忆。默认软删除（仍可查到），hard=true 才彻底删除。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "integer", "description": "记忆 id"},
                "hard": {"type": "boolean", "description": "是否彻底删除，默认 false"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "memory_resolve",
        "description": "人工强制标记某个心结已化解。慎用：正常情况应由时间、表达、状态多路证据自然消退。",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer", "description": "记忆 id"}},
            "required": ["id"],
        },
    },
    {
        "name": "memory_export",
        "description": "把记忆导出成 JSON 备份文件。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "导出文件路径"},
                "profile": {"type": "string", "description": "只导出某个角色，可省略"},
            },
            "required": ["path"],
        },
    },
]


# ---------------------------------------------------------------------------
# 工具实现
# ---------------------------------------------------------------------------

def _text(s: str, is_error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": s}], "isError": is_error}


def call_tool(name: str, args: dict) -> dict:
    profile = args.get("profile", "default") or "default"
    try:
        if name == "memory_remember":
            r = mc.remember(
                content=args["content"],
                kind=args.get("kind"),
                importance=args.get("importance"),
                trigger_terms=args.get("trigger_terms"),
                entity=args.get("entity", ""),
                profile=profile,
            )
            if not r.get("ok"):
                return _text(f"未记忆：{r.get('reason')}", is_error=False)
            verb = "已强化" if r["action"] == "strengthened" else "已记住"
            return _text(f"{verb} #{r['id']}（重要度 {r['importance']:.2f}，类型 {r.get('kind','')}）")

        if name == "memory_recall":
            items = mc.recall(args["query"], top_k=int(args.get("top_k", 5)), profile=profile)
            if not items:
                return _text("（没有相关的记忆被唤起）")
            body = mc.render_for_prompt(items)
            woke = [i for i in items if i.get("woke")]
            tail = f"\n\n（其中 {len(woke)} 条是刚从休眠中被线索唤醒的）" if woke else ""
            return _text(f"唤起了 {len(items)} 条相关记忆：\n{body}{tail}")

        if name == "memory_list":
            rows = mc.list_memories(status=args.get("status"), profile=profile,
                                    limit=int(args.get("limit", 30)))
            if not rows:
                return _text("（记忆库为空）")
            lines = [
                f"#{r['id']} [{r['status']}{'·钉住' if r['pinned'] else ''}] "
                f"重要{r['importance']:.2f} 权重{r['weight']:.2f} {r['age']} | {r['content']}"
                for r in rows
            ]
            return _text("\n".join(lines))

        if name == "memory_pin":
            r = mc.set_pinned(int(args["id"]), bool(args.get("pinned", True)))
            return _text(f"#{args['id']} {'已钉住' if r.get('pinned') else '已取消钉住'}" if r.get("ok")
                         else f"失败：{r.get('reason')}")

        if name == "memory_sleep":
            r = mc.set_status(int(args["id"]), "dormant")
            return _text(f"#{args['id']} 已转入休眠（内容保留，可随时唤醒）" if r.get("ok")
                         else f"失败：{r.get('reason')}")

        if name == "memory_wake":
            r = mc.set_status(int(args["id"]), "active")
            return _text(f"#{args['id']} 已唤醒" if r.get("ok") else f"失败：{r.get('reason')}")

        if name == "memory_stats":
            s = mc.stats(profile=profile)
            return _text(f"总 {s['total']} 条｜活跃 {s['active']}｜休眠 {s['dormant']}｜钉住 {s['pinned']}")

        if name == "memory_alias":
            mc.add_alias(args["canonical"], args["alias"])
            return _text(f"已建立同义词映射：{args['canonical']} ↔ {args['alias']}")

        if name == "memory_explain":
            return _text(mc.explain_memory(int(args["id"])))

        if name == "memory_mood":
            text = mc.recent_mood_summary(days=int(args.get("days", 14)), profile=profile)
            return _text(text)

        if name == "memory_update":
            r = mc.update_memory(int(args["id"]), content=args["content"],
                                 kind=args.get("kind"))
            return _text(f"#{args['id']} 已更新，重新评分为 {r.get('importance', '?')}"
                         if r.get("ok") else f"失败：{r.get('reason')}")

        if name == "memory_delete":
            r = mc.delete_memory(int(args["id"]), hard=bool(args.get("hard", False)))
            if not r.get("ok"):
                return _text(f"失败：{r.get('reason')}")
            return _text(f"#{args['id']} 已{'彻底删除' if r['hard'] else '软删除'}")

        if name == "memory_resolve":
            r = mc.set_resolved(int(args["id"]), True)
            return _text(f"#{args['id']} 已人工标记为化解" if r.get("ok")
                         else f"失败：{r.get('reason')}")

        if name == "memory_export":
            r = mc.export_json(args["path"], profile=args.get("profile"))
            return _text(f"已导出 {r['count']} 条到 {r['path']}")

        return _text(f"未知工具：{name}", is_error=True)
    except KeyError as e:
        return _text(f"缺少参数：{e}", is_error=True)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(traceback.format_exc())
        sys.stderr.flush()
        return _text(f"工具执行出错：{e}", is_error=True)


# ---------------------------------------------------------------------------
# JSON-RPC 主循环
# ---------------------------------------------------------------------------

def handle(msg: dict) -> dict | None:
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    # 通知类消息不需要回复
    if msg_id is None:
        return None

    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": msg_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
            },
        }

    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}

    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}

    if method == "tools/call":
        name = params.get("name", "")
        args = params.get("arguments") or {}
        result = call_tool(name, args)
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    return {
        "jsonrpc": "2.0", "id": msg_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> None:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.write(f"[human-memory] MCP server started, db={mc.DEFAULT_DB}\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            resp = {"jsonrpc": "2.0", "id": None,
                    "error": {"code": -32700, "message": "Parse error"}}
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue

        resp = handle(msg)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
