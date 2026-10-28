# -*- coding: utf-8 -*-
"""
mcp_test.py — MCP 协议验收（Python 内部跑，不依赖 PowerShell 管道）

PowerShell 5.1 处理 native 程序的 stderr 时不稳定，会把进程输出搅乱，
所以协议测试改为在 Python 里用 subprocess 做，结果更可靠。
"""

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, bool(cond), detail))
    print(f"  {'[OK]  ' if cond else '[FAIL]'} {name}" + (f"  {detail}" if detail else ""))


def main() -> int:
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "smoke", "version": "0"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "ping"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
         "params": {"name": "memory_stats", "arguments": {}}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
         "params": {"name": "memory_recall", "arguments": {"query": "测试一下"}}},
        {"jsonrpc": "2.0", "id": 6, "method": "unknown/method"},
    ]
    payload = "\n".join(json.dumps(m, ensure_ascii=False) for m in msgs) + "\n"

    proc = subprocess.run(
        [sys.executable, "mcp_server.py"],
        input=payload.encode("utf-8"),
        capture_output=True,
        cwd=str(HERE),
        timeout=60,
    )
    out = proc.stdout.decode("utf-8", errors="replace")
    responses = {}
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "id" in msg:
            responses[msg["id"]] = msg

    print("=" * 56)
    print("MCP 协议验收")
    print("=" * 56)

    check("进程正常退出", proc.returncode == 0, f"exit={proc.returncode}")
    check("initialize 返回协议版本",
          responses.get(1, {}).get("result", {}).get("protocolVersion") == "2024-11-05")
    check("initialize 返回服务器名",
          responses.get(1, {}).get("result", {}).get("serverInfo", {}).get("name")
          == "human-like-memory")
    check("ping 有响应", 2 in responses and responses[2].get("result") == {})

    tools = responses.get(3, {}).get("result", {}).get("tools", [])
    names = {t.get("name") for t in tools}
    expect = {"memory_remember", "memory_recall", "memory_list", "memory_pin",
              "memory_sleep", "memory_wake", "memory_stats", "memory_alias",
              "memory_explain", "memory_mood", "memory_update", "memory_delete",
              "memory_resolve", "memory_export"}
    check("工具数量齐全（14 个）", len(tools) == 14, f"{len(tools)} 个")
    missing = expect - names
    check("必需工具都在", not missing, f"缺少 {sorted(missing)}" if missing else "")

    stats_res = responses.get(4, {}).get("result", {})
    check("memory_stats 返回文本",
          bool(stats_res.get("content")) and not stats_res.get("isError"))
    recall_res = responses.get(5, {}).get("result", {})
    check("memory_recall 返回文本",
          bool(recall_res.get("content")) and not recall_res.get("isError"))

    unknown = responses.get(6, {})
    check("未知方法返回标准错误码",
          unknown.get("error", {}).get("code") == -32601,
          f"code={unknown.get('error', {}).get('code')}")

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print("-" * 56)
    print(f"结果：{passed}/{total} 通过")
    for name, ok, detail in results:
        if not ok:
            print(f"  失败：{name}  {detail}")
    print("=" * 56)
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
