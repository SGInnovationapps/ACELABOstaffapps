// ============================================================
// ACELABO 講師アプリ - app.js
// version 2.2.0 (パフォーマンス最適化版)
//
// 【2.1.0 からの主な変更】
//   1. 起動時のAPI呼び出しを 9往復 → 1往復（bootstrap）
//   2. 生徒選択時の呼び出しを 2往復 → 1往復（selectStudent）
//   3. 写真を送信前に自動縮小（3〜8MB → 200KB前後）
//   4. 読み取り系APIのみタイムアウト＋1回リトライ
// ============================================================

// ── トークン管理 ──────────────────────────────────────────
const TOKEN_KEY = 'acl_token';
function getToken(){ try{ return localStorage.getItem(TOKEN_KEY)||''; }catch(e){ return ''; } }
function setToken(t){ try{ if(t) localStorage.setItem(TOKEN_KEY,t); }catch(e){} }
function clearAuth(){
  try{
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('acl_email');
    localStorage.removeItem('acl_name');
  }catch(e){}
}

function handleAuthExpired(message){
  clearAuth();
  S.name=''; S.email='';
  const ls=document.getElementById('loginScreen');
  const app=document.getElementById('app');
  const loading=document.getElementById('loading');
  if(loading) loading.classList.add('hidden');
  if(app) app.classList.add('hidden');
  if(ls) ls.classList.remove('hidden');
  const errEl=document.getElementById('loginErr');
  if(errEl) errEl.textContent = message || 'セッションが切れました。再度ログインしてください。';
}

// ── GAS Web API 通信 ──────────────────────────────────────
// 読み取り専用API（失敗時に安全に再試行できるもの）
const READONLY_FNS = [
  'bootstrap','selectStudent','getStudents','getTodayReport','getReports',
  'getReportsByStudent','getAttendance','getShifts','getSchedule',
  'getConfirmedShifts','getTestConfig','getTestScores','loginWithEmail'
];
const REQ_TIMEOUT_MS = 60000;

async function run(fn,...args){
  if(!window.CONFIG || !CONFIG.API_URL || CONFIG.API_URL.includes('YOUR_GAS_URL')){
    throw new Error('API URLが未設定です。config.js を確認してください');
  }
  const retriable = READONLY_FNS.indexOf(fn) >= 0;
  const attempts = retriable ? 2 : 1;
  let lastErr;
  for(let i=0; i<attempts; i++){
    try{
      return await _post(fn,args);
    }catch(e){
      lastErr = e;
      if(e && e.__auth) throw e;              // 認証エラーは再試行しない
      if(i < attempts-1) await _sleep(700);   // 一時的な輻輳を吸収
    }
  }
  throw lastErr;
}

function _sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function _post(fn,args){
  const body = JSON.stringify({ fn, args, token: getToken() });
  const ctrl = (typeof AbortController!=='undefined') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(()=>ctrl.abort(), REQ_TIMEOUT_MS) : null;
  let resp;
  try{
    resp = await fetch(CONFIG.API_URL, {
      method: 'POST',
      mode: 'cors',
      // GAS の CORS 制約回避のため text/plain で送信（プリフライトを起こさない）
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    });
  }catch(networkErr){
    if(networkErr && networkErr.name === 'AbortError'){
      throw new Error('通信がタイムアウトしました。電波状況を確認して再試行してください');
    }
    throw new Error('通信エラー: ' + (networkErr.message||networkErr));
  }finally{
    if(timer) clearTimeout(timer);
  }
  if(!resp.ok){
    throw new Error('サーバーエラー (HTTP ' + resp.status + ')');
  }
  let data;
  try{ data = await resp.json(); }
  catch(parseErr){ throw new Error('レスポンス解析エラー'); }
  if(data && data.ok === false){
    if(data.code === 'AUTH'){
      handleAuthExpired(data.error);
      const err = new Error(data.error || 'ログインが必要です');
      err.__auth = true;
      throw err;
    }
    throw new Error(data.error || '不明なエラー');
  }
  return data && Object.prototype.hasOwnProperty.call(data,'result') ? data.result : data;
}

// ── State ─────────────────────────────────────────────────
const S={
  name:'',email:'',
  students:[],shifts:[],schedule:{},confirmedShifts:{},
  calY:new Date().getFullYear(),calM:new Date().getMonth(),selDate:null,
  editing:false,
  existingPhotoUrl:'',
  testConfig:null,
  studentScores:[],
  isTestTarget:false,
  gradeChart:null
};

// ── ログイン ──────────────────────────────────────────────
async function doLogin(){
  const email=document.getElementById('loginEmail').value.trim();
  const errEl=document.getElementById('loginErr');
  const btn=document.getElementById('loginBtn');
  errEl.textContent='';
  if(!email){errEl.textContent='メールアドレスを入力してください';return;}
  btn.disabled=true; btn.textContent='確認中...';
  try{
    // ★ ログイン検証と初期データ取得を1往復で行う
    const b=await run('bootstrap',email);
    setToken(b.info.token);
    try{
      localStorage.setItem('acl_email',b.info.email);
      localStorage.setItem('acl_name',b.info.name);
    }catch(e){}
    startApp(b);
  }catch(e){
    errEl.textContent=e.message;
  }finally{
    btn.disabled=false; btn.textContent='ログイン';
  }
}

