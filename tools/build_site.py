"""Build the public website from fictional data; no external dependencies."""
from pathlib import Path
import json
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '_site'


def main():
    OUTPUT.mkdir(exist_ok=True)
    subprocess.run([
        sys.executable, '-B', str(ROOT / 'skills/memory-universe/scripts/universe.py'),
        'demo', '--output', str(OUTPUT / 'demo'), '--force',
    ], check=True)
    # Retain fictional provenance while making the website independent of build paths.
    demo_root = OUTPUT / 'demo'
    def public_source(value):
        if isinstance(value, str):
            return value.replace(str(demo_root), 'demo://synthetic').replace(demo_root.as_posix(), 'demo://synthetic')
        if isinstance(value, list):
            return [public_source(item) for item in value]
        if isinstance(value, dict):
            return {key: public_source(item) for key, item in value.items()}
        return value
    for filename in ('network-data.js', 'data.js'):
        path = demo_root / '_lib' / filename
        text = path.read_text(encoding='utf-8')
        start = text.index('=') + 1
        payload = public_source(json.loads(text[start:].strip().removesuffix(';')))
        body = json.dumps(payload, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
        path.write_text(text[:start] + body + ';\n', encoding='utf-8')
    # The public website needs finished views only, not even the fictional SQLite DB.
    data = OUTPUT / 'demo' / 'data'
    for name in ('demo-memory.db', 'demo-stars.json'):
        path = data / name
        if path.is_file():
            path.unlink()
    if data.is_dir() and not any(data.iterdir()):
        data.rmdir()
    shutil.copyfile(ROOT / 'web/index.html', OUTPUT / 'index.html')
    assets = OUTPUT / 'assets'
    assets.mkdir(exist_ok=True)
    for name in ('memory-starmap-demo.png', 'memory-universe-demo.png', 'memory-universe-preview.gif'):
        source = ROOT / 'docs' / name
        if source.is_file():
            shutil.copyfile(source, assets / name)
    (OUTPUT / '.nojekyll').touch()
    for path in OUTPUT.rglob('*'):
        if path.is_file() and path.suffix.lower() in ('.db', '.sqlite', '.sqlite3', '.jsonl', '.zstd'):
            raise SystemExit('Unexpected data file in website: ' + str(path))
    print('Public website ready:', OUTPUT)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
