from pathlib import Path
from html import escape as esc
import json,re,hashlib
ROOT=Path(__file__).resolve().parent
OUT=ROOT.parents[1]/'source'/'shandong-trip-2026'
DATA=json.loads((ROOT/'content.json').read_text())
DAYS,HOTELS,TRAINS=DATA['days'],DATA['hotels'],DATA['trains']
E=lambda x:esc(str(x),quote=True)

def icon(name):
 paths={
 'arrow':'M5 12h14m-6-6 6 6-6 6', 'copy':'M9 9h11v12H9z M15 5V3H3v12h2',
 'train':'M6 3h12v14H6z M6 10h12 M8 21l2-4m6 4-2-4 M9 14h.01M15 14h.01',
 'pin':'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0 M15 10a3 3 0 1 1-6 0 3 3 0 1 1 6 0',
 'clock':'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0',
 'down':'m6 9 6 6 6-6', 'bed':'M3 18V7m18 11V9H3m0 5h18 M6 9V5h6v4',
 'phone':'M7 3H3c0 10 8 18 18 18v-4l-5-2-2 2-7-7 2-2z',
 'home':'m3 10 9-7 9 7 M5 9v12h5v-7h4v7h5V9',
 'check':'m5 12 4 4L19 6','sun':'M12 3V1m0 22v-2M3 12H1m22 0h-2M5 5l-2-2m18 18-2-2M5 19l-2 2M21 3l-2 2 M17 12a5 5 0 1 1-10 0 5 5 0 1 1 10 0',
 'bag':'M4 7h16v15H4z M9 7V2h6v5 M4 13h16',
 'meal':'M4 2v7h6V2M7 2v20M20 22V2c-5 4-5 10 0 10',
 'walk':'m12 6-3 5 4 3-3 8 M9 11H4m8-5 4 6h4m-7 2 4 8 M15 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0',
 'bus':'M4 4h16v14H4z M4 11h16 M7 18v3m10-3v3M7 14h.01M17 14h.01',
 'cable':'M1 5 23 1 M12 3v6 M6 9h12v11H6zM6 15h12M12 9v6',
 'camera':'M3 7h5l2-3h4l2 3h5v14H3z M16 14a4 4 0 1 1-8 0 4 4 0 1 1 8 0',
 'info':'M12 10v7m0-11v.01 M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0',
 }
 return f'<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="{paths.get(name,paths["pin"])}"/></svg>'

def copy(text,label='复制地点',cls=''):
 return f'<button type="button" class="copy-button {cls}" data-copy="{E(text)}">{icon("copy")}<span>{E(label)}</span></button>'

def nav(current):
 links=f'<a class="overview-link {"active" if current=="index" else ""}" href="index.html" '+('aria-current="page"' if current=='index' else '')+f'>{icon("home")}<span>总览</span></a>'
 for d in DAYS:
  links+=f'<a href="{d["id"]}.html" class="date-link {"active" if current==d["id"] else ""}" '+('aria-current="page"' if current==d['id'] else '')+f'><span>09.{d["id"][2:]}</span><small>{E(d["city"])}</small></a>'
 return f'<nav class="date-nav" aria-label="行程日期"><div class="nav-inner">{links}</div></nav>'

def layout(title,description,body,current='index'):
 return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#123bc6"><title>{E(title)}｜山海同行</title><meta name="description" content="{E(description)}"><meta property="og:title" content="{E(title)}｜山海同行"><meta property="og:description" content="{E(description)}"><meta property="og:type" content="website"><meta name="apple-mobile-web-app-title" content="山海同行"><link rel="icon" href="assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="assets/trip.css"><script src="assets/trip.js" defer></script></head>
