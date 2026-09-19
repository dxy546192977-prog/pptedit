import json
import unittest
import base64
import io
import tempfile
from pathlib import Path
from unittest.mock import patch
import figma_reference as f


class FigmaTests(unittest.TestCase):
    def native_import(self, fault=None):
        svg='<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><path d="M0 0"/><!--'+'a'*23000+'--></svg>'
        encoded=svg.encode('utf-16-le');h=2166136261
        for i in range(0,len(encoded),2):h=((h^int.from_bytes(encoded[i:i+2],'little'))*16777619)&0xffffffff
        ref={'fileKey':'A','nodeId':'1:2'}
        total=(len(svg)+7999)//8000
        image=io.BytesIO();f.Image.new('RGB',(2,2)).save(image,format='PNG')
        def result(index):
            value={**ref,'length':len(svg),'total':total,'hash':h,'index':index,
                   'chunk':'' if index<0 else svg[index*8000:(index+1)*8000]}
            if fault and index>=0:fault(value)
            return {'content':[{'type':'text','text':json.dumps(value)}]}
        class Client:
            def __init__(self,*args):pass
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def call(self,tool,args):
                if tool=='use_figma':return result(-1)
                return {'content':[{'type':'image','mimeType':'image/png','data':base64.b64encode(image.getvalue()).decode()}]}
            def call_many(self,tool,args):
                import re
                return [result(int(re.search(r'CHUNK_INDEX=(\d+)',a['code'])[1])) for a in args]
        with tempfile.TemporaryDirectory() as root, patch.object(f.figma_mcp,'Client',Client), patch.object(f.local_codex,'run',side_effect=AssertionError('No model turn')):
            folder=Path(root)
            try:
                actual,_=f.read_node({'html':'/tmp/deck.html'},folder,ref)
                self.assertEqual(actual,svg)
                self.assertEqual((folder/'figma-original.svg').read_text(),svg)
            except ValueError:
                self.assertFalse((folder/'figma-original.svg').exists())
                raise

    def test_native_import_over_20kb_without_model(self):
        self.native_import()

    def test_native_node_change_never_publishes(self):
        with self.assertRaisesRegex(ValueError,'节点发生变化'):
            self.native_import(lambda p:p.update(hash=p['hash']+1))

    def test_native_wrong_file_never_publishes(self):
        with self.assertRaisesRegex(ValueError,'分块不匹配'):
            self.native_import(lambda p:p.update(fileKey='other'))

    def test_native_truncated_chunk_never_publishes(self):
        with self.assertRaisesRegex(ValueError,'完整性校验失败'):
            self.native_import(lambda p:p.update(chunk=p['chunk'][:-1]))

    def test_screenshot_url_and_inline_forms(self):
        image=io.BytesIO();f.Image.new('RGB',(3,2)).save(image,format='PNG');png=image.getvalue()
        result={'content':[{'type':'text','text':json.dumps({'image_url':'https://www.figma.com/api/mcp/asset/test.png'})}]}
        def download(command,**kwargs):
            Path(command[command.index('--output')+1]).write_bytes(png)
            return type('Result',(),{'returncode':0})()
        with tempfile.TemporaryDirectory() as root,patch.object(f.subprocess,'run',download):
            self.assertEqual(f.screenshot_bytes(result,Path(root)),png)
            self.assertFalse((Path(root)/'reference.download').exists())

    def test_screenshot_url_rejects_non_figma_and_empty_response(self):
        with tempfile.TemporaryDirectory() as root:
            for url in ('http://127.0.0.1/secret','https://figma.com.evil.test/api/mcp/asset/a','https://www.figma.com/not-an-asset'):
                with self.assertRaisesRegex(ValueError,'截图地址无效'):
                    f.screenshot_bytes({'content':[{'type':'text','text':json.dumps({'image_url':url})}]},Path(root))
            with self.assertRaisesRegex(ValueError,'有效 PNG'):
                f.screenshot_bytes({'content':[{'type':'image','mimeType':'image/png','data':''}]},Path(root))

    def test_specific_node_and_branch(self):
        ref=f.parse_url('https://www.figma.com/design/Original/branch/Branch1/Name?node-id=12-34&t=tracking')
        self.assertEqual((ref['fileKey'],ref['nodeId']),('Branch1','12:34'))
        self.assertNotIn('tracking',ref['sourceUrl'])
        self.assertIsNone(f.parse_url('https://example.com/reference.png'))
        with self.assertRaises(ValueError):f.parse_url('https://figma.com/design/Original/Name')

    def test_native_images_allowed_but_external_content_rejected(self):
        f.validate('<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA=="/></svg>')
        for child in ['<script/>','<foreignObject/>','<image href="https://example.com/a.png"/>','<rect onclick="bad()"/>']:
            with self.assertRaises(ValueError):f.validate('<svg xmlns="http://www.w3.org/2000/svg">'+child+'</svg>')

    def test_no_generated_or_partial_export_accepted(self):
        ref={'fileKey':'A','nodeId':'1:2'}
        data={**ref,'svg':'<svg/>','png':'AA=='}
        with self.assertRaises(ValueError):f.exported_payload(json.dumps({'item':{'type':'agent_message','text':json.dumps(data)}}),ref)
        event={'item':{'type':'mcp_tool_call','tool':'use_figma','result':{'content':[{'type':'text','text':json.dumps({**ref,'chunk':'<svg/>','index':0,'total':2,'hash':1})}]}}}
        with self.assertRaises(ValueError):f.exported_payload(json.dumps(event),ref)


if __name__=='__main__':unittest.main()
