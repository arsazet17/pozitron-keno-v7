import fs from 'node:fs/promises';
import process from 'node:process';
import { chromium } from 'playwright';

const LOGIN_URL='https://oauth.stoloto.ru/login';
const ARCHIVE_URL='https://m.stoloto.ru/keno2/archive/';
const HISTORY_FILE='keno-history-v71.json';
const STATUS_FILE='keno-status-v71.json';
const EMAIL=process.env.STOLOTO_EMAIL||'';
const PASSWORD=process.env.STOLOTO_PASSWORD||'';

if(!EMAIL||!PASSWORD) throw new Error('FAIL: нет GitHub Secrets STOLOTO_EMAIL / STOLOTO_PASSWORD');

const MONTHS={января:1,февраля:2,марта:3,апреля:4,мая:5,июня:6,июля:7,августа:8,сентября:9,октября:10,ноября:11,декабря:12};
const pad2=n=>String(n).padStart(2,'0');
const norm=s=>String(s??'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').trim();

function moscowToday(){
  const f=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});
  const p=Object.fromEntries(f.formatToParts(new Date()).map(x=>[x.type,x.value]));
  return {y:+p.year,m:+p.month,d:+p.day};
}
function shiftDate(p,delta){const d=new Date(Date.UTC(p.y,p.m-1,p.d));d.setUTCDate(d.getUTCDate()+delta);return{y:d.getUTCFullYear(),m:d.getUTCMonth()+1,d:d.getUTCDate()}}
function normalizeDateLabel(label){
  const raw=norm(label).toLowerCase(),today=moscowToday();let p=null;
  if(raw==='сегодня')p=today;else if(raw==='вчера')p=shiftDate(today,-1);else{
    let m=raw.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
    if(m){let y=+m[3];if(y<100)y+=2000;p={d:+m[1],m:+m[2],y}}
    else{m=raw.match(/^(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?$/i);if(m&&MONTHS[m[2]]){let y=m[3]?+m[3]:today.y;p={d:+m[1],m:MONTHS[m[2]],y};if(!m[3]&&p.m>today.m+6)p.y--}}
  }
  return p?`${pad2(p.d)}.${pad2(p.m)}.${String(p.y).slice(-2)}`:null;
}
function normalizeTime(v){const m=String(v??'').match(/(\d{1,2}):(\d{2})/);if(!m)return null;const h=+m[1],min=+m[2];if(h>23||min>59)return null;return`${pad2(h)}:${pad2(min)}`}
function parseDraw(t){const m=String(t).match(/№\s*([0-9]{4,})/);return m?+m[1]:null}
function parseTime(t){const m=String(t).match(/\b([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/);return m?normalizeTime(m[0]):null}
function findDateLabel(text){
  const s=String(text);let m=s.match(/(?:^|\n)\s*(Сегодня|Вчера)\s*(?:\n|$)/i);if(m)return norm(m[1]);
  m=s.match(/(?:^|\n)\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})\s*(?:\n|$)/);if(m)return norm(m[1]);
  m=s.match(/(?:^|\n)\s*(\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+\d{4})?)\s*(?:\n|$)/i);
  return m?norm(m[1]):null
}

async function login(page){
  await page.goto(LOGIN_URL,{waitUntil:'domcontentloaded',timeout:60000});
  const logins=['input[type="email"]','input[name*="email" i]','input[name*="login" i]','input[autocomplete="username"]','input[type="text"]'];
  const passes=['input[type="password"]','input[name*="password" i]','input[autocomplete="current-password"]'];
  let login=null,pass=null;
  for(const s of logins){const l=page.locator(s).first();if(await l.count()){login=l;break}}
  for(const s of passes){const l=page.locator(s).first();if(await l.count()){pass=l;break}}
  if(!login||!pass)throw new Error('FAIL: не найдены поля OAuth Столото');
  await login.fill(EMAIL);await pass.fill(PASSWORD);
  const buttons=[page.getByRole('button',{name:/войти/i}).first(),page.locator('button[type="submit"]').first(),page.locator('input[type="submit"]').first()];
  let clicked=false;for(const b of buttons){if(await b.count()){await b.click();clicked=true;break}}
  if(!clicked)throw new Error('FAIL: не найдена кнопка Войти');
  await page.waitForLoadState('domcontentloaded',{timeout:60000}).catch(()=>{});
  await page.waitForTimeout(2000);
}

