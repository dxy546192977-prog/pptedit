(() => {
  const config=window.PPT_LAYOUT_REFERENCE, host=window.PPT_NARRATION_HOST;
  if(!config||!host||document.getElementById('layout-reference-open'))return;
  const open=document.createElement('button');open.id='layout-reference-open';open.textContent='参考版式';
  document.getElementById('show-notes').before(open);
  const dialog=document.createElement('dialog');dialog.className='layout-reference-dialog layout-reference-fixed';
  dialog.innerHTML='<form method="dialog"><header><strong>参考版式 · 当前页</strong><button value="cancel" aria-label="关闭">×</button></header><p data-page></p><label>上传参考图<input type="file" accept="image/png,image/jpeg,image/webp" data-file></label><img data-preview hidden alt="参考版式预览"><label>修改说明<textarea data-instruction rows="3" placeholder="例如：白底黑字，标题左对齐，大面积留白；保留当前文案。"></textarea></label><p class="layout-reference-hint">提交成功后窗口自动关闭，后台继续修改，您可以继续编辑。完成后刷新页面查看，原版自动备份。</p><p data-status role="status"></p><footer><button value="cancel">取消</button><button type="button" data-confirm disabled>确认修改当前页</button></footer></form>';
  document.body.append(dialog);
  const designLabel=document.createElement('label');designLabel.className='layout-design-switch';
  designLabel.innerHTML='<input type="checkbox" role="switch" data-design checked><span>遵循 design.md 设计规范</span>';
  const designHint=document.createElement('p');designHint.className='layout-reference-hint';designHint.id='layout-design-hint';
  dialog.querySelector('[data-instruction]').placeholder='例如：标题左对齐、分行排版、大面积留白；保留当前文案。';
  dialog.querySelector('[data-instruction]').parentElement.before(designLabel,designHint);
  const designSwitch=designLabel.querySelector('input');designSwitch.setAttribute('aria-describedby',designHint.id);
  const updateDesignHint=()=>{designHint.textContent=designSwitch.checked?'已开启：参考图只影响版式，配色与字体遵循 design.md。':'已关闭：仅本次修改可参考图片配色；下次打开默认恢复规范。';};
  designSwitch.onchange=updateDesignHint;updateDesignHint();
  const q=s=>dialog.querySelector(s);let data='',page=null,url=null,busy=false;
  let importing=false, importVersion=0, activeImport=null, loadedUrl='';
  let figmaSource=null;
  const modeLabel=document.createElement('label');
  modeLabel.innerHTML='处理方式<select data-mode><option value="exact">Figma 原稿还原</option><option value="style">参考风格改版</option></select>';
  q('[data-instruction]').parentElement.before(modeLabel);modeLabel.hidden=true;
  const modeSelect=modeLabel.querySelector('select');
  const updateMode=()=>{const exact=!!figmaSource&&modeSelect.value==='exact';modeLabel.hidden=!figmaSource;designLabel.hidden=exact;designHint.hidden=exact;q('[data-instruction]').disabled=exact;q('[data-instruction]').parentElement.hidden=exact;q('[data-confirm]').textContent=exact?'读取节点并还原当前页':'确认修改当前页';};
  modeSelect.onchange=()=>{updateMode();q('[data-status]').textContent=modeSelect.value==='exact'?'原稿还原：读取指定节点，同尺寸导入原生 SVG，文字转轮廓保留外观。':'参考风格改版：读取指定节点截图，按修改说明和设计规范重新排版，不保证与原稿一致。';};
  let activeJob=null;
  const jobKey='ppt-layout-job:'+location.pathname+':'+config.url;
  const notice=document.createElement('aside');notice.className='layout-job-notice';notice.hidden=true;
  notice.setAttribute('aria-label','版式修改进度');
  notice.innerHTML='<p role="status" aria-live="polite" aria-atomic="true"></p><a data-usage hidden href="https://chatgpt.com/codex/settings/usage" target="_blank" rel="noopener noreferrer">查看额度</a><button type="button" data-handoff hidden>复制任务到 Codex</button><button type="button" data-refresh hidden>刷新页面</button><button type="button" data-dismiss hidden aria-label="关闭进度提示">×</button>';
  document.body.append(notice);
  const noticeText=notice.querySelector('p'),refreshPage=notice.querySelector('[data-refresh]'),dismissNotice=notice.querySelector('[data-dismiss]');
  refreshPage.onclick=()=>location.reload();dismissNotice.onclick=()=>{notice.hidden=true;rememberJob(null);};
  let failedJob=null;
  const handoff=notice.querySelector('[data-handoff]'),usage=notice.querySelector('[data-usage]');
  handoff.onclick=async()=>{if(!failedJob)return;try{const detail=await request('/history/'+encodeURIComponent(failedJob.id));const text=detail.texts?.['handoff.md'];if(!text)throw Error('该历史任务尚未生成交接文本');await navigator.clipboard.writeText(text);noticeText.textContent='任务已复制，请粘贴到本机 Codex 对话中继续。原图和修改要求都已保留。';}catch(error){noticeText.textContent='复制未完成：'+error.message;}};
  const syncConfirm=()=>{q('[data-confirm]').disabled=busy||importing||(!data&&!figmaSource)||!!activeJob;};
  function rememberJob(job){try{if(job)sessionStorage.setItem(jobKey,JSON.stringify({id:job.id,page:job.page}));else sessionStorage.removeItem(jobKey);}catch{}}
  function showJob(job){
    const pending=['queued','running'].includes(job.state);
    notice.hidden=false;notice.dataset.state=job.state;
    noticeText.textContent='第 '+job.page+' 页 · '+(pending?'后台修改中，您可以继续编辑。':job.state==='done'?'修改完成，可在编辑告一段落后刷新页面查看。':'修改未完成：'+job.message);
    refreshPage.hidden=job.state!=='done';dismissNotice.hidden=pending;
    failedJob=job.state==='error'?job:null;handoff.hidden=!failedJob;usage.hidden=!failedJob||!/额度|usage limit|quota/i.test(job.message||'');
  }
  async function trackJob(initial){
    activeJob=initial;rememberJob(initial);syncConfirm();
    let job=initial,failures=0;
    showJob(job);
    while(['queued','running'].includes(job.state)){
      await new Promise(resolve=>setTimeout(resolve,failures?Math.min(15000,2000*2**failures):2000));
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
      try{
        job={...job,...await request('/jobs/'+encodeURIComponent(job.id),{signal:controller.signal})};
        failures=0;showJob(job);
      }catch(error){
        if(error.status===404){job={...job,state:'error',message:'无法找到任务，请在历史参考与修改记录中核对结果。'};showJob(job);break;}
        failures=Math.min(failures+1,4);
        noticeText.textContent='第 '+job.page+' 页 · 暂时无法获取进度，正在重连。后台任务可能仍在继续，您可以继续编辑。';
      }finally{clearTimeout(timeout);}
    }
    activeJob=null;rememberJob(job.state==='error'?job:null);syncConfirm();
  }
  const source=document.createElement('div');source.className='layout-reference-source';
  source.innerHTML='<div data-paste tabindex="0">在这里直接粘贴截图 · Ctrl+V<br><small>也可拖入图片</small></div><label>图片或网页链接<input data-url type="url" placeholder="粘贴 https://…"></label><button type="button" data-import>读取链接</button>';
  q('[data-file]').parentElement.before(source);
  const fileLabel=q('[data-file]').parentElement;const alternative=document.createElement('details');alternative.innerHTML='<summary>或选择本地图片</summary>';fileLabel.before(alternative);alternative.append(fileLabel);
  const request=async(path,options={})=>{const response=await fetch(config.url+path,{...options,headers:{'Content-Type':'application/json','X-Layout-Token':config.token}});const json=await response.json();if(!response.ok)throw Object.assign(Error(json.message),{status:response.status});return json;};
  open.onclick=()=>{page=host.getSlides()[host.getIndex()];designSwitch.checked=true;updateDesignHint();q('[data-page]').textContent=String(page.page).padStart(2,'0')+' · '+page.title;historyVersion++;historyList.replaceChildren();historySummary.textContent='当前页历史参考与修改记录 · 第 '+page.page+' 页';if(history.open)void loadHistory();dialog.showModal();};
  dialog.addEventListener('keydown',event=>event.stopPropagation());
  function acceptFile(file){if(busy||!file)return;figmaSource=null;updateMode();const version=++importVersion;if(activeImport){activeImport.abort();activeImport=null;}loadedUrl='';q('[data-import]').textContent='读取链接';data='';importing=true;syncConfirm();if(file.size>8*1024*1024){importing=false;q('[data-status]').textContent='图片不能超过 8 MB';return;}if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(file);q('[data-preview]').src=url;q('[data-preview]').hidden=false;const reader=new FileReader();reader.onload=()=>{if(version!==importVersion)return;data=reader.result.split(',')[1];importing=false;syncConfirm();q('[data-status]').textContent='参考图已就绪，确认后修改当前页';};reader.onerror=()=>{if(version===importVersion){importing=false;q('[data-status]').textContent='图片读取失败，请重新粘贴';}};reader.readAsDataURL(file);}
  q('[data-file]').onchange=()=>acceptFile(q('[data-file]').files[0]);
  async function importUrl(){
    if(busy)return;
    if(importing&&activeImport){activeImport.abort();return;}
    const value=q('[data-url]').value.trim();
    if(!/^https?:\/\//i.test(value)){q('[data-status]').textContent='请输入 HTTP/HTTPS 链接';return;}
    if(data&&loadedUrl===value){q('[data-status]').textContent='该链接的参考图已就绪';syncConfirm();return;}
    const version=++importVersion, previous=data;
    let isFigma=false;try{isFigma=['figma.com','www.figma.com'].includes(new URL(value).hostname);}catch{}
    if(isFigma){data='';figmaSource=null;loadedUrl='';q('[data-preview]').hidden=true;updateMode();}
    const controller=new AbortController();activeImport=controller;importing=true;
    q('[data-confirm]').disabled=true;q('[data-import]').textContent='取消读取';
    q('[data-status]').textContent=previous?'正在读取新链接；下方保留的是上一张参考图…':'正在读取链接中的参考图…';
    let timer,timedOut=false;
    const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error(timedOut?'读取超时，请重试或直接粘贴截图':'已取消读取')),{once:true}));
    timer=setTimeout(()=>{timedOut=true;controller.abort();},30000);
    try{
      const result=await Promise.race([request('/reference',{method:'POST',body:JSON.stringify({url:value}),signal:controller.signal}),cancelled]);
      if(version!==importVersion)return;
      if(result.kind==='figma'){figmaSource=result;data='';loadedUrl=result.sourceUrl;modeSelect.value='exact';q('[data-preview]').hidden=true;updateMode();q('[data-status]').textContent='已识别 Figma 节点 '+result.nodeId+'；尚未读取设计。确认后读取原始节点，同尺寸导入，文字转轮廓保留外观。读取失败不会改用网页封面。';return;}
      if(!result.image||!result.mime)throw Error('链接未返回有效参考图');
      figmaSource=null;updateMode();
      data=result.image;loadedUrl=value;q('[data-preview]').src='data:'+result.mime+';base64,'+data;q('[data-preview]').hidden=false;q('[data-status]').textContent='参考图已就绪，可以确认修改';
    }catch(error){if(version===importVersion)q('[data-status]').textContent=(timedOut?'读取超时，请重试或直接粘贴截图':controller.signal.aborted?'已取消读取':error.message)+(previous&&!isFigma?'。仍保留上一张参考图，可确认使用或粘贴替换。':'');}
    finally{clearTimeout(timer);if(version===importVersion){importing=false;activeImport=null;q('[data-import]').textContent='读取链接';syncConfirm();}}
  }
  q('[data-import]').onclick=importUrl;
  const history=document.createElement('details');history.className='layout-history';
  const historySummary=document.createElement('summary');historySummary.textContent='历史参考与修改记录';history.append(historySummary);
  const historyList=document.createElement('div');history.append(historyList);q('form').append(history);
  const refreshHistory=document.createElement('button');refreshHistory.type='button';refreshHistory.textContent='刷新记录';history.insertBefore(refreshHistory,historyList);
  let historyVersion=0;
  async function loadHistory(){const targetPage=Number(page?.page),version=++historyVersion;historyList.textContent='正在读取当前页记录…';try{const result=await request('/history');if(version!==historyVersion)return;const records=result.records.filter(record=>Number(record.page)===targetPage);historyList.replaceChildren();for(const record of records){const entry=document.createElement('details'),summary=document.createElement('summary');summary.textContent=new Date(record.createdAt*1000).toLocaleString()+' · '+(record.page?'第 '+record.page+' 页':'历史版本')+' · '+(record.source||'SVG 浏览器')+' · '+record.message;entry.append(summary);if(record.state==='error'){const recovery=document.createElement('button');recovery.type='button';recovery.textContent='处理失败任务';recovery.onclick=()=>{dialog.close();showJob(record);};entry.append(recovery);}if(record.timeLabel){const stamp=document.createElement('p');stamp.textContent=record.timeLabel;entry.append(stamp);}for(const turn of record.dialogue||[]){const text=document.createElement('p');text.textContent=(turn.role==='user'?'你：':'Codex：')+turn.text;entry.append(text);}const instruction=document.createElement('p');instruction.textContent=record.instruction;entry.append(instruction);const settings=document.createElement('p');settings.textContent='design.md：'+(record.respectDesign===true?'开启':record.respectDesign===false?'关闭':'未记录')+(record.sourceUrl?'\n参考链接：'+record.sourceUrl:'');entry.append(settings);if(/^https?:\/\//i.test(record.sourceUrl||'')){const link=document.createElement('a');link.href=record.sourceUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent='打开参考来源';link.style.color='#a9dfbb';entry.append(link);}let loaded=false;entry.addEventListener('toggle',async()=>{if(!entry.open||loaded)return;loaded=true;const comparison=document.createElement('div');comparison.className='layout-history-images';entry.append(comparison);try{const detail=await request('/history/'+encodeURIComponent(record.id));if(detail.texts?.['optimized.json']){const text=document.createElement('p');text.textContent='优化前：\\n'+(detail.texts['request.json']?.before||[]).join('\\n\\n')+'\\n\\n优化后：\\n'+detail.texts['optimized.json'].notes.join('\\n\\n');comparison.append(text);}for(const [name,label] of [['reference.png',record.attachmentLabel||'参考图'],['before.svg','修改前'],['after.svg','修改后']]){const figure=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=label;figure.append(caption);if(detail.images[name]){const img=document.createElement('img');img.src=detail.images[name];img.alt=label;figure.append(img);}else{const missing=document.createElement('p');missing.textContent='该历史版本未保存';figure.append(missing);}comparison.append(figure);}}catch(error){comparison.textContent=error.message;loaded=false;}});historyList.append(entry);}if(!records.length)historyList.textContent='当前页暂无修改记录。';}catch(error){if(version!==historyVersion)return;historyList.textContent='无法读取记录：'+error.message;}}
  history.addEventListener('toggle',()=>{if(history.open)loadHistory();});refreshHistory.onclick=loadHistory;
  q('[data-url]').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();importUrl();}});
  dialog.addEventListener('paste',event=>{if(busy)return;const image=Array.from(event.clipboardData?.items||[]).find(item=>item.type.startsWith('image/'));if(image){event.preventDefault();acceptFile(image.getAsFile());return;}const text=event.clipboardData?.getData('text/plain').trim();if(/^https?:\/\/\S+$/i.test(text)&&event.target!==q('[data-instruction]')){event.preventDefault();q('[data-url]').value=text;importUrl();}});
  q('[data-paste]').addEventListener('dragover',event=>event.preventDefault());
  q('[data-paste]').addEventListener('drop',event=>{event.preventDefault();const file=Array.from(event.dataTransfer.files).find(file=>file.type.startsWith('image/'));if(file)acceptFile(file);});
  q('[data-confirm]').onclick=async()=>{if(busy||importing||(!data&&!figmaSource)||activeJob)return;busy=true;open.disabled=true;syncConfirm();q('[data-file]').disabled=true;modeSelect.disabled=true;const target=page;
    designSwitch.disabled=true;
    q('[data-status]').textContent='正在提交修改…';
    try{const exact=!!figmaSource&&modeSelect.value==='exact';const job=await request('/jobs',{method:'POST',body:JSON.stringify({page:target.page,image:data,sourceUrl:loadedUrl,mode:figmaSource?modeSelect.value:'style',instruction:exact?'按指定 Figma 节点原稿还原':q('[data-instruction]').value,respectDesign:exact?false:designSwitch.checked})});
      if(!job.id||!['queued','running','done','error'].includes(job.state))throw Error('服务未返回有效任务，请在历史记录中核对是否提交成功');
      dialog.close();
      q('[data-status]').textContent='任务已提交，进度会在页面上提示。';
      void trackJob({...job,page:target.page});
    }catch(error){q('[data-status]').textContent='提交未成功：'+error.message+'。参考图与修改说明已保留。';}
    finally{busy=false;open.disabled=false;designSwitch.disabled=false;modeSelect.disabled=false;syncConfirm();q('[data-file]').disabled=false;}
  };
  // A reload only reconnects to the existing task; it never submits another one.
  const form=q('form'),header=q('header'),actions=q('footer');
  const scrollBody=document.createElement('div');scrollBody.className='layout-reference-scroll';
  for(const child of Array.from(form.children)){if(child!==header&&child!==actions)scrollBody.append(child);}
  form.replaceChildren(header,actions,scrollBody);
  try{const saved=JSON.parse(sessionStorage.getItem(jobKey)||'null');if(saved&&typeof saved.id==='string'&&Number.isInteger(saved.page))void trackJob({...saved,state:'running'});}catch{}
})();
