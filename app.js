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

// 認証切れ時の処理：保存情報を消してログイン画面へ戻す
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
// CONFIG.API_URL は config.js で定義
async function run(fn,...args){
  if(!window.CONFIG || !CONFIG.API_URL || CONFIG.API_URL.includes('YOUR_GAS_URL')){
    throw new Error('API URLが未設定です。config.js を確認してください');
  }
  // simple request (CORS preflight 回避)：text/plain で POST する
  const body = JSON.stringify({ fn, args, token: getToken() });
  let resp;
  try{
    resp = await fetch(CONFIG.API_URL, {
      method: 'POST',
      mode: 'cors',
      // GAS の CORS 制約回避のため text/plain で送信
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      redirect: 'follow',
    });
  }catch(networkErr){
    throw new Error('通信エラー: ' + (networkErr.message||networkErr));
  }
  if(!resp.ok){
    throw new Error('サーバーエラー (HTTP ' + resp.status + ')');
  }
  let data;
  try{ data = await resp.json(); }
  catch(parseErr){ throw new Error('レスポンス解析エラー'); }
  if(data && data.ok === false){
    // 認証エラーはログイン画面へ誘導
    if(data.code === 'AUTH'){
      handleAuthExpired(data.error);
      throw new Error(data.error || 'ログインが必要です');
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
  // ── 成績関連 ──
  testConfig:null,         // {students,testNames,subjects}
  studentScores:[],        // 現在選択中の生徒のスコア
  isTestTarget:false,      // 現在の生徒が対象生徒か
  gradeChart:null          // Chart.jsインスタンス
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
    const info=await run('loginWithEmail',email);
    setToken(info.token);
    try{localStorage.setItem('acl_email',info.email);localStorage.setItem('acl_name',info.name);}catch(e){}
    await startApp(info);
  }catch(e){
    errEl.textContent=e.message;
    btn.disabled=false; btn.textContent='ログイン';
  }
}

// ── 起動 ──────────────────────────────────────────────────
window.addEventListener('load',async()=>{
  let em='',nm='',tk='';
  try{
    em=localStorage.getItem('acl_email')||'';
    nm=localStorage.getItem('acl_name')||'';
    tk=getToken();
  }catch(e){}
  // トークンと基本情報が揃っていれば自動ログインを試みる
  if(em&&nm&&tk){
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('loading').classList.remove('hidden');
    try{
      // 保存済みトークンの有効性を、軽いAPI呼び出しで確認
      // （getScheduleは個人情報を含まず副作用もないため検証に最適）
      await run('getSchedule');
      await startApp({ email:em, name:nm });
    }catch(e){
      // 認証エラーなら run() 側で既にログイン画面へ戻している
      // それ以外（通信エラー等）の場合もここで安全側に倒す
      clearAuth();
      document.getElementById('loading').classList.add('hidden');
      document.getElementById('loginScreen').classList.remove('hidden');
    }
  }
});

async function startApp(info){
  S.email=info.email; S.name=info.name;
  document.getElementById('hdrName').textContent=info.name;
  document.getElementById('hdrEmail').textContent=info.email;
  document.getElementById('repTeacher').textContent=info.name;
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('loginScreen').classList.add('hidden');
  await Promise.allSettled([
    loadStudents().catch(console.warn),
    loadTodayStatus().catch(console.warn),
    loadAttHistory().catch(console.warn),
    loadShifts().catch(console.warn),
    loadReports().catch(console.warn),
    loadSchedule().catch(console.warn),
    loadConfirmedShifts().catch(console.warn),
    loadTestConfig().catch(console.warn)   // ★成績設定の読込み
  ]);
  renderCal(); updShfBtn();
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function jstToday(){
  return new Date(Date.now()+9*3600*1000).toISOString().slice(0,10).replace(/-/g,'/');
}

// ── 出退勤 ────────────────────────────────────────────────
async function loadTodayStatus(){
  const recs=await run('getAttendance',S.name);
  const today=jstToday();
  const rec=recs.find(r=>String(r.date).replace(/-/g,'/')===today);
  if(rec){
    setSV('sIn',rec.clockIn); setSV('sOut',rec.clockOut);
    if(rec.fee!=='') document.getElementById('sFee').textContent='¥'+Number(rec.fee).toLocaleString();
  }
}
function setSV(id,val){
  const el=document.getElementById(id);
  if(val&&String(val).includes(':')){el.textContent=String(val).slice(0,5);el.classList.add('ok');}
  else if(val){el.textContent=String(val);el.classList.add('ok');}
}
async function doClock(type){
  try{
    const r=await run(type==='in'?'clockIn':'clockOut',S.name);
    setSV(type==='in'?'sIn':'sOut',r.time);
    toast((type==='in'?'出勤':'退勤')+'打刻しました: '+r.time,'ok');
  }catch(e){toast(e.message,'ng');}
}
async function saveFee(){
  const v=parseInt(document.getElementById('feeInput').value);
  if(!v||v<0){toast('交通費を入力してください','ng');return;}
  try{
    await run('addTransportFee',S.name,v);
    document.getElementById('sFee').textContent='¥'+v.toLocaleString();
    document.getElementById('feeInput').value='';
    toast('交通費を保存しました','ok');
  }catch(e){toast(e.message,'ng');}
}
async function loadAttHistory(){
  const recs=await run('getAttendance',S.name);
  const el=document.getElementById('attList');
  if(!recs.length){el.innerHTML=emptyHTML('📋','記録がありません');return;}
  el.innerHTML='<div class="rlist">'+recs.map(r=>`
    <div class="ritem">
      <div>
        <div class="ritem-main">${r.date}</div>
        <div class="ritem-sub">${r.clockIn?'出勤 '+r.clockIn.slice(0,5):'—'}${r.clockOut?' → 退勤 '+r.clockOut.slice(0,5):''}</div>
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
    await loadAttHistory(); await loadTodayStatus();
  }catch(e){toast(e.message,'ng');}
}

// ── 指導報告 ──────────────────────────────────────────────
async function loadStudents(){
  S.students=await run('getStudents');
  const opts='<option value="">— 生徒を選択 —</option>'+
    S.students.map(s=>`<option value="${s.name}">${s.name}（${s.grade}）</option>`).join('');
  document.getElementById('stuSel').innerHTML=opts;
  document.getElementById('hisStuSel').innerHTML=opts;
}
async function onStudentChange(){
  const name=document.getElementById('stuSel').value;
  const card=document.getElementById('stuInfo');
  // リセット
  S.editing=false;
  S.existingPhotoUrl='';
  document.getElementById('editModeBadge').classList.add('hidden');
  document.getElementById('existingPhotoNote').classList.add('hidden');
  document.getElementById('existingPhotoNote').innerHTML='';
  document.getElementById('repBtn').textContent='報告を提出';
  // サブタブを「指導報告」に戻す
  resetRSub();

  if(!name){
    card.classList.remove('on');
    document.getElementById('rsubBar').classList.add('hidden');
    return;
  }
  const s=S.students.find(x=>x.name===name);if(!s)return;
  document.getElementById('stuInfoName').textContent=s.name;
  let tagsHtml = `<span class="stu-tag">📆 ${s.plan}</span>`;
  if(s.note) tagsHtml += `<div class="stu-note">${s.note}</div>`;
  document.getElementById('stuInfoTags').innerHTML = tagsHtml;

  const mats = s.materials.split(',').map(m=>m.trim()).filter(Boolean);
  const cl = document.getElementById('materialChecks');
  cl.innerHTML = mats.map((m,i)=>`
    <label class="mat-check-label">
      <input type="checkbox" class="mat-check" value="${m}" id="mat${i}">
      <span class="mat-check-text">${m}</span>
    </label>`).join('');
  document.getElementById('materialSection').style.display = mats.length ? 'block' : 'none';

  const hws = s.homework ? s.homework.split(',').map(h=>h.trim()).filter(Boolean) : [];
  const hl = document.getElementById('homeworkChecks');
  hl.innerHTML = hws.map((h,i)=>`
    <label class="mat-check-label">
      <input type="checkbox" class="mat-check hw-check" value="${h}" id="hw${i}">
      <span class="mat-check-text">${h}</span>
    </label>`).join('');
  document.getElementById('homeworkSection').style.display = hws.length ? 'block' : 'none';
  card.classList.add('on');

  removePhoto(null);
  document.getElementById('repNote').value='';

  // 本日の既存報告を取得して復元
  try{
    const existing = await run('getTodayReport', name);
    if(existing){
      S.editing = true;
      S.existingPhotoUrl = existing.photoUrl || '';
      const matSet = new Set(existing.materials || []);
      document.querySelectorAll('#materialChecks .mat-check').forEach(c=>{
        if(matSet.has(c.value)) c.checked = true;
      });
      const hwSet = new Set(existing.homework || []);
      document.querySelectorAll('#homeworkChecks .hw-check').forEach(c=>{
        if(hwSet.has(c.value)) c.checked = true;
      });
      document.getElementById('repNote').value = existing.note || '';
      if(existing.photoUrl){
        const note = document.getElementById('existingPhotoNote');
        note.innerHTML = `📂 既存の写真あり <a href="${existing.photoUrl}" target="_blank">ドライブで確認</a><br>新しい写真を撮影すると上書きされます`;
        note.classList.remove('hidden');
      }
      const editBadge = document.getElementById('editModeBadge');
      if(existing.teacherName && existing.teacherName !== S.name){
        editBadge.textContent = `✏ ${existing.teacherName}の記録を編集`;
      }else{
        editBadge.textContent = '✏ 本日分を編集';
      }
      editBadge.classList.remove('hidden');
      document.getElementById('repBtn').textContent='報告を更新';
    }
  }catch(e){ console.warn('既存報告取得エラー:', e); }

  // 成績データ読込み（生徒変更時）
  await loadStudentGrades(name);
}

let photoB64=null,photoFile=null,photoUrl=null;
function triggerCam(){document.getElementById('photoInput').click();}
function onPhotoSel(e){
  const f=e.target.files[0];if(!f)return;
  photoFile=f;photoUrl=null;
  document.getElementById('dLink').innerHTML='';
  const rd=new FileReader();
  rd.onload=ev=>{
    photoB64=ev.target.result;
    const pv=document.getElementById('photoPV');
    pv.src=photoB64;pv.classList.remove('hidden');
    document.getElementById('photoRM').classList.remove('hidden');
    const pa=document.getElementById('photoArea');
    pa.classList.add('has-photo');pa.style.padding='0';
    document.getElementById('photoPH').classList.add('hidden');
  };
  rd.readAsDataURL(f);
}
function removePhoto(e){
  if(e)e.stopPropagation();
  photoB64=null;photoFile=null;photoUrl=null;
  const inp=document.getElementById('photoInput');
  if(inp) inp.value='';
  const pv=document.getElementById('photoPV');pv.classList.add('hidden');pv.src='';
  document.getElementById('photoRM').classList.add('hidden');
  const pa=document.getElementById('photoArea');
  pa.classList.remove('has-photo');pa.style.padding='';
  document.getElementById('photoPH').classList.remove('hidden');
  document.getElementById('upProg').classList.add('hidden');
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
    const mime=photoFile?photoFile.type:'image/jpeg';
    const fn=`指導報告_${sName}_${new Date().toISOString().slice(0,16).replace(/[-T:]/g,'')}.jpg`;
    const r=await run('uploadPhotoToDrive',b64,mime,fn,sName);
    clearInterval(tk);bar.style.width='100%';txt.textContent='アップロード完了';
    photoUrl=r.fileUrl;
    document.getElementById('dLink').innerHTML=`<a href="${r.fileUrl}" target="_blank">📂 ドライブで確認</a>`;
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
    document.getElementById('repBtn').textContent='報告を提出';
    S.editing=false; S.existingPhotoUrl='';
    removePhoto(null);
    toast(result&&result.updated ? '本日の報告を更新しました' : '指導報告を提出しました','ok');
    await loadReports();
  }catch(e){toast(e.message,'ng');}
  finally{btn.disabled=false; if(btn.textContent.indexOf('送信中')>=0) btn.textContent = wasEditing?'報告を更新':'報告を提出';}
}
async function loadReports(){
  const recs=await run('getReports',S.name);
  const el=document.getElementById('repList');
  if(!recs.length){el.innerHTML=emptyHTML('📝','本日の報告はありません');return;}
  el.innerHTML='<div class="rlist">'+recs.map(r=>{
    const link=r.photoUrl?` <a href="${r.photoUrl}" target="_blank" style="font-size:18px;color:var(--ok)">📂</a>`:'';
    const mats=r.materials?`<div class="ritem-sub" style="color:var(--acc)">✔ ${r.materials}</div>`:'';
    const hws=r.homework?`<div class="ritem-sub" style="color:#8b5cf6">📚 ${r.homework}</div>`:'';
    return `<div class="ritem"><div>
      <div class="ritem-main">${r.studentName}${link}</div>
      ${mats}${hws}
      <div class="ritem-sub">${r.timestamp.slice(0,16)}${r.note?' — '+r.note.slice(0,24):''}</div>
    </div></div>`;
  }).join('')+'</div>';
}

// ============================================================
// ★★★ 成績（定期テスト）機能 ★★★
// ============================================================
async function loadTestConfig(){
  S.testConfig = await run('getTestConfig');
  // ドロップダウン初期化
  const tnSel = document.getElementById('gfTestName');
  tnSel.innerHTML = '<option value="">— 選択 —</option>' +
    S.testConfig.testNames.map(t=>`<option value="${t}">${t}</option>`).join('');
  const subSel = document.getElementById('gfSubject');
  subSel.innerHTML = '<option value="">— 選択 —</option>' +
    S.testConfig.subjects.map(s=>`<option value="${s}">${s}</option>`).join('');
}

// 指導報告/成績サブタブ切替
function switchRSub(id, el){
  document.querySelectorAll('.rsub').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.rsub-content').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('rsub-'+id).classList.add('on');
  if(id==='grade' && S.isTestTarget){
    // チャート描画は表示後に
    setTimeout(()=>renderGradeChart(), 60);
  }
}
function resetRSub(){
  document.querySelectorAll('.rsub').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.rsub-content').forEach(t=>t.classList.remove('on'));
  const repBtn = document.querySelector('.rsub[data-rsub="rep"]');
  if(repBtn) repBtn.classList.add('on');
  document.getElementById('rsub-rep').classList.add('on');
  // 成績フォーム閉じる
  closeGradeForm();
}

// 生徒選択時に呼ばれる
async function loadStudentGrades(studentName){
  const rsubBar = document.getElementById('rsubBar');
  if(!S.testConfig){
    S.isTestTarget = false;
    rsubBar.classList.add('hidden');
    return;
  }
  const testStudent = S.testConfig.students.find(s=>s.name===studentName);
  S.isTestTarget = !!testStudent;

  // 対象外の生徒にはサブタブ自体を出さない（指導報告のみ表示）
  if(!S.isTestTarget){
    rsubBar.classList.add('hidden');
    resetRSub();
    S.studentScores = [];
    return;
  }
  // 対象の生徒：サブタブバーを表示
  rsubBar.classList.remove('hidden');
  document.getElementById('gradeMain').classList.remove('hidden');

  // 生徒情報をフォームへ反映
  document.getElementById('gfStudentId').textContent = testStudent.id;
  document.getElementById('gfGrade').textContent = testStudent.grade;

  try{
    S.studentScores = await run('getTestScores', studentName);
  }catch(e){
    console.warn('成績取得エラー:', e);
    S.studentScores = [];
  }

  // サマリ・表を更新
  updateGradeSummary();
  renderGradeTable();
  // 成績タブが現在アクティブなら即時描画
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
    sumEl.textContent = '—';
    avgEl.textContent = '—';
    lblEl.textContent = '最新テスト';
    return;
  }
  summary.classList.remove('hidden');
  // 最新テスト（テスト名の並び順で最後に得点があるもの）
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
      const avg   = total / latestScores.length;
      sumEl.textContent = total;
      avgEl.textContent = avg.toFixed(1);
    }else{
      sumEl.textContent = '—';
      avgEl.textContent = '—';
    }
  }else{
    lblEl.textContent = '最新テスト';
    sumEl.textContent = '—';
    avgEl.textContent = '—';
  }
}

// ── 成績表の描画（行=教科 / 列=テスト名 + 合計・平均行） ──
function renderGradeTable(){
  const table = document.getElementById('gradeTable');
  const wrap  = document.getElementById('gradeTableWrap');
  if(!table || !S.testConfig) return;
  const tests    = S.testConfig.testNames;
  const subjects = S.testConfig.subjects;
  const scores   = S.studentScores || [];

  if(!scores.length){
    wrap.classList.add('hidden');
    table.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');

  const get = (subj, test) => {
    const r = scores.find(s=>s.subject===subj && s.testName===test);
    return (r && typeof r.score==='number') ? r.score : null;
  };

  // ヘッダー
  let html = '<thead><tr><th class="gt-subj">教科</th>' +
    tests.map(t=>`<th>${t}</th>`).join('') + '</tr></thead><tbody>';

  // 教科ごとの行
  subjects.forEach(subj=>{
    html += `<tr><th class="gt-subj">${subj}</th>`;
    tests.forEach(t=>{
      const v = get(subj, t);
      html += (v===null)
        ? '<td class="gt-empty">−</td>'
        : `<td class="gt-score">${v}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody>';

  // フッター（合計・平均）
  let sumRow = '<tr><td class="gt-foot-lbl">合計</td>';
  let avgRow = '<tr><td class="gt-foot-lbl">平均</td>';
  tests.forEach(t=>{
    const vals = subjects.map(s=>get(s,t)).filter(v=>v!==null);
    if(vals.length){
      const total = vals.reduce((a,b)=>a+b,0);
      const avg   = total / vals.length;
      sumRow += `<td class="gt-sum">${total}</td>`;
      avgRow += `<td class="gt-avg">${avg.toFixed(1)}</td>`;
    }else{
      sumRow += '<td class="gt-empty">−</td>';
      avgRow += '<td class="gt-empty">−</td>';
    }
  });
  sumRow += '</tr>'; avgRow += '</tr>';
  html += `<tfoot>${sumRow}${avgRow}</tfoot>`;

  table.innerHTML = html;
}

// 教科ごとのカラー（5教科想定 + 余裕）
const SUBJECT_COLORS = {
  '英語':'#e94560','数学':'#1d9e75','国語':'#378add',
  '理科':'#ef9f27','社会':'#7f77dd'
};
const FALLBACK_COLORS = ['#e94560','#1d9e75','#378add','#ef9f27','#7f77dd','#d4537e','#888780','#0a5c36'];

function renderGradeChart(){
  const ctx = document.getElementById('gradeChart');
  if(!ctx || !S.testConfig){ return; }
  if(typeof Chart==='undefined'){
    console.warn('Chart.js未ロード');
    return;
  }
  const labels   = S.testConfig.testNames;
  const subjects = S.testConfig.subjects;
  const scores   = S.studentScores || [];
  const hasAny   = scores.length > 0;

  document.getElementById('gradeNoData').classList.toggle('hidden', hasAny);

  const datasets = subjects.map((subj, i) => {
    const color = SUBJECT_COLORS[subj] || FALLBACK_COLORS[i % FALLBACK_COLORS.length];
    return {
      label: subj,
      data: labels.map(t=>{
        const r = scores.find(s=>s.subject===subj && s.testName===t);
        return r ? r.score : null;
      }),
      borderColor: color,
      backgroundColor: color,
      tension: 0.25,
      spanGaps: true,
      borderWidth: 2.5,
      pointRadius: 4,
      pointHoverRadius: 6
    };
  });

  if(S.gradeChart){ S.gradeChart.destroy(); S.gradeChart = null; }
  S.gradeChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: {
          min: 0, max: 100,
          ticks: { stepSize: 20, font: { size: 12 }, color: '#5f5e5a' },
          grid: { color: 'rgba(0,0,0,0.06)' }
        },
        x: {
          ticks: { font: { size: 12 }, color: '#5f5e5a', autoSkip: false, maxRotation: 0 },
          grid: { display: false }
        }
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { size: 13 }, boxWidth: 14, padding: 10, color: '#1c1c1e' }
        },
        tooltip: {
          titleFont: { size: 13 }, bodyFont: { size: 13 },
          padding: 10
        }
      }
    }
  });
}