<body data-page="{current}"><a class="skip-link" href="#main">跳到行程内容</a>
<header class="masthead"><a href="index.html" class="brand"><span class="brand-mark">山海</span><span>同行<span class="brand-sub">山东家庭随行手册</span></span></a><span class="edition">2026 <span>09.08—09.13</span></span></header>
{nav(current)}{body}
<footer class="site-footer"><span>山海同行 · 山东家庭游 2026</span><span>一家人，按自己的节奏走。</span><span id="offline-status" class="offline-status"></span><a href="credits.html">图片来源</a></footer>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<div class="copy-fallback" id="copy-fallback" hidden><section role="dialog" aria-modal="true" aria-labelledby="copy-title" tabindex="-1"><button class="close-copy" type="button" aria-label="关闭复制窗口">×</button><h2 id="copy-title">长按文字，复制地点</h2><p>复制后在地图 App 中粘贴搜索。</p><textarea id="copy-text" readonly aria-label="地点名称和地址"></textarea><button type="button" class="button close-copy">完成</button></section></div>
</body></html>'''

def ticket(t,compact=False):
 return f'''<article class="ticket {"compact" if compact else ""}"><div class="ticket-top"><span>{icon('train')} 已确认高铁</span><span>09.{t['day'][2:]}</span></div><div class="ticket-route"><div><strong>{t['depart']}</strong><span>{t['from']}</span></div><div class="ticket-mid"><small>{t['duration']}</small><span class="ticket-track">{icon('arrow')}</span></div><div><strong>{t['arrive']}</strong><span>{t['to']}</span></div></div><div class="ticket-foot"><span>{'青岛站出发 · 留意站名' if t['day']=='0910' else '检票口与车次以车票为准'}</span>{copy(t['station'],'复制出发站')}</div></article>'''

def hotelcard(h,small=False):
 return f'''<article class="hotel-card"><div class="hotel-top"><span>{icon('bed')} {h['city']}</span><span>{h['nights']}</span></div><h3>{E(h['name'])}</h3><p>{E(h['hint'])}</p>{copy(h['copy'],'复制酒店地址')}</article>'''

def notes(items):
 return ''.join(f'<details class="note"><summary>{icon("info")}<span>{E(n["title"])}</span>{icon("down")}</summary><div class="note-body">{E(n["detail"])}</div></details>' for n in items)

def overview():
 cards=''
 for d in DAYS:
  cards+=f'''<a class="day-card day-{d['id']}" href="{d['id']}.html" data-date="{d['date']}"><div class="day-card-date"><span>09</span><strong>{d['id'][2:]}</strong><small>{d['weekday']}</small></div><div class="day-card-main"><div class="day-card-top"><span>{E(d['city'])}</span><span class="day-order">第 {d['number']} 天</span></div><h3>{E(d['title'])}</h3><p>{E(d['subtitle'])}</p><div class="day-card-foot"><span><b>{E(d['anchor'])}</b> {E(d['anchorLabel'])}</span>{icon('arrow')}</div></div></a>'''
 body=f'''<main id="main" class="home-main">
