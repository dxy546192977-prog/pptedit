"""Local PPTedit adapter: edit only SVGs referenced by one configured deck."""
import argparse
from preview_origin import preview_origin_allowed
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


PAGE_NUMBER_RE = __import__('re').compile(r'(<text\b[^>]*\bid="page-number"[^>]*>)(.*?)(</text>)', __import__('re').S)
PAGE_DIGITS_RE = __import__('re').compile(r'(>\s*)(\d{1,3})(\s*<)')

def renumber_svg_text(text, number):
    """把 SVG 里 <text id="page-number"> 的显示数字改成 number（两位补零）。
    只改数字文本节点，不重排 XML，不触碰其它内容；找不到唯一数字节点时返回原文。
    返回 (new_text, changed: bool)。"""
    label = str(number).zfill(2)
    m = PAGE_NUMBER_RE.search(text)
    if not m: return text, False
    inner = m.group(2)
    if '<' not in inner:
        # <text id="page-number">04</text>
        if inner.strip() == label: return text, False
        if not inner.strip().isdigit(): return text, False
        new_inner = inner.replace(inner.strip(), label, 1)
    else:
        # <text id="page-number"><tspan ...>04</tspan></text>：恰好一个数字文本节点才改
        hits = list(PAGE_DIGITS_RE.finditer('>' + inner + '<'))
        if len(hits) != 1: return text, False
        if hits[0].group(2) == label: return text, False
        wrapped = PAGE_DIGITS_RE.sub(lambda h: h.group(1) + label + h.group(3), '>' + inner + '<', count=1)
        new_inner = wrapped[1:-1]
    return text[:m.start(2)] + new_inner + text[m.end(2):], True

def renumber_svgs(root, slides, backup_dir=None):
    """按 slides 当前顺序校对每个 SVG 文件里烘焙的页码。返回 {'updated': [...], 'skipped': [...], 'missing': [...]}。
    幂等：已一致的文件不写；写前把原文件复制到 backup_dir（若给出）。"""
    report = {'updated': [], 'skipped': [], 'missing': [], 'revisions': {}}
    for index, slide in enumerate(slides, start=1):
        file = root / slide['file']
        if not file.exists(): report['missing'].append(slide['page']); continue
        original = file.read_text(encoding='utf-8-sig')
        new_text, changed = renumber_svg_text(original, index)
        if not changed:
            if PAGE_NUMBER_RE.search(original) is None: report['skipped'].append(slide['page'])
            continue
        if backup_dir is not None:
            backup_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, backup_dir / file.name)
        temporary = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
        temporary.write_text(new_text, encoding='utf-8')
        temporary.replace(file)
        report['updated'].append(slide['page'])
        report['revisions'][str(slide['page'])] = revision(new_text)  # 让已打开该页的编辑器刷新乐观锁基线，避免下次保存 409
    return report

def audit_page_numbers(root, slides):
    """只读校对：返回 [{page, expected, actual}] 中不一致的项（actual=None 表示文件无 page-number）。"""
    problems = []
    for index, slide in enumerate(slides, start=1):
        file = root / slide['file']
        if not file.exists(): problems.append({'page': slide['page'], 'expected': index, 'actual': None, 'reason': 'missing-file'}); continue
        m = PAGE_NUMBER_RE.search(file.read_text(encoding='utf-8-sig'))
        if not m: continue  # 该页设计上没有页码槽位，不算问题
        digits = PAGE_DIGITS_RE.findall('>' + m.group(2) + '<') if '<' in m.group(2) else ([('', m.group(2).strip(), '')] if m.group(2).strip().isdigit() else [])
        actual = int(digits[0][1]) if len(digits) == 1 else None
        if actual != index: problems.append({'page': slide['page'], 'expected': index, 'actual': actual})
    return problems

def canonical_page(value):
    """页 id 一律用数字：外部工具偶尔把 "28.2" 写成字符串，会让严格相等的章节树/侧栏悄悄丢页。"""
    if isinstance(value, bool): return value
    if isinstance(value, (int, float)): return value
    if isinstance(value, str):
        try:
            n = float(value.strip())
            return int(n) if n.is_integer() else n
        except ValueError: return value
    return value

def canonical_pages(nodes):
    for node in nodes:
        if 'page' in node: node['page'] = canonical_page(node['page'])
        elif isinstance(node.get('children'), list): canonical_pages(node['children'])
    return nodes