async function expandArchive(page,targetRows){
  let last=0,stable=0;
  for(let round=0;round<90;round++){
    const count=await page.locator('tr').evaluateAll(list=>list.filter(el=>/№\s*\d{4,}/.test(el.innerText||'')).length);
    if(count>=targetRows)break;
    stable=count===last?stable+1:0;last=count;
    const more=page.getByRole('button',{name:/показать\s*(ещё|еще)|загрузить\s*(ещё|еще)|^(ещё|еще)$/i}).last();
    try{if(await more.count()&&await more.isVisible()){await more.click({timeout:4000});await page.waitForTimeout(650);continue}}catch{}
    const link=page.getByRole('link',{name:/показать\s*(ещё|еще)|загрузить\s*(ещё|еще)|^(ещё|еще)$/i}).last();
    try{if(await link.count()&&await link.isVisible()){await link.click({timeout:4000});await page.waitForTimeout(650);continue}}catch{}
    await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
    await page.waitForTimeout(650);
    if(stable>=6)break;
  }
  await page.evaluate(()=>window.scrollTo(0,0));
}

async function collectRows(page,targetRows){
  await page.goto(ARCHIVE_URL,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(2500);
  await expandArchive(page,targetRows);
  return await page.locator('body').evaluate(()=>{
    const drawRx=/№\s*\d{4,}/;
    const dateRx=/^(Сегодня|Вчера|\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+\d{4})?)$/i;
    const n=s=>String(s||'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').trim();
    const all=[...document.querySelectorAll('body *')];
    function nearestDate(el){
      let best=null;
      for(const node of all){
        if(node===el||el.contains(node))continue;
        const pos=node.compareDocumentPosition(el);
        if(!(pos&Node.DOCUMENT_POSITION_FOLLOWING))continue;
        const t=n(node.innerText||node.textContent||'');
        if(!t||t.length>40||!dateRx.test(t))continue;
        if(node.children&&node.children.length>3)continue;
        best=t;
      }
      return best;
    }
    let c=[...document.querySelectorAll('tr')].filter(el=>drawRx.test(el.innerText||''));
    if(!c.length)c=all.filter(el=>{
      const t=n(el.innerText||'');
      if(!drawRx.test(t)||el.querySelectorAll('button').length<20)return false;
      return ![...el.children].some(ch=>drawRx.test(n(ch.innerText||''))&&ch.querySelectorAll('button').length>=20);
    });
    return c.map(el=>({
      text:el.innerText||'',
      dateLabel:nearestDate(el),
      buttons:[...el.querySelectorAll('button')].map(b=>n(b.innerText||''))
    }));
  });
}

function parseRows(raw){
  const out=[];let carry=null;
  for(const row of raw){
    const text=String(row.text||'');
    const local=norm(row.dateLabel||'')||findDateLabel(text);
    if(local)carry=local;
    const draw=parseDraw(text);if(!draw)continue;
    const time=parseTime(text);if(!time)continue;
    const date=normalizeDateLabel(local||carry);if(!date)continue;
    let balls=(row.buttons||[]).map(x=>Number(norm(x))).filter(n=>Number.isInteger(n)&&n>=1&&n<=80);
    if(balls.length>20)balls=balls.slice(-20);
    if(balls.length!==20||new Set(balls).size!==20)continue;
    out.push({draw,date,time,balls});
  }
  return [...new Map(out.map(d=>[d.draw,d])).values()].sort((a,b)=>a.draw-b.draw);
}
function canon(d){return JSON.stringify({draw:d.draw,date:d.date,time:d.time,balls:d.balls})}

