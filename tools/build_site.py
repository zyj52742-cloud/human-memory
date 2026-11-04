"""Build the public website from fictional data; no external dependencies."""
from pathlib import Path
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