def navigation_pages(tree, depth=0):
    if not isinstance(tree, list) or depth > 32 or len(tree) > 10000:
        raise ValueError('章节树无效')
    pages = []
    for node in tree:
        if not isinstance(node, dict): raise ValueError('章节节点无效')
        if 'page' in node:
            if set(node) != {'page'} or type(node['page']) not in (int, float): raise ValueError('章节页面无效')
            pages.append(node['page'])
        else:
            if set(node) - {'key', 'title', 'subtitle', 'open', 'children'} or not isinstance(node.get('key'), str) or not isinstance(node.get('title'), str): raise ValueError('章节信息无效')
            pages.extend(navigation_pages(node.get('children'), depth + 1))
    if len(set(pages)) != len(pages): raise ValueError('章节页面重复')
    return pages


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
        slide = next(s for s in slides if str(s['page']) == str(page))
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
            self.send_header('Access-Control-Allow-Origin', origin if preview_origin_allowed(origin, config, allowed) else 'null')
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
            elif request.path == '/navigation-tree.js': file = assets / 'navigation-tree.js'
            elif request.path == '/preview-navigation.css': file = assets / 'preview-navigation.css'
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
            if endpoint not in ('/save', '/reorder', '/delete-page', '/chapters', '/renumber'): return self.send_error(404)
            if not self.authorized(): return self.send_json(403, {'error': '未授权'})
            try:
                size = int(self.headers.get('Content-Length', 0))
                if not 0 < size < 80 * 1024 * 1024: raise ValueError('文档过大')
                data = json.loads(self.rfile.read(size))
                with lock:
                    if endpoint == '/chapters':
                        path = root / 'chapter-settings.json'
                        original = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
                        if data.get('previous') != original:
                            return self.send_json(409, {'error': '章节已被其他窗口修改，请刷新后重试'})
                        settings = data.get('settings')
                        if not isinstance(settings, dict) or len(settings) > 1000:
                            raise ValueError('章节设置无效')
                        for key, value in settings.items():
                            if not isinstance(key, str) or len(key) > 1000 or not isinstance(value, dict):
                                raise ValueError('章节设置无效')
                            if key == '__navigation':
                                if set(value) != {'tree'}: raise ValueError('章节树设置无效')
                                navigation_pages(value['tree'])
                                continue
                            if set(value) - {'title', 'ungrouped', 'pages'} or ('title' in value and (not isinstance(value['title'], str) or not 0 < len(value['title'].strip()) <= 100)) or ('ungrouped' in value and type(value['ungrouped']) is not bool):
                                raise ValueError('章节名称或分组设置无效')
                            if 'pages' in value and (not isinstance(value['pages'], list) or not 2 <= len(value['pages']) <= 10000 or any(type(page) not in (int, float) for page in value['pages']) or len(set(value['pages'])) != len(value['pages'])):
                                raise ValueError('子章节页面设置无效')
                        index_path = root / 'index.html'
                        original_index = index_path.read_text(encoding='utf-8-sig')
                        updated_index = original_index
                        if 'order' in data:
                            start = original_index.index('const slides=') + len('const slides=')
                            slides, length = json.JSONDecoder().raw_decode(original_index[start:])
                            pages = [slide['page'] for slide in slides]
                            order = data['order']
                            if data.get('previousOrder') != pages:
                                return self.send_json(409, {'error': '顺序已被其他窗口修改，请刷新后重试'})
                            if not isinstance(order, list) or len(order) != len(pages) or any(type(page) not in (int, float) for page in order) or set(order) != set(pages):
                                raise ValueError('分组顺序无效')
                            if '__navigation' in settings and navigation_pages(settings['__navigation']['tree']) != order: raise ValueError('章节顺序与页面顺序不一致')
                            by_page = {slide['page']: slide for slide in slides}
                            updated_index = original_index[:start] + json.dumps([by_page[page] for page in order], ensure_ascii=False) + original_index[start + length:]

                        if path.exists() or updated_index != original_index:
                            backup = root / '制作源' / 'PPTedit备份' / (time.strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8])
                            backup.mkdir(parents=True)
                            if path.exists(): shutil.copy2(path, backup / path.name)
                            if updated_index != original_index: shutil.copy2(index_path, backup / index_path.name)
                        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
                        temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding='utf-8')
                        index_temporary = index_path.with_name(index_path.name + '.' + uuid.uuid4().hex + '.tmp')
                        try:
                            if updated_index != original_index:
                                index_temporary.write_text(updated_index, encoding='utf-8')
                                index_temporary.replace(index_path)
                            temporary.replace(path)
                        except Exception:
                            if updated_index != original_index:
                                index_temporary.write_text(original_index, encoding='utf-8')
                                index_temporary.replace(index_path)
                            temporary.unlink(missing_ok=True)
                            raise
                        return self.send_json(200, {'saved': True})
                    if endpoint == '/renumber':
                        path = root / 'index.html'
                        original = path.read_text(encoding='utf-8-sig')
                        start = original.index('const slides=') + len('const slides=')
                        slides, _ = json.JSONDecoder().raw_decode(original[start:])
                        for s_ in slides: s_['page'] = canonical_page(s_['page'])
                        problems = audit_page_numbers(root, slides)
                        if not data.get('fix'):
                            return self.send_json(200, {'total': len(slides), 'problems': problems})
                        backup = root / '制作源' / 'PPTedit备份' / (time.strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8] + '-renumber') if problems else None
                        report = renumber_svgs(root, slides, backup)
                        return self.send_json(200, {'total': len(slides), 'problems': problems, 'renumber': report})
                    if endpoint in ('/reorder', '/delete-page'):
                        path = root / 'index.html'
                        original = path.read_text(encoding='utf-8-sig')
                        start = original.index('const slides=') + len('const slides=')
                        slides, length = json.JSONDecoder().raw_decode(original[start:])
                        for s_ in slides: s_['page'] = canonical_page(s_['page'])
                        pages = [s['page'] for s in slides]
                        order = [canonical_page(p) for p in data.get('order')] if isinstance(data.get('order'), list) else data.get('order')
                        if isinstance(data.get('previousOrder'), list): data['previousOrder'] = [canonical_page(p) for p in data['previousOrder']]
                        if isinstance(data.get('page'), str): data['page'] = canonical_page(data['page'])
                        if isinstance(data.get('navigation'), list): canonical_pages(data['navigation'])
                        if endpoint == '/delete-page':
                            page = data.get('page')
                            if type(page) not in (int, float) or page not in pages:
                                raise ValueError('无法定位要删除的页面，请刷新后重试')
                            if len(pages) <= 1:
                                raise ValueError('至少保留 1 页，无法删除')
                            order = [p for p in pages if p != page]
                        elif not isinstance(order, list) or len(order) != len(pages) or any(type(p) not in (int, float) for p in order) or set(order) != set(pages):
                            raise ValueError('排序必须包含全部页面且不能重复')
                        if data.get('previousOrder') != pages:
                            return self.send_json(409, {'error': '顺序已被其他窗口修改，请刷新后重试'})
                        by_page = {s['page']: s for s in slides}
                        updated = original[:start] + json.dumps([by_page[p] for p in order], ensure_ascii=False) + original[start + length:]
                        navigation = data.get('navigation')
                        settings_path = root / 'chapter-settings.json'
                        settings = json.loads(settings_path.read_text(encoding='utf-8')) if settings_path.exists() else {}
                        if navigation is not None:
                            if navigation_pages(navigation) != order: raise ValueError('章节顺序与页面顺序不一致')
                            settings['__navigation'] = {'tree': navigation}
                        if updated != original or navigation is not None:
                            backup = root / '制作源' / 'PPTedit备份' / (time.strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8])
                            backup.mkdir(parents=True)
                            shutil.copy2(path, backup / path.name)
                            if settings_path.exists(): shutil.copy2(settings_path, backup / settings_path.name)
                            temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
                            temporary.write_text(updated, encoding='utf-8')
                            settings_temp = settings_path.with_name(settings_path.name + '.' + uuid.uuid4().hex + '.tmp')
                            try:
                                if navigation is not None: settings_temp.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding='utf-8')
                                temporary.replace(path)
                                if navigation is not None: settings_temp.replace(settings_path)
                            except Exception:
                                temporary.write_text(original, encoding='utf-8'); temporary.replace(path)
                                settings_temp.unlink(missing_ok=True)
                                raise
                        # 顺序已落盘：把每个 SVG 里烘焙的页码同步到新位置（含被删页之后所有页）。
                        # 失败不回滚顺序（顺序才是事实源），只在响应里报告，前端据此提示。
                        renumber = {'updated': [], 'skipped': [], 'missing': [], 'revisions': {}}
                        try:
                            renumber = renumber_svgs(root, [by_page[p] for p in order], backup if (updated != original or navigation is not None) else None)
                        except Exception as error:
                            renumber['error'] = str(error)
                        return self.send_json(200, {'order': order, 'renumber': renumber})
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
