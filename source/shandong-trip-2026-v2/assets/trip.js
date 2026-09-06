(function (root) {
  'use strict';
  const DAY_IDS = ['0908','0909','0910','0911','0912','0913'];
  function chinaClock(date) {
    const shifted = new Date(date.getTime() + 8 * 3600000);
    return { date: shifted.toISOString().slice(0,10), minutes: shifted.getUTCHours()*60 + shifted.getUTCMinutes(), time: shifted.toISOString().slice(11,16) };
  }
  function minute(value) { const parts=value.split(':').map(Number); return parts[0]*60+parts[1]; }
  function scheduleState(day, steps, now) {
    const clock=chinaClock(now);
    if (clock.date < day) return {kind:'before-day',index:0,clock};
    if (clock.date > day) return {kind:'after-day',index:-1,clock};
    const current=steps.findIndex(s=>minute(s.start)<=clock.minutes && clock.minutes<minute(s.end));
    if (current>=0) return {kind:'current',index:current,clock};
    const next=steps.findIndex(s=>minute(s.start)>clock.minutes);
    if (next>=0) return {kind:'next',index:next,clock};
    return {kind:'finished',index:-1,clock};
  }
  const model={chinaClock,minute,scheduleState};
  if (typeof module==='object' && module.exports) module.exports=model;
  if (typeof document==='undefined') return;
  let toastTimer;
  function toast(message) {
    const element=document.getElementById('toast');
    if (!element) return;
    clearTimeout(toastTimer); element.textContent=message; element.classList.add('visible');
    toastTimer=setTimeout(()=>element.classList.remove('visible'),3600);
  }
  function fallbackCopy(text) {
    const field=document.createElement('textarea'); field.value=text;
    field.setAttribute('readonly',''); field.style.position='fixed'; field.style.left='-9999px'; field.style.top='0'; field.style.fontSize='16px';
    document.body.appendChild(field); field.focus(); field.select(); field.setSelectionRange(0,text.length);
    let ok=false; try { ok=document.execCommand('copy'); } catch (_) {} field.remove(); return ok;
  }
  const fallback=document.getElementById('copy-fallback');
  let previousFocus=null;
  function showCopyFallback(text) {
    previousFocus=document.activeElement; fallback.hidden=false;
    document.getElementById('copy-text').value=text;
    document.body.style.overflow='hidden';
    const field=document.getElementById('copy-text'); field.focus(); field.select();
  }
  function closeCopyFallback() {
    fallback.hidden=true; document.body.style.overflow='';
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  }
  if(fallback) {
    fallback.querySelectorAll('.close-copy').forEach(b=>b.addEventListener('click',closeCopyFallback));
    fallback.addEventListener('click',e=>{if(e.target===fallback)closeCopyFallback();});
    fallback.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();closeCopyFallback();}
      if(e.key==='Tab') {
        const focusables=Array.from(fallback.querySelectorAll('button,textarea'));
        const first=focusables[0],last=focusables[focusables.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    });
  }
  document.querySelectorAll('[data-copy]').forEach(button=>{
    button.addEventListener('click',async()=>{
      const text=button.dataset.copy;let ok=false;
      // Preserve a manual selection fallback when clipboard APIs are unavailable.
      if(navigator.clipboard && root.isSecureContext) {
        try {await navigator.clipboard.writeText(text);ok=true;} catch (_) {}
      }
      if(!ok)ok=fallbackCopy(text);
      if(ok){button.classList.add('copied');button.focus({preventScroll:true});toast('已复制：'+text+'。可在地图 App 粘贴搜索。');setTimeout(()=>button.classList.remove('copied'),2400);}
      else showCopyFallback(text);
    });
  });
  const timeline=Array.from(document.querySelectorAll('.timeline-item'));
  const toggleAll=document.getElementById('toggle-all');
  function syncToggle(){if(toggleAll)toggleAll.textContent=timeline.length&&timeline.every(x=>x.open)?'全部收起':'展开全部';}
  if(toggleAll)toggleAll.addEventListener('click',()=>{const open=timeline.some(x=>!x.open);timeline.forEach(x=>{x.open=open;});syncToggle();});
  timeline.forEach(x=>x.addEventListener('toggle',syncToggle));
  const reduceMotion=root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('.map-node').forEach(button=>{
    button.addEventListener('click',()=>{
      document.querySelectorAll('.map-node.selected,.place-card.selected').forEach(x=>x.classList.remove('selected'));
      const place=document.getElementById('point-'+button.dataset.point);
      if(!place)return;
      button.classList.add('selected');place.classList.add('selected');
      place.focus({preventScroll:true});place.scrollIntoView({behavior:reduceMotion?'auto':'smooth',block:'center'});
    });
  });
  // Keep the selected date visible without moving the page vertically.
  const activeNav=document.querySelector('.date-nav .active');
  if(activeNav){const bar=activeNav.parentElement;bar.scrollLeft=Math.max(0,activeNav.offsetLeft-(bar.clientWidth-activeNav.offsetWidth)/2);}
  const dayMain=document.querySelector('[data-trip-date]');
  function updateClock(){
    const now=new Date(),clock=chinaClock(now);
    const todayId=clock.date.slice(5).replace('-','');
    document.querySelectorAll('.day-card[data-date]').forEach(el=>el.classList.toggle('is-today',el.dataset.date===clock.date));
    const homeLink=document.getElementById('today-link'),homeStatus=document.getElementById('trip-status');
    if(homeLink){
      if(clock.date>='2026-09-08'&&clock.date<='2026-09-13'&&DAY_IDS.includes(todayId)){
        homeLink.href=todayId+'.html';homeLink.childNodes[0].nodeValue='打开今天的行程 ';homeStatus.textContent='北京时间 '+clock.time+' · 09.'+todayId.slice(2);
      }else if(clock.date<'2026-09-08'){
        const daysLeft=Math.ceil((Date.parse('2026-09-08T00:00:00+08:00')-Date.parse(clock.date+'T00:00:00+08:00'))/86400000);
        homeLink.href='0908.html';homeLink.childNodes[0].nodeValue='从第一天开始 ';homeStatus.textContent='距离出发还有 '+daysLeft+' 天';
      }else{homeLink.href='0908.html';homeLink.childNodes[0].nodeValue='回看六日行程 ';homeStatus.textContent='2026.09.08—09.13 · 山东家庭游';}
    }
    if(!dayMain)return;
    const steps=timeline.map(x=>({start:x.dataset.start,end:x.dataset.end}));
    const state=scheduleState(dayMain.dataset.tripDate,steps,now);
    const title=document.getElementById('now-title'),label=document.getElementById('now-label'),next=document.getElementById('now-next'),link=document.getElementById('now-link'),card=document.getElementById('now-card');
    timeline.forEach((el,index)=>{el.classList.toggle('current-step',state.kind==='current'&&index===state.index);el.classList.toggle('past-step',clock.date===dayMain.dataset.tripDate&&minute(el.dataset.end)<=clock.minutes);});
    card.classList.toggle('is-current',state.kind==='current');
    const titleOf=el=>el.querySelector('.step-title').childNodes[0].textContent.trim();
    if(state.kind==='current'){
      const item=timeline[state.index];label.textContent='此刻 · 按计划 / 北京时间 '+clock.time;
      title.textContent=item.dataset.start+'–'+item.dataset.end+' · '+titleOf(item);
      const following=timeline[state.index+1];next.textContent=following?'下一项 '+following.dataset.start+' · '+titleOf(following):'这是今天最后一项安排，按实际进度从容结束。';link.href='#'+item.id;
    }else if(state.kind==='next'){
      const item=timeline[state.index],remaining=minute(item.dataset.start)-clock.minutes;
      label.textContent='接下来 · 按计划 / 北京时间 '+clock.time;
      title.textContent=item.dataset.start+' · '+titleOf(item);
      next.textContent='距计划开始还有 '+(remaining>=60?Math.floor(remaining/60)+'小时'+(remaining%60?remaining%60+'分钟':''):remaining+'分钟')+'，按现场进度安排。';link.href='#'+item.id;
    }else if(state.kind==='before-day'){
      label.textContent=dayMain.dataset.tripDate.slice(5).replace('-','.')+' · 提前看看';
      const item=timeline[0];title.textContent=item.dataset.start+' · '+titleOf(item);
      const following=timeline[1];next.textContent=following?'接下来 '+following.dataset.start+' · '+titleOf(following):'按当天实际进度安排。';link.href='#timeline';
    }else{
      label.textContent=state.kind==='finished'?'今日计划时段已结束':'行程回看';
      title.textContent=state.kind==='finished'?'今天辛苦了，好好休息。':'09.'+dayMain.dataset.tripDate.slice(8)+' 的安排，都在这里。';
      next.textContent='时间提示仅对应计划，实际进度以你们为准。';link.href='#timeline';
    }
  }
  updateClock();setInterval(updateClock,30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateClock();});
  document.querySelectorAll('a[href^="#step-"]').forEach(link=>link.addEventListener('click',()=>{const item=document.querySelector(link.getAttribute('href'));if(item)item.open=true;}));
  const currentLink=document.getElementById('now-link');
  if(currentLink)currentLink.addEventListener('click',()=>{const target=document.querySelector(currentLink.getAttribute('href'));if(target&&target.matches('details'))target.open=true;});
  const offlineStatus=document.getElementById('offline-status');
  let offlineReady=false;
  function updateNetwork(){
    if(!offlineStatus)return;
    offlineStatus.textContent=!navigator.onLine?'离线阅读 · 点评与电话等外部服务需网络或通话支持':(offlineReady?'六日日程已备好，可离线查看':'');
  }
  root.addEventListener('online',updateNetwork);root.addEventListener('offline',updateNetwork);updateNetwork();
  if('serviceWorker' in navigator && root.isSecureContext){
    navigator.serviceWorker.addEventListener('message',event=>{
      if(event.data && event.data.type==='TRIP_OFFLINE_READY'){offlineReady=true;updateNetwork();}
    });
    root.addEventListener('load',()=>{
      navigator.serviceWorker.register('sw.js',{scope:'./'}).then(reg=>{
        if(reg.active)reg.active.postMessage({type:'TRIP_CACHE_STATUS'});
        if(reg.waiting)reg.waiting.postMessage({type:'TRIP_CACHE_STATUS'});
      }).catch(()=>{ /* All itinerary content remains available without offline support. */ });
    });
  }
})(typeof window==='undefined'?globalThis:window);

