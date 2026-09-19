import queue
import unittest
import tempfile
from pathlib import Path
from unittest.mock import Mock,patch

from figma_mcp import Client, FigmaConnectionError


class TransportTests(unittest.TestCase):
    def client(self, messages):
        client=Client.__new__(Client)
        client.sequence=0
        client.messages=queue.Queue()
        client._send=Mock()
        for message in messages:client.messages.put(message)
        return client

    def test_out_of_order_parallel_results_and_notifications(self):
        client=self.client([{'method':'progress'}, {'id':2,'result':{'chunk':2}},
                            {'id':1,'result':{'chunk':1}}])
        self.assertEqual(client.rpc_batch('mcpServer/tool/call',[{},{}]),[{'chunk':1},{'chunk':2}])

    def test_disconnect_is_explicit(self):
        client=self.client([None])
        with self.assertRaisesRegex(FigmaConnectionError,'连接已断开'):client.rpc('test',{})

    def test_timeout_is_bounded(self):
        client=self.client([])
        with self.assertRaisesRegex(FigmaConnectionError,'超时'):client.rpc('test',{},timeout=0)

    def test_interactive_requests_are_not_approved(self):
        client=self.client([{'id':42,'method':'approval/request'}, {'id':1,'result':{}}])
        client.rpc('test',{})
        self.assertIn('error',client._send.call_args.args[0])

    def test_rpc_error_does_not_expose_credentials(self):
        client=self.client([{'id':1,'error':{'message':'Bearer SECRET'}}])
        with self.assertRaises(FigmaConnectionError) as error:client.rpc('test',{})
        self.assertNotIn('SECRET',str(error.exception))

    def test_missing_tools_fail_before_export_and_close_process(self):
        process=Mock()
        with tempfile.TemporaryDirectory() as root,patch('figma_mcp.local_codex.discover',return_value={'path':'codex'}),\
             patch('figma_mcp.subprocess.Popen',return_value=process),patch('figma_mcp.threading.Thread'),\
             patch.object(Client,'rpc',side_effect=[{}, {'thread':{'id':'ephemeral'}},
                 {'data':[{'name':'figma','tools':{}}]}]):
            with self.assertRaisesRegex(FigmaConnectionError,'缺少工具'):
                with Client({},Path(root)):self.fail('must not start export')
            process.terminate.assert_called_once()


if __name__=='__main__':unittest.main()