<section class="overview-head"><div><div class="eyebrow">六天 · 三城 · 一家人</div><h1>这一程，<br class="desktop-break">山海相伴。</h1><p>青岛的海，泰山的云，济南的泉。</p><a href="0908.html" class="button primary" id="today-link">从第一天开始 {icon('arrow')}</a><span class="trip-status" id="trip-status">2026年9月8日出发</span></div><figure class="cover-photo"><img src="assets/qingdao.webp" width="1400" height="1000" alt="青岛奥帆中心海岸与蓝色海面" fetchpriority="high"><figcaption><span>第一站 · 青岛</span><span>QINGDAO / 36°N</span></figcaption></figure></section>
<section class="days-section" aria-labelledby="days-title"><div class="section-heading"><div><span class="section-no">01 /</span><h2 id="days-title">六天，慢慢走</h2></div><span class="section-aside">选一天，带着走</span></div><div class="day-grid">{cards}</div></section>
<section class="home-transport" id="trains"><div class="section-heading"><div><span class="section-no">02 /</span><h2>四趟车，时间留足</h2></div><span class="section-aside">杭州西 → 青岛北 · 青岛 → 泰安 · 泰安 → 济南东 · 济南西 → 杭州</span></div><div class="train-grid">{''.join(ticket(t) for t in TRAINS)}</div></section>
<section id="hotels"><div class="section-heading"><div><span class="section-no">03 /</span><h2>今晚，住这里</h2></div><span class="section-aside">两晚青岛 · 一晚泰安 · 两晚济南</span></div><div class="hotel-grid">{''.join(hotelcard(h) for h in HOTELS)}</div></section>
<section class="prepare"><div><div class="eyebrow">出发前，记住这三件事</div><h2>准备好，<br>就从容一些。</h2><p>景区运行与优惠临行确认，行程保留弹性。</p><a class="button" href="tel:053296616">{icon('phone')} 崂山咨询 0532-96616</a></div><div>{notes([{'title':'09.08晚 · 确认崂山景交与索道','detail':'确认仰口索道运行、仰口至垭口班次、垭口下车与续乘、合法拍照点及太清至大河东末班。先确认再执行渔村停靠。'},{'title':'09.10入住 · 确认泰安酒店延迟退房','detail':'次日计划午休到15:10，须确认能否15:20退房及费用；不支持则早上退房寄存，午餐后安排有座位处休息。'},{'title':'报到材料、身份证、准考证带齐','detail':'妹妹准备学校要求的报到材料、录取通知书与身份证；崂山优惠先核验活动期限，带2026高考准考证。外婆备常用药与防滑鞋。'}])}</div></section>
</main>'''
 return layout('山东家庭游 · 六日行程','2026年9月8日至13日，青岛、崂山、泰山、济南家庭旅行：每日行程、路线、吃住和固定高铁。',body)

def timeline_icon(t):
 if t['icon'] in ['🚄','🚉']:return 'train'
 if t['icon'] in ['🚕','🚌','🚇']:return 'bus'
 if t['icon']=='🚡':return 'cable'
 if t['icon'] in ['🍽️','🥣','🍜','🍚']:return 'meal'
 if t['icon'] in ['🏨','😴','☕']:return 'bed'
 if t['icon']=='🧳':return 'bag'
 if t['icon'] in ['📷','🌅','🌃']:return 'camera'
 return 'walk'

def timeline(d):
 groups=[]
 for i,t in enumerate(d['timeline']):
  start=int(t['start'][:2]);period='上午' if start<12 else ('下午' if start<18 else '晚上')
  if not groups or groups[-1][0]!=period:groups.append([period,[]])
  kind=timeline_icon(t)
  groups[-1][1].append(f'''<details class="timeline-item kind-{kind} {'hard' if t['hard'] else ''}" id="{t['id']}" data-start="{t['start']}" data-end="{t['end']}"><summary><span class="time"><b>{t['start']}</b><small>— {t['end']}</small></span><span class="timeline-marker">{icon(kind)}</span><span class="step-title">{E(t['title'])}<span class="step-tag">{'重要节点' if t['hard'] else ''}</span></span><span class="chevron">{icon('down')}</span></summary><div class="step-detail"><p>{E(t['detail'])}</p></div></details>''')
 return f'''<section class="timeline-section" id="timeline"><div class="section-heading"><div><span class="section-no">01 /</span><h2>今天这样走</h2></div><button type="button" class="text-button" id="toggle-all">展开全部</button></div>{''.join(f'<div class="time-group"><div class="period-label">{name}<span></span></div>{"".join(items)}</div>' for name,items in groups)}</section>'''

def route(d):
 count=len(d['points'])
 if count==2:positions=[(140,100),(400,100)];height=200
 elif count==5:positions=[(80,70),(270,70),(460,70),(460,210),(270,210)];height=300
 else:positions=[(80,65),(270,65),(460,65),(460,190),(270,190),(80,190),(80,315),(270,315)][:count];height=405
 paths='';seen=set()
 for l in d['legs']:
  if not re.fullmatch(r'\d+→\d+',l['pair']):continue
  a,b=map(int,l['pair'].split('→'));x,y=positions[a-1];u,v=positions[b-1]
  back=b<a;line=f'M{x} {y} L{u} {v}'
  if back:
   side=30 if x<=270 else 515
   line=f'M{x} {y} C{side} {y+55},{side} {v+55},{u} {v}'
  paths+=f'<path d="{line}" class="map-line {"return-line" if back else ""}" marker-end="url(#arrow-{d["id"]}{"-back" if back else ""})"/>'
 buttons=''
 for p,(x,y) in zip(d['points'],positions):
  buttons+=f'<button type="button" class="map-node" style="left:{x/540*100:.3f}%;top:{y/height*100:.3f}%" data-point="{p["id"]}" aria-label="查看{p["id"]}号地点：{E(p["name"])}" aria-controls="point-{p["id"]}"><b>{p["id"]}</b><span>{E(p["short"])}</span></button>'
 pointlist=''.join(f'<article class="place-card" id="point-{p["id"]}" tabindex="-1"><span class="point-number">{p["id"]}</span><div><h3>{E(p["name"])}</h3><p>{E(p["copy"])}</p></div>{copy(p["copy"],"复制")}</article>' for p in d['points'])
 legs=''
 for l in d['legs']:
  pair=l['pair'];dest=''
  if re.fullmatch(r'\d+→\d+',pair):
   a,b=map(int,pair.split('→'));dest=d['points'][a-1]['short']+' → '+d['points'][b-1]['short']
  else:dest=pair
  mode=re.sub(r'^[^\w\u4e00-\u9fff]+','',l['mode'])
  legs+=f'<li class="leg"><div><b>{E(pair)}</b><span>{E(dest)}</span></div><div class="leg-info"><span>{E(mode)}</span><span>{E(l["distance"])}</span><strong>{E(l["duration"])}</strong></div></li>'
 return f'''<section id="route" class="route-section"><div class="section-heading"><div><span class="section-no">02 /</span><h2>把路线看清楚</h2></div></div><div class="route-panel"><div class="map-topline"><span>路线示意 · 非比例地图</span><span><i></i>去程 <i class="return-key"></i>折返</span></div><div class="route-canvas" style="--map-height:{height/16:.3f}rem"><svg viewBox="0 0 540 {height}" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="arrow-{d['id']}" viewBox="0 0 10 10" refX="25" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 10 5 0 10Z" fill="#2452d7"/></marker><marker id="arrow-{d['id']}-back" viewBox="0 0 10 10" refX="25" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 10 5 0 10Z" fill="#b35f06"/></marker></defs>{paths}</svg>{buttons}</div><div class="map-caption">点击编号查看地点 · 复制完整名称后在地图中搜索</div><details class="route-legs" open><summary><span>路段 · 交通 · 预留时间</span>{icon('down')}</summary><ol>{legs}</ol><p class="estimate-note">距离为行程估算；时间含部分等候与缓冲，实际路况和景区班次以当天为准。</p></details></div><div class="place-list">{pointlist}</div></section>'''