/* V2.1 MODULE TABS START */
(function(){
  'use strict';
  const body=document.body,switcher=document.querySelector('.module-switcher');
  if(!switcher)return;
  const names=['timeline','route','food','reminders'];
  const buttons=Array.from(switcher.querySelectorAll('[data-module]'));
  const panels=Object.fromEntries(names.map(name=>[name,document.getElementById(name)]));
  const timeline=panels.timeline,nowCard=document.getElementById('now-card');

  if(timeline&&nowCard){
    const heading=timeline.querySelector('.section-heading');
    if(heading)heading.insertAdjacentElement('afterend',nowCard);
  }
  const ticket=document.querySelector('.day-aside > .ticket');
  if(timeline&&ticket){
    ticket.classList.add('module-ticket');
    const now=document.getElementById('now-card');
    if(now)now.insertAdjacentElement('afterend',ticket);
    else{
      const heading=timeline.querySelector('.section-heading');
      if(heading)heading.insertAdjacentElement('afterend',ticket);
    }
  }

  function moduleFromHash(){
    const hash=location.hash.replace('#','');
    if(names.includes(hash))return hash;
    if(hash.startsWith('step-'))return'timeline';
    if(hash.startsWith('point-'))return'route';
    return null;
  }
  function activate(name,options={}){
    if(!names.includes(name))name='timeline';
    body.dataset.activeModule=name;
    buttons.forEach(btn=>{
      const active=btn.dataset.module===name;
      btn.classList.toggle('active',active);
      btn.setAttribute('aria-selected',active?'true':'false');
      btn.tabIndex=active?0:-1;
    });
    names.forEach(key=>{
      const panel=panels[key];
      if(!panel)return;
      const active=key===name;
      panel.hidden=!active;
      panel.setAttribute('aria-hidden',active?'false':'true');
      if('inert' in panel)panel.inert=!active;
    });
    if(options.updateHash)history.replaceState(null,'','#'+name);
    if(options.scroll){
      const reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      switcher.scrollIntoView({behavior:reduce?'auto':'smooth',block:'start'});
    }
  }

  buttons.forEach((btn,index)=>{
    btn.addEventListener('click',()=>activate(btn.dataset.module,{scroll:true,updateHash:true}));
    btn.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();
      let next=index;
      if(event.key==='ArrowLeft')next=(index-1+buttons.length)%buttons.length;
      if(event.key==='ArrowRight')next=(index+1)%buttons.length;
      if(event.key==='Home')next=0;
      if(event.key==='End')next=buttons.length-1;
      buttons[next].focus();
      activate(buttons[next].dataset.module,{updateHash:true});
    });
  });

  document.addEventListener('click',event=>{
    const link=event.target.closest('a[href^="#"]');
    if(!link)return;
    const target=link.getAttribute('href').slice(1);
    let module=names.includes(target)?target:null;
    if(target.startsWith('step-'))module='timeline';
    if(target.startsWith('point-'))module='route';
    if(module)activate(module);
  });
  window.addEventListener('hashchange',()=>{
    const name=moduleFromHash();
    if(name)activate(name);
  });

  activate(moduleFromHash()||'timeline');
})();
/* V2.1 MODULE TABS END */
