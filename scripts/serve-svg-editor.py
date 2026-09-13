"""Local PPTedit adapter: edit only SVGs referenced by one configured deck."""
import argparse
import copy
import hashlib
import json
import shutil
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote


def revision(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def sync_contents_foreground(root, svg):
    """Refresh the optional carousel's derived foreground from the edited SVG."""
    source = ET.fromstring(svg)
    if not any(node.get('id') == 'contents-static-poster' for node in source):
        return
    target = root / '媒体' / '目录轮播' / 'foreground.svg'
    if not target.is_file():
        return
    foreground = copy.deepcopy(source)
    for node in list(foreground):
        if node.tag.split('}')[-1] not in ('title', 'desc', 'defs') and node.get('id') not in ('slide-title', 'column-dividers', 'page-number'):
            foreground.remove(node)
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(ET.tostring(foreground, encoding='unicode'), encoding='utf-8')
    temporary.replace(target)


def validate_svg(text, original):
    if not isinstance(text, str) or '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
        raise ValueError('SVG 文档无效')
    root = ET.fromstring(text)
    previous = ET.fromstring(original)
    if root.tag != '{http://www.w3.org/2000/svg}svg' or root.get('viewBox') != previous.get('viewBox'):
        raise ValueError('请保留当前页的 SVG 画布尺寸')
    for node in root.iter():
        if node.tag.split('}')[-1] in ('script', 'foreignObject', 'iframe', 'object', 'embed'):
            raise ValueError('当前 SVG 不支持嵌入 HTML 或脚本')
        for name, value in node.attrib.items():
            if name.lower().startswith('on') or 'javascript:' in value.lower():
                raise ValueError('SVG 含不支持的事件或脚本')


def run(config):
    root = Path(config['root']).resolve()
    assets = Path(__file__).resolve().parent.parent / 'assets'
    lock = threading.Lock()
    def manifest():
        html = (root / 'index.html').read_text(encoding='utf-8-sig')
        items = json.JSONDecoder().raw_decode(html.split('const slides=', 1)[1])[0]
        chapters = json.JSONDecoder().raw_decode(html.split('const chapters=', 1)[1])[0] if 'const chapters=' in html else {}
        return {'slides': [{key: s[key] for key in ('page', 'title', 'file')} for s in items], 'chapters': chapters}
    def target(page):
        html = (root / 'index.html').read_text(encoding='utf-8-sig')
        slides = json.JSONDecoder().raw_decode(html.split('const slides=', 1)[1])[0]
        slide = next(s for s in slides if s['page'] == int(page))
        path = (root / slide['file']).resolve()
        if not path.is_relative_to(root) or path.suffix.lower() != '.svg':
            raise ValueError('页面路径无效')
        return path, slide
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def end_headers(self):
            self.send_header('Cache-Control', 'no-store')
            origin = self.headers.get('Origin', 'null')
            allowed = ('null', f"http://127.0.0.1:{config['port']}", 'http://127.0.0.1:8771', 'http://127.0.0.1:8775')
            self.send_header('Access-Control-Allow-Origin', origin if origin in allowed else 'null')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-PPTedit-Token')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            super().end_headers()
        def send_json(self, status, data):
            payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def authorized(self):
            return self.headers.get('Host') == f"127.0.0.1:{config['port']}" and self.headers.get('X-PPTedit-Token') == config['token']
        def do_OPTIONS(self):
            self.send_response(204)
            self.end_headers()
        def do_GET(self):
            request = urlparse(self.path)
            if request.path == '/state':
                if not self.authorized(): return self.send_json(403, {'error': '未授权'})
                try:
                    path, slide = target(parse_qs(request.query)['page'][0])
                    text = path.read_text(encoding='utf-8-sig')
                    return self.send_json(200, {'svg': text, 'revision': revision(text), 'slide': slide, **manifest()})
                except Exception as error: return self.send_json(400, {'error': str(error)})
            if request.path == '/health': return self.send_json(200, {'ready': True})
            if request.path == '/editor.html': file = assets / 'pptedit-frame.html'
            elif request.path == '/pptedit-frame.js': file = assets / 'pptedit-frame.js'
            elif request.path.startswith('/h5-editor/'):
                name = request.path.removeprefix('/h5-editor/')
                if name not in ('editor.js', 'editor.css', 'bootstrap.js'): return self.send_error(404)
                file = assets / 'h5-editor' / name
            elif request.path.startswith('/deck/'):
                file = (root / unquote(request.path.removeprefix('/deck/'))).resolve()
                if not file.is_relative_to(root) or file.suffix.lower() not in ('.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.otf'):
                    return self.send_error(404)
            else: return self.send_error(404)
            if not file.is_file(): return self.send_error(404)
            payload = file.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(str(file)))
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def do_POST(self):
            endpoint = urlparse(self.path).path
            if endpoint not in ('/save', '/reorder'): return self.send_error(404)
            if not self.authorized(): return self.send_json(403, {'error': '未授权'})
            try:
                size = int(self.headers.get('Content-Length', 0))
                if not 0 < size < 80 * 1024 * 1024: raise ValueError('文档过大')
                data = json.loads(self.rfile.read(size))
                with lock:
                    if endpoint == '/reorder':
                        path = root / 'index.html'
                        original = path.read_text(encoding='utf-8-sig')
                        start = original.index('const slides=') + len('const slides=')
                        slides, length = json.JSONDecoder().raw_decode(original[start:])
                        pages = [s['page'] for s in slides]
                        order = data.get('order')
                        if not isinstance(order, list) or len(order) != len(pages) or any(type(p) is not int for p in order) or set(order) != set(pages):
                            raise ValueError('排序必须包含全部页面且不能重复')
                        if data.get('previousOrder') != pages:
                            return self.send_json(409, {'error': '顺序已被其他窗口修改，请刷新后重试'})
                        by_page = {s['page']: s for s in slides}
                        updated = original[:start] + json.dumps([by_page[p] for p in order], ensure_ascii=False) + original[start + length:]
                        if updated != original:
                            backup = root / '制作源' / 'PPTedit备份' / (time.strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8])
                            backup.mkdir(parents=True)
                            shutil.copy2(path, backup / path.name)
                            temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
                            temporary.write_text(updated, encoding='utf-8')
                            temporary.replace(path)
                        return self.send_json(200, {'order': order})
                    path, slide = target(data['page'])
                    original = path.read_text(encoding='utf-8-sig')
                    if data.get('revision') != revision(original):
                        return self.send_json(409, {'error': '该页已被其他操作修改，当前草稿已保留；请合并后再保存', 'revision': revision(original)})
                    validate_svg(data['svg'], original)
                    if data['svg'] != original:
                        backup = root / '制作源' / 'PPTedit备份' / (time.strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8])
                        backup.mkdir(parents=True)
                        shutil.copy2(path, backup / path.name)
                        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
                        temporary.write_text(data['svg'], encoding='utf-8')
                        temporary.replace(path)
                    sync_contents_foreground(root, data['svg'])
                    self.send_json(200, {'revision': revision(data['svg'])})
            except Exception as error: self.send_json(400, {'error': str(error)})
    ThreadingHTTPServer(('127.0.0.1', config['port']), Handler).serve_forever()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    run(json.loads(Path(parser.parse_args().config).read_text(encoding='utf-8-sig')))