// 成績入力フォーム開閉
function toggleGradeForm(){
  const form = document.getElementById('gradeForm');
  const btn  = document.getElementById('gradeEntryToggle');
  if(form.classList.contains('hidden')){
    form.classList.remove('hidden');
    btn.textContent = '✕ キャンセル';
    btn.classList.remove('bp');
    btn.classList.add('bs');
  }else{
    closeGradeForm();
  }
}
function closeGradeForm(){
  const form = document.getElementById('gradeForm');
  const btn  = document.getElementById('gradeEntryToggle');
  form.classList.add('hidden');
  btn.textContent = '＋ 成績入力';
  btn.classList.remove('bs');
  btn.classList.add('bp');
  document.getElementById('gfTestName').value = '';
  document.getElementById('gfSubject').value  = '';
  document.getElementById('gfScore').value    = '';
}

// 成績登録
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
  if(scoreRaw==='' || scoreRaw===null){ toast('得点を入力してください','ng'); return; }
  const score = Number(scoreRaw);
  if(isNaN(score) || score<0 || score>100){ toast('得点は0〜100の数値で入力してください','ng'); return; }

  const btn = document.getElementById('gradeSaveBtn');
  btn.disabled = true; btn.innerHTML = '<span class="sp"></span> 保存中...';
  try{
    const r = await run('addTestScore',
      testStudent.id, testStudent.name, testStudent.grade,
      testName, subject, score);
    toast(r.updated ? '得点を更新しました' : '得点を記録しました', 'ok');
    closeGradeForm();
    // 再読み込み
    await loadStudentGrades(studentName);
    renderGradeChart();
  }catch(e){
    toast(e.message,'ng');
  }finally{
    btn.disabled = false; btn.textContent = '保存する';
  }
}

