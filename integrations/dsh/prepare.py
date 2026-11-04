"""Prepare portable DSH files without installing plugins or reading sessions."""
from pathlib import Path
import argparse
import json
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SKILL = REPO / 'skills' / 'memory-universe'

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', action='append', default=[])
    p.add_argument('--stars', action='append', default=[])
    p.add_argument('--force', action='store_true')
    args = p.parse_args()
    runtime = HERE / '_runtime'
    if runtime.exists() and any(runtime.iterdir()) and not args.force:
        p.error('_runtime already exists; use --force to overwrite generated files')
    for db in args.db:
        if not Path(db).expanduser().is_file(): p.error('Database not found: ' + db)
    network = runtime / 'network'
    network.mkdir(parents=True, exist_ok=True)
    stars = args.stars
    if not stars:
        empty = runtime / 'empty-stars.json'
        empty.write_text(json.dumps({'stars': [], 'archived': []}), encoding='utf-8')
        stars = [str(empty)]
    command = [sys.executable, '-B', str(SKILL/'scripts/universe.py'), 'export', '--output', str(network), '--force']
    for db in args.db: command.extend(['--db', str(Path(db).expanduser().resolve())])
    for value in stars: command.extend(['--stars', value])
    subprocess.run(command, check=True)
    engine = network/'engine'
    engine.mkdir(exist_ok=True)
    for source in (HERE/'engine').glob('*'):
        if source.is_file(): shutil.copyfile(source, engine/source.name)
    for name in ('export_memory.py','memory_core.py','scoring.py','extractor.py'):
        shutil.copyfile(SKILL/'scripts'/name, engine/name)
    for source in (HERE/'assets').glob('*.js'): shutil.copyfile(source, network/'_lib'/source.name)
    (network/'04-使用说明.md').write_text((SKILL/'assets/USAGE.md').read_text(encoding='utf-8').replace('{{MODE}}','DSH'), encoding='utf-8')
    if args.db:
        (network/'_lib/memory-source.json').write_text(json.dumps({'paths':[str(Path(v).expanduser().resolve()) for v in args.db]}), encoding='utf-8')
    planets=runtime/'planets'
    planets.mkdir(exist_ok=True)
    shutil.copytree(network/'_lib', planets/'_lib', dirs_exist_ok=True)
    text=(network/'02-记忆星图.html').read_text(encoding='utf-8').replace('01-记忆宇宙.html','../network/01-记忆宇宙.html')
    (planets/'01-记忆星图.html').write_text(text, encoding='utf-8')
    text=(network/'01-记忆宇宙.html').read_text(encoding='utf-8').replace('02-记忆星图.html','../planets/01-记忆星图.html')
    (network/'01-记忆宇宙.html').write_text(text, encoding='utf-8')
    text=(network/'_lib/atlas.js').read_text(encoding='utf-8').replace('02-记忆星图.html','../planets/01-记忆星图.html')
    (network/'_lib/atlas.js').write_text(text, encoding='utf-8')
    subprocess.run([sys.executable,'-B',str(SKILL/'scripts/universe.py'),'demo','--output',str(network/'_demo'),'--force'],check=True)
    print('Prepared:',runtime)
    print('DSH plugin (manual installation):',HERE/'dsh-plugin')
    return 0

if __name__ == '__main__': raise SystemExit(main())
