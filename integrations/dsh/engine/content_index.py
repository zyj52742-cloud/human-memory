"""Read user-authored DSH messages locally. Original sessions are never opened for writing.

Only explicit refresh creates this bounded index. Status polling just reads the finished
association file, keeping decompression and text analysis out of the rendering loop.
"""
from __future__ import annotations
import hashlib
import io
import os
import json
import re
import subprocess
import time
from pathlib import Path
from compression import zstd
import export_memory as exporter

ROOT = Path(__file__).resolve().parent.parent
SESSIONS = Path(os.environ.get('DSH_SESSIONS_DIR', str(Path.home() / '.dsh' / 'sessions'))).expanduser().resolve()
MAX_MESSAGES = 48
MAX_MESSAGE_CHARS = 1800
INDEX_VERSION = 2


def iter_events(file):
    # Bound each decompressed line; tools/assistant bodies are never used as evidence.
    pending = b''
    try:
        with file.open('rb') as raw, zstd.open(raw, 'rb') as stream:
            while chunk := stream.read(1 << 18):
                pending += chunk
                parts = pending.split(b'\n')
                pending = parts.pop()
                for line in parts:
                    if len(line) <= 16_000_000:
                        yield line
                if len(pending) > 16_000_000:
                    pending = b''
    except (OSError, EOFError, zstd.ZstdError):
        # A live session may end with an incomplete frame; retain complete events.
        pass
    if pending.strip() and len(pending) <= 16_000_000:
        yield pending


def user_text(data):
    if (data.get('source') or {}).get('kind') != 'user':
        return ''
    texts = [b.get('text', '') for b in data.get('content', []) if isinstance(b, dict) and b.get('type') == 'text']
    text = '\n'.join(t for t in texts if isinstance(t, str))
    text = re.sub(r'<(system-reminder|environment_context|instructions|INSTRUCTIONS|app-context)\b[^>]*>[\s\S]*?</\1>', ' ', text, flags=re.I)
    text = re.sub(r'```[\s\S]*?```', ' ', text)
    return exporter.redact(text).strip()


def parse_session(file):
    meta = {}; title = ''; label = ''; messages = []; turns = 0; last = 0; user_count = 0; assistant_count = 0; first_assistant = ''; line_count = 0
    for event_no, line in enumerate(iter_events(file), 1):
        line_count = event_no
        # Reject large tool payloads before JSON decoding.
        head = line[:160]
        timestamp = re.search(rb'"time"\s*:\s*(\d{13})', head)
        if timestamp: last = max(last, int(timestamp[1]))
        if b'"type":"assistant/message"' in head:
            assistant_count += 1
            if first_assistant: continue
        if not any(x in head for x in [b'"type":"session"', b'"type":"session/title"', b'"type":"subagent/descriptor"', b'"type":"user/message"', b'"type":"turn/start"', b'"type":"assistant/message"']):
            continue
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        kind = event.get('type'); data = event.get('data') or {}
        last = max(last, event.get('time') or 0)
        if kind == 'session': meta = event
        elif kind == 'session/title' and data.get('title'): title = exporter.redact(data['title'])[:100]
        elif kind == 'subagent/descriptor': label = exporter.redact(data.get('label') or '')[:100]
        elif kind == 'turn/start': turns += 1
        elif kind == 'assistant/message':
            parts = (data.get('message') or {}).get('content') or []
            first_assistant = exporter.redact(next((b.get('text','') for b in parts if b.get('type')=='text' and b.get('text')), ''))[:160]
        elif kind == 'user/message':
            text = user_text(data)
            if not text: continue
            user_count += 1
            # Keep both beginning and end of long requests, preserving quote offsets per excerpt.
            excerpt = text if len(text) <= MAX_MESSAGE_CHARS else text[:1200] + '\n…\n' + text[-600:]
            messages.append({'text': excerpt, 'turn': user_count, 'event': event_no})
            # Sample start and recent conversation turns, rather than just the first sentence.
            if len(messages) > MAX_MESSAGES: messages.pop(16)
    sid = str(meta.get('id') or file.parent.name)
    title = title or label or (messages[0]['text'][:40] if messages else '未命名对话')
    return {'id': 'conv:' + sid, 'sessionId': sid, 'title': title, 'messages': messages,
            'userMessages': user_count, 'cwd': meta.get('cwd') or '', 'created': meta.get('createdAt') or 0,
            'last': last or meta.get('createdAt') or 0, 'turns': turns or user_count,
            'a':assistant_count, 'u':user_count, 'lines':line_count, 'firstAsst':first_assistant,
            'sub': int(bool(meta.get('parentSession') or meta.get('origin') == 'subagent')),
            'parent': meta.get('parentSession') or '', 'depth': meta.get('delegationDepth') or 0}


