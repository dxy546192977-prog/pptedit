"""Native Figma RPC through Codex's OAuth client; no model turn or credential copying."""
import json
import queue
import subprocess
import threading
import time

import local_codex


class FigmaConnectionError(ValueError):
    pass


class Client:
    def __init__(self, config, folder):
        self.folder = folder
        self.runtime = local_codex.discover(config)
        self.process = None
        self.messages = queue.Queue()
        self.sequence = 0
        self.thread_id = None

    def __enter__(self):
        # Explicit endpoint avoids duplicate/remote plugin catalog discovery for Figma.
        # Overrides apply only to this process; the user's global config is untouched.
        command = [self.runtime['path'], 'app-server',
                   '-c', 'mcp_servers.figma.url="https://mcp.figma.com/mcp"',
                   '-c', 'mcp_servers.figma.required=true',
                   '-c', 'mcp_servers.figma.startup_timeout_sec=45',
                   '-c', 'analytics.enabled=false']
        self.log = (self.folder / 'figma-mcp.log').open('w', encoding='utf-8')
        (self.folder / 'figma-mcp.log').chmod(0o600)
        try:
            self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=self.log, text=True, encoding='utf-8', bufsize=1)
            threading.Thread(target=self._read, daemon=True).start()
            self.rpc('initialize', {'clientInfo': {'name': 'pptedit_figma', 'version': '1.0'},
                                   'capabilities': {'experimentalApi': True}})
            self._send({'method': 'initialized'})
            result = self.rpc('thread/start', {'cwd': str(self.folder), 'ephemeral': True,
                                              'approvalPolicy': 'never', 'sandbox': 'read-only'})
            self.thread_id = result['thread']['id']
            tools = {}
            cursor = None
            while True:
                result = self.rpc('mcpServerStatus/list', {'threadId': self.thread_id,
                                  'detail': 'toolsAndAuthOnly', 'cursor': cursor}, timeout=90)
                for server in result.get('data', []):
                    if server['name'] == 'figma':
                        tools.update(server.get('tools') or {})
                cursor = result.get('nextCursor')
                if not cursor:
                    break
            missing = {'use_figma', 'get_screenshot'} - tools.keys()
            if missing:
                raise FigmaConnectionError('Figma 后台连接不可用，缺少工具：' + '、'.join(sorted(missing)) +
                                           '。请重新连接 Figma；当前页未修改。')
            self.tools = tools
            (self.folder / 'runtime.json').write_text(json.dumps({**self.runtime,
                'transport': 'native-mcp', 'server': 'figma', 'tools': sorted(tools)}, ensure_ascii=False), encoding='utf-8')
            return self
        except Exception:
            self.close()
            raise

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    self.messages.put(json.loads(line))
                except ValueError:
                    continue
        finally:
            self.messages.put(None)

    def _send(self, value):
        self.process.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
        self.process.stdin.flush()

    def rpc(self, method, params, timeout=60):
        return self.rpc_batch(method,[params],timeout)[0]

    def rpc_batch(self, method, params_list, timeout=60):
        pending={}
        results=[None]*len(params_list)
        for index,params in enumerate(params_list):
            self.sequence += 1
            pending[self.sequence]=index
            self._send({'id': self.sequence, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while pending:
            try:
                message = self.messages.get(timeout=max(0, deadline-time.monotonic()))
            except queue.Empty:
                raise FigmaConnectionError('Figma 连接或读取超时；当前页未修改，请稍后重试。') from None
            if message is None:
                raise FigmaConnectionError('Figma 后台连接已断开；请检查 figma-mcp.log，当前页未修改。')
            if message.get('id') in pending and 'method' not in message:
                if 'error' in message:
                    # Do not expose raw transport/auth data to the browser.
                    raise FigmaConnectionError('Figma 后台调用失败（' + method +
                        '）；请检查连接与授权，当前页未修改。')
                results[pending.pop(message['id'])]=message.get('result', {})
            if 'id' in message and 'method' in message:
                # This importer never approves external writes or interactive requests.
                self._send({'id': message['id'], 'error': {'code': -32601,
                                                         'message': 'PPTedit supports read-only export only'}})
        return results

    def call(self, tool, arguments):
        return self.call_many(tool,[arguments])[0]

    def call_many(self, tool, arguments_list):
        if tool not in ('use_figma', 'get_screenshot'):
            raise ValueError('Unsupported Figma import tool')
        results = self.rpc_batch('mcpServer/tool/call', [{'threadId': self.thread_id,
                          'server': 'figma', 'tool': tool, 'arguments': arguments}
                          for arguments in arguments_list], timeout=180)
        for result in results:
            self.record(tool,result)
        return results

    def record(self,tool,result):
        with (self.folder / 'figma-events.jsonl').open('a', encoding='utf-8') as output:
            (self.folder / 'figma-events.jsonl').chmod(0o600)
            output.write(json.dumps({'type': 'item.completed', 'item': {'type': 'mcp_tool_call',
                         'server': 'figma', 'tool': tool, 'result': result}}, ensure_ascii=False) + '\n')
        if result.get('isError'):
            message = ' '.join(item.get('text', '') for item in result.get('content', [])
                               if item.get('type') == 'text')
            raise ValueError('Figma 原生读取失败：' + message[:1800])
        return result

    def close(self):
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            for pipe in (self.process.stdin, self.process.stdout):
                pipe.close()
        if getattr(self, 'log', None):
            self.log.close()

    def __exit__(self, *args):
        self.close()
