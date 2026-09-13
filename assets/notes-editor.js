(() => {
 const host=window.PPT_NARRATION_HOST,config=window.PPT_LAYOUT_REFERENCE;if(!host||!config||document.getElementById('edit-notes'))return;
 const button=document.createElement('button');button.id='edit-notes';button.textContent='编辑讲稿';button.style.cssText='float:right;font-size:12px;padding:4px 10px';document.getElementById('notes-title').append(button);
 const dialog=document.createElement('dialog');dialog.className='layout-reference-dialog';dialog.innerHTML='<form method="dialog"><header><strong>编辑讲稿</strong><button aria-label="关闭">×</button></header><p data-title></p><textarea data-draft rows="12" aria-label="讲稿内容" style="width:100%;box-sizing:border-box"></textarea><p>可自由补充内容。确认后 AI 保留原意，优化为更自然的口头表达，并更新本地语音。</p><p data-status role="status"></p><footer><button>关闭</button><button type="button" data-save>确认并优化</button></footer></form>';document.body.append(dialog);
 const q=s=>dialog.querySelector(s);let page,base,busy=false;const drafts=new Map();
 const progress=document.createElement('p');progress.setAttribute('role','status');progress.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10000;background:#22272f;color:#e2e9e4;padding:12px 20px;border:1px solid #496553;border-radius:8px;max-width:80vw';progress.hidden=true;document.body.append(progress);
 const report=message=>{q('[data-status]').textContent=message;progress.textContent=message;progress.hidden=false;};
 const localWindow=document.createElement('a');localWindow.textContent='打开本地编辑窗口';localWindow.target='_blank';localWindow.rel='noopener';localWindow.style.cssText='display:block;color:#a8d5b9;margin:12px 0';q('footer').before(localWindow);
 localWindow.addEventListener('click',()=>{remember();localWindow.href=config.url+'/notes-window#'+new URLSearchParams({token:config.token,page:String(page.page),draft:q('[data-draft]').value});});
 const key=p=>'ppt-notes-draft:'+location.pathname+':'+p;
 function remember(){if(!page)return;drafts.set(page.page,q('[data-draft]').value);try{localStorage.setItem(key(page.page),q('[data-draft]').value);}catch{}}
 q('[data-draft]').addEventListener('input',remember);dialog.addEventListener('keydown',e=>e.stopPropagation());
 button.onclick=()=>{if(busy){dialog.showModal();return;}page=host.getSlides()[host.getIndex()];base=[...page.notes];let saved=drafts.get(page.page);try{saved??=localStorage.getItem(key(page.page));}catch{}q('[data-draft]').value=saved??page.notes.join('\n\n');q('[data-title]').textContent=page.page+' · '+page.title;q('[data-status]').textContent='';dialog.showModal();};
 new MutationObserver(()=>{const title=document.getElementById('notes-title');if(!title.contains(button))title.append(button);}).observe(document.getElementById('notes-title'),{childList:true});
 const request=async(path,options={})=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetch(config.url+path,{...options,signal:controller.signal,headers:{'Content-Type':'application/json','X-Layout-Token':config.token}});const result=await response.json();if(!response.ok)throw Error(result.message);return result;}catch(error){if(error.name==='TypeError'||error.name==='AbortError')throw Error('浏览器未能连接本地服务。请点击「打开本地编辑窗口」继续，当前草稿会一起带过去');throw error;}finally{clearTimeout(timer);}};
 q('[data-save]').onclick=async()=>{
  if(busy)return;
  const draft=q('[data-draft]').value;
  if(!draft.trim()){q('[data-status]').textContent='请先填写讲稿内容。';return;}
  remember();busy=true;q('[data-save]').disabled=true;q('[data-draft]').disabled=true;
  const target=page,original=[...base];dialog.close();report('正在提交第 '+target.page+' 页讲稿，请稍候…');
  try{
   let job=await request('/notes',{method:'POST',body:JSON.stringify({page:target.page,baseNotes:original,draft})});
   while(['queued','running'].includes(job.state)){report('第 '+target.page+' 页：'+job.message);await new Promise(r=>setTimeout(r,2000));job=await request('/jobs/'+job.id);}
   if(job.state!=='done')throw Error(job.message);
   target.notes=job.notes;base=[...job.notes];q('[data-draft]').value=job.notes.join('\n\n');drafts.delete(target.page);
   try{localStorage.removeItem(key(target.page));}catch{}
   if(host.getSlides()[host.getIndex()].page===target.page)host.goTo(host.getIndex());
   if(dialog.open)dialog.close();report(job.message);
  }catch(error){report(error.message+'；草稿已保留，请重新点击编辑讲稿重试。');}
  finally{busy=false;q('[data-save]').disabled=false;q('[data-draft]').disabled=false;}
 };
})();