// ── シフト ────────────────────────────────────────────────
async function loadSchedule(){S.schedule=await run('getSchedule');}
async function loadConfirmedShifts(){
  S.confirmedShifts=await run('getConfirmedShifts');
}

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
  let h=['日','月','火','水','木','金','土'].map(d=>`<div class="cal-head">${d}</div>`).join('');
  for(let i=0;i<first;i++)h+='<div class="cal-day ce"></div>';
  for(let d=1;d<=days;d++){
    const dt=new Date(y,m,d);
    const ds=y+'/'+String(m+1).padStart(2,'0')+'/'+String(d).padStart(2,'0');
    const isT=dt.toDateString()===today.toDateString();
    const isP=dt<new Date(today.toDateString());
    const names=S.confirmedShifts[ds]||[];
    const isMine=names.includes(S.name.split(/[\s　]/)[0]);
    let c='cal-day';
    if(isP)c+=' cp'; else if(isT)c+=' ct';
    if(isMine)c+=' conf-mine';
    const nameLabels=names.map(n=>`<span class="conf-name">${n}</span>`).join('');
    h+=`<div class="${c}" style="flex-direction:column;gap:1px;padding:2px">`+
       `<span>${d}</span>${nameLabels}</div>`;
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
    const isS=S.selDate===ds,hasS=shiftDates.includes(ds);
    const sch=S.schedule[ds];
    let c='cal-day';
    if(sch&&!isP&&!isT&&!isS){
      if(sch.help)c+=' s-help';
      else if(sch.start==='11:00')c+=' s-1100';
      else if(sch.start==='16:30')c+=' s-1630';
    }
    if(isP)c+=' cp';else if(isS)c+=' cs';else if(isT)c+=' ct';
    if(hasS)c+=' chs';
    const timeLabel=sch&&sch.start&&!isP?`<span class="cal-time">${sch.start}</span>`:'';
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
    const [y,mo,da]=ds.split('/');
    const helpBadge=sch.help?'<span class="help-badge">⚠ 要ヘルプ</span>':'';
    detail.innerHTML=`<div class="day-detail-date">${y}年${+mo}月${+da}日${helpBadge}</div>`+
      `<div class="day-detail-time">開講時間: ${sch.start||'—'} 〜 ${sch.end||'—'}</div>`;
    detail.classList.remove('hidden');
  }else{
    detail.classList.add('hidden');
  }
}
function updShfBtn(){
  const btn=document.getElementById('shfBtn'),info=document.getElementById('calInfo');
  if(S.selDate){
    const [y,m,d]=S.selDate.split('/');
    info.textContent=`${y}年${+m}月${+d}日を選択中`;
    btn.textContent='この日をシフト申請する';btn.disabled=false;
  }else{
    info.textContent='日付をタップして選択してください';
    btn.textContent='日付を選択してください';btn.disabled=true;
  }
}
async function submitShift(){
  if(!S.selDate)return;
  try{
    await run('addShift',S.name,S.selDate);
    toast('シフトを申請しました','ok');
    S.selDate=null;await loadShifts();renderCal();updShfBtn();
    document.getElementById('calDayDetail').classList.add('hidden');
  }catch(e){toast(e.message,'ng');}
}
async function loadShifts(){
  S.shifts=await run('getShifts',S.name);
  const el=document.getElementById('shfList');
  if(!S.shifts.length){el.innerHTML=emptyHTML('📅','申請がありません');return;}
  const sorted=[...S.shifts].sort((a,b)=>b.date.localeCompare(a.date));
  const helpDates=Object.entries(S.schedule).filter(([,v])=>v.help).map(([k])=>k);
  el.innerHTML='<div class="rlist">'+sorted.map(s=>{
    const bc=s.status==='承認'?'badge-ok':s.status==='却下'?'badge-ng':'badge-p';
    const isHelp=helpDates.some(d=>d===s.date||d.replace(/-/g,'/')===s.date.replace(/-/g,'/'));
    const helpTag=isHelp?`<span style="font-size:16px;color:#e94560;font-weight:700;margin-left:8px">⚠ 要ヘルプ</span>`:'';
    const dateStyle=isHelp?'color:#e94560;font-weight:700':'';
    return `<div class="ritem"><div class="ritem-main" style="${dateStyle}">${s.date}${helpTag}</div><span class="badge ${bc}">${s.status}</span></div>`;
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
    if(!recs.length){el.innerHTML=emptyHTML('📋','記録がありません');return;}
    const sorted=[...recs].sort((a,b)=>b.timestamp.localeCompare(a.timestamp));
    el.innerHTML=sorted.map(r=>{
      const rows=[];
      if(r.materials) rows.push(`
        <div class="his-row">
          <div class="his-label">実施教材</div>
          <div class="his-val accent">${r.materials}</div>
        </div>`);
      if(r.homework) rows.push(`
        <div class="his-divider"></div>
        <div class="his-row">
          <div class="his-label">宿題</div>
          <div class="his-val purple">${r.homework}</div>
        </div>`);
      if(r.note) rows.push(`
        <div class="his-divider"></div>
        <div class="his-row">
          <div class="his-label">報告事項</div>
          <div class="his-val">${r.note}</div>
        </div>`);
      if(r.photoUrl) rows.push(`
        <div class="his-divider"></div>
        <div class="his-row">
          <div class="his-label">写真</div>
          <div class="his-val"><a href="${r.photoUrl}" target="_blank" style="color:var(--ok);font-size:43px">📂 確認</a></div>
        </div>`);
      return `
        <div class="his-card">
          <div class="his-header">
            <div class="his-date">${r.timestamp}</div>
            <div class="his-teacher">${r.teacherName}</div>
          </div>
          <div class="his-body">${rows.join('')}</div>
        </div>`;
    }).join('');
  }catch(e){el.innerHTML=emptyHTML('⚠️',e.message);}
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
let _tt;
function toast(msg,type=''){
  const el=document.getElementById('toast');
  el.textContent=msg;el.className='toast show '+(type||'');
  clearTimeout(_tt);_tt=setTimeout(()=>el.classList.remove('show'),3200);
}
