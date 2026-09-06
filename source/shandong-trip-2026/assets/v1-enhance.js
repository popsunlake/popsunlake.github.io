(function(){
'use strict';
const DAYS={
 '0908':{date:'2026-09-08',focus:'到青岛 · 海边夜景',sub:'抵达后先入住，晚饭后只走奥帆中心与五四广场。',keys:[['17:52','到青岛北'],['19:20','青未了晚餐'],['21:45','回到酒店']],stay:['桔子酒店（青岛五四广场万象城店）','江西路11号附近 · 连住两晚'],hard:['青岛北 → 桔子酒店']},
 '0909':{date:'2026-09-09',focus:'崂山一日 · 四人同行',sub:'仰口索道、青山渔村、太清，全家走同一条轻量路线。',keys:[['07:25','酒店出发'],['09:30','仰口索道'],['15:55','结束太清']],stay:['桔子酒店（青岛五四广场万象城店）','崂山返回后继续住同一酒店'],hard:['仰口 → 垭口','太清 → 大河东']},
 '0910':{date:'2026-09-10',focus:'青岛市区半日 · 下午去泰安',sub:'上午老城与八大关，下午严格围绕16:22高铁收口。',keys:[['11:00','春和楼午餐'],['14:20','取好行李'],['16:22','青岛站高铁']],stay:['丁格曼酒店（泰山天外村店）','泰安站到店入住 · 次日走天外村'],hard:['取行李','青岛站 → 泰安站','酒店 → 青岛站']},
 '0911':{date:'2026-09-11',focus:'泰山轻量登顶 · 当晚到济南',sub:'天外村景交 + 中天门索道，山顶只走南天门与天街核心段。',keys:[['07:45','景交上山'],['11:15','开始返程'],['17:29','泰安站高铁']],stay:['汉庭酒店（济南黄河大道店）','济南东到店 · 次日去英才北校区'],hard:['11:15','酒店 → 泰安站','泰安站 → 济南东']},
 '0912':{date:'2026-09-12',focus:'新生报到优先 · 下午泉城',sub:'上午只围绕报到，结束后再按时间决定趵突泉与大明湖。',keys:[['08:00','新生报到'],['14:00','趵突泉'],['17:10','大明湖']],stay:['柏曼酒店（济南大明湖趵突泉店）','泉城核心区 · 最后一晚'],hard:['新生报到','汉庭 → 柏曼酒店']},
 '0913':{date:'2026-09-13',focus:'从容返程 · 不再加景点',sub:'早餐、退房、济南西候车，最后一天只保留返程。',keys:[['09:20','离开酒店'],['10:10','到济南西'],['11:42','返杭州']],stay:['柏曼酒店（济南大明湖趵突泉店）','早餐后09:20离店'],hard:['柏曼酒店 → 济南西站','济南西 → 杭州']}
};
const HOME_FOCUS={'0908':'到青岛 · 海边夜景','0909':'崂山一日 · 四人同行','0910':'青岛市区半日 · 去泰安','0911':'泰山轻量登顶 · 去济南','0912':'新生报到 · 泉城下午','0913':'从容返程'};
function slug(){const m=location.pathname.match(/(0908|0909|0910|0911|0912|0913)\.html$/);return m?m[1]:'index';}
function cnClock(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const o={};parts.forEach(p=>o[p.type]=p.value);return{date:o.year+'-'+o.month+'-'+o.day,min:+o.hour*60 + +o.minute};}
function minutes(s){const m=s.match(/(\d{1,2}):(\d{2})/);return m?(+m[1]*60 + +m[2]):null}
function copyFallback(text){
 let modal=document.getElementById('v15-copy-fallback');
 if(!modal){modal=document.createElement('div');modal.id='v15-copy-fallback';modal.className='v15-copy-fallback';modal.hidden=true;modal.innerHTML='<div class="v15-copy-sheet" role="dialog" aria-modal="true"><h3>复制地点</h3><p>长按下方文字复制，再到地图 App 粘贴搜索。</p><textarea readonly></textarea><button type="button">完成</button></div>';document.body.appendChild(modal);modal.querySelector('button').onclick=()=>{modal.hidden=true;document.body.style.overflow=''};modal.addEventListener('click',e=>{if(e.target===modal){modal.hidden=true;document.body.style.overflow=''}})}
 modal.hidden=false;document.body.style.overflow='hidden';const ta=modal.querySelector('textarea');ta.value=text;ta.focus();ta.select();
}
async function robustCopy(text){
 let ok=false;try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);ok=true}}catch(e){}
 if(!ok){const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{ok=document.execCommand('copy')}catch(e){}ta.remove()}
 if(!ok)copyFallback(text);
 else{const toast=document.getElementById('copyToast');if(toast){toast.textContent='已复制：'+text;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1700)}}
}
function focusCard(day,id){
 const el=document.createElement('section');el.className='v15-focus';el.innerHTML='<div class="v15-focus-top"><span class="v15-focus-label">KEY MOMENTS · 关键时间</span><span class="v15-focus-day">'+id.slice(0,2)+'-'+id.slice(2)+'</span></div><div class="v15-keyrow">'+day.keys.map(k=>'<div class="v15-key"><b>'+k[0]+'</b><small>'+k[1]+'</small></div>').join('')+'</div>';return el;
}
function panelHead(k){
 const map={timeline:['ITINERARY','行程','按时间执行'],route:['ROUTE','路线','距离与交通'],food:['FOOD & STAY','吃住','餐厅与住宿'],reminders:['NOTES','提醒','现场预案']},v=map[k];
 const h=document.createElement('div');h.className='v15-panel-head';h.innerHTML='<div><span class="v15-panel-kicker">'+v[0]+'</span><h3>'+v[1]+'</h3></div><span>'+v[2]+'</span>';return h;
}
function enhanceDay(id){
 const d=DAYS[id],root=document.querySelector('.full-day');if(!d||!root)return;
 const title=root.querySelector('.day-title');
 const focus=focusCard(d,id);title.insertAdjacentElement('afterend',focus);
 const now=document.createElement('div');now.className='v15-now';now.innerHTML='<div class="copy"><small>当天安排</small><b>'+d.focus+'</b></div><span>按计划执行</span>';focus.insertAdjacentElement('afterend',now);
 const tabs=document.createElement('nav');tabs.className='v15-tabs';tabs.setAttribute('aria-label','当天内容');
 const names=[['timeline','行程','按时间'],['route','路线','距离交通'],['food','吃住','餐厅酒店'],['reminders','提醒','现场预案']];
 tabs.innerHTML=names.map((x,i)=>'<button type="button" class="v15-tab '+(i===0?'active':'')+'" data-tab="'+x[0]+'" aria-selected="'+(i===0)+'"><b>'+x[1]+'</b><small>'+x[2]+'</small></button>').join('');
 now.insertAdjacentElement('afterend',tabs);
 const host=document.createElement('div');host.className='v15-modules';tabs.insertAdjacentElement('afterend',host);
 const panels={};names.forEach((x,i)=>{const p=document.createElement('section');p.className='v15-panel '+(i===0?'active':'');p.dataset.panel=x[0];p.appendChild(panelHead(x[0]));host.appendChild(p);panels[x[0]]=p});
 const children=Array.from(root.children).filter(el=>![title,focus,now,tabs,host].includes(el));
 children.forEach(el=>{
   if(el.classList.contains('timeline-card'))panels.timeline.appendChild(el);
   else if(el.classList.contains('route-map-card'))panels.route.appendChild(el);
   else if(el.classList.contains('food'))panels.food.appendChild(el);
   else panels.reminders.appendChild(el);
 });
 const stay=document.createElement('article');stay.className='v15-stay';stay.innerHTML='<small>STAY · 住宿</small><h4>'+d.stay[0]+'</h4><p>'+d.stay[1]+'</p>';panels.food.insertBefore(stay,panels.food.children[1]||null);
 tabs.addEventListener('click',e=>{const b=e.target.closest('.v15-tab');if(!b)return;tabs.querySelectorAll('.v15-tab').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-selected',x===b?'true':'false')});Object.values(panels).forEach(p=>p.classList.toggle('active',p.dataset.panel===b.dataset.tab));history.replaceState(null,'','#'+b.dataset.tab);});
 const hash=location.hash.slice(1);if(panels[hash])tabs.querySelector('[data-tab="'+hash+'"]').click();
 const active=document.querySelector('.multi-nav a.active');if(active)setTimeout(()=>active.scrollIntoView({inline:'center',block:'nearest'}),60);
 const items=Array.from(panels.timeline.querySelectorAll('.tl-item'));items.forEach(it=>{const txt=it.textContent;d.hard.forEach(h=>{if(txt.includes(h))it.classList.add('v15-hard')})});
 const clock=cnClock();
 if(clock.date===d.date&&items.length){
   let found=null,next=null;
   items.forEach(it=>{const t=(it.querySelector('.tl-time')||{}).textContent||'',m=t.match(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/);if(!m)return;const a=minutes(m[1]),b=minutes(m[2]);if(a<=clock.min&&clock.min<b)found=it;if(a>clock.min&&!next)next=it});
   const target=found||next;if(target){const titleText=(target.querySelector('.tl-title')||{}).textContent||'';const timeText=(target.querySelector('.tl-time')||{}).textContent||'';now.querySelector('small').textContent=found?'现在':'下一项';now.querySelector('b').textContent=timeText+' · '+titleText;now.querySelector('span').textContent=found?'进行中':'即将开始';target.style.borderColor='#9db9a7';}
 } else if(clock.date<d.date){now.hidden=true}
 document.querySelectorAll('.food .btn.map').forEach(btn=>{const h=btn.closest('.food')?.querySelector('h3');if(h)btn.dataset.copy=h.textContent.trim()});
 const routeCard=panels.route.querySelector('.route-map-card');
 let selectRoutePoint=null;
 if(routeCard){
   const nodes=Array.from(routeCard.querySelectorAll('.route-node'));
   const cards=Array.from(routeCard.querySelectorAll('.premium-points .navpoint'));
   const source=routeCard.querySelector('.premium-legs');
   const sourceLegs=source?Array.from(source.querySelectorAll('.leg-chip')):[];
   const extras={0910:{8:['跨城','落地']},0911:{7:['跨城']},0913:{2:['跨城']}}[id]||{};
   if(source){
     source.classList.add('v15-leg-source');
     const wrap=source.closest('.legs-wrap');
     const view=document.createElement('div');view.className='v15-leg-view';
     wrap.insertBefore(view,source);
     function legData(leg){
       return{label:(leg.querySelector('.leg-top b')?.textContent||'').trim(),mode:(leg.querySelector('.leg-top span')?.textContent||'').trim(),dist:(leg.querySelector('.leg-bottom strong')?.textContent||'').trim(),time:(leg.querySelector('.leg-bottom small')?.textContent||'').trim()};
     }
     function renderLeg(index){
       const n=index+1,name=(cards[index]?.querySelector('span')?.textContent||('地标 '+n)).trim();
       let matches=sourceLegs.filter(leg=>legData(leg).label.startsWith(n+'→'));
       const special=extras[n]||[];
       if(special.length)matches=matches.concat(sourceLegs.filter(leg=>special.includes(legData(leg).label)));
       if(!matches.length)matches=sourceLegs.filter(leg=>legData(leg).label.endsWith('→'+n));
       const items=matches.map(leg=>{const x=legData(leg);return'<div class="v15-leg-item"><div class="v15-leg-main"><b>'+x.label+'</b><span>'+x.mode+'</span></div><div class="v15-leg-meta"><strong>'+x.dist+'</strong><small>'+x.time+'</small></div></div>'}).join('');
       view.innerHTML='<div class="v15-leg-view-head"><div><small>当前地标</small><b>'+n+' · '+name+'</b></div><span>'+(matches.length?matches.length+' 段':'到达点')+'</span></div>'+(items||'<div class="v15-leg-empty">这是当天路线的到达点，没有下一段本地路线。</div>');
     }
     selectRoutePoint=(index,scrollCard)=>{
       nodes.forEach(n=>n.classList.remove('selected'));cards.forEach(c=>c.classList.remove('selected'));
       if(nodes[index])nodes[index].classList.add('selected');
       if(cards[index])cards[index].classList.add('selected');
       renderLeg(index);
       if(scrollCard&&cards[index])cards[index].scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'nearest'});
     };
     nodes.forEach((node,i)=>{const card=cards[i];if(!card)return;node.setAttribute('tabindex','0');node.setAttribute('role','button');node.setAttribute('aria-label','查看 '+(card.querySelector('span')?.textContent||'地点')+' 的路段');const sel=()=>selectRoutePoint(i,true);node.addEventListener('click',sel);node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();sel()}});});
     cards.forEach((card,i)=>{const small=card.querySelector('small');if(small)small.textContent='查看路段 · 复制地点';card.addEventListener('click',()=>selectRoutePoint(i,false));});
     if(cards.length)selectRoutePoint(0,false);
   }
 }
 document.addEventListener('click',e=>{const t=e.target.closest('[data-copy]');if(!t)return;e.preventDefault();const card=t.closest('.premium-points .navpoint');if(card&&selectRoutePoint){const cards=Array.from(routeCard.querySelectorAll('.premium-points .navpoint')),i=cards.indexOf(card);if(i>=0)selectRoutePoint(i,false)}e.stopImmediatePropagation();robustCopy(t.dataset.copy)},true);
}
function enhanceHome(){
 const cards=Array.from(document.querySelectorAll('.premium-overview'));cards.forEach(card=>{const m=(card.getAttribute('href')||'').match(/(09\d\d)/);if(!m)return;const p=document.createElement('span');p.className='v15-home-focus';p.textContent='当天重点 · '+HOME_FOCUS[m[1]];card.appendChild(p)});
 const c=cnClock();const byDate=Object.entries(DAYS).find(([,d])=>d.date===c.date);if(byDate){const id=byDate[0],card=document.querySelector('.premium-overview[href="'+id+'.html"]');if(card){card.classList.add('today');setTimeout(()=>card.scrollIntoView({behavior:'smooth',block:'center'}),120)}}
}
function registerSW(){if(!('serviceWorker'in navigator))return;navigator.serviceWorker.register('./sw.js').then(()=>{let b=document.querySelector('.v15-offline');if(!b){b=document.createElement('div');b.className='v15-offline';b.textContent='行程已可离线查看';document.body.appendChild(b)}setTimeout(()=>b.classList.add('show'),800);setTimeout(()=>b.classList.remove('show'),3200)}).catch(()=>{})}
document.addEventListener('DOMContentLoaded',()=>{const id=slug();if(id==='index')enhanceHome();else enhanceDay(id);registerSW()});
})();