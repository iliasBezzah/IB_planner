/* ╔══════════════════════════════════════════════════════╗
   ║  IB Student Day Planner v2 — Application Logic       ║
   ╚══════════════════════════════════════════════════════╝ */

'use strict';

// ══════════════════════════════════════════
// STATE
// ══════════════════════════════════════════
let currentDate      = todayStr();
let currentWeekStart = getWeekStart(new Date());
let currentMonth     = { year: new Date().getFullYear(), month: new Date().getMonth() };
let db               = {};
let globalData       = {};
let selectedColor    = '#1565C0';
let deferredInstall  = null;

// ── Current logged-in user ──
function getCurrentUser() {
  try {
    const s = sessionStorage.getItem('ib_session') || localStorage.getItem('ib_remember');
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
const CURRENT_USER = getCurrentUser();
const USER_KEY     = CURRENT_USER ? CURRENT_USER.username : 'guest';

// ──────────────────────────────────────────
// Student Category Maps
// ──────────────────────────────────────────
const CAT_ICONS = {
  lecture:    '🎓',
  study:      '📖',
  assignment: '📝',
  exam:       '📋',
  group:      '🤝',
  library:    '📚',
  break:      '☕',
  meal:       '🍽️',
  sport:      '🏃',
  social:     '🎉',
  personal:   '🧘',
  travel:     '🚗'
};

const CAT_COLORS = {
  lecture:    '#1565C0',
  study:      '#1A237E',
  assignment: '#6A1B9A',
  exam:       '#C62828',
  group:      '#00838F',
  library:    '#0288D1',
  break:      '#5D4037',
  meal:       '#2E7D32',
  sport:      '#E65100',
  social:     '#AD1457',
  personal:   '#37474F',
  travel:     '#558B2F'
};

// ══════════════════════════════════════════
// PERSISTENCE & CLOUD SYNC (Firebase Firestore + Local Cache)
// ══════════════════════════════════════════
let cloudSyncTimer = null;

function save() {
  // 1. Instant local persistence for fast UI
  localStorage.setItem('ib_db_'     + USER_KEY, JSON.stringify(db));
  localStorage.setItem('ib_global_' + USER_KEY, JSON.stringify(globalData));

  // 2. Debounced Cloud Firestore sync (cross-device)
  if (typeof firebase !== 'undefined' && firebase.apps.length && CURRENT_USER && (CURRENT_USER.uid || CURRENT_USER.username)) {
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(() => {
      syncToCloud();
    }, 600);
  }
}

async function syncToCloud() {
  try {
    const docId = CURRENT_USER.uid || CURRENT_USER.username;
    if (!docId) return;
    await firebase.firestore().collection('userData').doc(docId).set({
      db: JSON.stringify(db),
      globalData: JSON.stringify(globalData),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    updateSyncIndicator(true);
  } catch (err) {
    console.warn('Cloud sync error:', err);
    updateSyncIndicator(false);
  }
}

function load() {
  try { db         = JSON.parse(localStorage.getItem('ib_db_'     + USER_KEY) || '{}'); } catch { db = {}; }
  try { globalData = JSON.parse(localStorage.getItem('ib_global_' + USER_KEY) || '{}'); } catch { globalData = {}; }
  if (!globalData.recurring) globalData.recurring = [];
  if (!globalData.contacts)  globalData.contacts  = [];
}

// Subscribe to real-time cloud changes from other devices (phone <-> laptop)
function initCloudSync() {
  if (typeof firebase === 'undefined' || !firebase.apps.length) return;
  const docId = CURRENT_USER && (CURRENT_USER.uid || CURRENT_USER.username);
  if (!docId) return;

  try {
    firebase.firestore().collection('userData').doc(docId).onSnapshot(doc => {
      if (doc.exists) {
        const data = doc.data();
        let changed = false;
        if (data.db) {
          try {
            const cloudDb = JSON.parse(data.db);
            if (JSON.stringify(cloudDb) !== JSON.stringify(db)) {
              db = cloudDb;
              localStorage.setItem('ib_db_' + USER_KEY, data.db);
              changed = true;
            }
          } catch {}
        }
        if (data.globalData) {
          try {
            const cloudGlobal = JSON.parse(data.globalData);
            if (JSON.stringify(cloudGlobal) !== JSON.stringify(globalData)) {
              globalData = cloudGlobal;
              localStorage.setItem('ib_global_' + USER_KEY, data.globalData);
              changed = true;
            }
          } catch {}
        }
        if (changed) {
          refreshAll();
          renderTasks();
          renderNotes();
          renderContacts();
          showToast('☁️ Synced with cloud data!', 2000);
        }
        updateSyncIndicator(true);
      }
    }, err => {
      console.warn('Snapshot sync error:', err);
      updateSyncIndicator(false);
    });
  } catch (e) {
    console.warn('initCloudSync exception:', e);
  }
}

function updateSyncIndicator(online) {
  const badge = document.getElementById('cloudSyncStatus');
  if (badge) {
    badge.title = online ? 'Cloud Sync: Connected' : 'Cloud Sync: Offline';
    badge.style.color = online ? '#4CAF50' : '#FFA000';
  }
}

function dayData(date) {
  if (!db[date]) db[date] = {
    events:[], tasks:[], notes:[], goals:[],
    health:{ water:0, meals:0, exercise:0, sleep:0 },
    mood:{ moodMorning:'', moodEvening:'' },
    energy:5
  };
  return db[date];
}

// ══════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════
function todayStr() { return new Date().toISOString().split('T')[0]; }
function uid()      { return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

function esc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function dur(start, end) {
  const [sh,sm] = start.split(':').map(Number);
  const [eh,em] = end.split(':').map(Number);
  const m = (eh*60+em)-(sh*60+sm);
  if (m<=0) return '—';
  const h=Math.floor(m/60), r=m%60;
  return h ? `${h}h${r?r+'m':''}` : `${m}m`;
}

function offset(base, days) {
  const d = new Date(base+'T12:00:00');
  d.setDate(d.getDate()+days);
  return d.toISOString().split('T')[0];
}

function getWeekStart(d) {
  const date = new Date(d);
  const day  = date.getDay();
  const diff = day===0 ? -6 : 1-day;
  date.setDate(date.getDate()+diff);
  return date.toISOString().split('T')[0];
}

function formatDateLong(dateStr) {
  return new Date(dateStr+'T12:00:00').toLocaleDateString('en-GB',
    { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}
function formatDateShort(dateStr) {
  return new Date(dateStr+'T12:00:00').toLocaleDateString('en-GB',
    { day:'2-digit', month:'short' });
}

// ══════════════════════════════════════════
// RECURRING ENGINE
// ══════════════════════════════════════════
function isRecurringOnDate(r, dateStr) {
  const d     = new Date(dateStr+'T12:00:00');
  const start = new Date((r.startDate||todayStr())+'T12:00:00');
  const end   = r.endDate ? new Date(r.endDate+'T12:00:00') : null;
  if (d < start) return false;
  if (end && d > end) return false;
  if (r.freq==='daily')   return true;
  if (r.freq==='weekly')  return (r.days||[]).includes(d.getDay());
  if (r.freq==='monthly') return d.getDate()===start.getDate();
  return false;
}

function getEventsForDate(dateStr) {
  const regular   = [...(dayData(dateStr).events||[])];
  const recurring = (globalData.recurring||[])
    .filter(r=>isRecurringOnDate(r,dateStr))
    .map(r=>({ ...r, id:r.id+'_'+dateStr, recurId:r.id, isRecurring:true, done:false }));
  return [...regular,...recurring].sort((a,b)=>a.start.localeCompare(b.start));
}

function saveRecurring(rec) {
  const idx = globalData.recurring.findIndex(r=>r.id===rec.id);
  if (idx>=0) globalData.recurring[idx]=rec;
  else        globalData.recurring.push(rec);
  save();
}

function deleteRecurring(id) {
  globalData.recurring = globalData.recurring.filter(r=>r.id!==id);
  save();
}

function renderRecurringList() {
  const list = document.getElementById('recurringList');
  if (!list) return;
  const recs = globalData.recurring||[];
  if (!recs.length) {
    list.innerHTML=`<div class="empty-state"><i class="fas fa-redo"></i>
      <p>No recurring classes yet.<br>Add one via <b>Add Event → Recurring / Routine Class</b>.</p></div>`;
    return;
  }
  const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  list.innerHTML=recs.map(r=>{
    let rule='';
    if (r.freq==='daily')   rule='Every day';
    else if (r.freq==='weekly')  rule='Every '+(r.days||[]).map(d=>dayNames[d]).join(', ');
    else if (r.freq==='monthly') rule='Monthly';
    const until = r.endDate ? ` → until ${formatDateShort(r.endDate)}` : '';
    return `
      <div class="recurring-item">
        <div style="width:5px;border-radius:3px;background:${r.color||CAT_COLORS[r.cat]||'#1565C0'};min-height:44px;flex-shrink:0;align-self:stretch"></div>
        <div class="recurring-item-body">
          <div class="recurring-item-title">${CAT_ICONS[r.cat]||'📌'} ${esc(r.title)}</div>
          <div class="recurring-item-meta">${r.start}–${r.end} &nbsp;|&nbsp; ${rule}${until}</div>
          ${r.location?`<div class="recurring-item-meta"><i class="fas fa-map-marker-alt"></i> ${esc(r.location)}</div>`:''}
        </div>
        <button class="recurring-item-del" onclick="deleteRecurring('${r.id}');renderRecurringList();showToast('🗑️ Removed.');">
          <i class="fas fa-trash"></i>
        </button>
      </div>`;
  }).join('');
}

function toggleRecurringSection() {
  const body   = document.getElementById('recurringBody');
  const header = body.previousElementSibling;
  const isOpen = !body.classList.contains('hidden');
  body.classList.toggle('hidden', isOpen);
  header.classList.toggle('open', !isOpen);
}

function onRepeatChange() {
  const val = document.getElementById('evRepeat').value;
  document.getElementById('weekdaysGroup').classList.toggle('hidden', val!=='weekly');
}

// ══════════════════════════════════════════
// CLOCK & DATE
// ══════════════════════════════════════════
function startClock() {
  function tick() {
    const n = new Date();
    document.getElementById('liveClock').textContent =
      n.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    document.getElementById('liveDate').textContent =
      n.toLocaleDateString('en-GB',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  }
  tick();
  setInterval(tick, 1000);
  setInterval(checkReminders, 30000);
  checkReminders();
}

// ══════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════
function initNav() {
  document.querySelectorAll('.nav-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      document.getElementById('view-'+view).classList.add('active');
      if (view==='timeline')  renderTimeline();
      if (view==='week')      renderWeek();
      if (view==='month')     renderMonth();
      if (view==='tasks')     renderTasks();
      if (view==='notes')     renderNotes();
      if (view==='contacts')  renderContacts();
      if (view==='analytics') renderAnalytics();
    });
  });
}

// ══════════════════════════════════════════
// DAY NAVIGATION
// ══════════════════════════════════════════
function loadDay() {
  currentDate = document.getElementById('dayPicker').value || todayStr();
  refreshAll();
}
function changeDay(delta) {
  currentDate = offset(currentDate, delta);
  document.getElementById('dayPicker').value = currentDate;
  refreshAll();
}
function goToday() {
  currentDate = todayStr();
  document.getElementById('dayPicker').value = currentDate;
  refreshAll();
}
function refreshAll() {
  updateDayLabel();
  renderSchedule();
  renderStats();
  loadHealthUI();
  loadMoodUI();
  loadEnergyUI();
  renderGoals();
}
function updateDayLabel() {
  const today = todayStr();
  let label   = formatDateLong(currentDate);
  if (currentDate===today)              label='📅 Today — '+label;
  else if (currentDate===offset(today,-1)) label='⬅️ Yesterday — '+label;
  else if (currentDate===offset(today,1))  label='➡️ Tomorrow — '+label;
  document.getElementById('dayLabel').textContent = label;
}

// ══════════════════════════════════════════
// COLOR PICKER
// ══════════════════════════════════════════
function pickColor(el) {
  document.querySelectorAll('#evColor .color-dot').forEach(d=>d.classList.remove('selected'));
  el.classList.add('selected');
  selectedColor = el.dataset.color;
}

// ══════════════════════════════════════════
// EVENTS
// ══════════════════════════════════════════
function openAddEventModal(dateForNew) {
  document.getElementById('editEventId').value  = '';
  document.getElementById('eventModalTitle').innerHTML = '<i class="fas fa-calendar-plus"></i> Add to Timetable';
  document.getElementById('evTitle').value      = '';
  document.getElementById('evStart').value      = '';
  document.getElementById('evEnd').value        = '';
  document.getElementById('evCat').value        = 'lecture';
  document.getElementById('evLocation').value   = '';
  document.getElementById('evPriority').value   = 'normal';
  document.getElementById('evReminder').value   = '15';
  document.getElementById('evNotes').value      = '';
  document.getElementById('evRepeat').value     = 'none';
  document.getElementById('evStartDate').value  = dateForNew||currentDate;
  document.getElementById('evRepeatUntil').value= '';
  document.querySelectorAll('.wday-cb').forEach(cb=>cb.checked=false);
  document.getElementById('weekdaysGroup').classList.add('hidden');
  selectedColor = '#1565C0';
  document.querySelectorAll('#evColor .color-dot').forEach((d,i)=>d.classList.toggle('selected',i===0));
  const body = document.getElementById('recurringBody');
  body.classList.add('hidden');
  body.previousElementSibling.classList.remove('open');
  openModal('addEventModal');
}

function saveEvent() {
  const title = document.getElementById('evTitle').value.trim();
  const start = document.getElementById('evStart').value;
  const end   = document.getElementById('evEnd').value;
  if (!title||!start||!end) { showToast('⚠️ Title, start and end time are required.'); return; }
  if (start>=end)            { showToast('⚠️ End time must be after start time.'); return; }

  const repeat    = document.getElementById('evRepeat').value;
  const startDate = document.getElementById('evStartDate').value||currentDate;
  const endDate   = document.getElementById('evRepeatUntil').value;

  if (repeat && repeat!=='none') {
    const days=[];
    document.querySelectorAll('.wday-cb:checked').forEach(cb=>days.push(parseInt(cb.value)));
    if (repeat==='weekly'&&days.length===0) { showToast('⚠️ Select at least one day.'); return; }
    const rec = {
      id:uid(), title, start, end,
      cat:      document.getElementById('evCat').value,
      location: document.getElementById('evLocation').value.trim(),
      priority: document.getElementById('evPriority').value,
      reminder: parseInt(document.getElementById('evReminder').value)||0,
      notes:    document.getElementById('evNotes').value.trim(),
      color:    selectedColor,
      freq:repeat, days, startDate, endDate:endDate||null
    };
    saveRecurring(rec);
    closeModal('addEventModal');
    refreshAll();
    if (document.getElementById('view-week').classList.contains('active'))  renderWeek();
    if (document.getElementById('view-month').classList.contains('active')) renderMonth();
    showToast('🔁 Recurring class saved!');
    return;
  }

  const editId = document.getElementById('editEventId').value;
  const data   = dayData(currentDate);
  const ev = {
    id:editId||uid(), title, start, end,
    cat:      document.getElementById('evCat').value,
    location: document.getElementById('evLocation').value.trim(),
    priority: document.getElementById('evPriority').value,
    reminder: parseInt(document.getElementById('evReminder').value)||0,
    notes:    document.getElementById('evNotes').value.trim(),
    color:    selectedColor, done:false, reminded:false
  };
  if (editId) {
    const idx=data.events.findIndex(e=>e.id===editId);
    if (idx>=0){ev.done=data.events[idx].done;data.events[idx]=ev;}
  } else { data.events.push(ev); }
  data.events.sort((a,b)=>a.start.localeCompare(b.start));
  save();
  closeModal('addEventModal');
  renderSchedule(); renderStats();
  if (document.getElementById('view-week').classList.contains('active'))  renderWeek();
  if (document.getElementById('view-month').classList.contains('active')) renderMonth();
  showToast(editId?'✏️ Updated!':'✅ Added to timetable!');
}

function editEvent(id) {
  if (id.includes('_')) { showToast('✏️ Edit via Recurring Classes manager.'); openModal('recurringModal'); renderRecurringList(); return; }
  const ev=dayData(currentDate).events.find(e=>e.id===id);
  if (!ev) return;
  document.getElementById('editEventId').value  = ev.id;
  document.getElementById('eventModalTitle').innerHTML='<i class="fas fa-edit"></i> Edit Event';
  document.getElementById('evTitle').value      = ev.title;
  document.getElementById('evStart').value      = ev.start;
  document.getElementById('evEnd').value        = ev.end;
  document.getElementById('evCat').value        = ev.cat;
  document.getElementById('evLocation').value   = ev.location||'';
  document.getElementById('evPriority').value   = ev.priority;
  document.getElementById('evReminder').value   = ev.reminder||'15';
  document.getElementById('evNotes').value      = ev.notes||'';
  document.getElementById('evRepeat').value     = 'none';
  document.getElementById('weekdaysGroup').classList.add('hidden');
  selectedColor = ev.color||'#1565C0';
  document.querySelectorAll('#evColor .color-dot').forEach(d=>
    d.classList.toggle('selected',d.dataset.color===selectedColor));
  openModal('addEventModal');
}

function deleteEvent(id) {
  if (id.includes('_')) { showToast('🗑️ Delete from Recurring Classes manager.'); openModal('recurringModal'); renderRecurringList(); return; }
  if (!confirm('Delete this event?')) return;
  const data=dayData(currentDate);
  data.events=data.events.filter(e=>e.id!==id);
  save(); renderSchedule(); renderStats();
  if (document.getElementById('view-week').classList.contains('active'))  renderWeek();
  if (document.getElementById('view-month').classList.contains('active')) renderMonth();
  showToast('🗑️ Event deleted.');
}

function toggleEventDone(id) {
  if (id.includes('_')) return;
  const ev=dayData(currentDate).events.find(e=>e.id===id);
  if (ev){ev.done=!ev.done;save();renderSchedule();renderStats();}
}

function quickAdd() {
  const title=document.getElementById('quickTitle').value.trim();
  if (!title){showToast('⚠️ Enter a title first.');return;}
  const start=document.getElementById('quickStart').value;
  const end  =document.getElementById('quickEnd').value;
  const cat  =document.getElementById('quickCat').value;
  if (start>=end){showToast('⚠️ End time must be after start.');return;}
  const data=dayData(currentDate);
  data.events.push({id:uid(),title,start,end,cat,color:CAT_COLORS[cat]||'#1565C0',priority:'normal',done:false,reminded:false});
  data.events.sort((a,b)=>a.start.localeCompare(b.start));
  document.getElementById('quickTitle').value='';
  save(); renderSchedule(); renderStats();
  showToast('⚡ Added to timetable!');
}

function renderSchedule() {
  const list  = document.getElementById('scheduleList');
  const filter= document.getElementById('filterCategory').value;
  let events  = getEventsForDate(currentDate);
  if (filter!=='all') events=events.filter(e=>e.cat===filter);

  if (!events.length) {
    list.innerHTML=`<div class="empty-state"><i class="fas fa-calendar-day"></i>
      <p>No events today. Click <b>Add Event</b> or use Quick Add.</p></div>`;
    return;
  }
  list.innerHTML=events.map(ev=>`
    <div class="event-card ${ev.done?'done':''} ${ev.isRecurring?'is-recurring':''}" onclick="editEvent('${ev.id}')">
      <div class="event-stripe" style="background:${ev.color||CAT_COLORS[ev.cat]||'#1565C0'}"></div>
      <div class="ev-body">
        <div class="ev-title">
          ${CAT_ICONS[ev.cat]||'📌'} ${esc(ev.title)}
          ${ev.isRecurring?'<span class="ev-recurring-badge"><i class="fas fa-redo"></i> Routine</span>':''}
        </div>
        <div class="ev-meta">
          <span class="ev-time"><i class="fas fa-clock"></i> ${ev.start}–${ev.end} (${dur(ev.start,ev.end)})</span>
          <span class="ev-cat-badge" style="background:${CAT_COLORS[ev.cat]||'#1565C0'}">${ev.cat}</span>
          ${ev.priority==='high'?'<span class="ev-priority">🔴 Urgent</span>':''}
          ${ev.priority==='low'?'<span class="ev-priority">🟢 Low</span>':''}
          ${ev.location?`<span class="ev-location"><i class="fas fa-map-marker-alt"></i> ${esc(ev.location)}</span>`:''}
        </div>
        ${ev.notes?`<div style="font-size:11px;color:var(--text-light);margin-top:3px">${esc(ev.notes)}</div>`:''}
      </div>
      <div class="ev-actions" onclick="event.stopPropagation()">
        ${!ev.isRecurring?`<button class="ev-btn done-btn" title="${ev.done?'Undo':'Mark done'}" onclick="toggleEventDone('${ev.id}')"><i class="fas fa-${ev.done?'undo':'check'}"></i></button>`:''}
        <button class="ev-btn del-btn" title="Delete" onclick="deleteEvent('${ev.id}')"><i class="fas fa-trash"></i></button>
      </div>
    </div>`).join('');
}

// ══════════════════════════════════════════
// STATS
// ══════════════════════════════════════════
function renderStats() {
  const events=getEventsForDate(currentDate);
  const tasks =dayData(currentDate).tasks||[];
  let totalMins=0;
  events.forEach(e=>{
    const[sh,sm]=e.start.split(':').map(Number);
    const[eh,em]=e.end.split(':').map(Number);
    totalMins+=(eh*60+em)-(sh*60+sm);
  });
  const done   =events.filter(e=>e.done).length;
  const pending=events.filter(e=>!e.done).length;
  const highP  =[...events,...tasks].filter(e=>e.priority==='high').length;
  const breaks =events.filter(e=>e.cat==='break').length;
  const pct    =events.length?Math.round((done/events.length)*100):0;

  document.getElementById('stat-hours').textContent   =totalMins>=60?`${Math.floor(totalMins/60)}h${totalMins%60?totalMins%60+'m':''}`:`${totalMins}m`;
  document.getElementById('stat-done').textContent    =done;
  document.getElementById('stat-pending').textContent =pending;
  document.getElementById('stat-priority').textContent=highP;
  document.getElementById('stat-breaks').textContent  =breaks;
  document.getElementById('stat-progress').textContent=pct+'%';
  document.getElementById('dayProgressFill').style.width=pct+'%';
  document.getElementById('dayProgressPct').textContent =pct+'%';
}

// ══════════════════════════════════════════
// WEEK VIEW
// ══════════════════════════════════════════
function changeWeek(delta){currentWeekStart=offset(currentWeekStart,delta*7);renderWeek();}
function goCurrentWeek(){currentWeekStart=getWeekStart(new Date());renderWeek();}

function renderWeek() {
  const grid  =document.getElementById('weekGrid');
  if (!grid) return;
  const today =todayStr();
  const weekEnd=offset(currentWeekStart,6);
  const s=new Date(currentWeekStart+'T12:00:00');
  const e=new Date(weekEnd+'T12:00:00');
  document.getElementById('weekLabel').textContent=
    `${s.toLocaleDateString('en-GB',{day:'numeric',month:'short'})} – ${e.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}`;

  const dayNames=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  let html='';
  for (let i=0;i<7;i++) {
    const dateStr=offset(currentWeekStart,i);
    const isToday=dateStr===today;
    const events =getEventsForDate(dateStr);
    const d=new Date(dateStr+'T12:00:00');
    html+=`
      <div class="week-day-col">
        <div class="week-day-header ${isToday?'today':''}">
          <div class="wdh-name">${dayNames[i]}</div>
          <div class="wdh-date">${d.getDate()}</div>
        </div>
        <div class="week-events">
          ${events.length?events.map(ev=>`
            <div class="week-event-chip ${ev.done?'done':''}"
                 style="background:${ev.color||CAT_COLORS[ev.cat]||'#1565C0'}"
                 onclick="goToDateAndEdit('${dateStr}','${ev.id}')">
              <small>${ev.start} ${ev.isRecurring?'🔁':''}</small>
              ${CAT_ICONS[ev.cat]||'📌'} ${esc(ev.title)}
            </div>`).join(''):`<div style="font-size:11px;color:var(--text-light);text-align:center;padding:12px 6px;opacity:.6">Free</div>`}
        </div>
        <button class="week-add-btn" onclick="goToDateAndAdd('${dateStr}')"><i class="fas fa-plus"></i> Add</button>
      </div>`;
  }
  grid.innerHTML=html;
}

function goToDateAndEdit(dateStr,eventId){currentDate=dateStr;document.getElementById('dayPicker').value=currentDate;switchView('dashboard');refreshAll();setTimeout(()=>editEvent(eventId),300);}
function goToDateAndAdd(dateStr){currentDate=dateStr;document.getElementById('dayPicker').value=currentDate;switchView('dashboard');refreshAll();setTimeout(()=>openAddEventModal(dateStr),200);}

// ══════════════════════════════════════════
// MONTH VIEW
// ══════════════════════════════════════════
function changeMonth(delta){
  currentMonth.month+=delta;
  if(currentMonth.month>11){currentMonth.month=0;currentMonth.year++;}
  if(currentMonth.month<0) {currentMonth.month=11;currentMonth.year--;}
  renderMonth();
}
function goCurrentMonth(){const n=new Date();currentMonth={year:n.getFullYear(),month:n.getMonth()};renderMonth();}

function renderMonth() {
  const grid=document.getElementById('monthGrid');
  if (!grid) return;
  const today=todayStr();
  const{year,month}=currentMonth;
  document.getElementById('monthLabel').textContent=
    new Date(year,month,1).toLocaleDateString('en-GB',{month:'long',year:'numeric'});

  const firstDay=new Date(year,month,1);
  const lastDay =new Date(year,month+1,0);
  let startDow=firstDay.getDay();
  startDow=startDow===0?6:startDow-1;

  const days=[];
  for(let i=startDow;i>0;i--){const d=new Date(year,month,1-i);days.push({dateStr:d.toISOString().split('T')[0],other:true});}
  for(let d=1;d<=lastDay.getDate();d++){const dt=new Date(year,month,d);days.push({dateStr:dt.toISOString().split('T')[0],other:false});}
  while(days.length%7!==0){const dt=new Date(year,month+1,days.length-lastDay.getDate()-startDow+1);days.push({dateStr:dt.toISOString().split('T')[0],other:true});}

  const dayNames=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  let html=`<div class="month-weekdays">${dayNames.map(n=>`<div class="month-wday">${n}</div>`).join('')}</div><div class="month-weeks">`;

  for(let w=0;w<days.length/7;w++){
    html+='<div class="month-week-row">';
    for(let d=0;d<7;d++){
      const cell  =days[w*7+d];
      const events=getEventsForDate(cell.dateStr);
      const isToday=cell.dateStr===today;
      const dayNum=new Date(cell.dateStr+'T12:00:00').getDate();
      html+=`
        <div class="month-day-cell ${cell.other?'other-month':''} ${isToday?'today':''}" onclick="goToDate('${cell.dateStr}')">
          <div class="mdc-num">${dayNum}</div>
          <div class="mdc-events">
            ${events.slice(0,3).map(ev=>`
              <div class="mdc-chip" style="background:${ev.color||CAT_COLORS[ev.cat]||'#1565C0'}" title="${esc(ev.title)} ${ev.start}–${ev.end}">
                ${ev.isRecurring?'🔁':''}${esc(ev.title)}
              </div>`).join('')}
            ${events.length>3?`<div class="mdc-more">+${events.length-3} more</div>`:''}
          </div>
        </div>`;
    }
    html+='</div>';
  }
  html+='</div>';
  grid.innerHTML=html;
}

function goToDate(dateStr){currentDate=dateStr;document.getElementById('dayPicker').value=currentDate;switchView('dashboard');refreshAll();}
function switchView(v){document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===v));document.querySelectorAll('.view').forEach(s=>s.classList.toggle('active',s.id==='view-'+v));}

// ══════════════════════════════════════════
// TIMELINE
// ══════════════════════════════════════════
function renderTimeline(){
  const container=document.getElementById('timelineContainer');
  const events=getEventsForDate(currentDate);
  const nowH=new Date().getHours();
  const isToday=currentDate===todayStr();
  let html='';
  for(let h=0;h<24;h++){
    const hStr=String(h).padStart(2,'0');
    const hrEvs=events.filter(e=>e.start.startsWith(hStr+':'));
    if(isToday&&h===nowH) html+=`<div class="tl-now-line"></div>`;
    html+=`<div class="timeline-hour">
      <div class="tl-hour-label">${hStr}:00</div>
      <div class="tl-events">
        ${hrEvs.map(ev=>`
          <div class="tl-event" style="background:${ev.color||CAT_COLORS[ev.cat]||'#1565C0'};opacity:${ev.done?.55:1}" onclick="editEvent('${ev.id}')">
            <i class="fas fa-circle" style="font-size:7px"></i>
            ${ev.start}–${ev.end}&nbsp;${CAT_ICONS[ev.cat]||'📌'} ${esc(ev.title)}
            ${ev.isRecurring?'<span style="margin-left:auto;font-size:10px">🔁</span>':''}
          </div>`).join('')}
      </div>
    </div>`;
  }
  container.innerHTML=html;
  if(isToday){const rows=container.querySelectorAll('.timeline-hour');if(rows[nowH])rows[nowH].scrollIntoView({behavior:'smooth',block:'center'});}
}

// ══════════════════════════════════════════
// TASKS / ASSIGNMENTS
// ══════════════════════════════════════════
function saveTask(){
  const title=document.getElementById('taskTitle').value.trim();
  if(!title){showToast('⚠️ Assignment title is required.');return;}
  const editId=document.getElementById('editTaskId').value;
  const data=dayData(currentDate);
  const tags=document.getElementById('taskTags').value.split(',').map(t=>t.trim()).filter(Boolean);
  const task={
    id:editId||uid(), title,
    cat:     document.getElementById('taskCat').value,
    priority:document.getElementById('taskPriority').value,
    due:     document.getElementById('taskDue').value,
    duration:parseInt(document.getElementById('taskDuration').value)||0,
    tags,
    notes:   document.getElementById('taskNotes').value.trim(),
    done:false
  };
  if(editId){const idx=data.tasks.findIndex(t=>t.id===editId);if(idx>=0){task.done=data.tasks[idx].done;data.tasks[idx]=task;}}
  else data.tasks.push(task);
  save();closeModal('addTaskModal');renderTasks();renderStats();
  showToast(editId?'✏️ Updated!':'✅ Assignment added!');
}

function editTask(id){
  const task=dayData(currentDate).tasks.find(t=>t.id===id);
  if(!task)return;
  document.getElementById('editTaskId').value   =task.id;
  document.getElementById('taskTitle').value    =task.title;
  document.getElementById('taskCat').value      =task.cat;
  document.getElementById('taskPriority').value =task.priority;
  document.getElementById('taskDue').value      =task.due||'';
  document.getElementById('taskDuration').value =task.duration||'';
  document.getElementById('taskTags').value     =(task.tags||[]).join(', ');
  document.getElementById('taskNotes').value    =task.notes||'';
  openModal('addTaskModal');
}

function toggleTask(id){const t=dayData(currentDate).tasks.find(t=>t.id===id);if(t){t.done=!t.done;save();renderTasks();renderStats();}}

function deleteTask(id){
  if(!confirm('Delete this assignment?'))return;
  const data=dayData(currentDate);
  data.tasks=data.tasks.filter(t=>t.id!==id);
  save();renderTasks();renderStats();showToast('🗑️ Deleted.');
}

function renderTasks(){
  const list=document.getElementById('taskList');if(!list)return;
  const filter=document.getElementById('taskFilter')?.value||'all';
  let tasks=[...(dayData(currentDate).tasks||[])];
  if(filter==='pending') tasks=tasks.filter(t=>!t.done);
  else if(filter==='done')  tasks=tasks.filter(t=>t.done);
  else if(filter==='high')  tasks=tasks.filter(t=>t.priority==='high');
  if(!tasks.length){list.innerHTML=`<div class="empty-state"><i class="fas fa-check-square"></i><p>No assignments here. Click <b>Add Assignment</b>.</p></div>`;return;}
  list.innerHTML=tasks.map(t=>`
    <div class="task-item ${t.done?'done':''}">
      <div class="task-check" onclick="toggleTask('${t.id}')"></div>
      <div class="task-body">
        <div class="task-title">${CAT_ICONS[t.cat]||'📋'} ${esc(t.title)}</div>
        <div class="task-meta">
          <span class="task-badge" style="background:${CAT_COLORS[t.cat]||'#1565C0'}">${t.cat}</span>
          ${t.priority==='high'?'<span class="task-prio-high">🔴 Urgent</span>':''}
          ${t.priority==='low'?'<span class="task-prio-low">🟢 Low</span>':''}
          ${t.due?`<span class="task-due"><i class="fas fa-clock"></i> Due ${t.due}</span>`:''}
          ${t.duration?`<span class="task-due">~${t.duration}min</span>`:''}
          ${(t.tags||[]).map(tag=>`<span class="task-tag">#${tag}</span>`).join('')}
        </div>
        ${t.notes?`<div style="font-size:11px;color:var(--text-light);margin-top:3px">${esc(t.notes)}</div>`:''}
      </div>
      <div class="task-actions">
        <button class="ev-btn" onclick="editTask('${t.id}')"><i class="fas fa-edit"></i></button>
        <button class="ev-btn del-btn" onclick="deleteTask('${t.id}')"><i class="fas fa-trash"></i></button>
      </div>
    </div>`).join('');
}

// ══════════════════════════════════════════
// NOTES
// ══════════════════════════════════════════
function addNote(){const data=dayData(currentDate);data.notes.push({id:uid(),text:'',createdAt:new Date().toLocaleString()});save();renderNotes();}
function deleteNote(id){const data=dayData(currentDate);data.notes=data.notes.filter(n=>n.id!==id);save();renderNotes();}
function updateNote(id,value){const note=dayData(currentDate).notes.find(n=>n.id===id);if(note){note.text=value;save();}}

function renderNotes(){
  const grid=document.getElementById('notesGrid');if(!grid)return;
  const notes=dayData(currentDate).notes||[];
  if(!notes.length){grid.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><i class="fas fa-sticky-note"></i><p>No notes yet. Click <b>New Note</b>.</p></div>`;return;}
  const colors=['#EBF3FB','#E8F5E9','#FFF8E1','#F3E5F5','#FCE4EC','#E0F7FA'];
  grid.innerHTML=notes.map((n,i)=>`
    <div class="note-card" style="background:${colors[i%colors.length]}">
      <button class="note-del" onclick="deleteNote('${n.id}')"><i class="fas fa-times"></i></button>
      <div class="note-date"><i class="fas fa-clock"></i> ${n.createdAt}</div>
      <textarea class="note-textarea" placeholder="Course notes, ideas, reminders…" oninput="updateNote('${n.id}',this.value)">${esc(n.text)}</textarea>
    </div>`).join('');
}

// ══════════════════════════════════════════
// CONTACTS / PEOPLE
// ══════════════════════════════════════════
function saveContact(){
  const first=document.getElementById('contactFirst').value.trim();
  if(!first){showToast('⚠️ First name is required.');return;}
  const roleSelect=document.getElementById('contactRole');
  globalData.contacts.push({
    id:uid(),first,
    last: document.getElementById('contactLast').value.trim(),
    role: roleSelect.value,
    org:  document.getElementById('contactOrg').value.trim(),
    email:document.getElementById('contactEmail').value.trim(),
    phone:document.getElementById('contactPhone').value.trim(),
    notes:document.getElementById('contactNotes').value.trim()
  });
  save();closeModal('addContactModal');renderContacts();showToast('✅ Person saved!');
}

function deleteContact(id){
  if(!confirm('Delete this person?'))return;
  globalData.contacts=globalData.contacts.filter(c=>c.id!==id);
  save();renderContacts();showToast('🗑️ Deleted.');
}

const ROLE_ICONS={'Professor':'👨‍🏫','Tutor':'📖','Teaching Assistant':'📋','Classmate':'🎓','Study Partner':'🤝','Lab Partner':'🔬','Friend':'😊'};

function renderContacts(){
  const grid=document.getElementById('contactsGrid');if(!grid)return;
  const contacts=globalData.contacts||[];
  if(!contacts.length){grid.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><i class="fas fa-user-graduate"></i><p>No people yet. Click <b>Add Person</b>.</p></div>`;return;}
  grid.innerHTML=contacts.map(c=>`
    <div class="contact-card">
      <button class="contact-del" onclick="deleteContact('${c.id}')"><i class="fas fa-times"></i></button>
      <div class="contact-avatar">${c.first[0]}${c.last?c.last[0]:''}</div>
      <div class="contact-name">${esc(c.first)} ${esc(c.last||'')}</div>
      ${c.role?`<div class="contact-role">${ROLE_ICONS[c.role]||'👤'} ${esc(c.role)}</div>`:''}
      ${c.org?`<div class="contact-org">${esc(c.org)}</div>`:''}
      <div class="contact-links">
        ${c.email?`<a href="mailto:${c.email}" class="contact-link" title="${c.email}"><i class="fas fa-envelope"></i></a>`:''}
        ${c.phone?`<a href="tel:${c.phone}" class="contact-link" title="${c.phone}"><i class="fas fa-phone"></i></a>`:''}
      </div>
      ${c.notes?`<div style="font-size:11px;color:var(--text-light);margin-top:6px">${esc(c.notes)}</div>`:''}
    </div>`).join('');
}

// ══════════════════════════════════════════
// HEALTH / DAILY TRACKER
// ══════════════════════════════════════════
function adjustCounter(field,delta){const data=dayData(currentDate);data.health[field]=Math.max(0,(data.health[field]||0)+delta);save();document.getElementById(field+'-count').textContent=data.health[field];}
function loadHealthUI(){const h=dayData(currentDate).health||{};['water','meals','exercise','sleep'].forEach(f=>{const el=document.getElementById(f+'-count');if(el)el.textContent=h[f]||0;});}

// ══════════════════════════════════════════
// MOOD & ENERGY
// ══════════════════════════════════════════
function setMood(field,val,el){dayData(currentDate).mood[field]=val;save();const row=el.closest('.emoji-row');row.querySelectorAll('.emoji-opt').forEach(e=>e.classList.remove('active'));el.classList.add('active');}
function saveEnergy(val){dayData(currentDate).energy=parseInt(val);save();document.getElementById('energyVal').textContent=val;}
function loadMoodUI(){
  const mood=dayData(currentDate).mood||{};
  const mr=document.getElementById('moodMorningRow');
  const er=document.getElementById('moodEveningRow');
  if(mr) mr.querySelectorAll('.emoji-opt').forEach(e=>e.classList.toggle('active',e.dataset.val===mood.moodMorning));
  if(er) er.querySelectorAll('.emoji-opt').forEach(e=>e.classList.toggle('active',e.dataset.val===mood.moodEvening));
}
function loadEnergyUI(){const energy=dayData(currentDate).energy||5;const sl=document.getElementById('energySlider');if(sl)sl.value=energy;const ev=document.getElementById('energyVal');if(ev)ev.textContent=energy;}

// ══════════════════════════════════════════
// STUDY GOALS
// ══════════════════════════════════════════
function addGoal(){const text=prompt('Enter a study goal for today:');if(!text)return;dayData(currentDate).goals.push({id:uid(),text,done:false});save();renderGoals();}
function toggleGoal(id){const g=(dayData(currentDate).goals||[]).find(g=>g.id===id);if(g){g.done=!g.done;save();renderGoals();}}
function deleteGoal(id){const data=dayData(currentDate);data.goals=data.goals.filter(g=>g.id!==id);save();renderGoals();}

function renderGoals(){
  const list=document.getElementById('goalsList');if(!list)return;
  const goals=dayData(currentDate).goals||[];
  if(!goals.length){list.innerHTML=`<div style="color:var(--text-light);font-size:12px;padding:8px">No study goals yet. Click <b>Add Goal</b>.</div>`;return;}
  list.innerHTML=goals.map(g=>`
    <div class="goal-chip ${g.done?'done':''}" onclick="toggleGoal('${g.id}')">
      <i class="fas fa-${g.done?'check-circle':'circle'}" style="color:${g.done?'var(--success)':'var(--primary)'}"></i>
      <span>${esc(g.text)}</span>
      <button class="del-g" onclick="event.stopPropagation();deleteGoal('${g.id}')"><i class="fas fa-times"></i></button>
    </div>`).join('');
}

// ══════════════════════════════════════════
// ANALYTICS
// ══════════════════════════════════════════
function renderAnalytics(){
  const events=getEventsForDate(currentDate);
  const tasks =dayData(currentDate).tasks||[];
  const catMins={};
  events.forEach(e=>{const[sh,sm]=e.start.split(':').map(Number);const[eh,em]=e.end.split(':').map(Number);const m=(eh*60+em)-(sh*60+sm);catMins[e.cat]=(catMins[e.cat]||0)+m;});
  const maxCat=Math.max(1,...Object.values(catMins));
  document.getElementById('catBarChart').innerHTML=Object.entries(catMins).length
    ?Object.entries(catMins).map(([cat,m])=>`<div class="bar-row"><div class="bar-row-label">${CAT_ICONS[cat]} ${cat}</div><div class="bar-track"><div class="bar-fill" style="width:${(m/maxCat*100).toFixed(1)}%;background:${CAT_COLORS[cat]}"></div></div><div class="bar-val">${m>=60?Math.floor(m/60)+'h'+(m%60?m%60+'m':''):m+'m'}</div></div>`).join('')
    :'<div style="color:var(--text-light);font-size:12px">No events yet.</div>';

  const hourLoad=Array(24).fill(0);
  events.forEach(e=>{const[sh]=e.start.split(':').map(Number);hourLoad[sh]++;});
  const maxH=Math.max(1,...hourLoad);
  document.getElementById('hourBarChart').innerHTML=
    hourLoad.map((cnt,h)=>cnt>0?`<div class="bar-row"><div class="bar-row-label">${String(h).padStart(2,'0')}:00</div><div class="bar-track"><div class="bar-fill" style="width:${(cnt/maxH*100).toFixed(1)}%"></div></div><div class="bar-val">${cnt}</div></div>`:'').join('')||'<div style="color:var(--text-light);font-size:12px">No events yet.</div>';

  const h=dayData(currentDate).health||{};
  document.getElementById('healthSummary').innerHTML=`
    <div class="hs-item"><i class="fas fa-tint" style="color:#42A5F5"></i><span>${h.water||0}</span><small>Water Glasses</small></div>
    <div class="hs-item"><i class="fas fa-apple-alt" style="color:#66BB6A"></i><span>${h.meals||0}</span><small>Meals</small></div>
    <div class="hs-item"><i class="fas fa-running" style="color:#FFA726"></i><span>${h.exercise||0}m</span><small>Sport</small></div>
    <div class="hs-item"><i class="fas fa-moon" style="color:#AB47BC"></i><span>${h.sleep||0}h</span><small>Sleep</small></div>`;

  const total=tasks.length+events.length;
  const done=(tasks.filter(t=>t.done).length)+(events.filter(e=>e.done).length);
  const score=total?Math.round((done/total)*100):0;
  document.getElementById('scoreVal').textContent=score+'%';
  document.getElementById('scoreLabel').textContent=score>=80?'🏆 Excellent day!':score>=50?'👍 Good progress!':score>0?'📚 Keep studying!':'No data yet';
}

// ══════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════
function initNotifications(){
  if(!('Notification'in window))return;
  if(Notification.permission==='default') document.getElementById('notifBanner').classList.remove('hidden');
}
function requestNotifPermission(){
  if(!('Notification'in window)){showToast('⚠️ Notifications not supported.');return;}
  Notification.requestPermission().then(perm=>{dismissNotifBanner();showToast(perm==='granted'?'🔔 Notifications enabled!':'🔕 Notifications denied.');});
}
function dismissNotifBanner(){document.getElementById('notifBanner').classList.add('hidden');}

function fireNotification(title,body){
  showReminder(`⏰ ${body}`);
  if('Notification'in window&&Notification.permission==='granted'){
    const n=new Notification('IB Student — '+title,{body,icon:'./icon-192.svg',badge:'./icon-192.svg',tag:'ib-'+uid()});
    n.onclick=()=>{window.focus();n.close();};
    setTimeout(()=>n.close(),10000);
  }
}

function checkReminders(){
  if(!(globalData.settings?.reminders!==false))return;
  if(currentDate!==todayStr())return;
  const now=new Date();
  const nowMins=now.getHours()*60+now.getMinutes();
  (dayData(currentDate).events||[]).forEach(ev=>{
    if(ev.reminded||ev.done)return;
    const[h,m]=ev.start.split(':').map(Number);
    const rem=ev.reminder||0;
    if(rem>0&&nowMins>=(h*60+m)-rem&&nowMins<(h*60+m)){ev.reminded=true;save();fireNotification(ev.title,`"${ev.title}" starts in ${rem} min!`);}
  });
  (globalData.recurring||[]).filter(r=>isRecurringOnDate(r,currentDate)).forEach(r=>{
    const key='rec_reminded_'+r.id+'_'+currentDate;
    if(sessionStorage.getItem(key))return;
    const[h,m]=r.start.split(':').map(Number);
    const rem=r.reminder||0;
    if(rem>0&&nowMins>=(h*60+m)-rem&&nowMins<(h*60+m)){sessionStorage.setItem(key,'1');fireNotification(r.title,`"${r.title}" starts in ${rem} min!`);}
  });
}

function showReminder(text){const bell=document.getElementById('reminderBell');document.getElementById('reminderText').textContent=text;bell.classList.remove('hidden');setTimeout(()=>bell.classList.add('hidden'),12000);}
function dismissReminder(){document.getElementById('reminderBell').classList.add('hidden');}

// ══════════════════════════════════════════
// PWA
// ══════════════════════════════════════════
function initPWA(){
  if('serviceWorker'in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;const btn=document.getElementById('installBtn');if(btn)btn.classList.remove('hidden');});
  window.addEventListener('appinstalled',()=>{const btn=document.getElementById('installBtn');if(btn)btn.classList.add('hidden');deferredInstall=null;showToast('📱 App installed!',4000);});
}
function installApp(){
  if(!deferredInstall){showToast('ℹ️ Open in Chrome/Edge and click the install icon in the address bar.',4000);return;}
  deferredInstall.prompt();
  deferredInstall.userChoice.then(()=>{deferredInstall=null;});
}

// ══════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════
function saveSettings(){
  if(!globalData.settings)globalData.settings={};
  globalData.settings.name      =document.getElementById('settingName').value.trim();
  globalData.settings.workStart =document.getElementById('settingWorkStart').value;
  globalData.settings.workEnd   =document.getElementById('settingWorkEnd').value;
  globalData.settings.theme     =document.getElementById('settingTheme').value;
  globalData.settings.reminders =document.getElementById('settingReminders').checked;
  save();applyTheme(globalData.settings.theme);closeModal('settingsModal');showToast('⚙️ Settings saved!');
}
function loadSettings(){
  const s=globalData.settings||{};
  if(s.name)      document.getElementById('settingName').value     =s.name;
  if(s.workStart) document.getElementById('settingWorkStart').value=s.workStart;
  if(s.workEnd)   document.getElementById('settingWorkEnd').value  =s.workEnd;
  if(s.theme)     document.getElementById('settingTheme').value    =s.theme;
  document.getElementById('settingReminders').checked=s.reminders!==false;
  applyTheme(s.theme||'blue');
}
function applyTheme(theme){document.body.dataset.theme=theme==='blue'?'':theme;}

// ══════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════
function exportData(){
  const blob=new Blob([JSON.stringify({db,globalData},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=`IB-Student-Planner-${currentDate}.json`;a.click();
  URL.revokeObjectURL(url);showToast('📥 Data exported!');
}

// ══════════════════════════════════════════
// MODALS
// ══════════════════════════════════════════
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
document.addEventListener('click',e=>{if(e.target.classList.contains('modal-overlay'))e.target.classList.remove('open');});

// ══════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════
let toastTimer;
function showToast(msg,dur=2800){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),dur);
}

// ══════════════════════════════════════════
// USER BADGE & DROPDOWN MENU
// ══════════════════════════════════════════
function initUserBadge() {
  const user = CURRENT_USER;
  if (!user) return;
  const initial = (user.displayName || 'U').charAt(0).toUpperCase();
  const name    = user.displayName || user.username || 'User';
  const role    = (user.role === 'teacher') ? 'Teacher / Dr.' : 'Student';
  const roleIcon= (user.role === 'teacher') ? 'fa-chalkboard-teacher' : 'fa-user-graduate';

  const avatarEl = document.getElementById('userAvatar');
  const nameEl   = document.getElementById('userName');
  const udAvatar = document.getElementById('udAvatar');
  const udName   = document.getElementById('udName');
  const udRole   = document.getElementById('udRole');

  if (avatarEl) avatarEl.textContent = initial;
  if (nameEl)   nameEl.textContent   = name;
  if (udAvatar) udAvatar.textContent = initial;
  if (udName)   udName.textContent   = name;
  if (udRole)   udRole.innerHTML     = `<i class="fas ${roleIcon}"></i> ${role}`;
}

function toggleUserDropdown(e) {
  if (e) e.stopPropagation();
  const container = document.getElementById('userMenuContainer');
  if (container) container.classList.toggle('open');
}

function closeUserDropdown() {
  const container = document.getElementById('userMenuContainer');
  if (container) container.classList.remove('open');
}

document.addEventListener('click', (e) => {
  const container = document.getElementById('userMenuContainer');
  if (container && !container.contains(e.target)) {
    container.classList.remove('open');
  }
});

function logout() {
  closeUserDropdown();
  if (!confirm('Sign out of IB Student Planner?')) return;
  if (typeof firebase !== 'undefined' && firebase.apps.length) {
    firebase.auth().signOut().catch(() => {});
  }
  sessionStorage.removeItem('ib_session');
  localStorage.removeItem('ib_remember');
  window.location.replace('login.html');
}

// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded',()=>{

  // ── One-time cleanup: wipe old auto-seeded data ──
  const cleaned = localStorage.getItem('ib_cleaned_v3');
  if (!cleaned) {
    localStorage.removeItem('ib_db');
    localStorage.removeItem('ib_global');
    localStorage.removeItem('ib_seeded_v2');
    localStorage.removeItem('ib_student_seeded');
    localStorage.removeItem('ib_student_seeded_v2');
    localStorage.setItem('ib_cleaned_v3','1');
  }

  load();loadSettings();startClock();initNav();initPWA();initNotifications();
  initUserBadge();
  initCloudSync();

  currentDate=todayStr();
  document.getElementById('dayPicker').value=currentDate;
  document.getElementById('evStartDate').value=currentDate;
  currentWeekStart=getWeekStart(new Date());
  const now=new Date();
  currentMonth={year:now.getFullYear(),month:now.getMonth()};

  refreshAll();renderTasks();renderNotes();renderContacts();

  const name = CURRENT_USER ? CURRENT_USER.displayName : '';
  showToast(`🎓 Welcome${name?' back, '+name:''}! Cloud sync active.`, 4000);
});