async function readTwice(page,targetRows){
  const reads=[];
  for(let i=1;i<=2;i++){
    const parsed=parseRows(await collectRows(page,targetRows));
    if(parsed.length<60)throw new Error(`FAIL: чтение ${i}: только ${parsed.length} тиражей`);
    reads.push(parsed);
    console.log(`Чтение ${i}: ${parsed.length}, №${parsed[0].draw}–№${parsed.at(-1).draw}`);
    if(i===1)await page.waitForTimeout(1200);
  }
  const a=new Map(reads[0].map(d=>[d.draw,d]));
  const b=new Map(reads[1].map(d=>[d.draw,d]));
  const stable=[];
  for(const [draw,d1] of a){
    const d2=b.get(draw);
    if(d2&&canon(d1)===canon(d2))stable.push(d1);
  }
  stable.sort((x,y)=>x.draw-y.draw);
  if(stable.length<60)throw new Error(`FAIL: двойная проверка: стабильны только ${stable.length}`);
  console.log(`Двойная проверка PASS: ${stable.length} тиражей`);
  return stable;
}

async function readHistory(){
  const p=JSON.parse(await fs.readFile(HISTORY_FILE,'utf8'));
  return Array.isArray(p)?p:(p.draws||[]);
}
function normalizeHistory(d){
  return {
    draw:Number(d?.draw??d?.number??d?.id),
    date:norm(d?.date),
    time:normalizeTime(d?.time),
    balls:Array.isArray(d?.balls)?d.balls.map(Number):Array.isArray(d?.numbers)?d.numbers.map(Number):[]
  };
}
function validateAndFindFresh(stoloto,historyRaw){
  const history=historyRaw.map(normalizeHistory).filter(d=>Number.isInteger(d.draw)&&d.balls.length===20).sort((a,b)=>a.draw-b.draw);
  if(!history.length)throw new Error('FAIL: локальная история пуста');
  const last=history.at(-1);
  const officialMap=new Map(stoloto.map(d=>[d.draw,d]));
  const anchor=officialMap.get(last.draw);
  if(!anchor)throw new Error(`FAIL: Столото не догружен до anchor №${last.draw}`);
  if(canon(anchor)!==canon(last))throw new Error(`FAIL: anchor №${last.draw} не совпал со Столото`);
  const fresh=stoloto.filter(d=>d.draw>last.draw).sort((a,b)=>a.draw-b.draw);
  let expected=last.draw+1;
  for(const d of fresh){
    if(d.draw!==expected)throw new Error(`FAIL: пропуск тиража: ожидался №${expected}, получен №${d.draw}`);
    expected++;
  }
  return {last,fresh};
}

const browser=await chromium.launch({headless:true});
try{
  const context=await browser.newContext({
    locale:'ru-RU',
    timezoneId:'Europe/Moscow',
    viewport:{width:390,height:844},
    userAgent:'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36'
  });
  const page=await context.newPage();
  await login(page);

  const historyRaw=await readHistory();
  const lastDraw=Math.max(...historyRaw.map(x=>Number(x?.draw??x?.number??x?.id)||0));

  let stoloto=null;
  for(const depth of [220,500,900,1400]){
    stoloto=await readTwice(page,depth);
    if(stoloto.some(d=>d.draw===lastDraw))break;
    console.log(`Anchor №${lastDraw} пока не найден, увеличиваем глубину`);
  }

  const {fresh}=validateAndFindFresh(stoloto,historyRaw);
  if(!fresh.length){
    console.log(`PASS: новых тиражей нет, последний №${lastDraw}`);
  }else{
    const source='Официальный Столото · OAuth · двойная проверка';
    const additions=fresh.map(d=>({...d,source}));
    const merged=[...historyRaw,...additions].sort((a,b)=>Number(a.draw??a.number??a.id)-Number(b.draw??b.number??b.id));
    await fs.writeFile(HISTORY_FILE,JSON.stringify(merged)+'\n');
    const last=merged.at(-1);
    await fs.writeFile(STATUS_FILE,JSON.stringify({
      version:'7.1.4',
      source:ARCHIVE_URL,
      updatedAt:new Date().toISOString(),
      drawsStored:merged.length,
      latestDraw:Number(last.draw??last.number??last.id),
      latestDate:String(last.date||''),
      latestTime:String(last.time||''),
      verification:'double'
    },null,2)+'\n');
    console.log(`PASS: добавлено ${fresh.length}, новый последний №${last.draw}`);
  }
}finally{
  await browser.close();
}
