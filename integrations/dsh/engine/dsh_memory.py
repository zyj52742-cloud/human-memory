"""DSH 本地接入适配器。记忆引擎与原始DSH会话独立，绝不删除会话。"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parent.parent
SKILL = Path(__file__).resolve().parent
sys.dont_write_bytecode = True

def core():
    for key in ('MEMORY_LLM_BASE_URL','MEMORY_LLM_API_KEY','MEMORY_LLM_MODEL'):
        os.environ.pop(key, None)
    sys.path.insert(0, str(SKILL))
    import memory_core
    return memory_core

def snapshot():
    import export_memory as exporter
    stars = ROOT / '_lib' / 'stars.js'
    if not stars.is_file():
        stars = ROOT / '_lib' / 'data.js'
    selected = ROOT / '_lib' / 'memory-source.json'
    dbs = json.loads(selected.read_text(encoding='utf-8')).get('paths', []) if selected.is_file() else []
    if not dbs:
        default = Path(core().DEFAULT_DB)
        dbs = [str(default)] if default.is_file() else []
    payload = exporter.build_export([str(stars)], dbs)
    from content_index import enrich
    payload = enrich(payload)
    files = [stars, ROOT / '_lib' / 'content-links.json']
    files += [Path(s['path']) for s in payload['metadata']['memorySources']]
    for candidate in [Path.home()/'.human-memory'/'memory.db', SKILL/'data'/'memory.db']:
        if candidate not in files: files.append(candidate)
    versions=[]
    for file in files:
        for p in [file,Path(str(file)+'-wal')]:
            try:s=p.stat();versions.append((str(p),s.st_mtime_ns,s.st_size))
            except FileNotFoundError:versions.append((str(p),None))
    payload['runtimeSignature']=hashlib.sha256(json.dumps(versions).encode()).hexdigest()[:20]
    return payload

def invoke(action, text, profile='default', session='', db=None):
    mc=core()
    kwargs={'profile':profile}
    if db is not None:kwargs['db_path']=db
    if action=='remember':
        result=mc.remember(text,session_id=session,**kwargs)
    else:
        items=mc.recall(text,top_k=3,**kwargs)
        result={'ok':True,'items':items,'context':mc.render_for_prompt(items) if items else '（没有相关记忆）'}
    # Attribution is an honest record of this call, independent of cumulative counters.
    if db is None:
        record={'id':uuid.uuid4().hex,'action':action,'profile':profile,'sessionId':session,'memoryIds':[result['id']] if 'id' in result else [x['id'] for x in result.get('items',[])], 'createdAt':mc.now_iso()}
        with (ROOT/'_lib'/'memory-activity.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(record,ensure_ascii=False)+'\n')
    return result

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['snapshot','remember','recall'])
    p.add_argument('--text',default='')
    p.add_argument('--profile',default='default')
    p.add_argument('--session',default='')
    args=p.parse_args()
    if args.action!='snapshot' and not args.text.strip():p.error('--text is required')
    result=snapshot() if args.action=='snapshot' else invoke(args.action,args.text,args.profile,args.session)
    print(json.dumps(result,ensure_ascii=False))
    return 0

if __name__=='__main__':raise SystemExit(main())
