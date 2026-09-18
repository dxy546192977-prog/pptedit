"""Explicit Figma-node import; never use a social preview as design evidence."""
import base64
import json
import re
from urllib.parse import urlsplit, parse_qs, quote
import xml.etree.ElementTree as ET
import local_codex


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


def read_node(config,folder,reference):
    prompt=('这是 Figma 原始节点读取任务，不是重新设计。只允许读取，不修改 Figma 或本地文件。'
            '使用 Figma MCP，先按 figma-design-to-code skill 读取指定 fileKey/nodeId 的 get_design_context；'
            '然后按 figma-use skill 使用 use_figma，在同一文件读取该节点并调用原生 exportAsync，'
            '导出 SVG_STRING（svgOutlineText:true，保证字体外观；svgIdAttribute:true）。'
            'hasMissingFont 仅作诊断，不能据此直接中止：该标志可能与当前可用字体不一致。'
            '导出前从所有 TEXT 的 getStyledTextSegments(["fontName"]) 收集去重后的实际 family/style，'
            '调用 listAvailableFontsAsync 核对，并逐一 await figma.loadFontAsync(fontName)，即使 hasMissingFont 为 true 也必须先尝试加载。'
            '若实际加载失败，返回具体 family/style、受影响节点 ID 和原始错误，停止且禁止替换字体。'
            '全部实际字体加载成功后，即使 hasMissingFont 仍为 true 也继续原生 exportAsync；以加载及导出结果判断成功，不能再次按该标志拒绝。'
            '每次 use_figma 分块导出调用都必须重新加载这些实际字体，因为调用间加载状态不保证保留。'
            'SVG 必须使用原生导出的完整结果，不能手绘、简化、删除图层或把整页截图包进 SVG。'
            '所有图片资源必须内嵌。另调用 get_screenshot 获取相同 fileKey/nodeId 的参考截图。不能只用桌面当前选择，因为必须核对文件。'
            '无法读取、缺少工具或导出失败时返回 {"error":"具体原因"}，不能猜测或抓 og:image。'
            '工具单次返回文本有限制，必须分块导出SVG。每块最多8000字符；首次可读SVG长度与块数，然后逐块调用 use_figma，重新export并 return {fileKey:"目标文件key",nodeId:node.id,index:从0开始的块号,total:Math.ceil(svg.length/8000),hash:对完整SVG计算FNV1a得到的32位无符号整数,chunk:svg.slice(index*8000,(index+1)*8000)}。'
            'FNV1a算法：let h=2166136261; for(let i=0;i<svg.length;i++){h=Math.imul(h^svg.charCodeAt(i),16777619)>>>0;}。每一块都要完整返回，不能遗漏或只返回摘要。调用器从工具事件直接组装，不要在最终回复复述SVG。'
            '最终仅返回 {"exportComplete":true} 或 {"error":"具体原因"}。'
            '\n目标：'+json.dumps(reference,ensure_ascii=False))
    result=folder/'figma-export.json'
    local_codex.run(config,folder,prompt,result,json_events=True)
    summary=json.loads(result.read_text(encoding='utf-8'))
    if summary.get('error'):raise ValueError('Figma 节点读取失败：'+str(summary['error']))
    value=exported_payload((folder/'codex.log').read_text(encoding='utf-8'),reference)
    if (value.get('fileKey'),value.get('nodeId'))!=(reference['fileKey'],reference['nodeId']):
        raise ValueError('Figma 返回的文件或节点不匹配，未修改当前页')
    validate(value['svg'])
    (folder/'figma-original.svg').write_text(value['svg'],encoding='utf-8')
    png=base64.b64decode(value['png'],validate=True) if value.get('png') else None
    if png:
        if not png.startswith(b'\x89PNG\r\n\x1a\n'):raise ValueError('Figma 未返回有效节点截图')
        (folder/'reference.png').write_bytes(png)
    return value['svg'],png
