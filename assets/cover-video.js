(() => {
  const host=window.PPT_NARRATION_HOST,config=window.PPT_COVER_VIDEOS;
  if(!host||!config||document.getElementById('cover-videos'))return;
  const stage=document.getElementById('stage'),box=document.createElement('div');box.id='cover-videos';
  Object.assign(box.style,{position:'absolute',display:'flex',overflow:'hidden',background:'#060907',gap:'2px'});
  const videos=config.files.map(file=>{const video=document.createElement('video');video.src=file;video.muted=true;video.loop=true;video.playsInline=true;video.preload='metadata';Object.assign(video.style,{width:100/config.files.length+'%',height:'100%',objectFit:'cover',minWidth:'0'});box.append(video);return video;});
  const toggle=document.createElement('button');toggle.textContent='暂停视频';Object.assign(toggle.style,{position:'absolute',right:'10px',bottom:'10px',background:'#060907cc',color:'#fff',fontSize:'12px',padding:'6px 10px'});box.append(toggle);stage.append(box);
  let paused=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const active=()=>host.getSlides()[host.getIndex()].page===1;
  function sync(){const visible=active();box.hidden=!visible;box.style.display=visible?'flex':'none';const narration=document.getElementById('narration-play')?.getAttribute('aria-pressed')==='true';const overview=document.getElementById('overview');const play=visible&&!paused&&!document.hidden&&!narration&&(!overview||overview.hidden);for(const video of videos){if(play)video.play().catch(()=>{toggle.textContent='播放视频';});else video.pause();}toggle.textContent=play?'暂停视频':'播放视频';}
  function position(){const w=stage.clientWidth,h=stage.clientHeight,k=Math.min(w/1920,h/1080);Object.assign(box.style,{left:((w-1920*k)/2+96*k)+'px',top:((h-1080*k)/2+540*k)+'px',width:1728*k+'px',height:454*k+'px'});}
  toggle.onclick=()=>{paused=!paused;sync();};
  new ResizeObserver(position).observe(stage);
  const observer=new MutationObserver(sync);observer.observe(document.getElementById('current-title'),{childList:true,subtree:true});
  const narration=document.getElementById('narration-play');if(narration)observer.observe(narration,{attributes:true,attributeFilter:['aria-pressed']});
  const overview=document.getElementById('overview');if(overview)observer.observe(overview,{attributes:true,attributeFilter:['hidden']});
  document.addEventListener('visibilitychange',sync);window.addEventListener('pagehide',()=>videos.forEach(video=>video.pause()));position();sync();
})();
