"""Generate local, naturally paced Qwen3-TTS rehearsal audio from a Deck's notes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import time
import atexit

MODEL_KEY = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'

STYLE = '用清晰自然的年轻男声说标准普通话，像日常向同事讲述自己的经历。中等音高，正常语速，按句意停顿，不刻意压低声音，不夸张表演，不带儿化音或地方口音。'
PAUSE = re.compile(r'[（(](?:停顿?|暂停)([一二两三四五六七八九十\d.]+)秒(?:[，,]\s*结束)?[）)]')

def extract_slides(html):
    match = re.search(r'const slides\s*=\s*', html)
    if not match:
        raise ValueError('No const slides JSON array found')
    return json.JSONDecoder().raw_decode(html[match.end():])[0]

def chunks(notes):
    result = []
    numbers = {'一':1, '二':2, '两':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10}
    for paragraph in notes:
        text = paragraph.replace('**', '')
        text = text.replace('（停一下）', '（停一秒）').replace('(停一下)', '(停一秒)')
        text = re.sub(r'[（(]结束[）)]', '', text)
        pos = 0
        for match in PAUSE.finditer(text):
            add_text(result, text[pos:match.start()])
            n = match.group(1)
            result.append({'pause': float(numbers[n]) if n in numbers else float(n)})
            pos = match.end()
        add_text(result, text[pos:])
        if not result or 'pause' not in result[-1]:
            result.append({'pause': 0.65})
    return result

def add_text(result, text):
    text = text.strip()
    if not text:
        return
    # Keep semantic sentences intact; split only long paragraphs at sentence boundaries.
    sentences = re.findall(r'[^。！？!?]+[。！？!?]*', text)
    pending = ''
    for sentence in sentences:
        if pending and len(pending) + len(sentence) > 180:
            result.append({'text': pending})
            pending = ''
        pending += sentence
    if pending:
        result.append({'text': pending})

def signature(notes, speaker):
    return hashlib.sha256(json.dumps([notes, speaker, STYLE, 2, MODEL_KEY], ensure_ascii=False).encode()).hexdigest()

def atomic_text(path, text):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(text, encoding='utf-8')
    temp.replace(path)

def main():
    global STYLE, MODEL_KEY
    parser = argparse.ArgumentParser()
    parser.add_argument('--html', required=True, type=Path)
    parser.add_argument('--model', required=True)
    parser.add_argument('--speaker', default='Aiden')
    parser.add_argument('--pages', help='Comma-separated page numbers, default all')
    parser.add_argument('--plan', action='store_true')
    parser.add_argument('--batch-size', type=int, default=4)
    parser.add_argument('--config', type=Path, help='Local voice configuration JSON')
    args = parser.parse_args()
    if args.config:
        config = json.loads(args.config.read_text(encoding='utf-8-sig'))
        args.speaker = config.get('speaker', args.speaker)
        STYLE = config.get('style', STYLE)
    MODEL_KEY = str(Path(args.model).resolve())
    slides = extract_slides(args.html.read_text(encoding='utf-8'))
    selected = {int(n) for n in args.pages.split(',')} if args.pages else None
    output = args.html.parent / 'narration'
    output.mkdir(exist_ok=True)
    manifest_path = output / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {'version':1, 'model':'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', 'speaker':args.speaker, 'style':STYLE, 'slides':{}}
    if manifest.get('speaker') != args.speaker or manifest.get('style') != STYLE:
        manifest = {'version':1, 'model':'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', 'speaker':args.speaker, 'style':STYLE, 'slides':{}}
    if args.plan:
        print(json.dumps([{'page':s['page'],'segments':chunks(s['notes'])} for s in slides if not selected or s['page'] in selected], ensure_ascii=False, indent=2))
        return
    from filelock import FileLock
    lock = FileLock(str(output / '.generation.lock'), timeout=0)
    lock.acquire()
    atexit.register(lock.release)
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel
    def cache_audio(path, wave, sr):
        temporary = path.with_suffix('.tmp.wav')
        sf.write(temporary, wave, sr, subtype='PCM_16')
        temporary.replace(path)
    torch.set_num_threads(6)
    torch.manual_seed(42)
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA GPU is required for this local rehearsal build')
    model = None
    cache_dir = output / '.segments'
    cache_dir.mkdir(exist_ok=True)
    pending = {}
    for slide in slides:
        if selected and slide['page'] not in selected:
            continue
        for segment in chunks(slide['notes']):
            if 'text' in segment:
                key = signature([segment['text']], args.speaker)
                if not (cache_dir / (key + '.wav')).exists():
                    pending[key] = segment['text']
    if args.batch_size > 1 and pending:
        print('Loading local model for',len(pending),'segments',flush=True)
        model = Qwen3TTSModel.from_pretrained(args.model, device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa')
        ordered = sorted(pending.items(), key=lambda pair:len(pair[1]))
        for offset in range(0, len(ordered), args.batch_size):
            batch = ordered[offset:offset+args.batch_size]
            start = time.time()
            print('BATCH',offset+1,'-',offset+len(batch),'/',len(ordered),flush=True)
            with torch.inference_mode():
                waves, sr = model.generate_custom_voice(text=[text for _,text in batch], language=['Chinese']*len(batch), speaker=[args.speaker]*len(batch), instruct=[STYLE]*len(batch), non_streaming_mode=True, max_new_tokens=2048)
            for (key,text),wave in zip(batch,waves,strict=True):
                wave = np.asarray(wave,dtype=np.float32)
                if not np.isfinite(wave).all() or len(wave)<sr*.2 or np.max(np.abs(wave))<.001:
                    raise RuntimeError('Invalid/empty generated audio: '+text)
                active = np.flatnonzero(np.abs(wave)>.003)
                if len(active):
                    wave=wave[max(0,active[0]-int(sr*.08)):min(len(wave),active[-1]+int(sr*.16))]
                cache_audio(cache_dir/(key+'.wav'),wave,sr)
            print('BATCH_DONE',offset+len(batch),'elapsed',round(time.time()-start,1),flush=True)
    for slide in slides:
        page = str(slide['page'])
        if selected and slide['page'] not in selected:
            continue
        digest = signature(slide['notes'], args.speaker)
        cached = manifest['slides'].get(page)
        if cached and cached.get('hash') == digest and (args.html.parent / cached['file']).exists():
            print('CACHED', page, flush=True)
            continue
        start = time.time()
        segments = chunks(slide['notes'])
        parts = []
        sample_rate = 24000
        speech_number = 0
        cache_dir = output / '.segments'
        cache_dir.mkdir(exist_ok=True)
        for segment in segments:
            if 'pause' in segment:
                parts.append(np.zeros(round(segment['pause'] * sample_rate), dtype=np.float32))
                continue
            speech_number += 1
            key = signature([segment['text']], args.speaker)
            cache_path = cache_dir / (key + '.wav')
            if cache_path.exists():
                wave, sample_rate = sf.read(cache_path, dtype='float32')
            else:
                if model is None:
                    print('Loading local model', args.model, flush=True)
                    model = Qwen3TTSModel.from_pretrained(args.model, device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa')
                print('GENERATE', page, speech_number, len(segment['text']), flush=True)
                with torch.inference_mode():
                    waves, sample_rate = model.generate_custom_voice(text=segment['text'], language='Chinese', speaker=args.speaker, instruct=STYLE, non_streaming_mode=True, max_new_tokens=2048)
                wave = np.asarray(waves[0], dtype=np.float32)
                if not np.isfinite(wave).all() or len(wave) < sample_rate * .2 or np.max(np.abs(wave)) < .001:
                    raise RuntimeError('Invalid/empty generated audio on page ' + page)
                # Trim only near-silent edges; preserve speech timing and internal pauses.
                active = np.flatnonzero(np.abs(wave) > .003)
                if len(active):
                    wave = wave[max(0, active[0]-int(sample_rate*.08)):min(len(wave),active[-1]+int(sample_rate*.16))]
                cache_audio(cache_path, wave, sample_rate)
            parts.append(wave)
        wave = np.concatenate(parts) if parts else np.zeros(sample_rate, dtype=np.float32)
        filename = f'{int(page):02d}-{digest[:10]}.wav'
        target = output / filename
        temporary = target.with_suffix('.tmp.wav')
        sf.write(temporary, wave, sample_rate, subtype='PCM_16')
        temporary.replace(target)
        duration = len(wave)/sample_rate
        # A save during inference must not publish audio for the superseded draft.
        latest = extract_slides(args.html.read_text(encoding='utf-8'))
        latest_slide = next((item for item in latest if str(item['page']) == page), None)
        if not latest_slide or latest_slide['notes'] != slide['notes']:
            print('SUPERSEDED', page, flush=True)
            continue
        manifest['slides'][page] = {'file':'narration/'+filename, 'duration':round(duration,3), 'budget':slide['seconds'], 'notes':slide['notes'], 'hash':digest, 'title':slide['title']}
        manifest['totalDuration'] = round(sum(s['duration'] for s in manifest['slides'].values()),3)
        atomic_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2))
        atomic_text(output / 'manifest.js', 'window.PPT_NARRATION = '+json.dumps(manifest, ensure_ascii=False)+';\n')
        print('DONE', page, 'audio_seconds',round(duration,1),'elapsed',round(time.time()-start,1),flush=True)

if __name__ == '__main__':
    main()
