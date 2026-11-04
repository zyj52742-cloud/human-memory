"""页面记忆管理：仅使用服务端快照中的库、对象与会话，不接收任意路径。"""
from __future__ import annotations
import json
from pathlib import Path
import sys

import dsh_memory
import export_memory


def manage(payload, current=None):
    if not isinstance(payload, dict):
        raise ValueError('请求必须是对象')
    action = payload.get('action')
    if action not in ('remember', 'cancel'):
        raise ValueError('不支持的记忆操作')
    if set(payload) - {'action', 'text', 'profile', 'sessionId', 'databaseId', 'nodeId'}:
        raise ValueError('请求含有不支持的字段')
    current = current if current is not None else dsh_memory.snapshot()
    sources = current.get('metadata', {}).get('memorySources', [])
    nodes = current.get('nodes', [])
    mc = dsh_memory.core()
    if action == 'cancel':
        node_id = payload.get('nodeId')
        node = next((n for n in nodes if n['type'] == 'memory' and n['id'] == node_id), None)
        if node is None:
            raise ValueError('这条记忆已不存在，请刷新后重试')
        db = next((s['path'] for s in sources if s['status'] == 'ok' and s['path'] == node['source']), None)
        if not db or not Path(db).is_file():
            raise ValueError('原记忆库不可用，未取消保存')
        # 同一事务复核 profile/id/status，防止过期页面或同号跨库条目误操作。
        conn = mc.connect(db)
        try:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT profile,status FROM memories WHERE id=?', (node['memoryId'],)).fetchone()
            if row is None or row['profile'] != node['profile'] or row['status'] == 'deleted':
                raise ValueError('记忆已变化，请刷新后重试')
            conn.execute("UPDATE memories SET status='deleted',updated_at=? WHERE id=? AND profile=?",
                         (mc.now_iso(), node['memoryId'], node['profile']))
            conn.execute('DELETE FROM memory_terms WHERE memory_id=?', (node['memoryId'],))
            mc._log(conn, node['memoryId'], 'deleted', '用户在记忆宇宙取消保存（软删除）')
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        return {'ok': True, 'action': 'cancelled', 'nodeId': node_id, 'profile': node['profile']}

    text = payload.get('text', '')
    profile = payload.get('profile', 'default')
    session = payload.get('sessionId', '')
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError('记忆内容需要 1～4000 个字符')
    if not isinstance(profile, str) or not profile.strip() or len(profile) > 120 or any(ord(c) < 32 for c in profile):
        raise ValueError('聊天对象需要 1～120 个字符')
    if not isinstance(session, str) or (session and not any(n['type'] == 'conversation' and n.get('sessionId') == session for n in nodes)):
        raise ValueError('来源会话不在当前记录中，请刷新后重试')
    source_id = payload.get('databaseId', '')
    if source_id and not isinstance(source_id, str):
        raise ValueError('记忆库标识无效')
    if source_id:
        source = next((s for s in sources if export_memory.db_key(s['path']) == source_id), None)
        if not source or source['status'] != 'ok':
            raise ValueError('所选记忆库不可用')
        db = source['path']
    elif sources:
        if len(sources) != 1 or sources[0]['status'] != 'ok':
            raise ValueError('请明确选择一个可用的记忆库')
        db = sources[0]['path']
    else:
        db = str(mc.DEFAULT_DB)
    result = mc.remember(text.strip(), profile=profile.strip(), session_id=session, db_path=db)
    if result.get('id') is not None:
        result['nodeId'] = f"mem:{export_memory.db_key(db)}:{profile.strip()}:{result['id']}"
    return result


def main():
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            raise ValueError('请求内容过长')
        result = manage(json.loads(raw.decode('utf-8')))
    except (ValueError, OSError) as exc:
        result = {'ok': False, 'reason': str(exc)[:200]}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