def foodcard(f):
 return f'''<article class="food-card"><div class="food-meal">{icon('meal')} {f['meal']}</div><h3>{E(f['name'])}</h3><p class="dish-label">一家人可以这样点</p><ul class="dishes">{''.join(f'<li>{E(x)}</li>' for x in f['dishes'])}</ul>{f'<p class="food-note">{E(f["detail"])}</p>' if f['detail'] else ''}<div class="food-actions">{copy(f['copy'])}<a class="text-link" href="{E(f['url'])}" target="_blank" rel="noopener noreferrer">看点评 {icon('arrow')}</a>{f'<a class="text-link" href="tel:{f["phone"]}">{icon("phone")} 电话</a>' if f['phone'] else ''}</div></article>'''

def daypage(d):
 train=ticket(d['train'],True) if d['train'] else ''
 photo=f'<div class="day-photo"><img src="assets/{d["photo"]}.webp" alt="{"青岛奥帆海岸" if d["photo"]=="qingdao" else "济南大明湖全景"}" width="1400" height="506"></div>' if d['photo'] else '<div class="day-wordmark" aria-hidden="true">'+('山海' if d['id']=='0909' else '登高')+'</div>'
 prev=f'<a href="{DAYS[d["number"]-2]["id"]}.html">← 前一天</a>' if d['number']>1 else '<span></span>'
 nxt=f'<a href="{DAYS[d["number"]]["id"]}.html">后一天 →</a>' if d['number']<6 else '<span></span>'
 foods=''.join(foodcard(f) for f in d['foods'])
 if d['id']=='0911':foods+='<article class="food-card simple-meal"><div class="food-meal">晚餐 · 抵达济南后</div><h3>汉庭附近，吃点热乎的</h3><p>19:10–20:00，附近家常菜、面、馄饨或饺子；早点休息，明天送妹妹报到。</p></article>'
 if d['id']=='0912':foods='<article class="food-card simple-meal"><div class="food-meal">午餐 · 报到后</div><h3>学校附近，简单吃好</h3><p>11:30–12:10，找就近、不久等的餐馆。先吃饭，再回汉庭取行李。</p></article>'+foods
 stay=hotelcard(HOTELS[d['hotel']]) if d['hotel'] is not None else '<article class="hotel-card"><div class="hotel-top">返程日 · 柏曼酒店</div><h3>09:20离店，前往济南西</h3><p>早餐后只在附近短走、准备车上食物，退房时检查证件与行李。</p>'+copy(HOTELS[3]['copy'],'复制酒店地址')+'</article>'
 body=f'''<main id="main" class="day-main" data-trip-date="{d['date']}"><header class="day-heading"><div class="day-heading-copy"><div class="eyebrow">第 {d['number']} 天 / {d['weekday']} / {E(d['city'])}</div><h1>{E(d['title'])}</h1><p>{E(d['intro'])}</p></div><div class="folio-date"><span>九月</span><b>{d['id'][2:]}</b><span>2026</span></div>{photo}</header>
<div class="day-keybar"><div>{icon('clock')}<span><small>{E(d['departLabel'])}</small><b>{E(d['depart'])}</b></span></div><div class="key-important">{icon('pin')}<span><small>{E(d['deadlineLabel'])}</small><b>{E(d['deadline'])}</b></span></div><div>{icon('train') if d['train'] else icon('sun')}<span><small>{E(d['anchorLabel'])}</small><b>{E(d['anchor'])}</b></span></div></div>
<section class="now-card" id="now-card" aria-label="按计划查看当前安排"><div><span class="now-label" id="now-label">当天安排</span><strong id="now-title">{d['depart']} · {E(d['departLabel'])}</strong><p id="now-next">{E(d['subtitle'])}</p></div><a id="now-link" href="#timeline">查看行程 {icon('arrow')}</a></section>
<nav class="section-nav" aria-label="当天内容"><a href="#timeline">行程</a><a href="#route">路线</a><a href="#food">吃住</a><a href="#reminders">提醒</a></nav>
<div class="day-columns"><div class="day-primary">{timeline(d)}<section id="food"><div class="section-heading"><div><span class="section-no">03 /</span><h2>{'吃好，再出发' if d['id']=='0913' else '一餐一宿，都安心'}</h2></div></div><div class="food-grid">{foods}</div>{stay}</section><section id="reminders"><div class="section-heading"><div><span class="section-no">04 /</span><h2>留一点余地</h2></div></div><div class="carry"><h3>{icon('bag')} 随身带上</h3><div>{''.join(f'<span>{E(x)}</span>' for x in d['carry'])}</div></div>{notes(d['notes'])}{'<a class="contact-line" href="tel:053296616">'+icon('phone')+' 崂山咨询 · 0532-96616</a>' if d['id'] in ['0908','0909'] else ''}</section></div><aside class="day-aside">{train}{route(d)}</aside></div>
<nav class="day-pagination" aria-label="前后日期">{prev}<a href="index.html">{icon('home')} 六日总览</a>{nxt}</nav></main>'''
 return layout(f'09.{d["id"][2:]} {d["city"]} · {d["subtitle"]}',f'{d["intro"]} {d["depart"]}{d["departLabel"]}；{d["deadline"]}{d["deadlineLabel"]}。',body,d['id'])