def refresh(root=ROOT, sessions=SESSIONS):
    started = time.perf_counter(); index_file = root / '_lib' / 'content-index.json'
    try:
        previous = json.loads(index_file.read_text(encoding='utf-8'))
        old = previous.get('files', {}) if previous.get('version') == INDEX_VERSION else {}
    except (OSError, ValueError): old = {}
    files = {}; errors = []; parsed = 0
    for file in sorted(sessions.rglob('session.v*.jsonl.zstd')):
        try:
            stat = file.stat(); sig = [stat.st_size, stat.st_mtime_ns]; key = str(file)
            if old.get(key, {}).get('signature') == sig:
                files[key] = old[key]; continue
            rec = parse_session(file)
            files[key] = {'signature': sig, 'record': rec}; parsed += 1
        except (OSError, ValueError, TypeError) as exc:
            errors.append({'file': str(file), 'error': type(exc).__name__})
            if str(file) in old: files[str(file)] = old[str(file)]
    if not files: raise ValueError('未能读取任何会话，保留现有索引。')
    by_id = {}
    for item in files.values():
        rec = item['record']; current = by_id.get(rec['id'])
        if current is None or item['signature'][1] > current['signature'][1]: by_id[rec['id']] = item
    records = [v['record'] for v in by_id.values()]
    result = subprocess.run(['node', str(root / 'engine' / 'content_links.cjs')],
                            input=json.dumps(records, ensure_ascii=False), capture_output=True, text=True,
                            encoding='utf-8', timeout=45, check=True)
    associations = json.loads(result.stdout)
    associations['metadata'].update({'parsedFiles': parsed, 'cachedFiles': len(files)-parsed,
        'indexedUserMessages': sum(r['userMessages'] for r in records), 'errors': errors,
        'seconds': round(time.perf_counter()-started, 3)})
    stars = []
    for rec in records:
        parts = [p for p in re.split(r'[\\/]+', rec['cwd']) if p]
        stars.append({k:rec[k] for k in ['title','created','last','turns','sub','parent','depth','u','a','lines','firstAsst']} |
                     {'id':rec['sessionId'], 'project':parts[-1] if parts else '未知',
                      'cwd':rec['cwd'],
                      'firstUser':rec['messages'][0]['text'][:220] if rec['messages'] else ''})
    # Compute everything before atomically replacing finished files. No writes to adjacent projects.
    exporter.atomic_write_text(index_file, json.dumps({'version':INDEX_VERSION,'files':files}, ensure_ascii=False))
    exporter.atomic_write_text(root / '_lib' / 'content-links.json', json.dumps(associations, ensure_ascii=False))
    exporter.atomic_write_text(root / '_lib' / 'stars.js', 'window.__STAR_DATA__=' + json.dumps(
        {'generatedAt':int(time.time()*1000), 'source':str(sessions),'stars':stars,
         'count':len(stars),'mainCount':sum(not s['sub'] for s in stars),'subCount':sum(bool(s['sub']) for s in stars),
         'scanSeconds':associations['metadata']['seconds'],'archived':[],
         'projects':{p:sum(s['project']==p for s in stars) for p in sorted({s['project'] for s in stars})}},
        ensure_ascii=False).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')+';\n')
    return associations['metadata']


def enrich(payload, root=ROOT):
    """Finished index is optional; old graph still works if unavailable or invalid."""
    try: data = json.loads((root / '_lib' / 'content-links.json').read_text(encoding='utf-8'))
    except (OSError, ValueError): return payload
    nodes = {n['id']:n for n in payload['nodes']}
    for node_id, facts in data.get('memberships', {}).items():
        if node_id in nodes and nodes[node_id]['type'] == 'conversation': nodes[node_id]['contentAssociation'] = facts
    content_edges = [e for e in data.get('edges', []) if e.get('source') in nodes and e.get('target') in nodes]
    payload['edges'].extend(content_edges)
    payload['metadata']['contentAssociations'] = data['metadata'] | {'generatedAt':data.get('generatedAt'), 'links':len(content_edges)}
    payload['metadata']['counts']['edges'] = len(payload['edges'])
    return payload


if __name__ == '__main__':
    print(json.dumps(refresh(), ensure_ascii=False))