// ── 起動 ──────────────────────────────────────────────────
window.addEventListener('load',async()=>{
  let em='',tk='';
  try{
    em=localStorage.getItem('acl_email')||'';
    tk=getToken();
  }catch(e){}
  if(!em||!tk) return;

  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('loading').classList.remove('hidden');
  try{
    // ★ 検証用の追加リクエストは廃止。bootstrap 1回で完結する
    const b=await run('bootstrap',em);
    setToken(b.info.token);   // トークンを更新（有効期限を延長）
    try{ localStorage.setItem('acl_name',b.info.name); }catch(e){}
    startApp(b);
  }catch(e){
    clearAuth();
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    const errEl=document.getElementById('loginErr');
    if(errEl) errEl.textContent=e.message||'';
  }
});

// bootstrap の結果を受け取って画面を組み立てる（API呼び出しなし）
function startApp(b){
  S.email=b.info.email; S.name=b.info.name;
  document.getElementById('hdrName').textContent=S.name;
  document.getElementById('hdrEmail').textContent=S.email;
  document.getElementById('repTeacher').textContent=S.name;
  document.getElementById('loginScreen').classList.add('hidden');

  S.students        = b.students   || [];
  S.schedule        = b.schedule   || {};
  S.confirmedShifts = b.confirmed  || {};
  S.testConfig      = b.testConfig || null;
  S.shifts          = b.shifts     || [];

  renderStudentOptions();
  applyTestConfig();
  renderAttendance(b.attendance || []);
  renderReports(b.reports || []);
  renderShifts();
  renderCal();
  updShfBtn();

  document.getElementById('loading').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function jstToday(){
  return new Date(Date.now()+9*3600*1000).toISOString().slice(0,10).replace(/-/g,'/');
}

// ── 出退勤 ────────────────────────────────────────────────
function renderAttendance(recs){
  renderTodayStatus(recs);
  renderAttHistory(recs);
}
async function refreshAttendance(){
  renderAttendance(await run('getAttendance',S.name));
}
function renderTodayStatus(recs){
  const today=jstToday();
  resetSV('sIn'); resetSV('sOut'); resetSV('sFee');
  const rec=(recs||[]).find(r=>String(r.date).replace(/-/g,'/')===today);
  if(!rec) return;
  setSV('sIn',rec.clockIn); setSV('sOut',rec.clockOut);
  if(rec.fee!==''&&rec.fee!==undefined){
    const el=document.getElementById('sFee');
    el.textContent='¥'+Number(rec.fee).toLocaleString();
    el.classList.add('ok');
  }
}
function resetSV(id){
  const el=document.getElementById(id);
  if(!el) return;
  el.textContent='—'; el.classList.remove('ok');
}
function setSV(id,val){
  const el=document.getElementById(id);
  if(!el||!val) return;
  el.textContent = String(val).includes(':') ? String(val).slice(0,5) : String(val);
  el.classList.add('ok');
}
async function doClock(type){
  try{
    const r=await run(type==='in'?'clockIn':'clockOut',S.name);
    setSV(type==='in'?'sIn':'sOut',r.time);
    toast((type==='in'?'出勤':'退勤')+'打刻しました: '+r.time,'ok');
    await refreshAttendance();
  }catch(e){toast(e.message,'ng');}
}
async function saveFee(){
  const v=parseInt(document.getElementById('feeInput').value);
  if(!v||v<0){toast('交通費を入力してください','ng');return;}
  try{
    await run('addTransportFee',S.name,v);
    const el=document.getElementById('sFee');
    el.textContent='¥'+v.toLocaleString(); el.classList.add('ok');
    document.getElementById('feeInput').value='';
    toast('交通費を保存しました','ok');
  }catch(e){toast(e.message,'ng');}
}
function renderAttHistory(recs){
  const el=document.getElementById('attList');
  if(!recs||!recs.length){el.innerHTML=emptyHTML('📋','記録がありません');return;}
  el.innerHTML='<div class="rlist">'+recs.map(r=>`
    <div class="ritem">
      <div>
        <div class="ritem-main">${esc(r.date)}</div>
        <div class="ritem-sub">${r.clockIn?'出勤 '+esc(r.clockIn.slice(0,5)):'—'}${r.clockOut?' → 退勤 '+esc(r.clockOut.slice(0,5)):''}</div>
      </div>
      <div class="ritem-right">${r.fee!==''?'¥'+Number(r.fee).toLocaleString():'—'}</div>
    </div>`).join('')+'</div>';
}

function toggleManual(){
  const form=document.getElementById('manForm'),arr=document.getElementById('manArrow');
  const opening=form.classList.toggle('hidden');
  arr.textContent=opening?'▼':'▲';
  arr.classList.toggle('open',!opening);
  if(!opening){
    document.getElementById('manDate').value=new Date(Date.now()+9*3600*1000).toISOString().slice(0,10);
  }
}
async function submitManual(){
  const date=document.getElementById('manDate').value;
  const inT=document.getElementById('manIn').value;
  const outT=document.getElementById('manOut').value;
  if(!date){toast('日付を入力してください','ng');return;}
  if(!inT&&!outT){toast('時刻を入力してください','ng');return;}
  try{
    const r=await run('addManualAttendance',S.name,date,inT,outT);
    toast(r.updated?'記録を更新しました':'打ち忘れを追加しました','ok');
    document.getElementById('manDate').value='';
    document.getElementById('manIn').value='';
    document.getElementById('manOut').value='';
    document.getElementById('manForm').classList.add('hidden');
    document.getElementById('manArrow').textContent='▼';
    document.getElementById('manArrow').classList.remove('open');
    await refreshAttendance();
  }catch(e){toast(e.message,'ng');}
}

// ── 指導報告 ──────────────────────────────────────────────
function renderStudentOptions(){
  const opts='<option value="">— 生徒を選択 —</option>'+
    S.students.map(s=>`<option value="${esc(s.name)}">${esc(s.name)}（${esc(s.grade)}）</option>`).join('');
  document.getElementById('stuSel').innerHTML=opts;
  document.getElementById('hisStuSel').innerHTML=opts;
}

async function onStudentChange(){
  const name=document.getElementById('stuSel').value;
  const card=document.getElementById('stuInfo');
  const sel=document.getElementById('stuSel');

  // リセット
  S.editing=false;
  S.existingPhotoUrl='';
  document.getElementById('editModeBadge').classList.add('hidden');
  document.getElementById('existingPhotoNote').classList.add('hidden');
  document.getElementById('existingPhotoNote').innerHTML='';
  document.getElementById('repBtn').textContent='報告を提出';
  resetRSub();

  if(!name){
    card.classList.remove('on');
    document.getElementById('rsubBar').classList.add('hidden');
    return;
  }
  const s=S.students.find(x=>x.name===name);
  if(!s) return;

  document.getElementById('stuInfoName').textContent=s.name;
  let tagsHtml = `<span class="stu-tag">📆 ${esc(s.plan)}</span>`;
  if(s.note) tagsHtml += `<div class="stu-note">${esc(s.note)}</div>`;
  document.getElementById('stuInfoTags').innerHTML = tagsHtml;

  const mats = (s.materials||'').split(',').map(m=>m.trim()).filter(Boolean);
  document.getElementById('materialChecks').innerHTML = mats.map((m,i)=>`
    <label class="mat-check-label">
      <input type="checkbox" class="mat-check" value="${esc(m)}" id="mat${i}">
      <span class="mat-check-text">${esc(m)}</span>
    </label>`).join('');
  document.getElementById('materialSection').style.display = mats.length ? 'block' : 'none';

  const hws = (s.homework||'').split(',').map(h=>h.trim()).filter(Boolean);
  document.getElementById('homeworkChecks').innerHTML = hws.map((h,i)=>`
    <label class="mat-check-label">
      <input type="checkbox" class="mat-check hw-check" value="${esc(h)}" id="hw${i}">
      <span class="mat-check-text">${esc(h)}</span>
    </label>`).join('');
  document.getElementById('homeworkSection').style.display = hws.length ? 'block' : 'none';
  card.classList.add('on');

  removePhoto(null);
  document.getElementById('repNote').value='';

  // ★ 当日報告 + 成績を1往復で取得
  sel.disabled = true;
  let data = null;
  try{
    data = await run('selectStudent', name);
  }catch(e){
    console.warn('生徒データ取得エラー:', e);
    toast('データの取得に失敗しました','ng');
  }finally{
    sel.disabled = false;
  }
  // 取得中に別の生徒へ切り替えられていたら破棄
  if(document.getElementById('stuSel').value !== name) return;

  applyTodayReport(data && data.today);
  applyStudentGrades(name, (data && data.scores) || []);
}

function applyTodayReport(existing){
  if(!existing) return;
  S.editing = true;
  S.existingPhotoUrl = existing.photoUrl || '';
  const matSet = {};
  (existing.materials||[]).forEach(m=>matSet[m]=1);
  document.querySelectorAll('#materialChecks .mat-check').forEach(c=>{
    if(matSet[c.value]) c.checked = true;
  });
  const hwSet = {};
  (existing.homework||[]).forEach(h=>hwSet[h]=1);
  document.querySelectorAll('#homeworkChecks .hw-check').forEach(c=>{
    if(hwSet[c.value]) c.checked = true;
  });
  document.getElementById('repNote').value = existing.note || '';
  if(existing.photoUrl){
    const note = document.getElementById('existingPhotoNote');
    note.innerHTML = `📂 既存の写真あり <a href="${esc(existing.photoUrl)}" target="_blank">ドライブで確認</a><br>新しい写真を撮影すると上書きされます`;
    note.classList.remove('hidden');
  }
  const editBadge = document.getElementById('editModeBadge');
  editBadge.textContent = (existing.teacherName && existing.teacherName !== S.name)
    ? `✏ ${existing.teacherName}の記録を編集`
    : '✏ 本日分を編集';
  editBadge.classList.remove('hidden');
  document.getElementById('repBtn').textContent='報告を更新';
}

// ── 写真（送信前に自動縮小） ──────────────────────────────
let photoB64=null,photoMime='image/jpeg',photoUrl=null;

function triggerCam(){document.getElementById('photoInput').click();}

// スマホのカメラ写真は3〜8MB。Base64化で約1.33倍になり、
// そのまま送るとタイムアウトの主因になるため縮小してから送る。
function shrinkImage(file, maxW, quality){
  maxW = maxW || 1280; quality = quality || 0.75;
  return new Promise((resolve,reject)=>{
    const rd=new FileReader();
    rd.onerror=()=>reject(new Error('画像を読み込めませんでした'));
    rd.onload=ev=>{
      const img=new Image();
      img.onerror=()=>reject(new Error('画像を解析できませんでした'));
      img.onload=()=>{
        try{
          const sc=Math.min(1, maxW/img.width);
          const c=document.createElement('canvas');
          c.width =Math.max(1, Math.round(img.width *sc));
          c.height=Math.max(1, Math.round(img.height*sc));
          const g=c.getContext('2d');
          g.fillStyle='#fff'; g.fillRect(0,0,c.width,c.height);
          g.drawImage(img,0,0,c.width,c.height);
          resolve(c.toDataURL('image/jpeg', quality));
        }catch(err){
          resolve(ev.target.result);   // 失敗時は原寸で続行
        }
      };
      img.src=ev.target.result;
    };
    rd.readAsDataURL(file);
  });
}

async function onPhotoSel(e){
  const f=e.target.files[0];
  if(!f) return;
  photoUrl=null;
  document.getElementById('dLink').innerHTML='';
  try{
    photoB64 = await shrinkImage(f, 1280, 0.75);
    photoMime = 'image/jpeg';
  }catch(err){
    toast('写真の処理に失敗しました','ng');
    return;
  }
  const pv=document.getElementById('photoPV');
  pv.src=photoB64; pv.classList.remove('hidden');
  document.getElementById('photoRM').classList.remove('hidden');
  const pa=document.getElementById('photoArea');
  pa.classList.add('has-photo'); pa.style.padding='0';
  document.getElementById('photoPH').classList.add('hidden');
}

function removePhoto(e){
  if(e)e.stopPropagation();
  photoB64=null; photoUrl=null; photoMime='image/jpeg';
  const inp=document.getElementById('photoInput');
  if(inp) inp.value='';
  const pv=document.getElementById('photoPV');pv.classList.add('hidden');pv.src='';
  document.getElementById('photoRM').classList.add('hidden');
  const pa=document.getElementById('photoArea');
  pa.classList.remove('has-photo');pa.style.padding='';
  document.getElementById('photoPH').classList.remove('hidden');
  const prog=document.getElementById('upProg');
  prog.classList.add('hidden');
  document.getElementById('upBar').style.background='';
  document.getElementById('upBar').style.width='0';
  document.getElementById('dLink').innerHTML='';
}

async function uploadPhoto(sName){
  if(!photoB64)return null;
  if(photoUrl)return photoUrl;
  const prog=document.getElementById('upProg'),bar=document.getElementById('upBar'),txt=document.getElementById('upTxt');
  prog.classList.remove('hidden');txt.textContent='アップロード中...';
  let p=0;const tk=setInterval(()=>{p=Math.min(p+7,85);bar.style.width=p+'%';},200);
  try{
    const b64=photoB64.split(',')[1];
    const fn=`指導報告_${sName}_${new Date().toISOString().slice(0,16).replace(/[-T:]/g,'')}.jpg`;
    const r=await run('uploadPhotoToDrive',b64,photoMime,fn,sName);
    clearInterval(tk);bar.style.width='100%';txt.textContent='アップロード完了';
    photoUrl=r.fileUrl;
    document.getElementById('dLink').innerHTML=`<a href="${esc(r.fileUrl)}" target="_blank">📂 ドライブで確認</a>`;
    return r.fileUrl;
  }catch(err){
    clearInterval(tk);bar.style.background='var(--ng)';txt.textContent='失敗: '+err.message;
    return null;
  }
}

async function submitReport(){
  const sName=document.getElementById('stuSel').value;
  if(!sName){toast('生徒を選択してください','ng');return;}
  const btn=document.getElementById('repBtn');
  const wasEditing = S.editing;
  btn.disabled=true;btn.innerHTML='<span class="sp"></span> 送信中...';
  try{
    const pu=photoB64?await uploadPhoto(sName):null;
    const note=document.getElementById('repNote').value;
    const checked=Array.from(document.querySelectorAll('.mat-check:not(.hw-check):checked')).map(c=>c.value);
    const hwChecked=Array.from(document.querySelectorAll('.hw-check:checked')).map(c=>c.value);
    const photoForServer = pu || S.existingPhotoUrl || '';
    const result = await run('addReport',S.name,sName,checked,hwChecked,note,photoForServer);

    document.getElementById('repNote').value='';
    document.getElementById('stuSel').value='';
    document.getElementById('stuInfo').classList.remove('on');
    document.getElementById('rsubBar').classList.add('hidden');
    document.getElementById('materialSection').style.display='none';
    document.getElementById('homeworkSection').style.display='none';
    document.querySelectorAll('.mat-check').forEach(c=>c.checked=false);
    document.getElementById('editModeBadge').classList.add('hidden');
    document.getElementById('existingPhotoNote').classList.add('hidden');
    document.getElementById('existingPhotoNote').innerHTML='';
    S.editing=false; S.existingPhotoUrl='';
    removePhoto(null);
    resetRSub();
    toast(result&&result.updated ? '本日の報告を更新しました' : '指導報告を提出しました','ok');
    renderReports(await run('getReports',S.name));
  }catch(e){
    toast(e.message,'ng');
  }finally{
    btn.disabled=false;
    btn.textContent = document.getElementById('stuSel').value
      ? (wasEditing?'報告を更新':'報告を提出')
      : '報告を提出';
  }
}

function renderReports(recs){
  const el=document.getElementById('repList');
  if(!recs||!recs.length){el.innerHTML=emptyHTML('📝','本日の報告はありません');return;}
  el.innerHTML='<div class="rlist">'+recs.map(r=>{
    const link=r.photoUrl?` <a href="${esc(r.photoUrl)}" target="_blank" style="font-size:18px;color:var(--ok)">📂</a>`:'';
    const mats=r.materials?`<div class="ritem-sub" style="color:var(--acc)">✔ ${esc(r.materials)}</div>`:'';
    const hws=r.homework?`<div class="ritem-sub" style="color:#8b5cf6">📚 ${esc(r.homework)}</div>`:'';
    const ts=String(r.timestamp||'').slice(0,16);
    return `<div class="ritem"><div>
      <div class="ritem-main">${esc(r.studentName)}${link}</div>
      ${mats}${hws}
      <div class="ritem-sub">${esc(ts)}${r.note?' — '+esc(r.note.slice(0,24)):''}</div>
    </div></div>`;
  }).join('')+'</div>';
}

// ============================================================
// ★★★ 成績（定期テスト）機能 ★★★
// ============================================================
function applyTestConfig(){
  if(!S.testConfig) return;
  const tnSel = document.getElementById('gfTestName');
  tnSel.innerHTML = '<option value="">— 選択 —</option>' +
    S.testConfig.testNames.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');
  const subSel = document.getElementById('gfSubject');
  subSel.innerHTML = '<option value="">— 選択 —</option>' +
    S.testConfig.subjects.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
}

function switchRSub(id, el){
  document.querySelectorAll('.rsub').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.rsub-content').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('rsub-'+id).classList.add('on');
  if(id==='grade' && S.isTestTarget){
    setTimeout(()=>renderGradeChart(), 60);
  }
}
function resetRSub(){
  document.querySelectorAll('.rsub').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.rsub-content').forEach(t=>t.classList.remove('on'));
  const repBtn = document.querySelector('.rsub[data-rsub="rep"]');
  if(repBtn) repBtn.classList.add('on');
  document.getElementById('rsub-rep').classList.add('on');
  closeGradeForm();
}

// selectStudent で取得済みのスコアを反映（API呼び出しなし）
function applyStudentGrades(studentName, scores){
  const rsubBar = document.getElementById('rsubBar');
  if(!S.testConfig){
    S.isTestTarget=false; S.studentScores=[];
    rsubBar.classList.add('hidden');
    return;
  }
  const testStudent = S.testConfig.students.find(s=>s.name===studentName);
  S.isTestTarget = !!testStudent;

  if(!S.isTestTarget){
    rsubBar.classList.add('hidden');
    resetRSub();
    S.studentScores = [];
    return;
  }
  rsubBar.classList.remove('hidden');
  document.getElementById('gradeMain').classList.remove('hidden');
  document.getElementById('gfStudentId').textContent = testStudent.id;
  document.getElementById('gfGrade').textContent = testStudent.grade;

  S.studentScores = scores || [];
  updateGradeSummary();
  renderGradeTable();
  if(document.getElementById('rsub-grade').classList.contains('on')){
    setTimeout(()=>renderGradeChart(), 60);
  }
}

function updateGradeSummary(){
  const scores = S.studentScores || [];
  const summary = document.getElementById('gradeSummary');
  document.getElementById('gradeCount').textContent = scores.length;
  const sumEl = document.getElementById('gradeSumLatest');
  const avgEl = document.getElementById('gradeAvgLatest');
  const lblEl = document.getElementById('gradeLatestLbl');
  if(!scores.length){
    summary.classList.add('hidden');
    sumEl.textContent='—'; avgEl.textContent='—'; lblEl.textContent='最新テスト';
    return;
  }
  summary.classList.remove('hidden');
  const testOrder = (S.testConfig && S.testConfig.testNames) || [];
  let latestTest = null;
  for(let i=testOrder.length-1; i>=0; i--){
    if(scores.some(s=>s.testName===testOrder[i])){ latestTest = testOrder[i]; break; }
  }
  if(latestTest){
    lblEl.textContent = latestTest;
    const latestScores = scores.filter(s=>s.testName===latestTest && typeof s.score==='number');
    if(latestScores.length){
      const total = latestScores.reduce((a,b)=>a+b.score,0);
      sumEl.textContent = total;
      avgEl.textContent = (total/latestScores.length).toFixed(1);
    }else{
      sumEl.textContent='—'; avgEl.textContent='—';
    }
  }else{
    lblEl.textContent='最新テスト'; sumEl.textContent='—'; avgEl.textContent='—';
  }
}

function renderGradeTable(){
  const table = document.getElementById('gradeTable');
  const wrap  = document.getElementById('gradeTableWrap');
  if(!table || !S.testConfig) return;
  const tests    = S.testConfig.testNames;
  const subjects = S.testConfig.subjects;
  const scores   = S.studentScores || [];

  if(!scores.length){
    wrap.classList.add('hidden');
    table.innerHTML='';
    return;
  }
  wrap.classList.remove('hidden');

  const get = (subj, test) => {
    const r = scores.find(s=>s.subject===subj && s.testName===test);
    return (r && typeof r.score==='number') ? r.score : null;
  };

  let html = '<thead><tr><th class="gt-subj">教科</th>' +
    tests.map(t=>`<th>${esc(t)}</th>`).join('') + '</tr></thead><tbody>';

  subjects.forEach(subj=>{
    html += `<tr><th class="gt-subj">${esc(subj)}</th>`;
    tests.forEach(t=>{
      const v = get(subj, t);
      html += (v===null) ? '<td class="gt-empty">−</td>' : `<td class="gt-score">${v}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody>';

  let sumRow = '<tr><td class="gt-foot-lbl">合計</td>';
  let avgRow = '<tr><td class="gt-foot-lbl">平均</td>';
  tests.forEach(t=>{
    const vals = subjects.map(s=>get(s,t)).filter(v=>v!==null);
    if(vals.length){
      const total = vals.reduce((a,b)=>a+b,0);
      sumRow += `<td class="gt-sum">${total}</td>`;
      avgRow += `<td class="gt-avg">${(total/vals.length).toFixed(1)}</td>`;
    }else{
      sumRow += '<td class="gt-empty">−</td>';
      avgRow += '<td class="gt-empty">−</td>';
    }
  });
  sumRow += '</tr>';
  avgRow += '</tr>';
  html += `<tfoot>${sumRow}${avgRow}</tfoot>`;

  table.innerHTML = html;
}

const SUBJECT_COLORS = {
  '英語':'#e94560','数学':'#1d9e75','国語':'#378add',
  '理科':'#ef9f27','社会':'#7f77dd'
};
const FALLBACK_COLORS = ['#e94560','#1d9e75','#378add','#ef9f27','#7f77dd','#d4537e','#888780','#0a5c36'];

function renderGradeChart(){
  const ctx = document.getElementById('gradeChart');
  if(!ctx || !S.testConfig) return;
  if(typeof Chart==='undefined'){ console.warn('Chart.js未ロード'); return; }

  const labels   = S.testConfig.testNames;
  const subjects = S.testConfig.subjects;
  const scores   = S.studentScores || [];
  document.getElementById('gradeNoData').classList.toggle('hidden', scores.length>0);

  const datasets = subjects.map((subj, i) => {
    const color = SUBJECT_COLORS[subj] || FALLBACK_COLORS[i % FALLBACK_COLORS.length];
    return {
      label: subj,
      data: labels.map(t=>{
        const r = scores.find(s=>s.subject===subj && s.testName===t);
        return r ? r.score : null;
      }),
      borderColor: color, backgroundColor: color,
      tension: 0.25, spanGaps: true, borderWidth: 2.5,
      pointRadius: 4, pointHoverRadius: 6
    };
  });

  if(S.gradeChart){ S.gradeChart.destroy(); S.gradeChart = null; }
  S.gradeChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { min:0, max:100,
             ticks:{stepSize:20,font:{size:12},color:'#5f5e5a'},
             grid:{color:'rgba(0,0,0,0.06)'} },
        x: { ticks:{font:{size:12},color:'#5f5e5a',autoSkip:false,maxRotation:0},
             grid:{display:false} }
      },
      plugins: {
        legend:{position:'bottom',labels:{font:{size:13},boxWidth:14,padding:10,color:'#1c1c1e'}},
        tooltip:{titleFont:{size:13},bodyFont:{size:13},padding:10}
      }
    }
  });
}

function toggleGradeForm(){
  const form = document.getElementById('gradeForm');
  const btn  = document.getElementById('gradeEntryToggle');
  if(form.classList.contains('hidden')){
    form.classList.remove('hidden');
    btn.textContent='✕ キャンセル';
    btn.classList.remove('bp'); btn.classList.add('bs');
  }else{
    closeGradeForm();
  }
}
function closeGradeForm(){
  const form = document.getElementById('gradeForm');
  const btn  = document.getElementById('gradeEntryToggle');
  form.classList.add('hidden');
  btn.textContent='＋ 成績入力';
  btn.classList.remove('bs'); btn.classList.add('bp');
  document.getElementById('gfTestName').value='';
  document.getElementById('gfSubject').value='';
  document.getElementById('gfScore').value='';
}

async function submitGrade(){
  const studentName = document.getElementById('stuSel').value;
  if(!studentName){ toast('生徒を選択してください','ng'); return; }
  if(!S.testConfig){ toast('設定が読込めていません','ng'); return; }
  const testStudent = S.testConfig.students.find(s=>s.name===studentName);
  if(!testStudent){ toast('この生徒は対象外です','ng'); return; }

  const testName = document.getElementById('gfTestName').value;
  const subject  = document.getElementById('gfSubject').value;
  const scoreRaw = document.getElementById('gfScore').value;

  if(!testName){ toast('テスト名を選択してください','ng'); return; }
  if(!subject){  toast('教科を選択してください','ng'); return; }
  if(scoreRaw===''||scoreRaw===null){ toast('得点を入力してください','ng'); return; }
  const score = Number(scoreRaw);
  if(isNaN(score)||score<0||score>100){ toast('得点は0〜100の数値で入力してください','ng'); return; }

  const btn = document.getElementById('gradeSaveBtn');
  btn.disabled = true; btn.innerHTML = '<span class="sp"></span> 保存中...';
  try{
    const r = await run('addTestScore',
      testStudent.id, testStudent.name, testStudent.grade, testName, subject, score);
    toast(r.updated ? '得点を更新しました' : '得点を記録しました', 'ok');
    closeGradeForm();
    // ローカル状態を更新（再取得の往復を省く）
    const idx = S.studentScores.findIndex(s=>s.testName===testName && s.subject===subject);
    if(idx>=0){ S.studentScores[idx].score = score; }
    else{
      S.studentScores.push({
        studentId:testStudent.id, studentName:testStudent.name, grade:testStudent.grade,
        testName:testName, subject:subject, score:score
      });
    }
    updateGradeSummary();
    renderGradeTable();
    renderGradeChart();
  }catch(e){
    toast(e.message,'ng');
  }finally{
    btn.disabled = false; btn.textContent = '保存する';
  }
}

// ── シフト ────────────────────────────────────────────────
function switchSubtab(id,el){
  document.querySelectorAll('.subtab').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.subtab-content').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('subtab-'+id+'-content').classList.add('on');
  if(id==='conf') renderCalConf();
}

let confY=new Date().getFullYear(), confM=new Date().getMonth();
function mvMonthConf(d){
  confM+=d;
  if(confM>11){confM=0;confY++;}
  if(confM<0){confM=11;confY--;}
  renderCalConf();
}
function renderCalConf(){
  const y=confY,m=confM;
  document.getElementById('calTitleConf').textContent=y+'年 '+(m+1)+'月';
  const first=new Date(y,m,1).getDay(),days=new Date(y,m+1,0).getDate();
  const today=new Date();
  const myLast=(S.name||'').split(/[\s　]/)[0];
  let h=['日','月','火','水','木','金','土'].map(d=>`<div class="cal-head">${d}</div>`).join('');
  for(let i=0;i<first;i++)h+='<div class="cal-day ce"></div>';
  for(let d=1;d<=days;d++){
    const dt=new Date(y,m,d);
    const ds=y+'/'+String(m+1).padStart(2,'0')+'/'+String(d).padStart(2,'0');
    const isT=dt.toDateString()===today.toDateString();
    const isP=dt<new Date(today.toDateString());
    const names=S.confirmedShifts[ds]||[];
    const isMine=names.indexOf(myLast)>=0;
    let c='cal-day';
    if(isP)c+=' cp'; else if(isT)c+=' ct';
    if(isMine)c+=' conf-mine';
    const nameLabels=names.map(n=>`<span class="conf-name">${esc(n)}</span>`).join('');
    h+=`<div class="${c}" style="flex-direction:column;gap:1px;padding:2px"><span>${d}</span>${nameLabels}</div>`;
  }
  document.getElementById('calConf').innerHTML=h;
}

function renderCal(){
  const y=S.calY,m=S.calM;
  document.getElementById('calTitle').textContent=y+'年 '+(m+1)+'月';
  const first=new Date(y,m,1).getDay(),days=new Date(y,m+1,0).getDate();
  const today=new Date();
  const shiftDates=S.shifts.filter(s=>s.status!=='却下').map(s=>s.date.replace(/-/g,'/'));
  let h=['日','月','火','水','木','金','土'].map(d=>`<div class="cal-head">${d}</div>`).join('');
  for(let i=0;i<first;i++)h+='<div class="cal-day ce"></div>';
  for(let d=1;d<=days;d++){
    const dt=new Date(y,m,d);
    const ds=y+'/'+String(m+1).padStart(2,'0')+'/'+String(d).padStart(2,'0');
    const isT=dt.toDateString()===today.toDateString();
    const isP=dt<new Date(today.toDateString());
    const isS=S.selDate===ds,hasS=shiftDates.indexOf(ds)>=0;
    const sch=S.schedule[ds];
    let c='cal-day';
    if(sch&&!isP&&!isT&&!isS){
      if(sch.help)c+=' s-help';
      else if(sch.start==='11:00')c+=' s-1100';
      else if(sch.start==='16:30')c+=' s-1630';
    }
    if(isP)c+=' cp';else if(isS)c+=' cs';else if(isT)c+=' ct';
    if(hasS)c+=' chs';
    const timeLabel=sch&&sch.start&&!isP?`<span class="cal-time">${esc(sch.start)}</span>`:'';
    const helpStyle=sch&&sch.help&&!isP&&!isT&&!isS?' style="color:#e94560;font-weight:800"':'';
    h+=`<div class="${c}"${isP?'':` onclick="selDate('${ds}')"`}><span${helpStyle}>${d}</span>${timeLabel}</div>`;
  }
  document.getElementById('cal').innerHTML=h;
}
function mvMonth(d){
  S.calM+=d;
  if(S.calM>11){S.calM=0;S.calY++;}
  if(S.calM<0){S.calM=11;S.calY--;}
  S.selDate=null;renderCal();updShfBtn();
  document.getElementById('calDayDetail').classList.add('hidden');
}
function selDate(ds){
  S.selDate=ds;renderCal();updShfBtn();
  const detail=document.getElementById('calDayDetail');
  const sch=S.schedule[ds];
  if(sch){
    const parts=ds.split('/');
    const helpBadge=sch.help?'<span class="help-badge">⚠ 要ヘルプ</span>':'';
    detail.innerHTML=`<div class="day-detail-date">${parts[0]}年${+parts[1]}月${+parts[2]}日${helpBadge}</div>`+
      `<div class="day-detail-time">開講時間: ${esc(sch.start||'—')} 〜 ${esc(sch.end||'—')}</div>`;
    detail.classList.remove('hidden');
  }else{
    detail.classList.add('hidden');
  }
}
function updShfBtn(){
  const btn=document.getElementById('shfBtn'),info=document.getElementById('calInfo');
  if(S.selDate){
    const p=S.selDate.split('/');
    info.textContent=`${p[0]}年${+p[1]}月${+p[2]}日を選択中`;
    btn.textContent='この日をシフト申請する';btn.disabled=false;
  }else{
    info.textContent='日付をタップして選択してください';
    btn.textContent='日付を選択してください';btn.disabled=true;
  }
}
async function submitShift(){
  if(!S.selDate)return;
  const btn=document.getElementById('shfBtn');
  btn.disabled=true;
  try{
    await run('addShift',S.name,S.selDate);
    toast('シフトを申請しました','ok');
    S.selDate=null;
    S.shifts=await run('getShifts',S.name);
    renderShifts(); renderCal(); updShfBtn();
    document.getElementById('calDayDetail').classList.add('hidden');
  }catch(e){
    toast(e.message,'ng');
    updShfBtn();
  }
}
function renderShifts(){
  const el=document.getElementById('shfList');
  if(!S.shifts.length){el.innerHTML=emptyHTML('📅','申請がありません');return;}
  const sorted=[...S.shifts].sort((a,b)=>b.date.localeCompare(a.date));
  const helpDates=Object.keys(S.schedule).filter(k=>S.schedule[k].help);
  el.innerHTML='<div class="rlist">'+sorted.map(s=>{
    const bc=s.status==='承認'?'badge-ok':s.status==='却下'?'badge-ng':'badge-p';
    const isHelp=helpDates.some(d=>d.replace(/-/g,'/')===s.date.replace(/-/g,'/'));
    const helpTag=isHelp?`<span style="font-size:16px;color:#e94560;font-weight:700;margin-left:8px">⚠ 要ヘルプ</span>`:'';
    const dateStyle=isHelp?'color:#e94560;font-weight:700':'';
    return `<div class="ritem"><div class="ritem-main" style="${dateStyle}">${esc(s.date)}${helpTag}</div><span class="badge ${bc}">${esc(s.status)}</span></div>`;
  }).join('')+'</div>';
}

// ── 指導報告一覧 ──────────────────────────────────────────
async function loadHistoryReports(){
  const sName=document.getElementById('hisStuSel').value;
  const el=document.getElementById('hisList');
  if(!sName){
    el.innerHTML=emptyHTML('📋','生徒を選択してください');
    return;
  }
  el.innerHTML=`<div class="empty-state"><div class="empty-icon" style="animation:blink 1s infinite">⏳</div></div>`;
  try{
    const recs=await run('getReportsByStudent',sName);
    if(document.getElementById('hisStuSel').value!==sName) return;
    if(!recs.length){el.innerHTML=emptyHTML('📋','記録がありません');return;}
    const sorted=[...recs].sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp)));
    el.innerHTML=sorted.map(r=>{
      const rows=[];
      if(r.materials) rows.push(`
        <div class="his-row">
          <div class="his-label">実施教材</div>
          <div class="his-val accent">${esc(r.materials)}</div>
        </div>`);
      if(r.homework) rows.push(`
        <div class="his-divider"></div>
        <div class="his-row">
          <div class="his-label">宿題</div>
          <div class="his-val purple">${esc(r.homework)}</div>
        </div>`);
      if(r.note) rows.push(`
        <div class="his-divider"></div>
        <div class="his-row">
          <div class="his-label">報告事項</div>
          <div class="his-val">${esc(r.note)}</div>
        </div>`);
      if(r.photoUrl) rows.push(`
        <div class="his-divider"></div>
        <div class="his-row">
          <div class="his-label">写真</div>
          <div class="his-val"><a href="${esc(r.photoUrl)}" target="_blank" style="color:var(--ok);font-size:43px">📂 確認</a></div>
        </div>`);
      return `
        <div class="his-card">
          <div class="his-header">
            <div class="his-date">${esc(r.timestamp)}</div>
            <div class="his-teacher">${esc(r.teacherName)}</div>
          </div>
          <div class="his-body">${rows.join('')}</div>
        </div>`;
    }).join('');
  }catch(e){el.innerHTML=emptyHTML('⚠️',esc(e.message));}
}

// ── UI ────────────────────────────────────────────────────
function switchTab(id,el){
  document.querySelectorAll('.tc').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.ti').forEach(t=>t.classList.remove('on'));
  document.getElementById('tab-'+id).classList.add('on');
  el.classList.add('on');
}
function emptyHTML(ic,msg){
  return `<div class="empty-state"><div class="empty-icon">${ic}</div><div class="empty-text">${msg}</div></div>`;
}
// シートの内容がそのままHTMLに入るため、記号によるレイアウト崩れを防ぐ
function esc(v){
  return String(v==null?'':v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
let _tt;
function toast(msg,type=''){
  const el=document.getElementById('toast');
  el.textContent=msg;el.className='toast show '+(type||'');
  clearTimeout(_tt);_tt=setTimeout(()=>el.classList.remove('show'),3200);
}