def credits():
 return layout('图片来源','山东家庭游实景图片来源与授权信息。','''<main id="main" class="credits"><h1>沿途实景</h1><p>照片用于呈现目的地，拍摄时间与本次行程不同。</p><article><h2>青岛奥帆海岸</h2><p>作者 Vitsuha · <a href="https://commons.wikimedia.org/wiki/File:Qingdao_International_Sailing_Centre_from_Sea.jpg">Wikimedia Commons 原图</a> · <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>。</p><p>本站转换为 WebP、缩小尺寸，页面展示时裁切；衍生图片继续以 CC BY-SA 4.0 提供。</p></article><article><h2>济南大明湖</h2><p>作者 happy lydia · <a href="https://commons.wikimedia.org/wiki/File:Daming_Lake.jpg">Wikimedia Commons 原图</a> · <a href="https://creativecommons.org/licenses/by/2.0/">CC BY 2.0</a>。</p><p>本站转换为 WebP、缩小尺寸，页面展示时裁切。</p></article><a class="button primary" href="index.html">回到行程总览</a></main>''','credits')

OUT.joinpath('index.html').write_text(overview())
for d in DAYS:OUT.joinpath(d['id']+'.html').write_text(daypage(d))
OUT.joinpath('credits.html').write_text(credits())
OUT.joinpath('assets/favicon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#123bc6"/><text x="32" y="43" text-anchor="middle" fill="white" font-size="35" font-family="serif">行</text></svg>')
sw=OUT/'sw.js'
if sw.exists():
 digest=hashlib.sha256(b''.join(p.read_bytes() for p in sorted(OUT.rglob('*')) if p.is_file() and p.name!='sw.js')).hexdigest()[:12]
 sw.write_text(re.sub(r"const VERSION='[^']+';","const VERSION='shandong-family-2026-"+digest+"';",sw.read_text()))
print('Generated overview, six daily pages, and image credits.')
