#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""刷新本地网络快照。原始 DSH 会话和 SQLite 只读，写入仅限本成品目录。"""
from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path
import export_memory as exporter
import content_index

ROOT = Path(__file__).resolve().parent.parent
STARMAP = ROOT.parent / 'planets'

def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    db_args = [str(Path(v).expanduser().resolve()) for v in sys.argv[1:] if not v.startswith('--')]
    selection = ROOT / '_lib' / 'memory-source.json'
    if db_args:
        missing = [v for v in db_args if not Path(v).is_file()]
        if missing:
            print('记忆库不存在，未保存路径，也未创建文件：' + '，'.join(missing))
            return 2
        exporter.atomic_write_text(selection, json.dumps({'paths': db_args}, ensure_ascii=False, indent=2))
    elif selection.is_file():
        try:
            db_args = json.loads(selection.read_text(encoding='utf-8')).get('paths', [])
        except (ValueError, OSError):
            print('记忆库路径设置无法读取，本次使用默认路径。')
    try:
        # Read original sessions; write only this project's bounded content index.
        association_stats = content_index.refresh()
        stars = ROOT / '_lib' / 'stars.js'
        if not db_args:
            import dsh_memory
            default = Path(dsh_memory.core().DEFAULT_DB)
            db_args = [str(default)] if default.is_file() else []
        payload = exporter.build_export([str(stars)], db_args)
        payload = content_index.enrich(payload)
        exporter.atomic_write_text(ROOT / '_lib' / 'network-data.js', exporter.render_js(payload))
    except (exporter.StarsError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print('刷新失败，原有快照保留：' + exporter.redact(str(exc)))
        return 1
    print(exporter.summarize(payload))
    print('内容关联：%d 条；索引 %d 条用户消息；耗时 %.2f 秒。' % (association_stats['links'], association_stats['indexedUserMessages'], association_stats['seconds']))
    print('刷新完成。已打开的页面请按 F5。')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
