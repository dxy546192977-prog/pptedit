"""Explicit Figma-node import; never use a social preview as design evidence."""
import base64
import json
import re
import subprocess
import io
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, quote
import xml.etree.ElementTree as ET
import local_codex
import figma_mcp
from PIL import Image


def screenshot_bytes(result,folder):
    """Figma may return inline PNG data or a short-lived native asset URL."""
    for content in result.get('content',[]):
        if content.get('type')=='image' and content.get('mimeType')=='image/png':
            data=base64.b64decode(content['data'],validate=True)
            break
        if content.get('type')!='text':continue
        try:value=json.loads(content['text'])
        except ValueError:continue
        if not isinstance(value,dict) or not value.get('image_url'):continue
        url=value['image_url'];parts=urlsplit(url)
        if (parts.scheme!='https' or parts.hostname not in ('www.figma.com','figma.com')
                or parts.username or parts.password or parts.port not in (None,443)
                or not re.fullmatch(r'/api/mcp/asset/[A-Za-z0-9_.-]+',parts.path)):
            raise ValueError('Figma 截图地址无效，未修改当前页')
        temporary=folder/'reference.download'
        try:
            # Python's default HTTP user agent can receive an empty 200 from this CDN.
            process=subprocess.run(['curl','--fail','--location','--silent','--show-error',
                '--proto','=https','--proto-redir','=https','--max-time','30',
                '--max-filesize','20000000','--output',str(temporary),url],capture_output=True,timeout=35)
            if process.returncode:raise ValueError('Figma 截图下载失败，请检查网络后重试；当前页未修改')
            data=temporary.read_bytes()
        finally:
            temporary.unlink(missing_ok=True)
        break
    else:raise ValueError('Figma 未返回有效节点截图；当前页未修改')
    if not data.startswith(b'\x89PNG\r\n\x1a\n') or len(data)>20_000_000:
        raise ValueError('Figma 截图不是有效 PNG；当前页未修改')
    with Image.open(io.BytesIO(data)) as picture:
        if picture.width*picture.height>25_000_000:raise ValueError('Figma 截图像素过大')
        picture.verify()
    return data


def parse_url(url):
    parts=urlsplit(url)
    if parts.hostname not in ('figma.com','www.figma.com'):
        return None
    match=re.match(r'^/(?:design|file)/([A-Za-z0-9]+)(?:/|$)',parts.path)
    node=parse_qs(parts.query).get('node-id',[''])[0].replace('-',':')
    if parts.scheme!='https' or parts.username or not match or not re.fullmatch(r'\d+:\d+',node):
        raise ValueError('请复制 Figma 具体画框的链接，链接需包含 node-id；不使用文件封面代替节点')
    branch=re.search(r'/branch/([A-Za-z0-9]+)(?:/|$)',parts.path)
    key=branch.group(1) if branch else match.group(1)
    return {'kind':'figma','fileKey':key,'nodeId':node,'sourceUrl':f'https://www.figma.com/design/{key}/?node-id={quote(node)}'}


def validate(svg):
    if len(svg)>20_000_000 or '<!DOCTYPE' in svg.upper() or '<!ENTITY' in svg.upper() or '<?xml-stylesheet' in svg.lower():
        raise ValueError('Figma SVG 导出无效或过大')
    root=ET.fromstring(svg)
    if root.tag!='{http://www.w3.org/2000/svg}svg':raise ValueError('Figma 未返回 SVG')
    for element in root.iter():
        allowed={'svg','g','defs','path','rect','circle','ellipse','polygon','polyline','line','text','tspan','image','use','mask','clipPath','pattern','linearGradient','radialGradient','stop','filter','feBlend','feColorMatrix','feComposite','feFlood','feGaussianBlur','feOffset','feMerge','feMergeNode','feComponentTransfer','feFuncR','feFuncG','feFuncB','feFuncA','feDropShadow','title','desc'}
        if element.tag.split('}')[-1] not in allowed:
            raise ValueError('Figma 导出包含不支持的可执行或样式元素')
        for key,value in element.attrib.items():
            if key.lower().startswith('on'):raise ValueError('SVG 不能含事件')
            if key.split('}')[-1] in ('href','src') and not (value.startswith('#') or re.fullmatch(r'data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+',value)):
                raise ValueError('Figma 资源未内嵌，不能发布会失效的外链')
            if any(not part.strip().startswith('#') for part in re.findall(r'url\((.*?)\)',value,re.I)):
                raise ValueError('SVG 不能含外部样式资源')
    return root


