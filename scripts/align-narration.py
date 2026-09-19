"""Local character timestamps for existing narration; audio is never regenerated."""
import argparse
import importlib.util
import json
import re
import time
import unicodedata
from pathlib import Path

spec = importlib.util.spec_from_file_location('narration_generator', Path(__file__).with_name('generate-narration.py'))
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
STAGE = re.compile(r'[（(](?:(?:停顿?|暂停)[一二两三四五六七八九十\d.]+秒(?:[，,]\s*结束)?|停一下|结束)[）)]')

def kept(char):
    return char == "'" or unicodedata.category(char)[0] in 'LN'

def source_chars(notes):
    paragraphs = [text.replace('**', '') for text in notes]
    locations = []
    for p, text in enumerate(paragraphs):
        skipped = {i for match in STAGE.finditer(text) for i in range(match.start(), match.end())}
        locations.extend((p, i, char) for i, char in enumerate(text) if i not in skipped and kept(char))
    return paragraphs, locations

def map_alignment(notes, items, duration):
    paragraphs, locations = source_chars(notes)
    chars = [[None] * len(text) for text in paragraphs]
    cursor = 0
    last = 0.0
    for item in items:
        letters = [c for c in item.text if kept(c)]
        expected = ''.join(c for _, _, c in locations[cursor:cursor + len(letters)])
        if expected != ''.join(letters):
            raise ValueError('Alignment transcript mismatch; refusing inaccurate character mapping')
        start = max(last, min(duration, float(item.start_time)))
        end = max(start, min(duration, float(item.end_time)))
        for n, char in enumerate(letters):
            p, i, _ = locations[cursor]
            chars[p][i] = [round(start + (end-start)*n/len(letters), 4), round(start + (end-start)*(n+1)/len(letters), 4)]
            cursor += 1
        last = end
    if cursor != len(locations):
        raise ValueError('Alignment missing characters')
    # The aligner can assign a shared boundary to a very short character.
    # Share that local interval instead of making the character impossible to highlight.
    flat = [pair for paragraph in chars for pair in paragraph if pair is not None]
    i = 0
    while i < len(flat):
        if flat[i][1] > flat[i][0]:
            i += 1
            continue
        end = i
        while end < len(flat) and flat[end][0] == flat[end][1]:
            end += 1
        if end < len(flat) and abs(flat[end][0] - flat[i][0]) < .001:
            begin, finish = flat[i][0], flat[end][1]
            for n in range(i, end + 1):
                flat[n][:] = [round(begin + (finish-begin)*(n-i)/(end-i+1),4), round(begin + (finish-begin)*(n-i+1)/(end-i+1),4)]
        elif i > 0:
            begin, finish = flat[i-1][0], flat[end-1][1]
            for n in range(i-1, end):
                flat[n][:] = [round(begin + (finish-begin)*(n-i+1)/(end-i+1),4), round(begin + (finish-begin)*(n-i+2)/(end-i+1),4)]
        i = end + 1
    return chars

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--pages')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    html = Path(config['html'])
    output = html.parent / 'narration'
    from filelock import FileLock, Timeout
    lock = FileLock(str(output / '.alignment.lock'), timeout=0)
    try:
        lock.acquire()
    except Timeout:
        print('Alignment service already running', flush=True)
        return
    data_path = output / 'alignment.json'
    data = json.loads(data_path.read_text()) if data_path.exists() else {'version': 1, 'files': {}}
    model = None
    failures = {}
    selected = set(args.pages.split(',')) if args.pages else None
    try:
        while True:
            manifest = json.loads((output / 'manifest.json').read_text())
            slides = generator.extract_slides(html.read_text())
            for slide in slides:
                if selected and str(slide['page']) not in selected:
                    continue
                records = manifest.get('slides', {})
                record = records.get(str(slide['page']))
                if not record or record.get('notes') != slide['notes']:
                    record = next((r for r in records.values() if r.get('notes') == slide['notes']), None)
                if not record or not (html.parent / record['file']).exists():
                    continue
                file = record['file']
                cached = data['files'].get(file)
                if cached and cached.get('version') == 3 and cached.get('notes') == slide['notes']:
                    continue
                if failures.get(file, 0) >= 2:
                    continue
                try:
                    if model is None:
                        from mlx_audio.stt import load
                        print('Loading forced aligner', flush=True)
                        model = load(config['alignmentModel'])
                    transcript = ' '.join(part['text'] for part in generator.chunks(slide['notes']) if 'text' in part)
                    print('ALIGN', slide['page'], file, flush=True)
                    result = model.generate(audio=str(html.parent / file), text=transcript, language='Chinese')
                    chars = map_alignment(slide['notes'], result, record['duration'])
                    data['files'][file] = {'notes': slide['notes'], 'chars': chars, 'method': 'qwen3-forced-aligner', 'version': 3}
                    generator.atomic_text(data_path, json.dumps(data, ensure_ascii=False))
                    generator.atomic_text(output / 'alignment.js', 'window.PPT_NARRATION_ALIGNMENT = ' + json.dumps(data, ensure_ascii=False) + ';\n')
                    print('ALIGNED', slide['page'], sum(v is not None for p in chars for v in p), flush=True)
                except Exception as error:
                    failures[file] = failures.get(file, 0) + 1
                    print('ALIGN_ERROR', slide['page'], type(error).__name__, str(error), flush=True)
                    if not args.watch:
                        raise
            if not args.watch:
                break
            time.sleep(3)
    finally:
        lock.release()

if __name__ == '__main__':
    main()
