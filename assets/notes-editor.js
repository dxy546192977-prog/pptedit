(() => {
 const host=window.PPT_NARRATION_HOST,config=window.PPT_LAYOUT_REFERENCE;if(!host||!config||document.getElementById('edit-notes'))return;
 const button=document.createElement('button');button.id='edit-notes';button.textContent='编辑讲稿';button.style.cssText='float:right;font-size:12px;padding:4px 10px';document.getElementById('notes-title').append(button);
 const dialog=document.createElement('dialog');dialog.className='layout-reference-dialog notes-editor-dialog';dialog.innerHTML='<form method="dialog"><header><strong>编辑讲稿</strong><button aria-label="关闭">×</button></header><p data-title></p><label>修改方式<select data-mode aria-label="修改方式"><option value="instruction">描述修改需求</option><option value="draft">直接改讲稿</option></select></label><textarea data-draft rows="8" aria-label="修改需求" style="width:100%;box-sizing:border-box" placeholder="例如：这一页整体换个意思，不再强调成果，改成讲这次尝试暴露了哪些问题，以及下一步怎么做。"></textarea><p data-hint>直接说你想怎么改，支持整段思路重写。发送后记录你的原话，由 Codex 修改本页讲稿并更新语音。</p><p data-status role="status"></p><footer><button>关闭</button><button type="button" data-save>发送到 Codex</button></footer></form>';document.body.append(dialog);
 const q=s=>dialog.querySelector(s);let page,base,busy=false;const drafts=new Map();
 const providerLabel=document.createElement('label');providerLabel.textContent='整理模型';
 const providerSelect=document.createElement('select');providerSelect.setAttribute('aria-label','整理模型');providerSelect.innerHTML='<option value="qwen">本地千问</option><option value="codex">Codex</option>';providerLabel.append(providerSelect);q('[data-draft]').before(providerLabel);
 let provider='qwen',providersReady=false,providerChoices=[];
 try{const saved=localStorage.getItem('ppt-notes-provider');if(['qwen','codex'].includes(saved))provider=saved;}catch{}
 providerSelect.value=provider;
 function updateProvider(){const label=provider==='qwen'?'本地千问':'Codex';q('[data-save]').textContent='用'+label+'整理';q('[data-hint]').textContent=(mode==='draft'?'保留原意润色':'按修改要求重写')+'，保存后自动更新语音。'+(provider==='qwen'?'讲稿在本机处理。':'使用当前 Codex 登录账号。');const item=providerChoices.find(p=>p.id===provider);q('[data-status]').textContent=item?.message||'';q('[data-save]').disabled=busy||!providersReady||!item?.available;}
 providerSelect.onchange=()=>{provider=providerSelect.value;try{localStorage.setItem('ppt-notes-provider',provider);}catch{}updateProvider();};
 const progress=document.createElement('p');progress.setAttribute('role','status');progress.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10000;background:#22272f;color:#e2e9e4;padding:12px 20px;border:1px solid #496553;border-radius:8px;max-width:80vw';progress.hidden=true;document.body.append(progress);
 const report=message=>{q('[data-status]').textContent=message;progress.textContent=message;progress.hidden=false;};
 let mode='instruction';
 const key=p=>'ppt-notes-'+mode+':'+location.pathname+':'+p;
 function remember(){if(!page)return;drafts.set(key(page.page),q('[data-draft]').value);try{localStorage.setItem(key(page.page),q('[data-draft]').value);}catch{}}
 function restore(){let saved=drafts.get(key(page.page));try{saved??=localStorage.getItem(key(page.page));}catch{}q('[data-draft]').value=saved??(mode==='draft'?page.notes.join('\n\n'):'');q('[data-draft]').setAttribute('aria-label',mode==='draft'?'讲稿内容':'修改需求');q('[data-draft]').placeholder=mode==='draft'?'填写完整讲稿':'例如：整页改为讲遇到的问题，再说明下一步怎么做。';q('[data-hint]').textContent=mode==='draft'?'发送后记录你的原稿，由 Codex 保留原意润色并更新语音。':'直接说你想怎么改，支持整段思路重写。发送后记录你的原话，由 Codex 修改本页讲稿并更新语音。';}
 q('[data-mode]').onchange=()=>{remember();mode=q('[data-mode]').value;restore();updateProvider();};
 q('[data-draft]').addEventListener('input',remember);dialog.addEventListener('keydown',e=>e.stopPropagation());
 button.onclick=()=>{if(busy){dialog.showModal();return;}page=host.getSlides()[host.getIndex()];base=[...page.notes];restore();updateProvider();q('[data-title]').textContent=page.page+' · '+page.title;q('[data-status]').textContent='';dialog.showModal();return loadProviders();};
 new MutationObserver(()=>{const title=document.getElementById('notes-title');if(!title.contains(button))title.append(button);}).observe(document.getElementById('notes-title'),{childList:true});
 const request=async(path,options={})=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetch(config.url+path,{...options,signal:controller.signal,headers:{'Content-Type':'application/json','X-Layout-Token':config.token}});const result=await response.json();if(!response.ok)throw Error(result.message);return result;}catch(error){if(error.name==='TypeError'||error.name==='AbortError')throw Error('未能连接修改服务，请检查服务和浏览器本地网络权限');throw error;}finally{clearTimeout(timer);}};
 async function loadProviders(){
  providersReady=false;q('[data-save]').disabled=true;q('[data-status]').textContent='正在检查整理模型…';
  try{const data=await request('/notes-providers');providerChoices=data.providers;
   for(const item of data.providers){const option=[...providerSelect.options].find(o=>o.value===item.id);if(option){option.textContent=item.label+(item.available?'':'（未安装）');option.disabled=!item.available;}}
   q('[data-status]').textContent=data.providers.find(p=>p.id===provider)?.message||'';providersReady=true;
  }catch(error){q('[data-status]').textContent=error.message;}
  finally{if(providersReady)updateProvider();else q('[data-save]').disabled=true;}
 }
 q('[data-save]').onclick=async()=>{
  if(busy||!providersReady||!providerChoices.find(p=>p.id===provider)?.available)return;
  const draft=q('[data-draft]').value;
  if(!draft.trim()){q('[data-status]').textContent='请先填写修改需求或讲稿内容。';return;}
  remember();busy=true;q('[data-save]').disabled=true;q('[data-draft]').disabled=true;q('[data-mode]').disabled=true;providerSelect.disabled=true;
  const target=page,original=[...base];dialog.close();report('正在提交第 '+target.page+' 页讲稿，请稍候…');
  try{
   let job=await request('/notes',{method:'POST',body:JSON.stringify({page:target.page,baseNotes:original,draft,mode,provider})});
   while(['queued','running'].includes(job.state)){report('第 '+target.page+' 页：'+job.message);await new Promise(r=>setTimeout(r,2000));job=await request('/jobs/'+job.id);}
   if(job.state!=='done')throw Error(job.message);
   target.notes=job.notes;base=[...job.notes];q('[data-draft]').value=mode==='draft'?job.notes.join('\n\n'):'';drafts.delete(key(target.page));
   try{localStorage.removeItem(key(target.page));}catch{}
   if(host.getSlides()[host.getIndex()].page===target.page)host.goTo(host.getIndex());
   if(dialog.open)dialog.close();report(job.message);
  }catch(error){report(error.message+'；草稿已保留，请重新点击编辑讲稿重试。');}
  finally{busy=false;q('[data-save]').disabled=false;q('[data-draft]').disabled=false;q('[data-mode]').disabled=false;providerSelect.disabled=false;}
 };
})();
