import json
import unittest
import figma_reference as f


class FigmaTests(unittest.TestCase):
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
