"""Local-only text generation for narration; never falls back to a cloud provider."""
import json
import os
from pathlib import Path
import subprocess
import threading

MODEL_LOCK = threading.Lock()


def settings(config):
    runtime = Path.home() / 'Library/Application Support/PPTedit'
    return (Path(config.get('notesPython', runtime / 'notes-venv/bin/python')),
            Path(config.get('notesModel', runtime / 'models/Qwen3-4B-4bit')))


def availability(config):
    python, model = settings(config)
    ready = python.is_file() and (model / 'config.json').is_file() and any(model.glob('*.safetensors'))
    return {'id': 'qwen', 'label': '本地千问', 'available': ready,
            'message': '在本机整理讲稿' if ready else '尚未安装千问文本模型；现有语音模型不能整理文字'}


def run(config, folder, prompt, result):
    if not availability(config)['available']:
        raise ValueError(availability(config)['message'] + '。请安装后重试，或手动选择 Codex')
    python, model = settings(config)
    prompt_file = folder / 'prompt.txt'
    prompt_file.write_text(prompt, encoding='utf-8')
    env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}
    with MODEL_LOCK, (folder / 'local-qwen.log').open('w') as log:
        try:
            proc = subprocess.run([str(python), str(Path(__file__).with_name('generate-notes-local.py')),
                                   '--model', str(model), '--prompt', str(prompt_file), '--output', str(result)],
                                  env=env, stdout=log, stderr=log, timeout=600)
        except subprocess.TimeoutExpired as error:
            raise ValueError('本地千问整理超时，原讲稿未修改，请缩短输入后重试') from error
    if proc.returncode:
        raise ValueError('本地千问整理失败，原讲稿未修改；请检查本地模型运行日志')


def parse_response(text):
    text = text.strip()
    if text.startswith('<think>') and '</think>' in text:
        text = text.split('</think>', 1)[1].strip()
    if text.startswith('```') and text.endswith('```'):
        text = text.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    value = json.loads(text)
    notes = value.get('notes') if isinstance(value, dict) else None
    if not isinstance(notes, list) or not notes or not all(isinstance(n, str) and n.strip() for n in notes) or sum(map(len, notes)) > 30000:
        raise ValueError('AI 返回格式不正确，未覆盖原稿')
    return value
