"""Install and start the loopback Codex bridge without a machine-specific CLI path."""
import argparse
import json
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import urllib.request
import local_codex


def ready(config):
    try:
        request = urllib.request.Request(f"http://127.0.0.1:{config['port']}/health",
                                         headers={'X-Layout-Token': config['token']})
        with urllib.request.urlopen(request, timeout=1) as response:
            return json.load(response).get('ready') is True
    except (OSError, ValueError):
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--html', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('--origin', action='append', default=[])
    parser.add_argument('--start', action='store_true')
    args = parser.parse_args()
    html = Path(args.html).resolve()
    if not html.is_file():
        raise ValueError('预览 HTML 不存在')
    path = Path(args.config).resolve()
    config = json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else {}
    runtime = local_codex.discover(config)
    login = subprocess.run([runtime['path'], 'login', 'status'], capture_output=True, text=True, timeout=15)
    if login.returncode:
        raise ValueError('本地 Codex 尚未登录，请先运行 codex login，再执行安装')
    # Fail before changing the page if the bridge dependency is missing.
    import PIL
    if 'port' not in config:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            config['port'] = sock.getsockname()[1]
    config.setdefault('token', secrets.token_hex(32))
    config['html'] = str(html)
    if 'designFiles' not in config:
        for directory in html.parents:
            design = directory / 'design.md'
            if design.is_file():
                config['designFiles'] = [str(design)]
                break
    config['allowedOrigins'] = list(dict.fromkeys(config.get('allowedOrigins', []) + args.origin))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
    path.chmod(0o600)
    if args.start and not ready(config):
        with (path.parent / 'local-codex-bridge.log').open('a') as log:
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('layout-bridge.py')),
                                        '--config', str(path)], stdout=log, stderr=log, start_new_session=True)
        for _ in range(50):
            if ready(config):
                break
            if process.poll() is not None:
                raise ValueError('后台启动失败，请查看 local-codex-bridge.log')
            time.sleep(.1)
        else:
            process.terminate()
            raise ValueError('后台启动超时，请查看 local-codex-bridge.log')
    print(json.dumps({'config': str(path), 'runtime': runtime, 'ready': ready(config)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
