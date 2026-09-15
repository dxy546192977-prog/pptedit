import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import local_codex


class RuntimeTests(unittest.TestCase):
    def test_old_config_does_not_pin_old_cli(self):
        def version(command, **kwargs):
            value = '0.151.0' if command[0] == '/old/codex' else '0.153.4'
            return type('Result', (), {'returncode': 0, 'stdout': 'codex-cli ' + value})()
        def which(value):
            return value if value in ('/old/codex', '/Applications/ChatGPT.app/Contents/Resources/codex') else None
        with patch.object(local_codex.shutil, 'which', which), patch.object(local_codex.subprocess, 'run', version):
            self.assertEqual(local_codex.discover({'codex': '/old/codex'})['version'], 'codex-cli 0.153.4')

    def test_missing_cli(self):
        with patch.object(local_codex.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(ValueError, '未找到本地 Codex'):
                local_codex.discover()

    def test_version_error_has_action(self):
        with tempfile.TemporaryDirectory() as root:
            log = Path(root) / 'codex.log'
            log.write_text("The model requires a newer version of Codex")
            self.assertIn('更新 Codex', local_codex.failure(log))

    def test_quota_is_not_transient_rate_limit(self):
        with tempfile.TemporaryDirectory() as root:
            log=Path(root)/'codex.log'
            log.write_text("You've hit your usage limit. try again at Sep 19th, 2026 4:18 PM.")
            self.assertIn('Sep 19th',local_codex.failure(log))
            self.assertIn('额度已用完',local_codex.failure(log))
            log.write_text('rate limit exceeded')
            self.assertIn('等待 60 秒',local_codex.failure(log))


if __name__ == '__main__':
    unittest.main()
