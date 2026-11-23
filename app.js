"use strict";
/* ───────── 기본 설정 ───────── */
const KEY = "daylog.v2";          // 기록 데이터 (이 기기)
const GKEY = "daylog.gh";         // GitHub 연결 정보 (이 기기에만 보관)
const DEFAULT_CATS = ["업무","영어공부","독서","식사","휴식","자기계발","운동","이동","준비","집안일"];
const DEFAULT_OWNER = "aiden1412";
const DEFAULT_REPO = "daylog-data";
const COLORS = ["#2F6FDB","#7B5CD6","#3A9A8C","#D98A2B","#3FA34D","#C2478B","#6C8A9C","#A0703F","#D45A4A","#4A9BC4","#8C6BB1","#5C9E6E"];
const WD = ["일","월","화","수","목","금","토"];

/* ───────── 유틸 ───────── */
const pad = n => String(n).padStart(2,"0");
const dkey = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const hm = ms => { const d=new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const toMin = s => { const [h,m]=s.split(":").map(Number); return h*60+m; };
const nowMin = () => { const d=new Date(); return d.getHours()*60+d.getMinutes(); };
const todayKey = () => dkey(new Date());
const esc = s => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDur = m => { m=Math.max(0,Math.round(m)); if(m<1) return "1분 미만"; const h=Math.floor(m/60), r=m%60; return h? (r? `${h}시간 ${r}분`:`${h}시간`) : `${r}분`; };
const fmtShort = m => { m=Math.max(0,Math.round(m)); const h=Math.floor(m/60), r=m%60; return h? `${h}h ${pad(r)}m` : `${r}m`; };
const hmOf = m => `${pad(Math.floor(m/60)%24)}:${pad(m%60)}`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const $ = id => document.getElementById(id);
const byStart = (a,b) => toMin(a.start)-toMin(b.start) || a.id.localeCompare(b.id);

/* ───────── 로컬 저장 ───────── */
function blank(){ return {categories:[...DEFAULT_CATS], catAt:0, running:null, runningAt:0, lastCat:null, days:{}, dirty:{days:[], meta:false}}; }
function load(){
  try{ const r=localStorage.getItem(KEY); if(r){ const s=JSON.parse(r); if(s && s.days){ s.dirty ||= {days:[],meta:false}; return s; } } }catch(e){}
  return blank();
}
let S = load();
function save(){ try{ localStorage.setItem(KEY, JSON.stringify(S)); }catch(e){} }

function loadG(){ try{ return JSON.parse(localStorage.getItem(GKEY)) || {}; }catch(e){ return {}; } }
let G = loadG();
const connected = () => !!(G.token && G.owner && G.repo);

let viewDate = todayKey();
const emptyDay = k => ({date:k, dayStart:null, dayEnd:null, at:0, entries:[], deleted:[]});
const getDay = k => S.days[k] || emptyDay(k);
const ensureDay = k => (S.days[k] ||= emptyDay(k));
const catColor = c => { const i=S.categories.indexOf(c); return COLORS[(i<0?S.categories.length:i)%COLORS.length]; };
const durOf = e => { let d=toMin(e.end)-toMin(e.start); if(d<0) d+=1440; return d; };

function markDay(k){ if(!S.dirty.days.includes(k)) S.dirty.days.push(k); save(); requestSync(); }
function markMeta(){ S.dirty.meta = true; save(); requestSync(); }
function setDayTimes(k, patch){ const d=ensureDay(k); Object.assign(d, patch); d.at=Date.now(); markDay(k); }

/* ───────── GitHub 연동 ───────── */
const API = "https://api.github.com";
function gh(method, path, body){
  return fetch(`${API}/repos/${encodeURIComponent(G.owner)}/${encodeURIComponent(G.repo)}${path}`, {
    method, cache:"no-store",
    headers:{ Authorization:`Bearer ${G.token}`, Accept:"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28",
      ...(body ? {"Content-Type":"application/json"} : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
}
function enc(str){ const b=new TextEncoder().encode(str); let s=""; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s); }
function dec(b64){ const s=atob(b64.replace(/\s/g,"")); return new TextDecoder().decode(Uint8Array.from(s, c=>c.charCodeAt(0))); }
class GhError extends Error{ constructor(status){ super("GitHub "+status); this.status=status; } }

async function getFile(path){
  const r = await gh("GET", `/contents/${path}`);
  if(r.status===404) return {sha:null, data:null};
  if(!r.ok) throw new GhError(r.status);
  const j = await r.json();
  return {sha:j.sha, data:JSON.parse(dec(j.content))};
}
function putFile(path, obj, sha, message){
  return gh("PUT", `/contents/${path}`, {message, content:enc(JSON.stringify(obj, null, 1)+"\n"), ...(sha?{sha}:{})});
}

function mergeDay(a, b){
  if(!b) return a; if(!a) return JSON.parse(JSON.stringify(b));
  const deleted = [...new Set([...(a.deleted||[]), ...(b.deleted||[])])];
  const map = new Map();
  for(const e of [...(b.entries||[]), ...(a.entries||[])]){
    if(deleted.includes(e.id)) continue;
    const x = map.get(e.id);
    if(!x || (e.at||0) >= (x.at||0)) map.set(e.id, e);
  }
  const newer = (b.at||0) > (a.at||0) ? b : a;
  return {date:a.date||b.date, dayStart:newer.dayStart??null, dayEnd:newer.dayEnd??null, at:Math.max(a.at||0,b.at||0),
    entries:[...map.values()].sort(byStart), deleted};
}
const canonDay = d => JSON.stringify([d.dayStart??null, d.dayEnd??null, d.at||0,
  [...(d.entries||[])].sort((x,y)=>x.id.localeCompare(y.id)).map(e=>[e.id,e.start,e.end,e.category,e.memo,e.at||0]),
  [...(d.deleted||[])].sort()]);

async function syncDay(k){
  const path = `days/${k}.json`;
  for(let i=0;i<3;i++){
    const {sha, data} = await getFile(path);
    const local = S.days[k];
    if(!local && !data) return;
    const merged = mergeDay(local, data); merged.date = k;
    S.days[k] = merged; save();
    if(data && canonDay(data)===canonDay(merged)) return;
    const r = await putFile(path, merged, sha, `${k} 기록`);
    if(r.ok) return;
    if(r.status!==409 && r.status!==422) throw new GhError(r.status);
  }
  throw new GhError(409);
}

function mergeMeta(a, b){
  if(!b) return a;
  const cats = [...a.categories]; for(const c of b.categories||[]) if(!cats.includes(c)) cats.push(c);
  const run = (b.runningAt||0) > (a.runningAt||0) ? {running:b.running||null, runningAt:b.runningAt} : {running:a.running, runningAt:a.runningAt};
  return {categories:cats, catAt:Math.max(a.catAt||0,b.catAt||0), ...run};
}
async function syncMeta(){
  for(let i=0;i<3;i++){
    const {sha, data} = await getFile("meta.json");
    const local = {categories:S.categories, catAt:S.catAt, running:S.running, runningAt:S.runningAt};
    const m = mergeMeta(local, data);
    Object.assign(S, m); save();
    const canon = x => JSON.stringify([x.categories, x.catAt||0, x.running||null, x.runningAt||0]);
    if(data && canon(data)===canon(m)) return;
    const r = await putFile("meta.json", m, sha, "설정·측정 상태");
    if(r.ok) return;
    if(r.status!==409 && r.status!==422) throw new GhError(r.status);
  }
  throw new GhError(409);
}

let syncTimer=null, syncing=false, syncAgain=false, lastOk=0, lastErr=null;
function requestSync(delay=800){ clearTimeout(syncTimer); syncTimer=setTimeout(runSync, delay); }
async function runSync(){
  if(!connected()){ setStatus(); return; }
  if(syncing){ syncAgain=true; return; }
  syncing=true; setStatus("busy");
  try{
    S.dirty.meta=false; save();
    try{ await syncMeta(); }catch(e){ S.dirty.meta=true; throw e; }
    const days = [...new Set([...S.dirty.days, todayKey(), viewDate])];
    for(const k of days){
      S.dirty.days = S.dirty.days.filter(x=>x!==k); save();
      try{ await syncDay(k); }catch(e){ if(!S.dirty.days.includes(k)) S.dirty.days.push(k); throw e; }
    }
    lastOk=Date.now(); lastErr=null;
  }catch(e){ lastErr=e; }
  save(); syncing=false;
  if(!sheetState) render(); else setStatus();
  if(syncAgain){ syncAgain=false; requestSync(300); }
}
function pendingCount(){ return S.dirty.days.length + (S.dirty.meta?1:0); }
function setStatus(force){
  const b=$("syncBtn"), t=$("syncText"); let s, txt;
  if(!connected()){ s="off"; txt="연결 안 됨"; }
  else if(force==="busy"){ s="busy"; txt="저장 중…"; }
  else if(lastErr){
    if(lastErr instanceof GhError){ s="err"; txt = lastErr.status===401 ? "토큰 오류" : lastErr.status===403 ? "권한 오류" : lastErr.status===404 ? "저장소 확인" : "저장 오류"; }
    else { s="wait"; txt=`오프라인 · 대기 ${pendingCount()}건`; }
  }
  else if(pendingCount()){ s="wait"; txt=`대기 ${pendingCount()}건`; }
  else if(lastOk){ s="ok"; txt=`저장됨 ${hm(lastOk)}`; }
  else { s="busy"; txt="확인 중…"; }
  b.dataset.s=s; t.textContent=txt;
  $("connectBanner").hidden = connected();
}

/* ───────── 타임라인 (기록 + 자투리) ───────── */
function timeline(k){
  const day = getDay(k), isToday = k===todayKey();
  const ents = [...day.entries].sort(byStart);
  const items = []; let cur = day.dayStart ? toMin(day.dayStart) : null;
  for(const e of ents){
    const s=toMin(e.start);
    if(cur!==null && s-cur>=1) items.push({gap:true, s:cur, e:s});
    items.push({entry:e});
    const end = s+durOf(e); cur = cur===null ? end : Math.max(cur,end);
  }
  const running = isToday && S.running;
  let bound=null, live=false;
  if(day.dayEnd) bound=toMin(day.dayEnd);
  else if(running){ bound=toMin(hm(S.running.startMs)); live=true; }
  else if(isToday && (day.dayStart||ents.length)){ bound=nowMin(); live=true; }
  if(cur!==null && bound!==null && bound-cur>=1) items.push({gap:true, s:cur, e:bound, live: live && !running});
  if(running) items.push({running:true});
  return items;
}

/* ───────── 화면 ───────── */
function render(){
  const isToday = viewDate===todayKey(), day=getDay(viewDate);
  const d = new Date(viewDate+"T00:00:00");
  $("dateTitle").textContent = `${d.getMonth()+1}월 ${d.getDate()}일 (${WD[d.getDay()]})${isToday?" · 오늘":""}`;
  $("next").disabled = isToday;
  setStatus(syncing ? "busy" : undefined);

  $("dayStartVal").textContent = day.dayStart || "--:--";
  $("dayEndVal").textContent = day.dayEnd || "--:--";
  $("dayStartBtn").hidden = !isToday || !!day.dayStart;
  const endBtn=$("dayEndBtn");
  endBtn.hidden = !isToday || !day.dayStart;
  endBtn.textContent = day.dayEnd ? "다시 열기" : "지금 마침";

  renderTimer(isToday, day);

  const items = timeline(viewDate);
  let rec=0, gap=0, gaps10=0, longest=0; const byCat={};
  for(const it of items){
    if(it.entry){ const m=durOf(it.entry); rec+=m; byCat[it.entry.category]=(byCat[it.entry.category]||0)+m; }
    if(it.gap){ const m=it.e-it.s; gap+=m; if(m>=10) gaps10++; longest=Math.max(longest,m); }
  }
  if(isToday && S.running){ const m=(Date.now()-S.running.startMs)/60000; rec+=m; byCat["측정 중"]=(byCat["측정 중"]||0)+m; }
  const span = rec+gap;
  $("summary").innerHTML = `
    <div class="stat"><div class="lbl">기록한 시간</div><div class="val num">${fmtShort(rec)}</div></div>
    <div class="stat gapstat"><div class="lbl">자투리 시간</div><div class="val num">${fmtShort(gap)}</div></div>
    <div class="stat"><div class="lbl">자투리 비율</div><div class="val num">${span? Math.round(gap/span*100):0}%</div></div>`;
  const cats = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const col = c => c==="측정 중" ? "var(--danger)" : catColor(c);
  $("bar").innerHTML = span ? cats.map(([c,m])=>`<span style="width:${m/span*100}%;background:${col(c)}"></span>`).join("") + (gap?`<span class="g" style="width:${gap/span*100}%"></span>`:"") : "";
  $("legend").innerHTML = cats.map(([c,m])=>`<span><i style="background:${col(c)}"></i>${esc(c)} ${fmtDur(m)}</span>`).join("") + (gap?`<span><i style="background:var(--gap)"></i>자투리 ${fmtDur(gap)}</span>`:"");
  $("insight").innerHTML = gap>=1 ? `10분 이상 자투리 <b>${gaps10}회</b> · 가장 긴 공백 <b>${fmtDur(longest)}</b>` : "";

  const list = $("list");
  if(!items.length){ list.innerHTML = `<li class="empty-state">${isToday? "아래 순서로 기록해 보세요.<br>[▶ 시작] → 일하기 → [■ 종료] → 한 일 적기":"이 날은 기록이 없습니다."}</li>`; return; }
  list.innerHTML = items.map(it=>{
    if(it.gap) return `<li><div class="row gaprow"><div class="t num">${hmOf(it.s)}–${it.live?"지금":hmOf(it.e)}</div><div class="body"><div class="memo">자투리${it.live?" (진행 중)":""}</div></div><div class="d num">${fmtDur(it.e-it.s)}</div></div></li>`;
    if(it.running) return `<li><div class="row live"><div class="t num">${hm(S.running.startMs)}–</div><div class="body"><div class="memo"><span class="dot"></span>측정 중</div></div><div class="d num" data-live="1">${fmtDur((Date.now()-S.running.startMs)/60000)}</div></div></li>`;
    const e=it.entry;
    return `<li><button class="row" data-id="${e.id}"><div class="t num">${e.start}–${e.end}</div><div class="body"><div class="cat"><i style="background:${catColor(e.category)}"></i>${esc(e.category)}</div><div class="memo${e.memo?"":" empty"}">${e.memo?esc(e.memo):"한 일 미입력 · 눌러서 적기"}</div></div><div class="d num">${fmtDur(durOf(e))}</div></button></li>`;
  }).join("");
}

function renderTimer(isToday, day){
  const t=$("timer");
  if(!isToday){ t.innerHTML = `<div class="state">지난 날짜 보기</div><button class="bigbtn start" id="goToday">오늘로 이동</button>`; $("goToday").onclick=()=>{viewDate=todayKey();render();}; return; }
  if(S.running){
    t.innerHTML = `<div class="state"><span class="dot"></span>측정 중 · ${hm(S.running.startMs)} 시작</div>
      <div class="clock num" id="clock">${clockText()}</div>
      <button class="bigbtn stop" id="stopBtn"><svg viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" rx="2"/></svg>종료</button>`;
    $("stopBtn").onclick = stopTimer;
  } else {
    const ents = day.entries; let sub="";
    if(ents.length){ const last=Math.max(...ents.map(e=>toMin(e.start)+durOf(e))); const g=nowMin()-last; if(g>=1 && !day.dayEnd) sub=`마지막 기록 이후 <b>${fmtDur(g)}</b> 자투리 진행 중`; }
    else if(day.dayStart && !day.dayEnd){ const g=nowMin()-toMin(day.dayStart); if(g>=1) sub=`하루 시작 이후 <b>${fmtDur(g)}</b> 기록 없음`; }
    t.innerHTML = `<div class="state">대기 중</div><div class="clock num idle">00:00:00</div>
      <div class="sub">${sub}</div>
      <button class="bigbtn start" id="startBtn"><svg viewBox="0 0 20 20"><path d="M5 3.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 5 3.5z"/></svg>시작</button>`;
    $("startBtn").onclick = startTimer;
  }
}
function clockText(){ const s=Math.max(0,Math.floor((Date.now()-S.running.startMs)/1000)); return `${pad(Math.floor(s/3600))}:${pad(Math.floor(s/60)%60)}:${pad(s%60)}`; }

/* ───────── 측정 ───────── */
function startTimer(){
  const k=todayKey(), day=getDay(k);
  if(!day.dayStart || day.dayEnd) setDayTimes(k, {dayStart: day.dayStart || hm(Date.now()), dayEnd:null});
  S.running = {startMs: Date.now()}; S.runningAt = Date.now();
  markMeta(); render();
}
function stopTimer(){
  const startD = dkey(new Date(S.running.startMs));
  const start = startD===todayKey() ? hm(S.running.startMs) : "00:00";   // 자정을 넘긴 측정은 오늘 0시부터로 처리
  openSheet({mode:"new", start, end:hm(Date.now()), category:S.lastCat||S.categories[0], memo:""});
}

/* ───────── 기록 입력 시트 ───────── */
let sheetState=null, delArmed=false;
function showSheet(id){ $("backdrop").hidden=false; $(id).hidden=false; }
function openSheet(st){
  sheetState = st; delArmed=false;
  $("sheetTitle").textContent = st.mode==="new" ? "방금 한 일 기록" : "기록 수정";
  $("fStart").value = st.start; $("fEnd").value = st.end; $("fMemo").value = st.memo||"";
  $("err").textContent=""; $("addcat").hidden=true;
  renderChips(); updateDur();
  $("actions").innerHTML = st.mode==="new"
    ? `<button class="primary" id="saveBtn">저장</button><button class="sec" id="laterBtn">한 일은 나중에 적기</button><button class="sec" id="resumeBtn">취소 (측정 계속)</button>`
    : `<button class="primary" id="saveBtn">저장</button><button class="sec danger" id="delBtn">삭제</button><button class="sec" id="closeBtn">닫기</button>`;
  $("saveBtn").onclick = ()=>commit(false);
  if(st.mode==="new"){ $("laterBtn").onclick=()=>commit(true); $("resumeBtn").onclick=closeSheets; }
  else { $("closeBtn").onclick=closeSheets; $("delBtn").onclick=delEntry; }
  showSheet("sheet");
}
function closeSheets(){ $("backdrop").hidden=true; $("sheet").hidden=true; $("setSheet").hidden=true; sheetState=null; render(); }
function renderChips(){
  $("chips").innerHTML = S.categories.map(c=>`<button class="chip" aria-pressed="${c===sheetState.category}" data-cat="${esc(c)}"><i style="background:${catColor(c)}"></i>${esc(c)}</button>`).join("") + `<button class="chip add" id="addChip">+ 분류 추가</button>`;
  $("chips").querySelectorAll("[data-cat]").forEach(b=>b.onclick=()=>{ sheetState.category=b.dataset.cat; renderChips(); });
  $("addChip").onclick=()=>{ $("addcat").hidden=false; $("newCat").focus(); };
}
function updateDur(){
  const s=$("fStart").value, e=$("fEnd").value;
  if(!s||!e){ $("durline").textContent=""; return; }
  const d=toMin(e)-toMin(s);
  $("durline").textContent = d<0 ? "종료 시각이 시작 시각보다 빠릅니다." : `소요 시간 ${fmtDur(d)}`;
}
$("fStart").oninput=updateDur; $("fEnd").oninput=updateDur;
$("addCatBtn").onclick=()=>{
  const v=$("newCat").value.trim(); if(!v) return;
  if(!S.categories.includes(v)){ S.categories.push(v); S.catAt=Date.now(); markMeta(); }
  sheetState.category=v; $("newCat").value=""; $("addcat").hidden=true; renderChips();
};
function commit(later){
  const s=$("fStart").value, e=$("fEnd").value;
  if(!s||!e){ $("err").textContent="시작과 종료 시각을 모두 입력해 주세요."; return; }
  if(toMin(e)<toMin(s)){ $("err").textContent="종료 시각을 시작 시각 이후로 고쳐 주세요."; return; }
  const memo = later ? "" : $("fMemo").value.trim();
  const rec = {start:s, end:e, category:sheetState.category, memo, at:Date.now()};
  if(sheetState.mode==="new"){
    const k=todayKey(), day=ensureDay(k);
    day.entries.push({id:uid(), ...rec});
    if(!day.dayStart || toMin(s)<toMin(day.dayStart)){ day.dayStart=s; day.at=Date.now(); }
    S.running=null; S.runningAt=Date.now(); S.lastCat=rec.category;
    markDay(k); markMeta();
  } else {
    const day=ensureDay(viewDate); const x=day.entries.find(z=>z.id===sheetState.id);
    if(x) Object.assign(x, rec);
    markDay(viewDate);
  }
  closeSheets();
}
function delEntry(){
  if(!delArmed){ delArmed=true; $("delBtn").textContent="한 번 더 누르면 삭제"; return; }
  const day=ensureDay(viewDate);
  day.entries=day.entries.filter(z=>z.id!==sheetState.id);
  (day.deleted ||= []).push(sheetState.id);
  markDay(viewDate); closeSheets();
}

/* ───────── GitHub 설정 시트 ───────── */
let resetArmed=false;
function openSettings(){
  sheetState={mode:"settings"}; resetArmed=false;
  $("gOwner").value = G.owner || DEFAULT_OWNER;
  $("gRepo").value = G.repo || DEFAULT_REPO;
  $("gToken").value = ""; $("gToken").placeholder = G.token ? "저장되어 있음 (바꿀 때만 입력)" : "토큰을 붙여넣으세요";
  $("gErr").textContent=""; $("gOk").textContent = connected() ? `${G.owner}/${G.repo}에 연결되어 있습니다.` : "";
  $("gReset").textContent="연결 해제"; $("gReset").hidden = !connected(); $("gSync").hidden = !connected();
  showSheet("setSheet");
}
$("gSave").onclick = async ()=>{
  const owner=$("gOwner").value.trim(), repo=$("gRepo").value.trim(), token=$("gToken").value.trim() || G.token;
  $("gErr").textContent=""; $("gOk").textContent="";
  if(!owner||!repo||!token){ $("gErr").textContent="아이디, 저장소, 토큰을 모두 입력해 주세요."; return; }
  const prev=G; G={owner, repo, token};
  $("gSave").disabled=true; $("gOk").textContent="연결 확인 중…";
  try{
    const r = await gh("GET","");
    if(r.status===401) throw new Error("토큰이 올바르지 않거나 만료되었습니다. 새로 발급해 주세요.");
    if(r.status===404) throw new Error("저장소를 찾을 수 없습니다. 아이디·저장소 이름, 그리고 토큰에 이 저장소 권한을 주었는지 확인해 주세요.");
    if(!r.ok) throw new Error(`연결에 실패했습니다 (오류 ${r.status}).`);
    const j = await r.json();
    try{ localStorage.setItem(GKEY, JSON.stringify(G)); }catch(e){}
    lastErr=null; S.dirty.meta=true; for(const k of Object.keys(S.days)) if(!S.dirty.days.includes(k)) S.dirty.days.push(k); save();
    $("gOk").textContent = "연결되었습니다. 기록을 저장하는 중입니다…";
    if(!j.private) $("gErr").textContent = "주의: 이 저장소는 공개 상태입니다. GitHub 저장소 Settings에서 Private로 바꿔 주세요.";
    await runSync();
    if(lastErr){ $("gOk").textContent=""; $("gErr").textContent = lastErr.status===403 ? "읽기는 되지만 저장 권한이 없습니다. 토큰의 Contents 권한을 'Read and write'로 설정해 주세요." : "저장 중 오류가 났습니다. 잠시 후 '지금 동기화'를 눌러 주세요."; }
    else { $("gOk").textContent = `연결 완료 · ${G.owner}/${G.repo}에 저장됩니다.`; $("gReset").hidden=false; $("gSync").hidden=false; }
  }catch(e){
    G=prev; $("gOk").textContent="";
    $("gErr").textContent = e instanceof TypeError ? "인터넷 연결을 확인해 주세요." : e.message;
  }
  $("gSave").disabled=false; setStatus();
};
$("gSync").onclick = async ()=>{ $("gOk").textContent="동기화 중…"; await runSync(); $("gOk").textContent = lastErr ? "" : `동기화 완료 ${hm(Date.now())}`; if(lastErr) $("gErr").textContent="동기화에 실패했습니다. 인터넷 연결과 토큰을 확인해 주세요."; };
$("gReset").onclick = ()=>{
  if(!resetArmed){ resetArmed=true; $("gReset").textContent="한 번 더 누르면 해제"; return; }
  G={}; try{ localStorage.removeItem(GKEY); }catch(e){}
  lastOk=0; lastErr=null; closeSheets();
};
$("gClose").onclick = closeSheets;
$("syncBtn").onclick = openSettings;
$("connectBtn").onclick = openSettings;
$("settingsBtn").onclick = openSettings;

/* ───────── 기타 동작 ───────── */
$("backdrop").onclick=closeSheets;
document.addEventListener("keydown",e=>{ if(e.key==="Escape" && sheetState) closeSheets(); });
$("list").addEventListener("click",ev=>{
  const b=ev.target.closest("button[data-id]"); if(!b) return;
  const x=getDay(viewDate).entries.find(z=>z.id===b.dataset.id); if(!x) return;
  openSheet({mode:"edit", id:x.id, start:x.start, end:x.end, category:x.category, memo:x.memo});
});
$("dayStartBtn").onclick=()=>{ setDayTimes(todayKey(), {dayStart:hm(Date.now())}); render(); };
$("dayEndBtn").onclick=()=>{
  const k=todayKey(), day=getDay(k);
  if(day.dayEnd) setDayTimes(k, {dayEnd:null});
  else { if(S.running){ stopTimer(); return; } setDayTimes(k, {dayEnd:hm(Date.now())}); }
  render();
};
function go(delta){ const d=new Date(viewDate+"T00:00:00"); d.setDate(d.getDate()+delta); const k=dkey(d); if(k<=todayKey()){ viewDate=k; render(); requestSync(200); } }
$("prev").onclick=()=>go(-1);
$("next").onclick=()=>go(1);

$("copyBtn").onclick=()=>{
  const day=getDay(viewDate);
  const data = JSON.stringify({date:viewDate, dayStart:day.dayStart, dayEnd:day.dayEnd,
    entries:[...day.entries].sort(byStart).map(({start,end,category,memo})=>({start,end,category,memo}))}, null, 1);
  const box=$("copybox"); box.value=data;
  const fallback=()=>{ box.hidden=false; box.focus(); box.select(); $("copyBtn").textContent="아래 내용을 길게 눌러 복사하세요"; };
  try{
    navigator.clipboard.writeText(data).then(()=>{ $("copyBtn").textContent="복사됨 · Claude 채팅에 붙여넣으세요"; setTimeout(()=>$("copyBtn").textContent="이 날 기록 복사 (Claude 분석용)",2500); }, fallback);
  }catch(e){ fallback(); }
};

setInterval(()=>{
  if(S.running && viewDate===todayKey()){
    const c=$("clock"); if(c) c.textContent=clockText();
    const l=document.querySelector("[data-live]"); if(l) l.textContent=fmtDur((Date.now()-S.running.startMs)/60000);
  }
},1000);
setInterval(()=>{ if(!sheetState) render(); },30000);
setInterval(()=>{ if(!document.hidden) requestSync(0); },120000);
document.addEventListener("visibilitychange",()=>{ if(!document.hidden){ if(!sheetState) render(); requestSync(0); } });
window.addEventListener("online",()=>requestSync(0));

if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
render();
requestSync(0);
