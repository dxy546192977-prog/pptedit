import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function scenario(fail=false,mode='instruction',provider='qwen'){
 const elements=new Map();
 const element=()=>({options:[{value:'qwen'},{value:'codex'}],style:{},value:'',textContent:'',disabled:false,hidden:false,open:false,append(){},before(){},setAttribute(){},addEventListener(){},contains(){return true;},showModal(){this.open=true;},close(){this.open=false;},querySelector(s){if(!elements.has(s))elements.set(s,element());return elements.get(s);}});
 const title=element(),created=[],storage=new Map(),slide={page:6,title:'测试',notes:['原稿']};let release,calls=0,rendered=0;
 const context={window:{PPT_NARRATION_HOST:{getSlides:()=>[slide],getIndex:()=>0,goTo:()=>rendered++},PPT_LAYOUT_REFERENCE:{url:'http://127.0.0.1:48765',token:'test'}},document:{getElementById:id=>id==='notes-title'?title:null,createElement:()=>{const e=element();created.push(e);return e;},body:{append(){}}},MutationObserver:class{observe(){}},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},location:{pathname:'/deck'},URLSearchParams,AbortController,setTimeout:()=>0,clearTimeout(){},fetch:async(url,options)=>{if(url.endsWith('/notes-providers'))return {ok:true,json:async()=>({providers:[{id:'qwen',available:true},{id:'codex',available:true}]})};calls++;assert.equal(JSON.parse(options.body).provider,provider);assert.equal(JSON.parse(options.body).draft,'新增讲稿');assert.equal(JSON.parse(options.body).mode,mode);await new Promise(r=>release=r);if(fail)throw new TypeError('Failed to fetch');return {ok:true,json:async()=>({state:'done',notes:['优化讲稿'],message:'已保存'})};}};
 vm.runInNewContext(fs.readFileSync(new URL('../assets/notes-editor.js',import.meta.url),'utf8'),context);
 const [button,dialog,,providerSelect,progress]=created;await button.onclick();providerSelect.value=provider;providerSelect.onchange();
 assert.ok(!dialog.innerHTML.includes('打开本地编辑窗口'));
 if(mode==='draft'){elements.get('[data-mode]').value='draft';elements.get('[data-mode]').onchange();assert.equal(elements.get('[data-draft]').value,'原稿');}
 elements.get('[data-draft]').value='新增讲稿';
 const pending=elements.get('[data-save]').onclick();assert.equal(dialog.open,false);assert.equal(progress.hidden,false);assert.equal(elements.get('[data-save]').disabled,true);
 await elements.get('[data-save]').onclick();assert.equal(calls,1);release();await pending;
 assert.equal(elements.get('[data-save]').disabled,false);
 if(fail){assert.equal(slide.notes[0],'原稿');assert.ok(storage.has('ppt-notes-'+mode+':/deck:6'));assert.match(progress.textContent,/草稿已保留/);await button.onclick();assert.equal(elements.get('[data-draft]').value,'新增讲稿');}
 else{assert.equal(slide.notes[0],'优化讲稿');assert.equal(storage.has('ppt-notes-'+mode+':/deck:6'),false);assert.equal(rendered,1);}
}
await scenario();await scenario(true);await scenario(false,'draft');await scenario(false,'instruction','codex');console.log('Notes editor: both modes, duplicate submission prevention, notes update and failed draft recovery passed.');
