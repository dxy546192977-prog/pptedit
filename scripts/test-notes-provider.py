import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import local_notes

spec = importlib.util.spec_from_file_location('notes_editor', Path(__file__).with_name('notes-editor.py'))
editor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(editor)


class NotesProviderTests(unittest.TestCase):
    def test_local_failure_never_calls_codex_or_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            job = {}
            with patch.object(local_notes, 'run', side_effect=ValueError('模型不可用')), patch.object(editor.local_codex, 'run') as codex, patch.object(editor, 'publish') as publish:
                editor.run(job, {}, {'page': 1, 'title': '测试', 'notes': ['旧稿']}, '新稿', Path(directory)/'job', provider='qwen')
                self.assertEqual(job['state'], 'error')
                codex.assert_not_called()
                publish.assert_not_called()

    def test_provider_routes_and_publishes_valid_notes(self):
        for provider in ('qwen', 'codex'):
            with tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                html = folder/'index.html'
                item = {'page': 1, 'title': '测试', 'notes': ['旧稿']}
                html.write_text('const slides='+json.dumps([item])+';')
                def generate(config, work, prompt, output):
                    output.write_text('{"notes":["新讲稿"]}')
                job = {}
                with patch.object(local_notes, 'run', side_effect=generate) as qwen, patch.object(editor.local_codex, 'run', side_effect=generate) as codex:
                    editor.run(job, {'html': str(html)}, item, '新稿', folder/'job', provider=provider)
                    self.assertEqual(job['state'], 'done')
                    self.assertEqual(qwen.call_count, int(provider == 'qwen'))
                    self.assertEqual(codex.call_count, int(provider == 'codex'))
                    self.assertIn('新讲稿', html.read_text())

    def test_conflicting_notes_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            html = Path(directory)/'index.html'
            text = 'const slides='+json.dumps([{'page': 1, 'notes': ['别人已修改']}])+';'
            html.write_text(text)
            with self.assertRaises(ValueError): editor.publish(html, 1, ['旧稿'], ['模型返回'])
            self.assertEqual(html.read_text(), text)

    def test_invalid_output_rejected(self):
        for text in ('{"notes":[]}', '{"notes":[null]}', 'plain text', '{"notes":[" "]}'):
            with self.assertRaises(ValueError): local_notes.parse_response(text)
        self.assertEqual(local_notes.parse_response('```json\n{"notes":["讲稿"]}\n```')['notes'], ['讲稿'])


if __name__ == '__main__': unittest.main()
