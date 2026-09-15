"""Exercise the editor's disk boundary using an isolated disposable deck."""
import json
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
import importlib.util
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('svg_editor', Path(__file__).with_name('serve-svg-editor.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
with tempfile.TemporaryDirectory(prefix='pptedit-foreground-test-') as temporary:
    root = Path(temporary)
    foreground = root / '媒体' / '目录轮播' / 'foreground.svg'
    foreground.parent.mkdir(parents=True)
    foreground.write_text('<svg/>', encoding='utf-8')
    source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><defs/><rect id="background"/><text id="slide-title" style="transform:translate(498px,0px)">Centered</text><g id="contents-static-poster"/><path id="column-dividers"/><g id="project-1"/><text id="page-number">02</text></svg>'
    adapter.sync_contents_foreground(root, source)
    result = ET.fromstring(foreground.read_text(encoding='utf-8'))
    title = next(n for n in result if n.get('id') == 'slide-title')
    assert title.text == 'Centered' and title.get('style') == 'transform:translate(498px,0px)'
    assert {n.get('id') for n in result} == {None, 'slide-title', 'column-dividers', 'page-number'}
    print('PASS: carousel foreground preserves saved title position without covering videos')

with tempfile.TemporaryDirectory(prefix='pptedit-svg-test-') as temporary:
    root = Path(temporary)
    original = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><text x="10" y="30">Before</text></svg>'
    (root / 'page.svg').write_text(original, encoding='utf-8')
    (root / 'index.html').write_text('const slides=' + json.dumps([{'page': 4, 'file': 'page.svg', 'title': 'Test'}]) + ';', encoding='utf-8')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    config = {'root': str(root), 'port': port, 'token': 'isolated-test-token'}
    config_file = root / 'config.json'
    config_file.write_text(json.dumps(config), encoding='utf-8')
    process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('serve-svg-editor.py')), '--config', str(config_file)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def request(path, body=None, token=True):
        headers = {'Content-Type': 'application/json'}
        if token: headers['X-PPTedit-Token'] = config['token']
        req = urllib.request.Request(f'http://127.0.0.1:{port}' + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=2) as response: return response.status, response.read()
        except urllib.error.HTTPError as error: return error.code, error.read()
    try:
        for attempt in range(40):
            try:
                if request('/health')[0] == 200: break
            except OSError: time.sleep(.05)
        assert request('/state?page=4', token=False)[0] == 403
        status, payload = request('/state?page=4')
        assert status == 200
        state = json.loads(payload)
        assert state['svg'] == original
        assert state['slides'] == [{'page': 4, 'title': 'Test', 'file': 'page.svg'}]
        assert request('/editor.html')[0] == 200
        assert request('/h5-editor/editor.js')[0] == 200
        changed = original.replace('Before', 'After')
        body = {'page': 4, 'svg': changed, 'revision': state['revision']}
        status, payload = request('/save', body)
        assert status == 200
        assert (root / 'page.svg').read_text(encoding='utf-8') == changed
        assert list((root / '制作源' / 'PPTedit备份').rglob('page.svg'))[0].read_text(encoding='utf-8') == original
        assert request('/save', body)[0] == 409
        body['revision'] = json.loads(payload)['revision']
        for invalid in [changed.replace('1920 1080', '100 100'), changed.replace('</svg>', '<script>alert(1)</script></svg>')]:
            assert request('/save', {**body, 'svg': invalid})[0] == 400
        assert request('/state?page=999')[0] == 400
        assert request('/deck/../../config.json')[0] == 404
        assert (root / 'page.svg').read_text(encoding='utf-8') == changed
        print('PASS: authenticated SVG read/save, original backup, revision conflict, invalid markup, fixed canvas, page and file boundaries')
        slides = [{'page': p, 'file': 'page.svg', 'title': str(p), 'notes': ['note' + str(p)]} for p in (4, 8, 12)]
        (root / 'index.html').write_text('const slides=' + json.dumps(slides) + ';const untouched=true;', encoding='utf-8')
        reorder = {'previousOrder': [4, 8, 12], 'order': [12, 4, 8]}
        assert request('/reorder', reorder, token=False)[0] == 403
        assert request('/reorder', {**reorder, 'order': [4, 4, 12]})[0] == 400
        assert request('/reorder', reorder)[0] == 200
        saved = (root / 'index.html').read_text(encoding='utf-8')
        result = json.JSONDecoder().raw_decode(saved.split('const slides=')[1])[0]
        assert result == [slides[2], slides[0], slides[1]]
        assert saved.endswith(';const untouched=true;')
        assert request('/reorder', reorder)[0] == 409
        assert [s['page'] for s in json.loads(request('/state?page=4')[1])['slides']] == [12, 4, 8]
        assert request('/reorder', {'previousOrder': [12, 4, 8], 'order': [4, 8, 12]})[0] == 200
        print('PASS: reorder persists all slide metadata, rejects duplicates and stale writes, and supports restoring order')
        slides[1]['page'] = 5.1
        (root / 'index.html').write_text('const slides=' + json.dumps(slides) + ';', encoding='utf-8')
        assert request('/state?page=5.1')[0] == 200
        fractional = {'previousOrder': [4, 5.1, 12], 'order': [5.1, 12, 4]}
        assert request('/reorder', fractional)[0] == 200
        assert [s['page'] for s in json.loads(request('/state?page=5.1')[1])['slides']] == [5.1, 12, 4]
        assert request('/reorder', {'previousOrder': [5.1, 12, 4], 'order': [4, 5.1, 12]})[0] == 200
        for invalid in ([4, 5.1, 5.1], [4, '5.1', 12], [4, True, 12], [4, 5.2, 12]):
            assert request('/reorder', {**fractional, 'order': invalid})[0] == 400
        print('PASS: fractional page IDs load, reorder, persist and restore; invalid orders rejected')
        deletion = {'page': 5.1, 'previousOrder': [4, 5.1, 12]}
        assert request('/delete-page', deletion, token=False)[0] == 403
        assert request('/delete-page', {**deletion, 'page': True})[0] == 400
        assert request('/delete-page', {**deletion, 'page': 99})[0] == 400
        assert request('/delete-page', {**deletion, 'previousOrder': [12, 4, 5.1]})[0] == 409
        assert request('/delete-page', deletion)[0] == 200
        result = json.JSONDecoder().raw_decode((root / 'index.html').read_text().split('const slides=')[1])[0]
        assert result == [slides[0], slides[2]]
        assert (root / 'page.svg').read_text() == changed
        assert request('/state?page=5.1')[0] == 400
        assert request('/delete-page', {'page': 12, 'previousOrder': [4, 12]})[0] == 200
        assert request('/delete-page', {'page': 4, 'previousOrder': [4]})[0] == 400
        assert any('5.1' in p.read_text() for p in (root / '制作源' / 'PPTedit备份').rglob('index.html'))
        print('PASS: deletion persists metadata and fractional IDs, retains SVG and backup, rejects stale/unauthorized requests, protects final page')
    finally:
        process.terminate()
        process.wait(timeout=5)
