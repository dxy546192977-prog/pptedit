"""Archive explicitly selected dialogue and attachments alongside layout jobs."""
import argparse,json,time,shutil
from pathlib import Path
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--record',required=True);args=parser.parse_args()
    record=json.loads(Path(args.record).read_text(encoding='utf-8-sig'))
    ident=record['id']
    if not ident or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in ident):raise ValueError('Invalid record id')
    folder=Path(args.root)/'制作源/layout-jobs'/ident;folder.mkdir(parents=True,exist_ok=True)
    # Stable IDs make repeated imports idempotent. Never infer an old result from current state.
    if (folder/'request.json').exists():print('Already archived:',ident);return
    if record.get('image'):shutil.copy2(record['image'],folder/'reference.png')
    for key in ('before','after'):
        if record.get(key):shutil.copy2(record[key],folder/(key+'.svg'))
    request={key:record[key] for key in ('instruction','respectDesign','dialogue','sourceUrl','attachmentLabel') if key in record}
    request['source']='Codex 对话'
    (folder/'request.json').write_text(json.dumps(request,ensure_ascii=False,indent=2),encoding='utf-8')
    status={'id':ident,'page':record.get('page',1),'state':'recorded','message':'对话记录已补录','createdAt':time.time(),'timeLabel':'对话补录时间；非原消息时间'}
    (folder/'status.json').write_text(json.dumps(status,ensure_ascii=False),encoding='utf-8')
    print('Archived:',ident)
if __name__=='__main__':main()
