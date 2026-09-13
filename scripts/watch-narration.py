"""Debounced local note watcher. One generator at a time, resumable across restarts."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('generator', Path(__file__).with_name('generate-narration.py'))
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except FileNotFoundError:
        return default

def snapshot(html, config):
    slides = generator.extract_slides(html.read_text(encoding='utf-8'))
    voice = [config['model'], config.get('speaker','Aiden'), config.get('style',generator.STYLE)]
    hashes = {str(s['page']):hashlib.sha256(json.dumps([s['notes'],voice],ensure_ascii=False).encode()).hexdigest() for s in slides}
    return slides, hashes

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',required=True,type=Path)
    parser.add_argument('--stop-after',type=float,default=0,help='Bounded integration test run')
    args=parser.parse_args()
    config=read_json(args.config,{})
    html=Path(config['html']).resolve()
    output=html.parent/'narration'
    output.mkdir(exist_ok=True)
    from filelock import FileLock, Timeout
    lock=FileLock(str(output/'.watcher.lock'),timeout=0)
    try:
        lock.acquire()
    except Timeout:
        print('Watcher already running',flush=True)
        return
    state_path=output/'watch-state.json'
    slides,current=snapshot(html,config)
    saved=read_json(state_path,{})
    seen=saved.get('seen',current)
    dirty={p:info for p,info in saved.get('dirty',{}).items() if p in current}
    jobs={p:{'state':'queued'} for p in dirty}
    # First install observes future saves; it does not silently approve/rebuild a pending voice choice.
    process=None
    running={}
    deadline=time.monotonic()+float(config.get('debounceSeconds',4))
    started=time.monotonic()
    log=None
    last_live=None
    last_error=None
    runtime=output/'watcher-runtime.json'
    import os
    generator.atomic_text(runtime,json.dumps({'pid':os.getpid(),'startedAt':time.time(),'config':str(args.config)},ensure_ascii=False))
    print('WATCHING',html,flush=True)
    try:
        while not args.stop_after or time.monotonic()-started<args.stop_after:
            now=time.monotonic()
            try:
                config=read_json(args.config,{})
                slides,current=snapshot(html,config)
                changes={p:h for p,h in current.items() if seen.get(p)!=h}
                if changes:
                    for page,digest in changes.items():
                        dirty[page]={'hash':digest,'attempts':0}
                        jobs[page]={'state':'queued'}
                    deadline=now+float(config.get('debounceSeconds',4))
                    print('QUEUED',','.join(changes),flush=True)
                seen=current.copy()
                dirty={p:info for p,info in dirty.items() if p in current}
                jobs={p:info for p,info in jobs.items() if p in current}
                last_error=None
            except (OSError,ValueError,KeyError) as error:
                # Editors may temporarily truncate/replace the file; never synthesize a partial save.
                last_error=str(error)
                deadline=now+float(config.get('debounceSeconds',4))
            if process and process.poll() is not None:
                code=process.returncode
                log.close()
                manifest=read_json(output/'manifest.json',{'slides':{}})
                for page,digest in running.items():
                    if page not in dirty or dirty[page]['hash']!=digest:
                        continue
                    record=manifest.get('slides',{}).get(page)
                    slide=next((s for s in slides if str(s['page'])==page),None)
                    if code==0 and record and slide and record['notes']==slide['notes'] and (html.parent/record['file']).exists():
                        del dirty[page]
                        jobs[page]={'state':'ready'}
                    else:
                        dirty[page]['attempts']+=1
                        jobs[page]={'state':'error','message':'本地语音生成失败；详见 narration/build.log'}
                print('BUILD_EXIT',code,flush=True)
                process=None
                deadline=now+15
            pending={p:info['hash'] for p,info in dirty.items() if info['attempts']<2}
            voice_ready=config.get('voiceReady',True)
            if not voice_ready:
                for page in pending:
                    jobs[page]={'state':'waiting_voice'}
            if not process and pending and voice_ready and now>=deadline and not last_error:
                running=pending
                for page in pending:
                    jobs[page]={'state':'generating'}
                log=(output/'build.log').open('a',encoding='utf-8')
                command=[sys.executable,'-X','utf8',str(Path(__file__).with_name('generate-narration.py')),'--html',str(html),'--model',config['model'],'--config',str(args.config),'--pages',','.join(pending),'--batch-size',str(config.get('batchSize',4))]
                process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                print('BUILD',','.join(pending),flush=True)
            state={'seen':seen,'dirty':dirty}
            encoded=json.dumps(state,ensure_ascii=False,sort_keys=True)
            if not state_path.exists() or state_path.read_text(encoding='utf-8')!=encoded:
                generator.atomic_text(state_path,encoded)
            live={'manifest':read_json(output/'manifest.json',{'slides':{}}),'jobs':jobs,'sourceNotes':{str(s['page']):s['notes'] for s in slides},'watcherError':last_error,'voiceReady':voice_ready}
            encoded_live=json.dumps(live,ensure_ascii=False,sort_keys=True)
            if encoded_live!=last_live:
                generator.atomic_text(output/'live.js','window.PPT_NARRATION_LIVE = '+encoded_live+';\n')
                last_live=encoded_live
            time.sleep(.5)
    finally:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=15)
        if log and not log.closed:
            log.close()
        lock.release()

if __name__=='__main__':
    main()