def exported_payload(events,reference):
    def visit(value,depth=0):
        if depth>15:return None
        if isinstance(value,dict):
            if value.get('fileKey')==reference['fileKey'] and value.get('nodeId')==reference['nodeId'] and (isinstance(value.get('svg'),str) or isinstance(value.get('chunk'),str)):return value
            for child in value.values():
                found=visit(child,depth+1)
                if found:return found
        elif isinstance(value,list):
            for child in value:
                found=visit(child,depth+1)
                if found:return found
        elif isinstance(value,str) and value.lstrip().startswith(('{','[')):
            try:return visit(json.loads(value),depth+1)
            except ValueError:pass
        return None
    chunks={};fingerprint=None;total=None;png=None;full=None
    for line in events.splitlines():
        try:event=json.loads(line)
        except ValueError:continue
        # Only accept the native MCP result, never the assistant's final prose.
        item=event.get('item',{})
        if item.get('type')=='mcp_tool_call' and item.get('tool')=='use_figma':
            found=visit(item.get('result'))
            if found:
                if 'svg' in found:full=found['svg'];png=found.get('png',png)
                else:
                    if fingerprint is not None and fingerprint!=(found.get('hash'),found.get('total')):raise ValueError('Figma 导出期间节点发生变化，未拼接过期数据')
                    fingerprint=(found.get('hash'),found.get('total'));total=found.get('total');chunks[found.get('index')]=found['chunk']
        if item.get('type')=='mcp_tool_call' and item.get('tool')=='get_screenshot':
            result=item.get('result') or {}
            for content in result.get('content',[]):
                if content.get('type')=='image' and content.get('mimeType')=='image/png':png=content.get('data')
    if full is None and isinstance(total,int) and 0<total<=2000 and set(chunks)==set(range(total)):
        full=''.join(chunks[i] for i in range(total))
        h=2166136261;encoded=full.encode('utf-16-le')
        for i in range(0,len(encoded),2):h=((h^int.from_bytes(encoded[i:i+2],'little'))*16777619)&0xffffffff
        if h!=fingerprint[0]:raise ValueError('Figma SVG 分块校验失败，未发布不完整设计')
    if full is None:raise ValueError('未取得完整的 Figma 原生导出记录；未猜测或覆盖当前页，可复制任务到 Codex 继续')
    return {**reference,'svg':full,'png':png}


def read_node(config,folder,reference,progress=None):
    """Import deterministic native tool output, never model-generated SVG or prose."""
    local_codex.save_handoff(config,folder)
    template=Path(__file__).with_name('figma-export.js').read_text(encoding='utf-8')
    code=('const TARGET_NODE_ID='+json.dumps(reference['nodeId'])+';\n'
          'const TARGET_FILE_KEY='+json.dumps(reference['fileKey'])+';\n'+template)
    def arguments(index):
        return {'fileKey':reference['fileKey'],'code':'const CHUNK_INDEX='+str(index)+';\n'+code,
                'description':'只读导出 PPT 源节点的原生 SVG 分块 '+str(index),
                'skillNames':'figma-use'}
    def payload(result):
        for content in result.get('content',[]):
            if content.get('type')=='text':
                try:value=json.loads(content['text'])
                except ValueError:continue
                if isinstance(value,dict) and 'chunk' in value:return value
        raise ValueError('Figma 未返回完整原生 SVG 分块；当前页未修改')
    if progress:progress('正在检查后台 Figma 连接与导出工具…')
    with figma_mcp.Client(config,folder) as client:
        metadata=payload(client.call('use_figma',arguments(-1)))
        if (metadata.get('fileKey'),metadata.get('nodeId'))!=(reference['fileKey'],reference['nodeId']):
            raise ValueError('Figma 返回的文件或节点不匹配，未修改当前页')
        total=metadata.get('total');length=metadata.get('length')
        if type(total) is not int or not 0<total<=2000 or type(length) is not int or not 0<length<=16_000_000:
            raise ValueError('Figma SVG 大小无效或过大；当前页未修改')
        chunks=[]
        for start in range(0,total,4):
            if progress:progress(f'正在读取 Figma 原生 SVG：{start}/{total} 块…')
            indices=list(range(start,min(start+4,total)))
            for index,result in zip(indices,client.call_many('use_figma',[arguments(i) for i in indices])):
                part=payload(result)
                if any(part.get(k)!=metadata.get(k) for k in ('fileKey','nodeId','hash','total','length')) or part.get('index')!=index:
                    raise ValueError('Figma 导出期间节点发生变化或分块不匹配；当前页未修改，请重试')
                if not isinstance(part.get('chunk'),str):raise ValueError('Figma SVG 分块无效')
                chunks.append(part['chunk'])
        svg=''.join(chunks).encode('utf-16-le',errors='surrogatepass').decode('utf-16-le')
        encoded=svg.encode('utf-16-le');h=2166136261
        for i in range(0,len(encoded),2):h=((h^int.from_bytes(encoded[i:i+2],'little'))*16777619)&0xffffffff
        if length!=len(encoded)//2 or metadata.get('hash')!=h:
            raise ValueError('Figma SVG 完整性校验失败，未修改当前页')
        validate(svg)
        if progress:progress('SVG 完整性校验通过，正在读取同节点截图…')
        result=client.call('get_screenshot',{'fileKey':reference['fileKey'],'nodeId':reference['nodeId']})
        png=screenshot_bytes(result,folder)
    (folder/'figma-original.svg').write_text(svg,encoding='utf-8')
    (folder/'reference.png').write_bytes(png)
    (folder/'figma-export.json').write_text(json.dumps(metadata,ensure_ascii=False),encoding='utf-8')
    return svg,png
