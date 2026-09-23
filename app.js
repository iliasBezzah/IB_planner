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
let CURRENT_USER = getCurrentUser();
let USER_KEY     = CURRENT_USER ? (CURRENT_USER.username || CURRENT_USER.email || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '_') : 'guest';

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
// PERSISTENCE & REAL-TIME CROSS-DEVICE CLOUD SYNC
// ══════════════════════════════════════════
let cloudSyncTimer = null;
let lastCloudSyncTime = 0;
let unsubscribeCloudSync = null;

// Canonical document IDs guaranteed across PC, Phone, and Tablet
function getCloudDocIds() {
  const u = getCurrentUser() || CURRENT_USER;
  if (!u) return ['guest'];
  const ids = [];
  const username = u.username || (u.email ? u.email.split('@')[0] : null);
  if (username) {
    const cleanUser = username.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');
    ids.push('user_' + cleanUser);
    ids.push(cleanUser);
  }
  if (u.uid) {
    ids.push(u.uid);
  }
  return [...new Set(ids)];
}

function getCloudDocId() {
  return getCloudDocIds()[0] || 'guest';
}

function save(immediateSync = false) {
  // 1. Instant local persistence for fast UI
  try {
    localStorage.setItem('ib_db_'     + USER_KEY, JSON.stringify(db));
    localStorage.setItem('ib_global_' + USER_KEY, JSON.stringify(globalData));
  } catch (e) {
    console.warn('Local save warning:', e);
  }

  // 2. Real-time Cross-Device Cloud Sync
  if (typeof firebase !== 'undefined' && firebase.apps.length && CURRENT_USER) {
    clearTimeout(cloudSyncTimer);
    if (immediateSync) {
      syncToCloud();
    } else {
      cloudSyncTimer = setTimeout(() => {
        syncToCloud();
      }, 300);
    }
  }
}

async function syncToCloud() {
  try {
    if (typeof firebase === 'undefined' || !firebase.apps.length) return;
    const docIds = getCloudDocIds();
    if (!docIds.length) return;

    updateSyncIndicator('syncing');
    const now = Date.now();
    lastCloudSyncTime = now;

    const u = getCurrentUser() || CURRENT_USER || {};
    const username = (u.username || (u.email ? u.email.split('@')[0] : '')).toLowerCase().trim();

    const payload = {
      db: JSON.stringify(db),
      globalData: JSON.stringify(globalData),
      updatedAt: now,
      username: username,
      email: u.email || '',
      displayName: u.displayName || u.name || username,
      lastDevice: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop'
    };

    // Save simultaneously to all alias documents so both new and older versions sync
    await Promise.allSettled(docIds.map(id =>
      firebase.firestore().collection('userData').doc(id).set(payload, { merge: true })
    ));

    updateSyncIndicator(true);
  } catch (err) {
    console.warn('Cloud sync error:', err);
    updateSyncIndicator(false);
  }
}

async function pullFromCloud(silent = false) {
  if (typeof firebase === 'undefined' || !firebase.apps.length) return;
  const docIds = getCloudDocIds();
  if (!docIds.length) return;

  updateSyncIndicator('syncing');

  try {
    // Fetch all candidate documents in parallel
    const docs = await Promise.all(
      docIds.map(id => firebase.firestore().collection('userData').doc(id).get().catch(() => null))
    );

    const validDocs = docs.filter(d => d && d.exists && d.data());

    if (validDocs.length > 0) {
      // Pick the document with the richest data or newest update
      let bestData = null;
      let maxScore = -1;

      for (const d of validDocs) {
        const data = d.data();
        let score = (data.updatedAt || 0);
        let items = 0;
        if (data.globalData) {
          try {
            const g = JSON.parse(data.globalData);
            items += (g.recurring || []).length * 10;
            items += (g.contacts || []).length;
          } catch(e) {}
        }
        if (data.db) {
          try {
            const dObj = JSON.parse(data.db);
            for (const k in dObj) {
              items += (dObj[k].events || []).length;
              items += (dObj[k].tasks || []).length;
            }
          } catch(e) {}
        }
        // Heavily weight actual data items so empty overwrite documents are rejected
        const totalScore = items * 1000000000000 + score;
        if (totalScore > maxScore) {
          maxScore = totalScore;
          bestData = data;
        }
      }

      if (bestData) {
        applyCloudData(bestData, silent);
      }
      updateSyncIndicator(true);
    } else {
      if (Object.keys(db).length > 0 || (globalData.recurring && globalData.recurring.length)) {
        await syncToCloud();
      }
      updateSyncIndicator(true);
    }
  } catch (err) {
    console.warn('pullFromCloud error:', err);
    updateSyncIndicator(false);
    if (!silent) {
      showToast('⚠️ Cloud sync offline. Using local copy.');
    }
  }
}

function mergeDatabases(localDb, cloudDb) {
  const merged = { ...cloudDb };
  for (const date in localDb) {
    if (!merged[date]) {
      merged[date] = localDb[date];
    } else {
      const cloudEvents = merged[date].events || [];
      const localEvents = localDb[date].events || [];
      const evMap = new Map();
      cloudEvents.forEach(e => { if (e && e.id) evMap.set(e.id, e); });
      localEvents.forEach(e => {
        if (e && e.id && !evMap.has(e.id)) evMap.set(e.id, e);
      });
      merged[date].events = Array.from(evMap.values()).sort((a,b) => (a.start||'').localeCompare(b.start||''));

      const cloudTasks = merged[date].tasks || [];
      const localTasks = localDb[date].tasks || [];
      const tMap = new Map();
      cloudTasks.forEach(t => { if (t && t.id) tMap.set(t.id, t); });
      localTasks.forEach(t => {
        if (t && t.id && !tMap.has(t.id)) tMap.set(t.id, t);
      });
      merged[date].tasks = Array.from(tMap.values());

      const cloudGoals = merged[date].goals || [];
      const localGoals = localDb[date].goals || [];
      const gMap = new Map();
      cloudGoals.forEach(g => { if (g && g.id) gMap.set(g.id, g); });
      localGoals.forEach(g => {
        if (g && g.id && !gMap.has(g.id)) gMap.set(g.id, g);
      });
      merged[date].goals = Array.from(gMap.values());
    }
  }
  return merged;
}

function mergeGlobalData(localG, cloudG) {
  const merged = { ...cloudG, ...localG };
  const rMap = new Map();
  (cloudG.recurring || []).forEach(r => { if (r && r.id) rMap.set(r.id, r); });
  (localG.recurring || []).forEach(r => { if (r && r.id && !rMap.has(r.id)) rMap.set(r.id, r); });
  merged.recurring = Array.from(rMap.values());

  const cMap = new Map();
  (cloudG.contacts || []).forEach(c => { if (c && c.id) cMap.set(c.id, c); });
  (localG.contacts || []).forEach(c => { if (c && c.id && !cMap.has(c.id)) cMap.set(c.id, c); });
  merged.contacts = Array.from(cMap.values());

  return merged;
}

function applyCloudData(data, silent = false) {
  let changed = false;
  const cloudTime = data.updatedAt || 0;

  if (data.db) {
    try {
      const cloudDb = JSON.parse(data.db);
      if (JSON.stringify(cloudDb) !== JSON.stringify(db)) {
        if (cloudTime >= lastCloudSyncTime || Object.keys(db).length === 0) {
          db = cloudDb;
        } else {
          db = mergeDatabases(db, cloudDb);
        }
        localStorage.setItem('ib_db_' + USER_KEY, JSON.stringify(db));
        changed = true;
      }
    } catch (e) { console.warn('Cloud db parse error:', e); }
  }

  if (data.globalData) {
    try {
      const cloudGlobal = JSON.parse(data.globalData);
      if (JSON.stringify(cloudGlobal) !== JSON.stringify(globalData)) {
        if (cloudTime >= lastCloudSyncTime || !(globalData.recurring && globalData.recurring.length)) {
          globalData = cloudGlobal;
        } else {
          globalData = mergeGlobalData(globalData, cloudGlobal);
        }
        localStorage.setItem('ib_global_' + USER_KEY, JSON.stringify(globalData));
        changed = true;
      }
    } catch (e) { console.warn('Cloud global parse error:', e); }
  }

  if (changed) {
    refreshAll();
    if (document.getElementById('view-week')?.classList.contains('active')) renderWeek();
    if (document.getElementById('view-month')?.classList.contains('active')) renderMonth();
    if (document.getElementById('view-timeline')?.classList.contains('active')) renderTimeline();
    renderTasks();
    renderNotes();
    renderContacts();
    renderAnalytics();
    if (!silent) {
      showToast('☁️ Synced with all your devices!');
    }
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
  const docId = getCloudDocId();
  if (!docId) return;

  // 1. Pull latest cloud data immediately
  pullFromCloud(true);

  // 2. Real-time live updates
  try {
    if (unsubscribeCloudSync) unsubscribeCloudSync();
    unsubscribeCloudSync = firebase.firestore().collection('userData').doc(docId).onSnapshot(doc => {
      if (doc.exists) {
        applyCloudData(doc.data(), true);
        updateSyncIndicator(true);
      }
    }, err => {
      console.warn('Snapshot sync error:', err);
      updateSyncIndicator(false);
    });
  } catch (e) {
    console.warn('initCloudSync exception:', e);
  }

  // 3. Auto-sync on visibility change (mobile phone wake-up / app switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      pullFromCloud(true);
    }
  });
  window.addEventListener('focus', () => {
    pullFromCloud(true);
  });
  window.addEventListener('online', () => {
    pullFromCloud(false);
  });
}

function updateSyncIndicator(status) {
  const icon = document.getElementById('cloudSyncStatus');
  const text = document.getElementById('syncStatusText');
  const btn  = document.getElementById('cloudSyncBtn');

  if (!icon) return;

  if (status === 'syncing') {
    icon.className = 'fas fa-sync fa-spin';
    icon.style.color = '#0288D1';
    if (text) text.textContent = 'Syncing…';
    if (btn) btn.title = 'Syncing with Cloud…';
  } else if (status === true) {
    icon.className = 'fas fa-cloud';
    icon.style.color = '#4CAF50';
    if (text) text.textContent = 'Synced';
    if (btn) btn.title = `Cloud Sync: Active (${getCloudDocId()}). Click to refresh now.`;
  } else {
    icon.className = 'fas fa-cloud-rain';
    icon.style.color = '#FFA000';
    if (text) text.textContent = 'Offline';
    if (btn) btn.title = 'Cloud Sync: Offline. Click to reconnect.';
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
      <div class="recurring-item" onclick="openCourseDetails('${r.id}')" style="cursor:pointer;" title="Tap to open Course Details, Projects & Assignments">
        <div style="width:5px;border-radius:3px;background:${r.color||CAT_COLORS[r.cat]||'#1565C0'};min-height:44px;flex-shrink:0;align-self:stretch"></div>
        <div class="recurring-item-body">
          <div class="recurring-item-title">${CAT_ICONS[r.cat]||'📌'} ${esc(r.title)}</div>
          <div class="recurring-item-meta">${r.start}–${r.end} &nbsp;|&nbsp; ${rule}${until}</div>
          ${r.location?`<div class="recurring-item-meta"><i class="fas fa-map-marker-alt"></i> ${esc(r.location)}</div>`:''}
        </div>
        <div class="recurring-item-actions" onclick="event.stopPropagation()">
          <button class="recurring-item-edit" title="Edit Routine Class" onclick="editRecurringClass('${r.id}')">
            <i class="fas fa-edit"></i>
          </button>
          <button class="recurring-item-del" title="Delete" onclick="deleteRecurring('${r.id}');renderRecurringList();refreshAll();showToast('🗑️ Removed.');">
            <i class="fas fa-trash"></i>
          </button>
        </div>
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
    const clockEl = document.getElementById('liveClock');
    if (clockEl) {
      clockEl.textContent = n.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
    const dateEl = document.getElementById('liveDate');
    if (dateEl) {
      dateEl.textContent = n.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    }
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
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      switchView(btn.dataset.view);
    };
  });
}

function switchView(v) {
  if (!v) return;
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === v);
  });
  document.querySelectorAll('.view').forEach(s => {
    s.classList.toggle('active', s.id === 'view-' + v);
  });

  if (v === 'dashboard')  {
    refreshAll();
    applyRoleUI();
  }
  else if (v === 'week')  { renderWeek(); }
  else if (v === 'month') { renderMonth(); }
  else if (v === 'timeline') { renderTimeline(); }
  else if (v === 'tasks') { renderTasks(); }
  else if (v === 'notes') { renderNotes(); }
  else if (v === 'contacts') { renderContacts(); }
  else if (v === 'analytics') { renderAnalytics(); }
}

// ══════════════════════════════════════════
// DAY NAVIGATION
// ══════════════════════════════════════════
function loadDay() {
  const dp = document.getElementById('dayPicker');
  currentDate = (dp && dp.value) ? dp.value : todayStr();
  refreshAll();
}
function changeDay(delta) {
  currentDate = offset(currentDate, delta);
  const dp = document.getElementById('dayPicker');
  if (dp) dp.value = currentDate;
  refreshAll();
}
function goToday() {
  currentDate = todayStr();
  const dp = document.getElementById('dayPicker');
  if (dp) dp.value = currentDate;
  refreshAll();
}
function refreshAll() {
  updateDayLabel();
  if (isTeacherRole()) {
    renderTeacherDashboard();
  } else {
    renderSchedule();
    renderStats();
    loadHealthUI();
    loadMoodUI();
    loadEnergyUI();
    renderGoals();
  }
}
function updateDayLabel() {
  const el = document.getElementById('dayLabel');
  if (el) el.textContent = formatDateLong(currentDate);
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
  document.getElementById('editEventId').value = '';
  const recurInput = document.getElementById('editRecurId');
  if (recurInput) recurInput.value = '';
  document.getElementById('eventModalTitle').innerHTML = '<i class="fas fa-calendar-plus"></i> Add to Timetable';
  document.getElementById('evTitle').value       = '';
  document.getElementById('evStart').value       = '';
  document.getElementById('evEnd').value         = '';
  document.getElementById('evCat').value         = 'lecture';
  document.getElementById('evLocation').value    = '';
  document.getElementById('evPriority').value    = 'normal';
  document.getElementById('evReminder').value    = '15';
  document.getElementById('evNotes').value       = '';
  document.getElementById('evRepeat').value      = 'none';
  document.getElementById('evStartDate').value   = dateForNew || currentDate;
  document.getElementById('evRepeatUntil').value = '';
  document.querySelectorAll('.wday-cb').forEach(cb => cb.checked = false);
  document.getElementById('weekdaysGroup').classList.add('hidden');
  selectedColor = '#1565C0';
  document.querySelectorAll('#evColor .color-dot').forEach((d,i) => d.classList.toggle('selected', i === 0));
  const body = document.getElementById('recurringBody');
  body.classList.add('hidden');
  body.previousElementSibling.classList.remove('open');
  openModal('addEventModal');
}

function saveEvent() {
  const title = document.getElementById('evTitle').value.trim();
  const start = document.getElementById('evStart').value;
  const end   = document.getElementById('evEnd').value;
  if (!title || !start || !end) { showToast('⚠️ Title, start and end time are required.'); return; }
  if (start >= end)             { showToast('⚠️ End time must be after start time.'); return; }

  const editId      = document.getElementById('editEventId').value;
  const recurInput  = document.getElementById('editRecurId');
  const editRecurId = recurInput ? recurInput.value : '';

  const repeat    = document.getElementById('evRepeat').value;
  const startDate = document.getElementById('evStartDate').value || currentDate;
  const endDate   = document.getElementById('evRepeatUntil').value;
  const cat       = document.getElementById('evCat').value;
  const location  = document.getElementById('evLocation').value.trim();
  const priority  = document.getElementById('evPriority').value;
  const reminder  = parseInt(document.getElementById('evReminder').value) || 0;
  const notes     = document.getElementById('evNotes').value.trim();

  // If recurring (daily, weekly, monthly)
  if (repeat && repeat !== 'none') {
    const days = [];
    document.querySelectorAll('.wday-cb:checked').forEach(cb => days.push(parseInt(cb.value)));
    if (repeat === 'weekly' && days.length === 0) {
      showToast('⚠️ Please select at least one day.');
      return;
    }
    const rec = {
      id: editRecurId || uid(),
      title, start, end, cat, location, priority, reminder, notes,
      color: selectedColor,
      freq: repeat, days, startDate, endDate: endDate || null
    };

    saveRecurring(rec);

    // If it was previously a single event, remove it
    if (editId) {
      const data = dayData(currentDate);
      data.events = data.events.filter(e => e.id !== editId);
      save();
    }

    closeModal('addEventModal');
    refreshAll();
    if (document.getElementById('view-week').classList.contains('active'))  renderWeek();
    if (document.getElementById('view-month').classList.contains('active')) renderMonth();
    showToast(editRecurId ? '🔁 Routine class updated!' : '🔁 Routine class saved!');
    return;
  }

  // If it was a recurring class and user turned repeat to "none"
  if (editRecurId && (!repeat || repeat === 'none')) {
    deleteRecurring(editRecurId);
  }

  // Single day event save / update
  const data = dayData(currentDate);
  const ev = {
    id: editId || uid(),
    title, start, end, cat, location, priority, reminder, notes,
    color: selectedColor, done: false, reminded: false
  };

  if (editId) {
    const idx = data.events.findIndex(e => e.id === editId);
    if (idx >= 0) { ev.done = data.events[idx].done; data.events[idx] = ev; }
    else { data.events.push(ev); }
  } else {
    data.events.push(ev);
  }

  data.events.sort((a, b) => a.start.localeCompare(b.start));
  save();
  closeModal('addEventModal');
  renderSchedule();
  renderStats();
  if (document.getElementById('view-week').classList.contains('active'))  renderWeek();
  if (document.getElementById('view-month').classList.contains('active')) renderMonth();
  showToast(editId ? '✏️ Class updated!' : '✅ Added to timetable!');
}

function editEvent(id) {
  if (!id) return;
  const recurInput = document.getElementById('editRecurId');

  // If this is an instance of a recurring class (e.g. "rec123_2026-09-18")
  if (id.includes('_')) {
    const recurId = id.split('_')[0];
    editRecurringClass(recurId);
    return;
  }

  const ev = dayData(currentDate).events.find(e => e.id === id);
  if (!ev) return;

  document.getElementById('editEventId').value = ev.id;
  if (recurInput) recurInput.value = '';
  document.getElementById('eventModalTitle').innerHTML = '<i class="fas fa-edit"></i> Edit Event';
  document.getElementById('evTitle').value      = ev.title;
  document.getElementById('evStart').value      = ev.start;
  document.getElementById('evEnd').value        = ev.end;
  document.getElementById('evCat').value        = ev.cat;
  document.getElementById('evLocation').value   = ev.location || '';
  document.getElementById('evPriority').value   = ev.priority;
  document.getElementById('evReminder').value   = ev.reminder || '15';
  document.getElementById('evNotes').value      = ev.notes || '';
  document.getElementById('evRepeat').value     = 'none';
  document.getElementById('weekdaysGroup').classList.add('hidden');
  const body = document.getElementById('recurringBody');
  body.classList.add('hidden');
  body.previousElementSibling.classList.remove('open');

  selectedColor = ev.color || '#1565C0';
  document.querySelectorAll('#evColor .color-dot').forEach(d =>
    d.classList.toggle('selected', d.dataset.color === selectedColor));

  openModal('addEventModal');
}

function editRecurringClass(recurId) {
  const r = (globalData.recurring || []).find(item => item.id === recurId);
  if (!r) {
    showToast('⚠️ Routine class not found.');
    return;
  }
  closeModal('recurringModal');

  document.getElementById('editEventId').value = '';
  const recurInput = document.getElementById('editRecurId');
  if (recurInput) recurInput.value = r.id;

  document.getElementById('eventModalTitle').innerHTML = '<i class="fas fa-edit"></i> Edit Routine Class';
  document.getElementById('evTitle').value      = r.title;
  document.getElementById('evStart').value      = r.start;
  document.getElementById('evEnd').value        = r.end;
  document.getElementById('evCat').value        = r.cat || 'lecture';
  document.getElementById('evLocation').value   = r.location || '';
  document.getElementById('evPriority').value   = r.priority || 'normal';
  document.getElementById('evReminder').value   = r.reminder || '15';
  document.getElementById('evNotes').value      = r.notes || '';

  // Expand recurring section and pre-fill
  document.getElementById('evRepeat').value     = r.freq || 'weekly';
  const body = document.getElementById('recurringBody');
  body.classList.remove('hidden');
  body.previousElementSibling.classList.add('open');

  document.getElementById('evStartDate').value  = r.startDate || currentDate;
  document.getElementById('evRepeatUntil').value= r.endDate || '';

  const isWeekly = (r.freq === 'weekly');
  document.getElementById('weekdaysGroup').classList.toggle('hidden', !isWeekly);
  document.querySelectorAll('.wday-cb').forEach(cb => {
    cb.checked = (r.days || []).includes(parseInt(cb.value));
  });

  selectedColor = r.color || CAT_COLORS[r.cat] || '#1565C0';
  document.querySelectorAll('#evColor .color-dot').forEach(d =>
    d.classList.toggle('selected', d.dataset.color === selectedColor));

  openModal('addEventModal');
}

function deleteEvent(id) {
  if (!id) return;
  if (id.includes('_')) {
    const recurId = id.split('_')[0];
    if (!confirm('Delete this routine class from your timetable? This will remove all recurring instances.')) return;
    deleteRecurring(recurId);
    refreshAll();
    if (document.getElementById('view-week').classList.contains('active'))  renderWeek();
    if (document.getElementById('view-month').classList.contains('active')) renderMonth();
    showToast('🗑️ Routine class deleted.');
    return;
  }
  if (!confirm('Delete this event?')) return;
  const data = dayData(currentDate);
  data.events = data.events.filter(e => e.id !== id);
  save(); renderSchedule(); renderStats();
  if (document.getElementById('view-week').classList.contains('active'))  renderWeek();
  if (document.getElementById('view-month').classList.contains('active')) renderMonth();
  showToast('🗑️ Event deleted.');
}

function toggleEventDone(id) {
  if (id.includes('_')) return;
  const ev = dayData(currentDate).events.find(e => e.id === id);
  if (ev) { ev.done = !ev.done; save(); renderSchedule(); renderStats(); }
}

function quickAdd() {
  const title = document.getElementById('quickTitle').value.trim();
  if (!title) { showToast('⚠️ Enter a title first.'); return; }
  const start = document.getElementById('quickStart').value;
  const end   = document.getElementById('quickEnd').value;
  const cat   = document.getElementById('quickCat').value;
  if (start >= end) { showToast('⚠️ End time must be after start.'); return; }
  const data = dayData(currentDate);
  data.events.push({ id: uid(), title, start, end, cat, color: CAT_COLORS[cat] || '#1565C0', priority: 'normal', done: false, reminded: false });
  data.events.sort((a, b) => a.start.localeCompare(b.start));
  document.getElementById('quickTitle').value = '';
  save(); renderSchedule(); renderStats();
  showToast('⚡ Added to timetable!');
}

function renderSchedule() {
  const list   = document.getElementById('scheduleList');
  if (!list) return;
  const filter = document.getElementById('filterCategory')?.value || 'all';
  let events   = getEventsForDate(currentDate);
  if (filter !== 'all') events = events.filter(e => e.cat === filter);

  if (!events.length) {
    const recs = globalData.recurring || [];
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    // Find next upcoming day that has routine classes
    let nextDateWithClass = null;
    let nextClassTitle = '';
    if (recs.length > 0) {
      for (let i = 1; i <= 14; i++) {
        const testDate = offset(currentDate, i);
        const testEvents = getEventsForDate(testDate);
        if (testEvents.length > 0) {
          nextDateWithClass = testDate;
          nextClassTitle = testEvents[0].title;
          break;
        }
      }
    }

    let routineHtml = '';
    if (recs.length > 0) {
      routineHtml = `
        <div class="empty-routine-box">
          <div class="erb-header"><i class="fas fa-redo"></i> You have ${recs.length} routine class${recs.length > 1 ? 'es' : ''} configured:</div>
          <div class="erb-list">
            ${recs.map(r => `
              <div class="erb-item" onclick="openCourseDetails('${r.id}')" title="Tap to view course assignments, project tracker & notes">
                <span class="erb-dot" style="background:${r.color || CAT_COLORS[r.cat] || '#1565C0'}"></span>
                <div class="erb-info">
                  <span class="erb-title">${CAT_ICONS[r.cat] || '📌'} ${esc(r.title)}</span>
                  <span class="erb-meta">${r.start}–${r.end} &bull; ${r.freq === 'weekly' ? (r.days||[]).map(d => dayNames[d]).join(', ') : r.freq}</span>
                </div>
                <button class="erb-edit-btn" title="Edit this routine class" onclick="event.stopPropagation();editRecurringClass('${r.id}')"><i class="fas fa-edit"></i> Edit</button>
              </div>
            `).join('')}
          </div>
          <div class="erb-actions">
            ${nextDateWithClass ? `
              <button class="btn-primary btn-sm" onclick="goToDate('${nextDateWithClass}')">
                <i class="fas fa-arrow-right"></i> View Next Class: ${esc(nextClassTitle)} (${formatDateShort(nextDateWithClass)})
              </button>
            ` : ''}
            <button class="btn-secondary btn-sm" onclick="renderRecurringList(); openModal('recurringModal');">
              <i class="fas fa-sliders-h"></i> Manage Routine Classes
            </button>
          </div>
        </div>`;
    }

    list.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-calendar-day"></i>
        <p>No classes scheduled for <b>${formatDateLong(currentDate)}</b>.</p>
        ${routineHtml}
      </div>`;
    return;
  }
  list.innerHTML = events.map(ev => `
    <div class="event-card ${ev.done ? 'done' : ''} ${ev.isRecurring ? 'is-recurring' : ''}" onclick="openCourseDetails('${ev.recurId || ev.id}')" title="Tap to view course assignments, project tracker & notes">
      <div class="event-stripe" style="background:${ev.color || CAT_COLORS[ev.cat] || '#1565C0'}"></div>
      <div class="ev-body">
        <div class="ev-title">
          ${CAT_ICONS[ev.cat] || '📌'} ${esc(ev.title)}
          ${ev.isRecurring ? '<span class="ev-recurring-badge"><i class="fas fa-redo"></i> Routine</span>' : ''}
          ${ev.classCode ? `<span class="badge-enrolled-course" title="Class Code: ${esc(ev.classCode)}"><i class="fas fa-university"></i> ${esc(ev.instructorName || ev.classCode)}</span>` : ''}
        </div>
        <div class="ev-meta">
          <span class="ev-time"><i class="fas fa-clock"></i> ${ev.start}–${ev.end} (${dur(ev.start, ev.end)})</span>
          <span class="ev-cat-badge" style="background:${CAT_COLORS[ev.cat] || '#1565C0'}">${ev.cat}</span>
          ${ev.priority === 'high' ? '<span class="ev-priority">🔴 Urgent</span>' : ''}
          ${ev.priority === 'low' ? '<span class="ev-priority">🟢 Low</span>' : ''}
          ${ev.location ? `<span class="ev-location"><i class="fas fa-map-marker-alt"></i> ${esc(ev.location)}</span>` : ''}
        </div>
        ${ev.notes ? `<div style="font-size:11px;color:var(--text-light);margin-top:3px">${esc(ev.notes)}</div>` : ''}
      </div>
      <div class="ev-actions" onclick="event.stopPropagation()">
        <button class="ev-btn edit-btn" title="Edit Class Schedule" onclick="editEvent('${ev.id}')"><i class="fas fa-edit"></i></button>
        ${!ev.isRecurring ? `<button class="ev-btn done-btn" title="${ev.done ? 'Undo' : 'Mark done'}" onclick="toggleEventDone('${ev.id}')"><i class="fas fa-${ev.done ? 'undo' : 'check'}"></i></button>` : ''}
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
                 onclick="openCourseDetails('${ev.recurId || ev.id}')"
                 title="Tap to view course assignments, project tracker & notes">
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
function goToDate(dateStr){if(!dateStr)return;currentDate=dateStr;const dp=document.getElementById('dayPicker');if(dp)dp.value=currentDate;switchView('dashboard');refreshAll();}

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

function goToDate(dateStr){currentDate=dateStr;document.getElementById('dayPicker').value=currentDate;switchView('dashboard');}

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
          <div class="tl-event" style="background:${ev.color||CAT_COLORS[ev.cat]||'#1565C0'};opacity:${ev.done?.55:1}" onclick="openCourseDetails('${ev.recurId || ev.id}')" title="Tap to view course assignments, project tracker & notes">
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

function toggleTask(id){
  const t = dayData(currentDate).tasks.find(t=>t.id===id);
  if(t){
    t.done = !t.done;
    (globalData.recurring || []).forEach(c => {
      const ca = (c.assignments || []).find(a => a.id === id);
      if (ca) ca.done = t.done;
    });
    save();
    renderTasks();
    renderStats();
  }
}

function deleteTask(id){
  if(!confirm('Delete this assignment?'))return;
  const data = dayData(currentDate);
  data.tasks = data.tasks.filter(t=>t.id!==id);
  (globalData.recurring || []).forEach(c => {
    if (c.assignments) c.assignments = c.assignments.filter(a => a.id !== id);
  });
  save();
  renderTasks();
  renderStats();
  showToast('🗑️ Deleted.');
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
  updateNotifSettingsUI();
  if(!('Notification' in window)) return;
  if(Notification.permission === 'default') {
    const banner = document.getElementById('notifBanner');
    if (banner) banner.classList.remove('hidden');
  }
}

function updateNotifSettingsUI() {
  const statusEl = document.getElementById('notifStatusText');
  if (!statusEl) return;
  if (!('Notification' in window)) {
    statusEl.innerHTML = '<span style="color:#C62828">⚠️ Not supported in this browser</span>';
    return;
  }
  const p = Notification.permission;
  if (p === 'granted') {
    statusEl.innerHTML = '<span style="color:#2E7D32;font-weight:600"><i class="fas fa-check-circle"></i> Permissions Granted &amp; Active</span>';
  } else if (p === 'denied') {
    statusEl.innerHTML = '<span style="color:#C62828;font-weight:600"><i class="fas fa-times-circle"></i> Blocked by browser settings</span>';
  } else {
    statusEl.innerHTML = '<span style="color:#FFA000;font-weight:600"><i class="fas fa-question-circle"></i> Permission not requested yet</span>';
  }
}

async function requestNotifPermission(){
  if(!('Notification' in window)){
    showToast('⚠️ Notifications are not supported by this browser.');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    dismissNotifBanner();
    updateNotifSettingsUI();
    if(perm === 'granted'){
      showToast('🔔 Notifications enabled successfully!');
      fireNotification('Notifications Active', 'You will receive alerts for upcoming classes, deadlines, and project milestones.', { tag: 'welcome-alert' });
    } else if(perm === 'denied'){
      showToast('🔕 Notifications were blocked. To enable them, allow notifications in site settings.', 5000);
    }
  } catch(err) {
    console.warn('requestNotifPermission error:', err);
    showToast('⚠️ Permission error: ' + (err.message || 'Failed'));
  }
}

function dismissNotifBanner(){
  const banner = document.getElementById('notifBanner');
  if (banner) banner.classList.add('hidden');
}

// Subtle audio chime via Web Audio API (cross-platform, zero external file dependency)
function playNotificationChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch(e) {}
}

async function fireNotification(title, body, data = {}){
  showReminder(body);
  playNotificationChime();

  if(!('Notification' in window) || Notification.permission !== 'granted') return;

  const notifTitle = 'IB Student — ' + title;
  const options = {
    body,
    icon: './icon-192.svg',
    badge: './icon-192.svg',
    vibrate: [200, 100, 200],
    tag: data.tag || 'ib-' + uid(),
    data: Object.assign({ url: './index.html' }, data)
  };

  // 1. Try ServiceWorkerRegistration.showNotification (standard on Android Chrome & iOS Safari PWA)
  if('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg && reg.showNotification) {
        await reg.showNotification(notifTitle, options);
        return;
      }
    } catch(e) {
      console.warn('SW showNotification fallback:', e);
    }
  }

  // 2. Fallback to desktop window Notification constructor
  try {
    const n = new Notification(notifTitle, options);
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => { try { n.close(); } catch(e){} }, 10000);
  } catch(err) {
    console.warn('Standard Notification fallback note:', err);
  }
}

async function testNotification(){
  if(!('Notification' in window)){
    showToast('⚠️ Notifications are not supported in this browser.');
    return;
  }
  if(Notification.permission !== 'granted'){
    const perm = await Notification.requestPermission();
    updateNotifSettingsUI();
    if(perm !== 'granted'){
      showToast('⚠️ Please allow notification permission in your browser to test alerts.');
      return;
    }
  }
  showToast('🚀 Sending test notification…');
  await fireNotification(
    'Test Alert',
    '🔔 Push notifications are working perfectly on this device! Timetable, assignment, and project reminders are active.',
    { tag: 'test-' + Date.now() }
  );
}

function checkReminders(){
  if(globalData.settings?.reminders === false) return;
  const realToday = todayStr();
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  let notifLog = {};
  try {
    notifLog = JSON.parse(localStorage.getItem('ib_notif_log') || '{}');
  } catch { notifLog = {}; }

  // 1. Today's Timetable Events
  (dayData(realToday).events || []).forEach(ev => {
    if(ev.reminded || ev.done) return;
    const [h, m] = (ev.start || '00:00').split(':').map(Number);
    const rem = ev.reminder || 0;
    if(rem > 0 && nowMins >= (h * 60 + m) - rem && nowMins < (h * 60 + m)){
      ev.reminded = true;
      save();
      fireNotification(ev.title, `"${ev.title}" starts in ${rem} min!`, { tag: 'ev-' + ev.id });
    }
  });

  // 2. Today's Recurring Classes
  (globalData.recurring || []).filter(r => isRecurringOnDate(r, realToday)).forEach(r => {
    const logKey = 'rec_' + r.id + '_' + realToday;
    if(notifLog[logKey]) return;
    const [h, m] = (r.start || '00:00').split(':').map(Number);
    const rem = r.reminder || 0;
    if(rem > 0 && nowMins >= (h * 60 + m) - rem && nowMins < (h * 60 + m)){
      notifLog[logKey] = Date.now();
      try { localStorage.setItem('ib_notif_log', JSON.stringify(notifLog)); } catch(e){}
      fireNotification(r.title, `"${r.title}" starts in ${rem} min!`, { tag: 'rec-' + r.id, courseId: r.id });
    }
  });

  // 3. Course Assignments & Deadlines
  (globalData.recurring || []).forEach(course => {
    (course.assignments || []).forEach(a => {
      if(a.done || !a.dueDate) return;
      const dueTs = new Date(a.dueDate + 'T' + (a.dueTime || '23:59') + ':00').getTime();
      const diffMins = Math.round((dueTs - now.getTime()) / 60000);
      const intervals = a.reminderIntervals || ['1d', '2h', '30m', 'due'];

      const checks = [
        { code: '1d',  name: '1 day',   min: 1440 - 30, max: 1440 + 5 },
        { code: '12h', name: '12 hours', min: 720 - 20,  max: 720 + 5 },
        { code: '2h',  name: '2 hours',  min: 120 - 15,  max: 120 + 5 },
        { code: '30m', name: '30 mins',  min: 30 - 10,   max: 30 + 5 },
        { code: 'due', name: 'deadline', min: -5,        max: 5 }
      ];

      checks.forEach(chk => {
        if(intervals.includes(chk.code)){
          const logKey = `assign_${a.id}_${chk.code}`;
          if(!notifLog[logKey] && diffMins >= chk.min && diffMins <= chk.max){
            notifLog[logKey] = Date.now();
            try { localStorage.setItem('ib_notif_log', JSON.stringify(notifLog)); } catch(e){}
            const msg = chk.code === 'due'
              ? `⚠️ Deadline Reached: "${a.title}" (${course.title}) is due now!`
              : `📌 Assignment Reminder: "${a.title}" (${course.title}) is due in ${chk.name}!`;
            fireNotification('Assignment Deadline', msg, { courseId: course.id, tag: logKey });
          }
        }
      });
    });

    // 4. Course Project Tracker Reminders
    const p = course.project;
    if(p && p.remindersEnabled !== false && p.deadlineDate){
      let freqDays = 3;
      if(p.notificationFrequency === 'daily') freqDays = 1;
      else if(p.notificationFrequency === 'every_2_days') freqDays = 2;
      else if(p.notificationFrequency === 'every_3_days') freqDays = 3;
      else if(p.notificationFrequency === 'weekly') freqDays = 7;
      else if(p.notificationFrequency === 'custom') freqDays = parseInt(p.customIntervalDays) || 3;

      const intervalMs = freqDays * 24 * 3600 * 1000;
      const last = p.lastNotified || 0;
      if(now.getTime() - last >= intervalMs){
        p.lastNotified = now.getTime();
        save();

        const stages = p.stages || [];
        const doneCount = stages.filter(s => s.done).length;
        const pct = stages.length ? Math.round((doneCount / stages.length) * 100) : 0;
        const dlineTs = new Date(p.deadlineDate + 'T' + (p.deadlineTime || '23:59') + ':00').getTime();
        const daysLeft = Math.ceil((dlineTs - now.getTime()) / (1000 * 3600 * 24));

        let msg = `Project "${p.title}" (${course.title}) is at ${pct}% completion. `;
        if(daysLeft > 0) msg += `${daysLeft} days remaining until deadline (${p.deadlineDate}).`;
        else if(daysLeft === 0) msg += `Deadline is today at ${p.deadlineTime || '23:59'}!`;
        else msg += `Deadline was ${Math.abs(daysLeft)} days ago.`;

        fireNotification('Project Milestone Update', msg, { courseId: course.id, tag: 'proj-' + p.id });
      }
    }
  });
}

function showReminder(text){
  const bell = document.getElementById('reminderBell');
  const textEl = document.getElementById('reminderText');
  if(textEl) textEl.textContent = text;
  if(bell) {
    bell.classList.remove('hidden');
    setTimeout(() => { if(bell) bell.classList.add('hidden'); }, 12000);
  }
}
function dismissReminder(){
  const bell = document.getElementById('reminderBell');
  if(bell) bell.classList.add('hidden');
}

// ══════════════════════════════════════════
// COURSE DETAILS, PROJECTS, ASSIGNMENTS & NOTES
// ══════════════════════════════════════════
let currentActiveCourseId = null;

function getCourseById(courseId) {
  if (!courseId) return null;
  const baseId = courseId.includes('_') ? courseId.split('_')[0] : courseId;
  // 1. Check routine recurring classes
  let course = (globalData.recurring || []).find(r => r.id === baseId);
  if (course) return course;

  // 2. Check regular timetable events for currentDate
  let ev = (dayData(currentDate).events || []).find(e => e.id === baseId);
  if (ev) return ev;

  // 3. Search across all dates in db
  for (const date in db) {
    if (db[date]?.events) {
      ev = db[date].events.find(e => e.id === baseId);
      if (ev) return ev;
    }
  }
  return null;
}

function openCourseDetails(courseId) {
  const course = getCourseById(courseId);
  if (!course) {
    showToast('⚠️ Course details not found.');
    return;
  }
  currentActiveCourseId = course.id;

  if (!Array.isArray(course.courseNotes)) course.courseNotes = [];
  if (!Array.isArray(course.assignments)) course.assignments = [];

  const catEl = document.getElementById('cdCatBadge');
  const titleEl = document.getElementById('cdTitle');
  const timeEl = document.getElementById('cdTime');
  const locEl = document.getElementById('cdLocation');

  if (catEl) {
    catEl.innerHTML = `${CAT_ICONS[course.cat] || '🎓'} ${course.cat || 'Course'}`;
    catEl.style.background = course.color || CAT_COLORS[course.cat] || '#1565C0';
  }
  if (titleEl) titleEl.textContent = course.title;
  if (timeEl) timeEl.textContent = `${course.start} – ${course.end} (${dur(course.start, course.end)})`;
  if (locEl) locEl.textContent = course.location || 'Classroom / Campus';

  renderCourseProject(course);
  renderCourseAssignments(course);
  renderCourseNotes(course);

  const activeTabBtn = document.querySelector('.course-tab-btn.active');
  const currentTab = activeTabBtn ? activeTabBtn.dataset.tab : 'project';
  switchCourseTab(currentTab || 'project');

  openModal('courseDetailsModal');
}

function switchCourseTab(tabName) {
  document.querySelectorAll('.course-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  const panels = {
    project: document.getElementById('cdPanelProject'),
    assignments: document.getElementById('cdPanelAssignments'),
    notes: document.getElementById('cdPanelNotes')
  };
  Object.keys(panels).forEach(key => {
    if (panels[key]) panels[key].classList.toggle('active', key === tabName);
  });
}

function editCurrentCourseSchedule() {
  if (!currentActiveCourseId) return;
  closeModal('courseDetailsModal');
  const isRecur = (globalData.recurring || []).some(r => r.id === currentActiveCourseId);
  if (isRecur) {
    editRecurringClass(currentActiveCourseId);
  } else {
    editEvent(currentActiveCourseId);
  }
}

// ══════════════════════════════════════════
// IN-APP NOTIFICATION CENTER
// ══════════════════════════════════════════
let readNotificationIds = [];
try {
  readNotificationIds = JSON.parse(localStorage.getItem('ib_read_notifs') || '[]');
} catch(e) { readNotificationIds = []; }

function toggleNotificationCenter(e) {
  if (e) e.stopPropagation();
  closeUserDropdown();
  const container = document.getElementById('notifMenuContainer');
  if (container) {
    const wasOpen = container.classList.contains('open');
    container.classList.toggle('open');
    if (!wasOpen) {
      updateNotificationCenter();
    }
  }
}

function closeNotificationCenter() {
  const container = document.getElementById('notifMenuContainer');
  if (container) container.classList.remove('open');
}

function markAllNotificationsRead() {
  const allNotifs = collectAllActivityNotifications();
  readNotificationIds = allNotifs.map(n => n.id);
  try {
    localStorage.setItem('ib_read_notifs', JSON.stringify(readNotificationIds));
  } catch(e) {}
  updateNotificationCenter();
  showToast('✅ All notifications marked as read.');
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const now = Date.now();
  const diffSec = Math.floor((now - ts) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffDays = Math.floor(diffH / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function collectAllActivityNotifications() {
  const list = [];
  const curUser = getCurrentUser() || CURRENT_USER || {};
  const myName = curUser.displayName || curUser.username || '';

  const seenIds = new Set();
  const projectsToScan = Object.values(sharedProjects);
  (globalData.recurring || []).forEach(c => {
    if (c.project && !sharedProjects[c.project.id]) {
      projectsToScan.push(c.project);
    }
  });

  projectsToScan.forEach(proj => {
    (proj.activity || []).forEach(act => {
      if (act && act.id && !seenIds.has(act.id)) {
        seenIds.add(act.id);
        list.push({
          id: act.id,
          projectId: proj.id,
          courseId: proj.courseId,
          courseTitle: proj.courseTitle || proj.title,
          projectTitle: proj.title,
          type: act.type || 'activity',
          text: act.text,
          byUser: act.byUser,
          isSelf: act.byUser === myName,
          timestamp: act.timestamp || Date.now()
        });
      }
    });
  });

  // Also collect broadcast announcements from courses
  (globalData.recurring || []).forEach(c => {
    (c.announcements || []).forEach(ann => {
      if (ann && ann.id && !seenIds.has(ann.id)) {
        seenIds.add(ann.id);
        list.push({
          id: ann.id,
          projectId: c.projectId || '',
          courseId: c.id,
          courseTitle: c.title,
          projectTitle: c.title,
          type: 'announcement',
          text: `📢 ${ann.title}: ${ann.text}`,
          byUser: ann.byUser || 'Instructor',
          isSelf: ann.byUser === myName,
          timestamp: ann.timestamp || Date.now()
        });
      }
    });
  });

  return list.sort((a, b) => b.timestamp - a.timestamp);
}

function updateNotificationCenter() {
  const badge = document.getElementById('notifCounterBadge');
  const body = document.getElementById('notifDropdownBody');
  if (!body) return;

  const notifs = collectAllActivityNotifications();
  const unreadNotifs = notifs.filter(n => !readNotificationIds.includes(n.id) && !n.isSelf);

  if (badge) {
    if (unreadNotifs.length > 0) {
      badge.textContent = unreadNotifs.length > 9 ? '9+' : unreadNotifs.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (notifs.length === 0) {
    body.innerHTML = `
      <div class="notif-empty">
        <i class="fas fa-check-circle"></i>
        <span>No project activity yet</span>
        <small style="opacity:0.7">Collaborator updates &amp; milestones will appear here</small>
      </div>`;
    return;
  }

  body.innerHTML = notifs.slice(0, 20).map(n => {
    const isUnread = !readNotificationIds.includes(n.id) && !n.isSelf;
    let iconClass = 'fas fa-info-circle';
    let iconMod = '';

    if (n.type === 'milestone_completed') {
      iconClass = 'fas fa-check-circle';
      iconMod = 'done';
    } else if (n.type === 'deadline_updated') {
      iconClass = 'fas fa-stopwatch';
      iconMod = 'deadline';
    } else if (n.type === 'member_invited') {
      iconClass = 'fas fa-user-plus';
      iconMod = 'invite';
    } else if (n.type === 'milestone_reopened') {
      iconClass = 'fas fa-undo';
    } else if (n.type === 'announcement') {
      iconClass = 'fas fa-bullhorn';
      iconMod = 'invite';
    }

    return `
      <div class="notif-item ${isUnread ? 'unread' : ''}" onclick="onNotificationItemClick('${n.projectId}', '${n.courseId}')">
        <div class="notif-item-icon ${iconMod}"><i class="${iconClass}"></i></div>
        <div class="notif-item-content">
          <div class="notif-item-title">${esc(n.courseTitle || n.projectTitle)}</div>
          <div class="notif-item-text">${esc(n.text)}</div>
          <div class="notif-item-time"><i class="far fa-clock"></i> ${formatTimeAgo(n.timestamp)}</div>
        </div>
      </div>`;
  }).join('');
}

function onNotificationItemClick(projectId, courseId) {
  closeNotificationCenter();
  let targetCourseId = courseId;
  if (!targetCourseId) {
    const found = (globalData.recurring || []).find(c => c.project?.id === projectId || c.projectId === projectId);
    if (found) targetCourseId = found.id;
  }
  if (targetCourseId) {
    openCourseDetails(targetCourseId);
    switchCourseTab('project');
  }
}

// ══════════════════════════════════════════
// REAL-TIME SHARED PROJECTS (FIRESTORE 'projects')
// ══════════════════════════════════════════
let projectsUnsubscribe = null;
const sharedProjects = {};

function initProjectsRealtimeSync() {
  const user = getCurrentUser() || CURRENT_USER;
  if (!user || !user.uid || typeof firebase === 'undefined' || !firebase.apps.length) return;

  if (projectsUnsubscribe) {
    try { projectsUnsubscribe(); } catch(e){}
    projectsUnsubscribe = null;
  }

  try {
    const dbFs = firebase.firestore();
    projectsUnsubscribe = dbFs.collection('projects')
      .where('assignedUsers', 'array-contains', user.uid)
      .onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
          const proj = change.doc.data();
          if (change.type === 'removed') {
            delete sharedProjects[proj.id];
            (globalData.recurring || []).forEach(c => {
              if (c.project?.id === proj.id) c.project = null;
            });
          } else {
            const prev = sharedProjects[proj.id];
            const isUpdated = prev && prev.updatedAt !== proj.updatedAt;
            sharedProjects[proj.id] = proj;

            linkSharedProjectToCourses(proj);

            if (isUpdated && change.type === 'modified') {
              const lastAct = proj.activity && proj.activity.length ? proj.activity[proj.activity.length - 1] : null;
              const myName = user.displayName || user.username || '';
              if (lastAct && lastAct.byUser !== myName) {
                playNotificationChime();
                showToast(`🔔 [${proj.title}] ${lastAct.text}`, 4000);
              }
            }
          }
        });

        if (currentActiveCourseId) {
          const course = getCourseById(currentActiveCourseId);
          if (course) {
            renderCourseProject(course);
          }
        }

        updateNotificationCenter();
        save();
      }, err => {
        console.warn('Real-time projects listener note (offline mode active):', err);
      });
  } catch(e) {
    console.warn('initProjectsRealtimeSync error:', e);
  }
}

function linkSharedProjectToCourses(proj) {
  if (!proj || !proj.id) return;
  let linked = false;
  (globalData.recurring || []).forEach(c => {
    if (c.project?.id === proj.id || c.projectId === proj.id || (proj.courseTitle && c.title.toLowerCase() === proj.courseTitle.toLowerCase())) {
      c.project = proj;
      c.projectId = proj.id;
      linked = true;
    }
  });

  if (!linked && proj.courseTitle) {
    const newCourse = {
      id: proj.courseId || uid(),
      title: proj.courseTitle,
      start: '09:00',
      end: '10:30',
      cat: 'group',
      color: '#1565C0',
      location: 'Shared Collaboration',
      priority: 'normal',
      reminder: 15,
      freq: 'weekly',
      days: [1],
      startDate: todayStr(),
      courseNotes: [],
      assignments: [],
      projectId: proj.id,
      project: proj
    };
    if (!Array.isArray(globalData.recurring)) globalData.recurring = [];
    globalData.recurring.push(newCourse);
    save();
    refreshAll();
  }
}

async function syncProjectToFirestore(proj) {
  if (!proj || !proj.id) return;
  if (typeof firebase !== 'undefined' && firebase.apps.length) {
    try {
      await firebase.firestore().collection('projects').doc(proj.id).set(proj, { merge: true });
    } catch(e) {
      console.warn('Firestore project sync note (cached locally):', e);
    }
  }
}

function logProjectActivity(proj, text, type = 'activity') {
  if (!proj) return;
  if (!Array.isArray(proj.activity)) proj.activity = [];
  const curUser = getCurrentUser() || CURRENT_USER || {};
  proj.activity.push({
    id: uid(),
    type,
    text,
    byUser: curUser.displayName || curUser.username || 'User',
    timestamp: Date.now()
  });
  proj.updatedAt = new Date().toISOString();
}

// ── Course Project Tracker ──
function renderCourseProject(course) {
  const container = document.getElementById('cdProjectContainer');
  if (!container) return;

  // Check if we have shared live project in sharedProjects
  let p = course.project;
  if (course.projectId && sharedProjects[course.projectId]) {
    p = sharedProjects[course.projectId];
    course.project = p;
  }

  if (!p) {
    container.innerHTML = `
      <div class="cd-empty-project">
        <i class="fas fa-project-diagram"></i>
        <h4>No Project Assigned Yet</h4>
        <p>Set up term projects, milestone checklists, and collaborate with your classmates in real time.</p>
        <button class="btn-primary" onclick="openProjectModal(false)">
          <i class="fas fa-plus"></i> Set Up Course Project
        </button>
      </div>`;
    return;
  }

  const stages = p.stages || [];
  const completedStages = stages.filter(s => s.done).length;
  const pct = stages.length ? Math.round((completedStages / stages.length) * 100) : 0;

  let daysDiff = null;
  let deadlineBadgeHtml = '';
  if (p.deadlineDate) {
    const dline = new Date(p.deadlineDate + 'T' + (p.deadlineTime || '23:59') + ':00');
    const now = new Date();
    daysDiff = Math.ceil((dline.getTime() - now.getTime()) / (1000 * 3600 * 24));

    if (daysDiff > 7) {
      deadlineBadgeHtml = `<span class="cd-deadline-pill"><i class="fas fa-calendar-check"></i> Due: ${formatDateShort(p.deadlineDate)} (${daysDiff} days left)</span>`;
    } else if (daysDiff > 0) {
      deadlineBadgeHtml = `<span class="cd-deadline-pill urgent"><i class="fas fa-stopwatch"></i> Due Soon: ${daysDiff} day${daysDiff > 1 ? 's' : ''} left (${formatDateShort(p.deadlineDate)})</span>`;
    } else if (daysDiff === 0) {
      deadlineBadgeHtml = `<span class="cd-deadline-pill urgent"><i class="fas fa-exclamation-triangle"></i> Due Today (${p.deadlineTime || '23:59'})!</span>`;
    } else {
      deadlineBadgeHtml = `<span class="cd-deadline-pill urgent"><i class="fas fa-history"></i> Passed (${Math.abs(daysDiff)} days ago)</span>`;
    }
  }

  let freqLabel = 'Every 3 days';
  if (p.notificationFrequency === 'daily') freqLabel = 'Daily';
  else if (p.notificationFrequency === 'every_2_days') freqLabel = 'Every 2 days';
  else if (p.notificationFrequency === 'every_3_days') freqLabel = 'Every 3 days';
  else if (p.notificationFrequency === 'weekly') freqLabel = 'Weekly';
  else if (p.notificationFrequency === 'custom') freqLabel = `Every ${p.customIntervalDays || 3} days`;

  const members = p.members || [];
  const curUser = getCurrentUser() || CURRENT_USER || {};
  const isOwner = !p.ownerUid || p.ownerUid === curUser.uid;

  const activities = (p.activity || []).slice(-5).reverse();

  container.innerHTML = `
    <div class="cd-proj-card">
      <div class="cd-proj-top">
        <div class="cd-proj-title-wrap">
          <h4><i class="fas fa-rocket" style="color:var(--primary);margin-right:6px"></i>${esc(p.title)}</h4>
          ${p.description ? `<p class="cd-proj-desc">${esc(p.description)}</p>` : ''}
        </div>
        <div class="cd-proj-actions">
          <button class="btn-secondary btn-sm" onclick="openProjectModal(true)" title="Edit project & invite team members">
            <i class="fas fa-user-plus"></i> Edit &amp; Invite
          </button>
          <button class="btn-secondary btn-sm" style="color:var(--danger)" onclick="deleteCourseProject()" title="${isOwner ? 'Delete project' : 'Leave project'}">
            <i class="fas fa-${isOwner ? 'trash' : 'sign-out-alt'}"></i> ${isOwner ? 'Delete' : 'Leave'}
          </button>
        </div>
      </div>

      <!-- Real-Time Progress Bar -->
      <div class="cd-progress-container">
        <div class="cd-progress-info">
          <span><i class="fas fa-chart-line"></i> Multi-User Project Progress</span>
          <span class="cd-progress-pct">${pct}% (${completedStages}/${stages.length} milestones)</span>
        </div>
        <div class="cd-progress-track">
          <div class="cd-progress-fill" style="width:${pct}%;"></div>
        </div>
      </div>

      <!-- Deadline & Reminder Bar -->
      <div class="cd-proj-meta-bar">
        <div>${deadlineBadgeHtml}</div>
        <div class="cd-notif-freq-pill" title="Automated notification reminder schedule">
          <i class="fas fa-bell"></i> ${p.remindersEnabled !== false ? `Reminders: ${freqLabel}` : 'Reminders off'}
        </div>
      </div>

      <!-- Milestones / Stages Checklist with Member Assignee Badges -->
      <div>
        <div class="cd-stages-header"><i class="fas fa-check-square"></i> Project Milestones &amp; Assigned Members:</div>
        <div class="cd-stages-list">
          ${stages.length ? stages.map((s, idx) => `
            <div class="cd-stage-item ${s.done ? 'done' : ''}" onclick="toggleCourseProjectStage(${idx})">
              <div class="cd-stage-check">${s.done ? '<i class="fas fa-check"></i>' : ''}</div>
              <span class="cd-stage-text">${esc(s.title)}</span>
              ${s.assignedName ? `
                <span class="cd-stage-assignee" title="Assigned to ${esc(s.assignedName)}">
                  <span class="cd-stage-assignee-av">${(s.assignedName || 'M').charAt(0).toUpperCase()}</span>
                  <span>${esc(s.assignedName)}</span>
                </span>
              ` : `
                <span class="cd-stage-assignee unassigned" onclick="event.stopPropagation(); promptAssignStage(${idx})" title="Click to assign member">
                  <i class="fas fa-user-plus"></i> Assign
                </span>
              `}
            </div>
          `).join('') : '<div style="font-size:12px;color:var(--text-light);padding:8px 0;">No stages added yet. Edit project to add milestone stages.</div>'}
        </div>
      </div>

      <!-- Collaborators & Team Members -->
      <div class="cd-collaborators-wrap">
        <div class="cd-collab-title">
          <i class="fas fa-users"></i> Project Team Members (${members.length}):
        </div>
        <div class="cd-members-chips">
          ${members.length ? members.map(m => {
            const initial = (m.name || 'M').charAt(0).toUpperCase();
            return `
              <div class="cd-member-chip" title="${m.username ? '@' + m.username : m.email}">
                <div class="cd-member-av">${initial}</div>
                <div>
                  <span class="cd-member-name">${esc(m.name)}</span>
                  ${m.role ? `<span class="cd-member-role">${esc(m.role)}</span>` : ''}
                </div>
              </div>`;
          }).join('') : '<span style="font-size:12px;color:var(--text-light);">No team members yet. Click Edit &amp; Invite to add collaborators.</span>'}
        </div>
      </div>

      <!-- Real-time Activity Stream -->
      ${activities.length ? `
        <div class="cd-activity-box">
          <div class="cd-activity-header"><i class="fas fa-history"></i> Recent Project Activity:</div>
          <div class="cd-activity-list">
            ${activities.map(a => `
              <div class="cd-activity-item">
                <i class="fas fa-${a.type === 'milestone_completed' ? 'check-circle' : (a.type === 'member_invited' ? 'user-plus' : 'dot-circle')}" style="color:var(--primary);font-size:10px"></i>
                <span>${esc(a.text)}</span>
                <span class="cd-activity-time">${formatTimeAgo(a.timestamp)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

    </div>`;
}

function promptAssignStage(idx) {
  const course = getCourseById(currentActiveCourseId);
  if (!course || !course.project || !course.project.stages) return;
  const p = course.project;
  const stg = p.stages[idx];
  if (!stg) return;

  const members = p.members || [];
  if (members.length === 0) {
    showToast('⚠️ No collaborators on this project yet. Click Edit & Invite to add team members.');
    return;
  }

  const optionsStr = members.map((m, i) => `${i + 1}. ${m.name} (${m.role || 'Member'})`).join('\n');
  const input = prompt(`Assign milestone "${stg.title}" to:\n\n${optionsStr}\n0. Unassign\n\nEnter number:`);
  if (input === null) return;
  const choice = parseInt(input.trim());
  if (isNaN(choice)) return;

  const curUser = getCurrentUser() || CURRENT_USER || {};
  const actor = curUser.displayName || curUser.username || 'Owner';

  if (choice === 0) {
    stg.assignedTo = '';
    stg.assignedName = '';
    stg.assignedUid = '';
    logProjectActivity(p, `${actor} unassigned milestone "${stg.title}"`);
  } else if (choice >= 1 && choice <= members.length) {
    const sel = members[choice - 1];
    stg.assignedTo = sel.username || sel.name;
    stg.assignedName = sel.name;
    stg.assignedUid = sel.uid || '';
    logProjectActivity(p, `${actor} assigned milestone "${stg.title}" to ${sel.name}`);
  }

  p.updatedAt = new Date().toISOString();
  syncProjectToFirestore(p);
  save();
  renderCourseProject(course);
  showToast('Milestone assigned.');
}

function openProjectModal(isEdit) {
  const course = getCourseById(currentActiveCourseId);
  if (!course) return;

  document.getElementById('projCourseId').value = course.id;
  let p = isEdit && course.project ? course.project : null;
  if (isEdit && course.projectId && sharedProjects[course.projectId]) {
    p = sharedProjects[course.projectId];
  }

  document.getElementById('projModalTitle').innerHTML = p
    ? '<i class="fas fa-edit"></i> Edit Course Project &amp; Team'
    : '<i class="fas fa-project-diagram"></i> Set Up Course Project';

  document.getElementById('projTitle').value = p ? p.title : '';
  document.getElementById('projDesc').value = p ? (p.description || '') : '';
  document.getElementById('projDeadlineDate').value = p ? (p.deadlineDate || '') : '';
  document.getElementById('projDeadlineTime').value = p ? (p.deadlineTime || '23:59') : '23:59';

  const freq = p ? (p.notificationFrequency || 'every_3_days') : 'every_3_days';
  document.getElementById('projNotifFreq').value = freq;
  document.getElementById('projCustomDays').value = p ? (p.customIntervalDays || 3) : 3;
  toggleCustomFreqInput();

  document.getElementById('projNotifEnabled').checked = p ? (p.remindersEnabled !== false) : true;

  const stageList = document.getElementById('stageBuilderList');
  if (stageList) stageList.innerHTML = '';

  const memberList = document.getElementById('membersBuilderList');
  if (memberList) memberList.innerHTML = '';

  const curUser = getCurrentUser() || CURRENT_USER || {};

  // Ensure project owner is present in members
  if (p && Array.isArray(p.members) && p.members.length) {
    p.members.forEach(m => addMemberToBuilder(m.name, m.role, m.username, m.uid, m.status || (m.uid === p.ownerUid ? 'owner' : 'collaborator')));
  } else {
    // Current user is initial owner
    addMemberToBuilder(
      curUser.displayName || curUser.username || 'You',
      'Lead',
      curUser.username || '',
      curUser.uid || '',
      'owner'
    );
  }

  updateStageAssigneeDropdown();

  if (p && Array.isArray(p.stages) && p.stages.length) {
    p.stages.forEach(s => addStageToBuilder(s.title, s.done, s.assignedTo, s.assignedName, s.assignedUid));
  } else if (!p) {
    addStageToBuilder('Topic proposal & requirements', false, curUser.username, curUser.displayName || 'You', curUser.uid);
    addStageToBuilder('Core development & analysis', false);
    addStageToBuilder('Final presentation & report submission', false);
  }

  const pillsEl = document.getElementById('quickContactsPills');
  if (pillsEl) {
    const contacts = globalData.contacts || [];
    if (contacts.length) {
      pillsEl.innerHTML = contacts.map(c => `
        <button type="button" class="btn-secondary btn-sm" style="font-size:11px;padding:3px 9px;border-radius:12px;margin:2px;" onclick="addMemberToBuilder('${esc(c.first + (c.last ? ' ' + c.last : ''))}', '${esc(c.role || 'Member')}')">
          <i class="fas fa-plus"></i> ${esc(c.first)} (${esc(c.role || 'Contact')})
        </button>
      `).join('');
    } else {
      pillsEl.innerHTML = '<span style="font-size:11px;color:var(--text-light)">Enter registered usernames or emails above to invite.</span>';
    }
  }

  const feedbackEl = document.getElementById('inviteFeedback');
  if (feedbackEl) feedbackEl.classList.add('hidden');
  const invInput = document.getElementById('inviteUserInput');
  if (invInput) invInput.value = '';

  openModal('courseProjectModal');
}

function updateStageAssigneeDropdown() {
  const sel = document.getElementById('newStageAssignee');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">👤 Unassigned</option>';

  document.querySelectorAll('#membersBuilderList .builder-item').forEach(item => {
    const uidVal = item.dataset.uid || '';
    const username = item.dataset.username || '';
    const name = item.dataset.name || '';
    if (name) {
      const opt = document.createElement('option');
      opt.value = uidVal || username || name;
      opt.dataset.name = name;
      opt.dataset.username = username;
      opt.dataset.uid = uidVal;
      opt.textContent = `👤 ${name}`;
      if (opt.value === currentVal) opt.selected = true;
      sel.appendChild(opt);
    }
  });
}

function toggleCustomFreqInput() {
  const sel = document.getElementById('projNotifFreq');
  const group = document.getElementById('projCustomDaysGroup');
  if (sel && group) {
    group.classList.toggle('hidden', sel.value !== 'custom');
  }
}

function addStageToBuilder(title = '', done = false, assignedTo = '', assignedName = '', assignedUid = '') {
  const list = document.getElementById('stageBuilderList');
  if (!list) return;
  const input = document.getElementById('newStageInput');
  const stageTitle = title || (input ? input.value.trim() : '');
  if (!stageTitle) return;

  const assigneeSel = document.getElementById('newStageAssignee');
  let finalAssignedTo = assignedTo;
  let finalAssignedName = assignedName;
  let finalAssignedUid = assignedUid;

  if (!title && assigneeSel && assigneeSel.selectedIndex > 0) {
    const selectedOpt = assigneeSel.options[assigneeSel.selectedIndex];
    finalAssignedTo = selectedOpt.dataset.username || selectedOpt.value;
    finalAssignedName = selectedOpt.dataset.name || selectedOpt.textContent.replace('👤 ', '');
    finalAssignedUid = selectedOpt.dataset.uid || '';
  }

  const item = document.createElement('div');
  item.className = 'builder-item';
  item.dataset.assignedTo = finalAssignedTo || '';
  item.dataset.assignedName = finalAssignedName || '';
  item.dataset.assignedUid = finalAssignedUid || '';

  item.innerHTML = `
    <span style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
      <input type="checkbox" class="builder-stage-done" ${done ? 'checked' : ''} style="width:15px;height:15px;cursor:pointer;flex-shrink:0"/>
      <span class="builder-stage-text" style="overflow:hidden;text-overflow:ellipsis">${esc(stageTitle)}</span>
      <span class="cd-stage-assignee ${finalAssignedName ? '' : 'unassigned'}" style="margin-left:auto;flex-shrink:0">
        ${finalAssignedName ? `
          <span class="cd-stage-assignee-av">${finalAssignedName.charAt(0).toUpperCase()}</span>
          <span>${esc(finalAssignedName)}</span>
        ` : 'Unassigned'}
      </span>
    </span>
    <button type="button" class="btn-secondary btn-sm" style="padding:2px 8px;color:var(--danger);flex-shrink:0" onclick="this.closest('.builder-item').remove()"><i class="fas fa-trash"></i></button>
  `;
  list.appendChild(item);
  if (input && !title) input.value = '';
}

function addMemberToBuilder(name = '', role = '', username = '', uidVal = '', status = 'collaborator') {
  const list = document.getElementById('membersBuilderList');
  if (!list) return;
  const memberName = name.trim();
  const memberRole = role || 'Collaborator';
  if (!memberName) return;

  const curUser = getCurrentUser() || CURRENT_USER || {};
  const isOwner = status === 'owner' || uidVal === curUser.uid;

  const item = document.createElement('div');
  item.className = 'builder-item';
  item.dataset.uid = uidVal || '';
  item.dataset.username = username || '';
  item.dataset.name = memberName;
  item.dataset.role = memberRole;
  item.dataset.status = status;

  const initial = memberName.charAt(0).toUpperCase();

  item.innerHTML = `
    <span style="display:flex;align-items:center;gap:8px;flex:1">
      <div class="cd-member-av" style="width:24px;height:24px;font-size:10px">${initial}</div>
      <div>
        <strong class="builder-member-name">${esc(memberName)}</strong>
        ${username ? `<small style="color:var(--text-light);margin-left:4px">@${esc(username)}</small>` : ''}
        <span class="builder-member-role" style="color:var(--text-light);font-size:11px;margin-left:4px">(${esc(memberRole)})</span>
        <span class="member-status-pill ${status}">${status}</span>
      </div>
    </span>
    ${!isOwner ? `
      <button type="button" class="btn-secondary btn-sm" style="padding:2px 8px;color:var(--danger)" onclick="this.closest('.builder-item').remove(); updateStageAssigneeDropdown();">
        <i class="fas fa-times"></i>
      </button>
    ` : '<span style="font-size:11px;color:var(--primary);font-weight:700">Project Lead</span>'}
  `;
  list.appendChild(item);
  updateStageAssigneeDropdown();
}

async function inviteUserToProject() {
  const inputEl = document.getElementById('inviteUserInput');
  const roleEl = document.getElementById('inviteUserRole');
  const feedbackEl = document.getElementById('inviteFeedback');
  const btn = document.getElementById('btnInviteUser');

  const query = (inputEl?.value || '').trim();
  const role = roleEl?.value || 'Collaborator';

  if (!query) {
    showToast('⚠️ Please enter a username or email address.');
    return;
  }

  if (feedbackEl) {
    feedbackEl.className = 'invite-feedback';
    feedbackEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Searching for registered user…';
    feedbackEl.classList.remove('hidden');
  }
  if (btn) btn.disabled = true;

  try {
    const clean = query.toLowerCase();
    let foundUser = null;

    if (typeof firebase !== 'undefined' && firebase.apps.length) {
      const dbFs = firebase.firestore();
      if (clean.includes('@')) {
        const snap = await dbFs.collection('users').where('email', '==', clean).limit(1).get();
        if (!snap.empty) {
          const d = snap.docs[0];
          foundUser = { uid: d.id, ...d.data() };
        }
      } else {
        const uDoc = await dbFs.collection('usernames').doc(clean).get();
        if (uDoc.exists) {
          const uData = uDoc.data();
          const userDoc = await dbFs.collection('users').doc(uData.uid).get();
          if (userDoc.exists) {
            foundUser = { uid: uData.uid, ...userDoc.data() };
          } else {
            foundUser = { uid: uData.uid, username: clean, email: uData.email, displayName: clean };
          }
        }
      }
    }

    if (!foundUser) {
      if (feedbackEl) {
        feedbackEl.className = 'invite-feedback error';
        feedbackEl.innerHTML = `<i class="fas fa-times-circle"></i> User "<b>${esc(query)}</b>" was not found in registered accounts.`;
      }
      showToast(`⚠️ User "${query}" not found.`);
      return;
    }

    const curUser = getCurrentUser() || CURRENT_USER || {};
    if (foundUser.uid === curUser.uid) {
      if (feedbackEl) {
        feedbackEl.className = 'invite-feedback error';
        feedbackEl.innerHTML = `<i class="fas fa-info-circle"></i> You are already the project lead!`;
      }
      return;
    }

    // Check if already in builder list
    let alreadyExists = false;
    document.querySelectorAll('#membersBuilderList .builder-item').forEach(item => {
      if (item.dataset.uid === foundUser.uid || item.dataset.username === foundUser.username) {
        alreadyExists = true;
      }
    });

    if (alreadyExists) {
      if (feedbackEl) {
        feedbackEl.className = 'invite-feedback error';
        feedbackEl.innerHTML = `<i class="fas fa-check-circle"></i> <b>${esc(foundUser.displayName || foundUser.username)}</b> is already in this project.`;
      }
      return;
    }

    addMemberToBuilder(
      foundUser.displayName || foundUser.username,
      role,
      foundUser.username || clean,
      foundUser.uid,
      'collaborator'
    );

    if (feedbackEl) {
      feedbackEl.className = 'invite-feedback success';
      feedbackEl.innerHTML = `<i class="fas fa-check-circle"></i> Added <b>${esc(foundUser.displayName || foundUser.username)}</b> (${esc(role)}) to team!`;
    }
    if (inputEl) inputEl.value = '';
    showToast(`🎉 ${foundUser.displayName || foundUser.username} added! Click Save Project to sync.`);

  } catch(err) {
    console.error('Invite error:', err);
    if (feedbackEl) {
      feedbackEl.className = 'invite-feedback error';
      feedbackEl.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Lookup failed: ${esc(err.message)}`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveCourseProject() {
  const course = getCourseById(currentActiveCourseId);
  if (!course) return;

  const title = document.getElementById('projTitle').value.trim();
  const deadlineDate = document.getElementById('projDeadlineDate').value;
  if (!title) { showToast('⚠️ Project Title is required.'); return; }
  if (!deadlineDate) { showToast('⚠️ Deadline date is required.'); return; }

  const desc = document.getElementById('projDesc').value.trim();
  const deadlineTime = document.getElementById('projDeadlineTime').value || '23:59';
  const freq = document.getElementById('projNotifFreq').value;
  const customDays = parseInt(document.getElementById('projCustomDays').value) || 3;
  const remindersEnabled = document.getElementById('projNotifEnabled').checked;

  const stages = [];
  document.querySelectorAll('#stageBuilderList .builder-item').forEach(item => {
    const textEl = item.querySelector('.builder-stage-text');
    const cb = item.querySelector('.builder-stage-done');
    if (textEl) {
      stages.push({
        id: item.dataset.stageId || uid(),
        title: textEl.textContent.trim(),
        done: cb ? cb.checked : false,
        assignedTo: item.dataset.assignedTo || '',
        assignedName: item.dataset.assignedName || '',
        assignedUid: item.dataset.assignedUid || ''
      });
    }
  });

  const curUser = getCurrentUser() || CURRENT_USER || {};
  const members = [];
  const assignedUsersSet = new Set();
  if (curUser.uid) assignedUsersSet.add(curUser.uid);

  document.querySelectorAll('#membersBuilderList .builder-item').forEach(item => {
    const name = item.dataset.name || item.querySelector('.builder-member-name')?.textContent.trim();
    const role = item.dataset.role || 'Collaborator';
    const username = item.dataset.username || '';
    const uidVal = item.dataset.uid || '';
    const status = item.dataset.status || (uidVal === curUser.uid ? 'owner' : 'collaborator');

    if (uidVal) assignedUsersSet.add(uidVal);
    if (name) {
      members.push({ uid: uidVal, username, name, role, status });
    }
  });

  const existingProj = course.project || (course.projectId ? sharedProjects[course.projectId] : null);
  const projId = existingProj?.id || uid();
  const isNew = !existingProj;

  const activity = existingProj?.activity || [];
  const userName = curUser.displayName || curUser.username || 'Lead';

  if (isNew) {
    activity.push({
      id: uid(),
      type: 'created',
      text: `${userName} created project "${title}"`,
      byUser: userName,
      timestamp: Date.now()
    });
  } else if (existingProj.deadlineDate !== deadlineDate) {
    activity.push({
      id: uid(),
      type: 'deadline_updated',
      text: `${userName} updated deadline to ${formatDateShort(deadlineDate)}`,
      byUser: userName,
      timestamp: Date.now()
    });
  }

  const proj = {
    id: projId,
    courseId: course.id,
    courseTitle: course.title,
    title,
    description: desc,
    deadlineDate,
    deadlineTime,
    ownerUid: existingProj?.ownerUid || curUser.uid || '',
    ownerUsername: existingProj?.ownerUsername || curUser.username || '',
    ownerName: existingProj?.ownerName || curUser.displayName || curUser.username || 'Lead',
    assignedUsers: Array.from(assignedUsersSet),
    members,
    stages,
    activity,
    notificationFrequency: freq,
    customIntervalDays: customDays,
    remindersEnabled,
    lastNotified: existingProj?.lastNotified || 0,
    updatedAt: new Date().toISOString()
  };

  course.project = proj;
  course.projectId = proj.id;
  sharedProjects[proj.id] = proj;

  // Real-time Firestore sync
  await syncProjectToFirestore(proj);

  save();
  renderCourseProject(course);
  updateNotificationCenter();
  closeModal('courseProjectModal');
  showToast('🚀 Project updated & synced live with team!');
}

async function deleteCourseProject() {
  const course = getCourseById(currentActiveCourseId);
  if (!course || !course.project) return;
  const p = course.project;
  const curUser = getCurrentUser() || CURRENT_USER || {};
  const isOwner = !p.ownerUid || p.ownerUid === curUser.uid;

  if (isOwner) {
    if (!confirm('Are you sure you want to delete this project for all collaborators?')) return;
    if (typeof firebase !== 'undefined' && firebase.apps.length && p.id) {
      try {
        await firebase.firestore().collection('projects').doc(p.id).delete();
      } catch(e) {
        console.warn('Firestore project delete error:', e);
      }
    }
    delete sharedProjects[p.id];
    course.project = null;
    course.projectId = null;
    save();
    renderCourseProject(course);
    updateNotificationCenter();
    showToast('🗑️ Project deleted.');
  } else {
    if (!confirm('Leave this shared project? You will no longer receive updates.')) return;
    p.assignedUsers = (p.assignedUsers || []).filter(u => u !== curUser.uid);
    p.members = (p.members || []).filter(m => m.uid !== curUser.uid && m.username !== curUser.username);
    logProjectActivity(p, `${curUser.displayName || curUser.username || 'A member'} left the project`);
    await syncProjectToFirestore(p);

    delete sharedProjects[p.id];
    course.project = null;
    course.projectId = null;
    save();
    renderCourseProject(course);
    updateNotificationCenter();
    showToast('👋 You have left the project.');
  }
}

async function toggleCourseProjectStage(idx) {
  const course = getCourseById(currentActiveCourseId);
  if (!course || !course.project || !course.project.stages) return;
  const p = course.project;

  if (p.stages[idx]) {
    p.stages[idx].done = !p.stages[idx].done;
    const isDone = p.stages[idx].done;
    const curUser = getCurrentUser() || CURRENT_USER || {};
    const actor = curUser.displayName || curUser.username || 'Teammate';

    logProjectActivity(
      p,
      `${actor} ${isDone ? 'completed' : 'reopened'} milestone "${p.stages[idx].title}"`,
      isDone ? 'milestone_completed' : 'milestone_reopened'
    );

    await syncProjectToFirestore(p);
    save();
    renderCourseProject(course);
    updateNotificationCenter();
    showToast(isDone ? '✅ Milestone completed!' : 'Milestone reopened.');
  }
}

// ── Course Assignments & Deadlines ──
function renderCourseAssignments(course) {
  const list = document.getElementById('cdAssignmentsList');
  const countEl = document.getElementById('cdAssignmentCount');
  if (!course) return;

  const assignments = course.assignments || [];
  if (countEl) countEl.textContent = assignments.length;
  if (!list) return;

  if (!assignments.length) {
    list.innerHTML = `
      <div class="empty-state" style="padding:28px 16px;">
        <i class="fas fa-clipboard-check"></i>
        <p>No assignments or homework added yet for <b>${esc(course.title)}</b>.</p>
        <button class="btn-primary btn-sm" onclick="openAddCourseAssignmentModal()">
          <i class="fas fa-plus"></i> Add Assignment
        </button>
      </div>`;
    return;
  }

  const sorted = [...assignments].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (a.dueDate || '').localeCompare(b.dueDate || '');
  });

  list.innerHTML = sorted.map(a => {
    const isOverdue = !a.done && a.dueDate && (a.dueDate < todayStr());
    const isToday = !a.done && a.dueDate === todayStr();
    const intervals = a.reminderIntervals || [];

    return `
      <div class="cd-assignment-item ${a.done ? 'done' : ''}">
        <div class="cd-ass-check" onclick="toggleCourseAssignmentDone('${a.id}')" title="${a.done ? 'Mark as incomplete' : 'Mark as completed'}">
          <i class="fas fa-check"></i>
        </div>
        <div class="cd-ass-content">
          <div class="cd-ass-title">${esc(a.title)}</div>
          <div class="cd-ass-meta">
            <span class="cd-due-badge ${isOverdue || isToday ? 'urgent' : ''}">
              <i class="fas fa-clock"></i> Due: ${formatDateShort(a.dueDate)} ${a.dueTime ? 'at ' + a.dueTime : ''}
              ${isOverdue ? ' (Overdue)' : (isToday ? ' (Today!)' : '')}
            </span>
            ${a.priority === 'high' ? '<span class="ev-priority">🔴 Urgent</span>' : ''}
            ${a.priority === 'low' ? '<span class="ev-priority">🟢 Low</span>' : ''}
            ${a.duration ? `<span><i class="fas fa-hourglass-half"></i> ~${a.duration}m</span>` : ''}
            ${intervals.length ? `
              <div class="cd-rem-pills" title="Scheduled push notification reminders">
                ${intervals.map(iv => `<span class="cd-rem-pill">🔔 ${iv}</span>`).join('')}
              </div>` : ''}
          </div>
          ${a.notes ? `<div style="font-size:12px;color:var(--text-light);margin-top:4px;">${esc(a.notes)}</div>` : ''}
        </div>
        <div class="cd-ass-actions">
          <button class="ev-btn del-btn" title="Delete Assignment" onclick="deleteCourseAssignment('${a.id}')">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  }).join('');
}

function openAddCourseAssignmentModal(assignmentId = null) {
  const course = getCourseById(currentActiveCourseId);
  if (!course) return;

  document.getElementById('caCourseId').value = course.id;
  document.getElementById('caAssignmentId').value = assignmentId || '';

  const a = assignmentId && course.assignments ? course.assignments.find(x => x.id === assignmentId) : null;
  document.getElementById('caModalTitle').innerHTML = a
    ? '<i class="fas fa-edit"></i> Edit Course Assignment'
    : '<i class="fas fa-tasks"></i> Add Course Assignment';

  document.getElementById('caTitle').value = a ? a.title : '';
  document.getElementById('caDueDate').value = a ? a.dueDate : currentDate;
  document.getElementById('caDueTime').value = a ? (a.dueTime || '23:59') : '23:59';
  document.getElementById('caPriority').value = a ? (a.priority || 'normal') : 'normal';
  document.getElementById('caDuration').value = a ? (a.duration || '') : '';
  document.getElementById('caNotes').value = a ? (a.notes || '') : '';

  const selectedIntervals = a ? (a.reminderIntervals || ['1d', '2h', '30m', 'due']) : ['1d', '2h', '30m', 'due'];
  document.querySelectorAll('.ca-rem-cb').forEach(cb => {
    cb.checked = selectedIntervals.includes(cb.value);
  });

  openModal('courseAssignmentModal');
}

function saveCourseAssignment() {
  const course = getCourseById(currentActiveCourseId);
  if (!course) return;

  const title = document.getElementById('caTitle').value.trim();
  const dueDate = document.getElementById('caDueDate').value;
  if (!title) { showToast('⚠️ Assignment title is required.'); return; }
  if (!dueDate) { showToast('⚠️ Due date is required.'); return; }

  const dueTime = document.getElementById('caDueTime').value || '23:59';
  const priority = document.getElementById('caPriority').value;
  const duration = parseInt(document.getElementById('caDuration').value) || 0;
  const notes = document.getElementById('caNotes').value.trim();
  const assignmentId = document.getElementById('caAssignmentId').value;

  const reminderIntervals = [];
  document.querySelectorAll('.ca-rem-cb:checked').forEach(cb => reminderIntervals.push(cb.value));

  if (!Array.isArray(course.assignments)) course.assignments = [];

  const existingIdx = assignmentId ? course.assignments.findIndex(a => a.id === assignmentId) : -1;
  const newOrUpdated = {
    id: existingIdx >= 0 ? assignmentId : uid(),
    title,
    dueDate,
    dueTime,
    priority,
    duration,
    reminderIntervals,
    notes,
    done: existingIdx >= 0 ? course.assignments[existingIdx].done : false
  };

  if (existingIdx >= 0) {
    course.assignments[existingIdx] = newOrUpdated;
  } else {
    course.assignments.push(newOrUpdated);
  }

  // Mirror into dayData(dueDate).tasks for unified assignment visibility
  const dData = dayData(dueDate);
  if (!Array.isArray(dData.tasks)) dData.tasks = [];
  const taskTitle = `[${course.title}] ${title}`;
  const tIdx = dData.tasks.findIndex(t => t.id === newOrUpdated.id);
  if (tIdx >= 0) {
    dData.tasks[tIdx].title = taskTitle;
    dData.tasks[tIdx].text = taskTitle;
    dData.tasks[tIdx].priority = priority;
    dData.tasks[tIdx].duration = duration;
    dData.tasks[tIdx].due = dueTime;
  } else {
    dData.tasks.push({
      id: newOrUpdated.id,
      title: taskTitle,
      text: taskTitle,
      cat: 'assignment',
      priority,
      duration,
      due: dueTime,
      notes,
      done: false
    });
  }

  save();
  renderCourseAssignments(course);
  renderTasks();
  renderStats();
  closeModal('courseAssignmentModal');
  showToast('✅ Assignment saved & reminders scheduled!');
}

function toggleCourseAssignmentDone(assignmentId) {
  const course = getCourseById(currentActiveCourseId);
  if (!course || !course.assignments) return;

  const a = course.assignments.find(x => x.id === assignmentId);
  if (!a) return;
  a.done = !a.done;

  if (a.dueDate) {
    const t = (dayData(a.dueDate).tasks || []).find(x => x.id === assignmentId);
    if (t) t.done = a.done;
  }

  save();
  renderCourseAssignments(course);
  renderTasks();
  renderStats();
  showToast(a.done ? '🎉 Assignment completed!' : 'Assignment reopened.');
}

function deleteCourseAssignment(assignmentId) {
  const course = getCourseById(currentActiveCourseId);
  if (!course || !course.assignments) return;
  if (!confirm('Delete this assignment?')) return;

  const a = course.assignments.find(x => x.id === assignmentId);
  course.assignments = course.assignments.filter(x => x.id !== assignmentId);

  if (a && a.dueDate) {
    const dData = dayData(a.dueDate);
    if (dData.tasks) {
      dData.tasks = dData.tasks.filter(x => x.id !== assignmentId);
    }
  }

  save();
  renderCourseAssignments(course);
  renderTasks();
  renderStats();
  showToast('🗑️ Assignment deleted.');
}

// ── Course Personal Notes ──
function renderCourseNotes(course) {
  const grid = document.getElementById('cdNotesList');
  const countEl = document.getElementById('cdNoteCount');
  if (!course) return;

  if (!Array.isArray(course.courseNotes)) course.courseNotes = [];
  if (countEl) countEl.textContent = course.courseNotes.length;
  if (!grid) return;

  if (!course.courseNotes.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;padding:28px 16px;">
        <i class="fas fa-book-open"></i>
        <p>No notes written yet for <b>${esc(course.title)}</b>.<br>Keep lecture notes, formulas, and study reminders right here.</p>
        <button class="btn-primary btn-sm" onclick="addCourseNote()">
          <i class="fas fa-plus"></i> Create First Note
        </button>
      </div>`;
    return;
  }

  grid.innerHTML = course.courseNotes.map(n => `
    <div class="cd-note-card">
      <div class="cd-note-header">
        <span><i class="fas fa-sticky-note" style="color:var(--primary);margin-right:4px"></i>${esc(n.createdAt || '')}</span>
        <button class="cd-note-del-btn" title="Delete Note" onclick="deleteCourseNote('${n.id}')">
          <i class="fas fa-trash"></i>
        </button>
      </div>
      <textarea class="cd-note-textarea" placeholder="Type lecture notes, concepts, exam tips..." oninput="updateCourseNote('${n.id}', this.value)">${esc(n.text || '')}</textarea>
    </div>
  `).join('');
}

function addCourseNote() {
  const course = getCourseById(currentActiveCourseId);
  if (!course) return;
  if (!Array.isArray(course.courseNotes)) course.courseNotes = [];

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const newNote = {
    id: uid(),
    text: '',
    createdAt: dateStr
  };
  course.courseNotes.unshift(newNote);
  save();
  renderCourseNotes(course);

  setTimeout(() => {
    const firstTextarea = document.querySelector('.cd-note-textarea');
    if (firstTextarea) firstTextarea.focus();
  }, 100);
}

function updateCourseNote(noteId, text) {
  const course = getCourseById(currentActiveCourseId);
  if (!course || !course.courseNotes) return;
  const n = course.courseNotes.find(x => x.id === noteId);
  if (n) {
    n.text = text;
    save();
  }
}

function deleteCourseNote(noteId) {
  const course = getCourseById(currentActiveCourseId);
  if (!course || !course.courseNotes) return;
  if (!confirm('Delete this note?')) return;
  course.courseNotes = course.courseNotes.filter(x => x.id !== noteId);
  save();
  renderCourseNotes(course);
  showToast('🗑️ Note deleted.');
}

// ══════════════════════════════════════════
// ROLE-BASED ARCHITECTURE & ACADEMIC CLASSROOMS
// ══════════════════════════════════════════
let classroomsUnsubscribe = null;
let teacherSelectedColor = '#1565C0';

function isTeacherRole() {
  const u = getCurrentUser() || CURRENT_USER;
  return u && u.role === 'teacher';
}

function applyRoleUI() {
  const isTeacher = isTeacherRole();

  // 1. Header Subtitle
  const sub = document.getElementById('brandSub');
  if (sub) {
    sub.textContent = isTeacher ? 'Academic Portal: Instructor Hub' : 'Full Day Academic Manager';
  }

  // 2. Strict Role Header Action Buttons
  const createBtn = document.getElementById('btnCreateClassHeader');
  const joinBtn = document.getElementById('btnJoinClassHeader');
  if (createBtn) {
    createBtn.style.display = isTeacher ? 'inline-flex' : 'none';
    createBtn.classList.toggle('hidden', !isTeacher);
  }
  if (joinBtn) {
    joinBtn.style.display = isTeacher ? 'none' : 'inline-flex';
    joinBtn.classList.toggle('hidden', isTeacher);
  }

  // 3. Top Navigation Labels & Icons
  const navMap = isTeacher ? {
    dashboard: { icon: 'fa-university', text: ' Academic Hub' },
    week:      { icon: 'fa-calendar-week', text: ' Schedule' },
    month:     { icon: 'fa-calendar-alt', text: ' Calendar' },
    timeline:  { icon: 'fa-stream', text: ' Timeline' },
    tasks:     { icon: 'fa-tasks', text: ' Assignments' },
    notes:     { icon: 'fa-sticky-note', text: ' Notes' },
    contacts:  { icon: 'fa-user-graduate', text: ' Students' },
    analytics: { icon: 'fa-chart-bar', text: ' Analytics' }
  } : {
    dashboard: { icon: 'fa-th-large', text: ' My Day' },
    week:      { icon: 'fa-calendar-week', text: ' Week' },
    month:     { icon: 'fa-calendar-alt', text: ' Month' },
    timeline:  { icon: 'fa-stream', text: ' Timeline' },
    tasks:     { icon: 'fa-tasks', text: ' Assignments' },
    notes:     { icon: 'fa-sticky-note', text: ' Notes' },
    contacts:  { icon: 'fa-user-graduate', text: ' People' },
    analytics: { icon: 'fa-chart-bar', text: ' Analytics' }
  };

  document.querySelectorAll('.nav-btn').forEach(btn => {
    const v = btn.dataset.view;
    if (navMap[v]) {
      const iEl = btn.querySelector('i');
      const sEl = btn.querySelector('.nav-text');
      if (iEl) iEl.className = 'fas ' + navMap[v].icon;
      if (sEl) sEl.textContent = navMap[v].text;
    }
  });

  // 4. Complete Separation of Teacher vs Student Dashboard
  const stuWidgets = document.getElementById('studentDashboardWidgets');
  const tchHub = document.getElementById('teacherDashboardHub');
  if (stuWidgets) {
    stuWidgets.style.display = isTeacher ? 'none' : 'block';
    stuWidgets.classList.toggle('hidden', isTeacher);
  }
  if (tchHub) {
    tchHub.style.display = isTeacher ? 'flex' : 'none';
    tchHub.classList.toggle('hidden', !isTeacher);
  }

  if (isTeacher) {
    renderTeacherDashboard();
  }
}

function generateClassCode(title = '') {
  let prefix = (title || 'CLASS')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
  if (prefix.length < 2) prefix = 'IB' + prefix;
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let rand = '';
  for (let i = 0; i < 3; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefix}-${rand}`;
}

function selectTeacherCourseColor(c, el) {
  teacherSelectedColor = c;
  document.querySelectorAll('#tcColorPicker .color-dot').forEach(d => {
    d.classList.toggle('selected', d === el || d.dataset.color === c);
  });
}

function generateNewClassCodeInput() {
  const title = document.getElementById('tcTitle')?.value || '';
  const code = generateClassCode(title);
  const inp = document.getElementById('tcCustomCode');
  if (inp) inp.value = code;
  return code;
}

function openCreateClassroomModal(editCourseId = null) {
  if (!isTeacherRole()) {
    showToast('⚠️ Only instructors can create academic courses.');
    return;
  }
  document.getElementById('editClassroomId').value = editCourseId || '';
  const isEdit = !!editCourseId;
  const course = isEdit ? (globalData.recurring || []).find(r => r.id === editCourseId) : null;

  document.getElementById('ccModalTitle').innerHTML = isEdit
    ? '<i class="fas fa-edit"></i> Edit Academic Course'
    : '<i class="fas fa-university"></i> Create Academic Course';

  document.getElementById('tcTitle').value = course ? course.title : '';
  document.getElementById('tcCat').value = course ? (course.cat || 'lecture') : 'lecture';
  teacherSelectedColor = course ? (course.color || '#1565C0') : '#1565C0';
  document.querySelectorAll('#tcColorPicker .color-dot').forEach(d => {
    d.classList.toggle('selected', d.dataset.color === teacherSelectedColor);
  });

  document.getElementById('tcStart').value = course ? course.start : '09:00';
  document.getElementById('tcEnd').value = course ? course.end : '10:30';

  const defaultDays = course ? (course.days || [1, 3]) : [1, 3];
  document.querySelectorAll('.tc-wday-cb').forEach(cb => {
    cb.checked = defaultDays.includes(parseInt(cb.value));
  });

  document.getElementById('tcLocation').value = course ? (course.location || '') : '';
  document.getElementById('tcCustomCode').value = course ? (course.classCode || '') : generateClassCode();
  document.getElementById('tcDesc').value = course ? (course.description || '') : '';

  openModal('createClassroomModal');
}

async function saveTeacherClassroom() {
  const title = document.getElementById('tcTitle').value.trim();
  if (!title) { showToast('⚠️ Course title is required.'); return; }

  const start = document.getElementById('tcStart').value;
  const end = document.getElementById('tcEnd').value;
  if (!start || !end) { showToast('⚠️ Class start and end times required.'); return; }

  const days = [];
  document.querySelectorAll('.tc-wday-cb:checked').forEach(cb => days.push(parseInt(cb.value)));
  if (!days.length) { showToast('⚠️ Please select at least one meeting day.'); return; }

  let classCode = document.getElementById('tcCustomCode').value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!classCode) classCode = generateClassCode(title);

  const editId = document.getElementById('editClassroomId').value;
  const u = getCurrentUser() || CURRENT_USER || {};
  const instructorUid = u.uid || '';
  const instructorName = u.displayName || u.name || 'Instructor';
  const instructorUsername = u.username || '';

  const courseId = editId || uid();
  const existingCourse = (globalData.recurring || []).find(r => r.id === courseId);

  const courseObj = {
    id: courseId,
    title,
    cat: document.getElementById('tcCat').value,
    color: teacherSelectedColor,
    start,
    end,
    days,
    freq: 'weekly',
    startDate: existingCourse?.startDate || todayStr(),
    endDate: existingCourse?.endDate || null,
    location: document.getElementById('tcLocation').value.trim(),
    description: document.getElementById('tcDesc').value.trim(),
    classCode,
    instructorUid,
    instructorName,
    instructorUsername,
    isTaughtCourse: true,
    enrolledStudents: existingCourse?.enrolledStudents || [],
    studentUids: existingCourse?.studentUids || [],
    assignments: existingCourse?.assignments || [],
    announcements: existingCourse?.announcements || [],
    courseNotes: existingCourse?.courseNotes || [],
    updatedAt: new Date().toISOString()
  };

  saveRecurring(courseObj);

  // Sync to Firestore classrooms/{classCode}
  if (typeof firebase !== 'undefined' && firebase.apps.length) {
    try {
      await firebase.firestore().collection('classrooms').doc(classCode).set(courseObj, { merge: true });
    } catch (e) {
      console.warn('Classroom cloud save note (cached locally):', e);
    }
  }

  closeModal('createClassroomModal');
  refreshAll();
  showToast(`🎓 Academic Course "${title}" saved! Class Code: ${classCode}`, 4500);
}

function copyClassCode(code) {
  if (!code) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(() => {
      showToast(`📋 Class Code "${code}" copied to clipboard!`);
    }).catch(() => {
      prompt('Copy class code:', code);
    });
  } else {
    prompt('Copy class code:', code);
  }
}

function copyClassInviteLink(code) {
  if (!code) return;
  const baseUrl = window.location.origin + window.location.pathname;
  const url = `${baseUrl}?join=${encodeURIComponent(code)}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      showToast(`🔗 Invite Link copied to clipboard!`);
    }).catch(() => {
      prompt('Copy invitation link:', url);
    });
  } else {
    prompt('Copy invitation link:', url);
  }
}

function renderTeacherDashboard() {
  const isTeacher = isTeacherRole();
  if (!isTeacher) return;

  const courses = (globalData.recurring || []).filter(r => r.isTaughtCourse || r.classCode);

  // Calculate metrics
  const uniqueStudents = new Set();
  let totalAssignments = 0;
  let totalAnnouncements = 0;

  courses.forEach(c => {
    (c.studentUids || []).forEach(uid => uniqueStudents.add(uid));
    totalAssignments += (c.assignments || []).length;
    totalAnnouncements += (c.announcements || []).length;
  });

  const todayEvents = getEventsForDate(currentDate).filter(e => e.isTaughtCourse || courses.some(c => c.id === (e.recurId || e.id)));

  // Update Stat counters
  const elCourses = document.getElementById('teacherStatCourses');
  const elStudents = document.getElementById('teacherStatStudents');
  const elAssignments = document.getElementById('teacherStatAssignments');
  const elAnnouncements = document.getElementById('teacherStatAnnouncements');
  const elTodayClasses = document.getElementById('teacherStatTodayClasses');

  if (elCourses) elCourses.textContent = courses.length;
  if (elStudents) elStudents.textContent = uniqueStudents.size;
  if (elAssignments) elAssignments.textContent = totalAssignments;
  if (elAnnouncements) elAnnouncements.textContent = totalAnnouncements;
  if (elTodayClasses) elTodayClasses.textContent = todayEvents.length;

  // Populate Quick Announcement select
  const quickSelect = document.getElementById('quickAnnounceCourseSelect');
  if (quickSelect) {
    quickSelect.innerHTML = '<option value="">Select course to broadcast…</option>' +
      courses.map(c => `<option value="${c.classCode || c.id}">${esc(c.title)} (${c.classCode || 'No Code'})</option>`).join('');
  }

  const dateLbl = document.getElementById('teacherTodayDateLabel');
  if (dateLbl) {
    const isToday = currentDate === todayStr();
    dateLbl.textContent = isToday
      ? `Upcoming classes and lecture sessions scheduled to teach today (${formatDateShort(currentDate)})`
      : `Upcoming classes and lecture sessions scheduled to teach on ${formatDateShort(currentDate)}`;
  }

  // Populate Today's Teaching Schedule
  const todayListEl = document.getElementById('teacherTodayClassesList');
  if (todayListEl) {
    if (!todayEvents.length) {
      todayListEl.innerHTML = `
        <div style="font-size:12px;color:var(--text-light);padding:14px 10px;text-align:center">
          <i class="fas fa-mug-hot" style="font-size:20px;margin-bottom:6px;display:block;opacity:0.6"></i>
          No lectures or sessions scheduled for today (${formatDateShort(currentDate)}).
        </div>`;
    } else {
      todayListEl.innerHTML = todayEvents.map(e => `
        <div class="teacher-today-item" onclick="openCourseDetails('${e.recurId || e.id}')" style="cursor:pointer" title="Click to view course hub">
          <div>
            <div class="tti-title">${CAT_ICONS[e.cat] || '🎓'} ${esc(e.title)}</div>
            <div class="tti-meta">
              <span><i class="fas fa-clock"></i> ${e.start}–${e.end}</span>
              ${e.location ? `<span><i class="fas fa-map-marker-alt"></i> ${esc(e.location)}</span>` : ''}
              ${e.classCode ? `<span><i class="fas fa-key"></i> ${esc(e.classCode)}</span>` : ''}
            </div>
          </div>
          <button class="btn-secondary btn-sm" onclick="event.stopPropagation(); openCourseDetails('${e.recurId || e.id}')">
            View
          </button>
        </div>
      `).join('');
    }
  }

  // Populate Course Hub Grid
  const gridEl = document.getElementById('teacherCoursesGrid');
  if (!gridEl) return;

  if (!courses.length) {
    gridEl.innerHTML = `
      <div class="empty-state" style="padding:36px 16px;">
        <i class="fas fa-university"></i>
        <h3>No Academic Courses Created Yet</h3>
        <p>Set up your first course to generate a unique Class Code, distribute it to your students, and publish assignments.</p>
        <button class="btn-primary" onclick="openCreateClassroomModal()">
          <i class="fas fa-plus"></i> Create Academic Course
        </button>
      </div>`;
    return;
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  gridEl.innerHTML = courses.map(c => {
    const studentCount = (c.enrolledStudents || c.studentUids || []).length;
    const assignmentCount = (c.assignments || []).length;
    const daysStr = (c.days || []).map(d => dayNames[d]).join(', ');

    return `
      <div class="teacher-course-card" style="border-left-color:${c.color || '#1565C0'}">
        <div class="tcc-top-row">
          <div class="tcc-title-wrap">
            <div class="tcc-title">
              <span>${CAT_ICONS[c.cat] || '🎓'} ${esc(c.title)}</span>
              <span class="ev-cat-badge" style="background:${c.color || '#1565C0'}">${esc(c.cat || 'Lecture')}</span>
            </div>
            <div class="tcc-meta-row">
              <span class="tcc-meta-item"><i class="fas fa-clock"></i> ${c.start}–${c.end} (${daysStr || 'Weekly'})</span>
              ${c.location ? `<span class="tcc-meta-item"><i class="fas fa-map-marker-alt"></i> ${esc(c.location)}</span>` : ''}
            </div>
          </div>
          <button class="btn-secondary btn-sm" onclick="openCreateClassroomModal('${c.id}')" title="Edit course settings">
            <i class="fas fa-cog"></i> Settings
          </button>
        </div>

        <!-- Prominent Class Code Banner with 1-Click Copy -->
        <div class="tcc-code-banner">
          <div class="tcc-code-info">
            <i class="fas fa-key" style="color:var(--primary)"></i>
            <span class="tcc-code-label">Student Class Code:</span>
            <span class="tcc-code-tag">${esc(c.classCode || 'NONE')}</span>
          </div>
          <div class="tcc-code-btns">
            <button class="btn-code-copy" onclick="copyClassCode('${c.classCode}')" title="Copy code for syllabus / board">
              <i class="fas fa-copy"></i> Copy Code
            </button>
            <button class="btn-code-copy" onclick="copyClassInviteLink('${c.classCode}')" title="Copy direct enrollment link">
              <i class="fas fa-link"></i> Invite Link
            </button>
          </div>
        </div>

        <!-- Enrollment & Material Stats -->
        <div class="tcc-stats-bar">
          <span class="tcc-stat-pill students" onclick="openClassRosterModal('${c.classCode || c.id}')" style="cursor:pointer" title="Click to view student list">
            <i class="fas fa-users"></i> ${studentCount} Enrolled Student${studentCount !== 1 ? 's' : ''}
          </span>
          <span class="tcc-stat-pill assignments">
            <i class="fas fa-clipboard-check"></i> ${assignmentCount} Assignment${assignmentCount !== 1 ? 's' : ''}
          </span>
          ${(c.announcements || []).length ? `
            <span class="tcc-stat-pill">
              <i class="fas fa-bullhorn"></i> ${(c.announcements || []).length} Announcements
            </span>` : ''}
        </div>

        <!-- Teacher Actions Grid -->
        <div class="tcc-actions-grid">
          <button class="btn-tcc-action" onclick="openPublishAssignmentModal('${c.id}', '${c.classCode || ''}')" title="Create course-wide assignment">
            <i class="fas fa-plus"></i> Assignment
          </button>
          <button class="btn-tcc-action" onclick="openPostAnnouncementModal('${c.id}', '${c.classCode || ''}')" title="Broadcast announcement to students">
            <i class="fas fa-bullhorn"></i> Announcement
          </button>
          <button class="btn-tcc-action" onclick="openCourseDetails('${c.id}')" title="Open full course details & notes">
            <i class="fas fa-folder-open"></i> Course View
          </button>
          <button class="btn-tcc-action" onclick="openClassRosterModal('${c.classCode || c.id}')" title="View enrolled students">
            <i class="fas fa-user-graduate"></i> Roster
          </button>
        </div>
      </div>`;
  }).join('');
}

// ── Publish Course Assignment (Teacher) ──
function openPublishAssignmentModal(courseId, classCode) {
  const course = (globalData.recurring || []).find(r => r.id === courseId || r.classCode === classCode);
  if (!course) return;

  document.getElementById('paCourseId').value = course.id;
  document.getElementById('paClassCode').value = course.classCode || classCode || '';
  document.getElementById('paCourseTitleDisplay').textContent = `${course.title} (${course.classCode || ''})`;

  document.getElementById('paTitle').value = '';
  document.getElementById('paDue').value = offset(todayStr(), 7);
  document.getElementById('paDueTime').value = '23:59';
  document.getElementById('paPriority').value = 'normal';
  document.getElementById('paDuration').value = '60';
  document.getElementById('paNotes').value = '';

  openModal('publishAssignmentModal');
}

async function submitPublishAssignment() {
  const courseId = document.getElementById('paCourseId').value;
  const classCode = document.getElementById('paClassCode').value;
  const title = document.getElementById('paTitle').value.trim();
  const due = document.getElementById('paDue').value;
  if (!title) { showToast('⚠️ Assignment title is required.'); return; }
  if (!due) { showToast('⚠️ Due date is required.'); return; }

  const dueTime = document.getElementById('paDueTime').value || '23:59';
  const priority = document.getElementById('paPriority').value;
  const duration = parseInt(document.getElementById('paDuration').value) || 60;
  const notes = document.getElementById('paNotes').value.trim();

  const course = (globalData.recurring || []).find(r => r.id === courseId || r.classCode === classCode);
  if (!course) return;

  if (!Array.isArray(course.assignments)) course.assignments = [];

  const assignmentObj = {
    id: uid(),
    courseId: course.id,
    courseTitle: course.title,
    title,
    due,
    dueTime,
    priority,
    duration,
    notes,
    cat: 'assignment',
    done: false,
    createdAt: new Date().toISOString()
  };

  course.assignments.unshift(assignmentObj);
  save();

  // Push to Firestore collection classrooms/{classCode}
  if (classCode && typeof firebase !== 'undefined' && firebase.apps.length) {
    try {
      await firebase.firestore().collection('classrooms').doc(classCode).update({
        assignments: firebase.firestore.FieldValue.arrayUnion(assignmentObj),
        updatedAt: new Date().toISOString()
      });
    } catch(e) {
      console.warn('Assignment publish note:', e);
    }
  }

  closeModal('publishAssignmentModal');
  refreshAll();
  showToast(`📢 Assignment "${title}" published to enrolled students!`, 4000);
}

// ── Post Course Announcement (Teacher) ──
function openPostAnnouncementModal(courseId, classCode) {
  const course = (globalData.recurring || []).find(r => r.id === courseId || r.classCode === classCode);
  if (!course) return;

  document.getElementById('panCourseId').value = course.id;
  document.getElementById('panClassCode').value = course.classCode || classCode || '';
  document.getElementById('panCourseTitleDisplay').textContent = `${course.title} (${course.classCode || ''})`;

  document.getElementById('panTitle').value = '';
  document.getElementById('panText').value = '';
  document.getElementById('panUrgent').checked = false;

  openModal('postAnnouncementModal');
}

async function submitPostAnnouncement() {
  const courseId = document.getElementById('panCourseId').value;
  const classCode = document.getElementById('panClassCode').value;
  const title = document.getElementById('panTitle').value.trim();
  const text = document.getElementById('panText').value.trim();
  if (!title) { showToast('⚠️ Announcement title is required.'); return; }
  if (!text) { showToast('⚠️ Announcement text is required.'); return; }

  const urgent = document.getElementById('panUrgent').checked;
  const course = (globalData.recurring || []).find(r => r.id === courseId || r.classCode === classCode);
  if (!course) return;

  if (!Array.isArray(course.announcements)) course.announcements = [];

  const u = getCurrentUser() || CURRENT_USER || {};
  const instructorName = u.displayName || u.name || 'Instructor';

  const annObj = {
    id: uid(),
    courseId: course.id,
    courseTitle: course.title,
    title,
    text,
    urgent,
    byUser: instructorName,
    timestamp: Date.now()
  };

  course.announcements.unshift(annObj);
  save();

  // Push to Firestore collection classrooms/{classCode}
  if (classCode && typeof firebase !== 'undefined' && firebase.apps.length) {
    try {
      await firebase.firestore().collection('classrooms').doc(classCode).update({
        announcements: firebase.firestore.FieldValue.arrayUnion(annObj),
        updatedAt: new Date().toISOString()
      });
    } catch(e) {
      console.warn('Announcement publish note:', e);
    }
  }

  closeModal('postAnnouncementModal');
  refreshAll();
  showToast(`📢 Announcement "${title}" broadcast to all students!`, 4000);
}

function quickBroadcastAnnouncement() {
  const select = document.getElementById('quickAnnounceCourseSelect');
  const classCodeOrId = select?.value;
  if (!classCodeOrId) {
    showToast('⚠️ Please select a course to broadcast.');
    return;
  }
  const course = (globalData.recurring || []).find(r => r.id === classCodeOrId || r.classCode === classCodeOrId);
  if (!course) {
    showToast('⚠️ Selected course not found.');
    return;
  }
  const title = (document.getElementById('quickAnnounceTitle')?.value || '').trim();
  const text = (document.getElementById('quickAnnounceText')?.value || '').trim();

  if (!title || !text) {
    showToast('⚠️ Headline and details are required.');
    return;
  }

  const u = getCurrentUser() || CURRENT_USER || {};
  const annObj = {
    id: uid(),
    courseId: course.id,
    courseTitle: course.title,
    title,
    text,
    urgent: false,
    byUser: u.displayName || u.name || 'Instructor',
    timestamp: Date.now()
  };

  if (!Array.isArray(course.announcements)) course.announcements = [];
  course.announcements.unshift(annObj);
  save();

  if (course.classCode && typeof firebase !== 'undefined' && firebase.apps.length) {
    firebase.firestore().collection('classrooms').doc(course.classCode).update({
      announcements: firebase.firestore.FieldValue.arrayUnion(annObj),
      updatedAt: new Date().toISOString()
    }).catch(e => console.warn('Broadcast note:', e));
  }

  document.getElementById('quickAnnounceTitle').value = '';
  document.getElementById('quickAnnounceText').value = '';
  refreshAll();
  showToast(`📢 Broadcast sent to ${course.title}!`);
}

// ── Student Join Course Modal ──
function openJoinClassModal(prefillCode = '') {
  if (isTeacherRole()) {
    showToast('⚠️ Instructors cannot join courses as students. Use your Academic Hub to manage courses.');
    return;
  }
  const codeInp = document.getElementById('jcCode');
  const preview = document.getElementById('jcPreviewBox');
  const feedback = document.getElementById('jcFeedback');

  if (codeInp) {
    codeInp.value = prefillCode ? prefillCode.toUpperCase().trim() : '';
  }
  if (preview) preview.classList.add('hidden');
  if (feedback) feedback.classList.add('hidden');

  if (prefillCode) {
    onJoinCodeInput(prefillCode);
  }

  openModal('joinClassModal');
}

let joinCodeDebounce = null;
async function onJoinCodeInput(val) {
  const code = (val || '').toUpperCase().trim();
  const preview = document.getElementById('jcPreviewBox');
  const feedback = document.getElementById('jcFeedback');
  if (!preview) return;

  clearTimeout(joinCodeDebounce);
  if (code.length < 4) {
    preview.classList.add('hidden');
    if (feedback) feedback.classList.add('hidden');
    return;
  }

  joinCodeDebounce = setTimeout(async () => {
    if (typeof firebase === 'undefined' || !firebase.apps.length) return;
    try {
      const doc = await firebase.firestore().collection('classrooms').doc(code).get();
      if (doc.exists) {
        const data = doc.data();
        document.getElementById('jpCat').textContent = (CAT_ICONS[data.cat] || '🎓') + ' ' + (data.cat || 'Lecture');
        document.getElementById('jpTitle').textContent = data.title;
        document.getElementById('jpInstructor').textContent = data.instructorName || 'Professor';
        document.getElementById('jpSchedule').textContent = `${data.start}–${data.end} (${data.freq || 'Weekly'})`;
        document.getElementById('jpLocation').textContent = data.location || 'Classroom / Campus';
        preview.classList.remove('hidden');
        if (feedback) feedback.classList.add('hidden');
      } else {
        preview.classList.add('hidden');
        if (feedback) {
          feedback.className = 'invite-feedback';
          feedback.innerHTML = '<i class="fas fa-info-circle"></i> No course found with code <b>' + esc(code) + '</b>. Check code spelling.';
          feedback.classList.remove('hidden');
        }
      }
    } catch(e) {
      console.warn('Classroom query note:', e);
    }
  }, 400);
}

async function submitJoinCourse() {
  const codeInp = document.getElementById('jcCode');
  const code = (codeInp?.value || '').toUpperCase().trim();
  const feedback = document.getElementById('jcFeedback');
  const btn = document.getElementById('btnSubmitJoinCourse');

  if (!code) {
    showToast('⚠️ Please enter a Class Code.');
    return;
  }

  // Check if student already enrolled
  const existing = (globalData.recurring || []).find(r => r.classCode === code);
  if (existing) {
    showToast(`ℹ️ You are already enrolled in "${existing.title}".`);
    closeModal('joinClassModal');
    return;
  }

  if (btn) btn.disabled = true;
  if (feedback) {
    feedback.className = 'invite-feedback';
    feedback.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying Class Code &amp; enrolling…';
    feedback.classList.remove('hidden');
  }

  try {
    const doc = await firebase.firestore().collection('classrooms').doc(code).get();
    if (!doc.exists) {
      if (btn) btn.disabled = false;
      if (feedback) {
        feedback.innerHTML = '❌ Class code not found. Please confirm with your instructor.';
      }
      return;
    }

    const data = doc.data();
    const u = getCurrentUser() || CURRENT_USER || {};
    const studentInfo = {
      uid: u.uid || uid(),
      name: u.displayName || u.name || u.username || 'Student',
      username: u.username || '',
      email: u.email || '',
      enrolledAt: new Date().toISOString()
    };

    // Update Firestore enrolled students
    try {
      await firebase.firestore().collection('classrooms').doc(code).update({
        studentUids: firebase.firestore.FieldValue.arrayUnion(studentInfo.uid),
        enrolledStudents: firebase.firestore.FieldValue.arrayUnion(studentInfo),
        updatedAt: new Date().toISOString()
      });
    } catch(e) {
      console.warn('Firestore enroll note:', e);
    }

    // Add to student's recurring classes
    const courseObj = {
      id: data.courseId || uid(),
      title: data.title,
      cat: data.cat || 'lecture',
      color: data.color || '#1565C0',
      start: data.start,
      end: data.end,
      days: data.days || [1],
      freq: data.freq || 'weekly',
      startDate: data.startDate || todayStr(),
      endDate: data.endDate || null,
      location: data.location || '',
      description: data.description || '',
      classCode: code,
      instructorUid: data.instructorUid || '',
      instructorName: data.instructorName || 'Professor',
      isEnrolled: true,
      assignments: data.assignments || [],
      announcements: data.announcements || [],
      courseNotes: []
    };

    if (!Array.isArray(globalData.recurring)) globalData.recurring = [];
    globalData.recurring.push(courseObj);

    // Sync any published assignments into student's active assignments
    (data.assignments || []).forEach(asgn => {
      const taskObj = {
        id: asgn.id || uid(),
        courseId: courseObj.id,
        title: asgn.title,
        cat: 'assignment',
        due: asgn.due,
        priority: asgn.priority || 'normal',
        duration: asgn.duration || 60,
        notes: asgn.notes || `Course: ${data.title}`,
        done: false
      };
      const curDay = dayData(asgn.due || currentDate);
      if (!Array.isArray(curDay.tasks)) curDay.tasks = [];
      if (!curDay.tasks.some(t => t.id === taskObj.id)) {
        curDay.tasks.push(taskObj);
      }
    });

    save();
    playNotificationChime();
    closeModal('joinClassModal');
    refreshAll();
    renderTasks();
    showToast(`🎓 Successfully enrolled in "${data.title}" taught by ${data.instructorName || 'your instructor'}!`, 5000);
  } catch(err) {
    if (btn) btn.disabled = false;
    if (feedback) {
      feedback.innerHTML = `⚠️ Enrollment error: ${err.message || 'Please check your connection.'}`;
    }
  }
}

function checkUrlForClassCode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (joinCode) {
      setTimeout(() => {
        openJoinClassModal(joinCode);
      }, 500);
    }
  } catch(e) {}
}

// ── Student Roster Modal (Teacher) ──
async function openClassRosterModal(classCodeOrCourseId) {
  const course = (globalData.recurring || []).find(r => r.classCode === classCodeOrCourseId || r.id === classCodeOrCourseId);
  const classCode = course?.classCode || classCodeOrCourseId;

  document.getElementById('rosterModalTitle').innerHTML = `<i class="fas fa-user-graduate"></i> ${course ? esc(course.title) : 'Class'} Roster`;
  document.getElementById('rosterModalSub').textContent = course ? `${course.start}–${course.end} • ${course.location || 'Classroom'}` : 'Student Roster';
  document.getElementById('rosterClassCodeBadge').textContent = `CODE: ${classCode}`;

  const listEl = document.getElementById('classRosterList');
  const countEl = document.getElementById('rosterStudentCount');

  let students = course?.enrolledStudents || [];
  if (countEl) countEl.textContent = `${students.length} Student${students.length !== 1 ? 's' : ''} Enrolled`;

  if (listEl) {
    if (!students.length) {
      listEl.innerHTML = `
        <div class="empty-state" style="padding:28px 14px;">
          <i class="fas fa-user-graduate"></i>
          <h4>No Students Enrolled Yet</h4>
          <p>Share your Class Code <b>${esc(classCode)}</b> with your students to have them appear here automatically.</p>
          <button class="btn-primary btn-sm" onclick="copyClassCode('${classCode}')">
            <i class="fas fa-copy"></i> Copy Class Code
          </button>
        </div>`;
    } else {
      listEl.innerHTML = students.map(s => {
        const av = (s.name || s.username || 'S').charAt(0).toUpperCase();
        const dateStr = s.enrolledAt ? new Date(s.enrolledAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Recently';
        return `
          <div class="roster-student-item">
            <div class="roster-av">${av}</div>
            <div class="roster-info">
              <div class="roster-name">${esc(s.name || s.username || 'Student')}</div>
              <div class="roster-meta">
                ${s.username ? `<span>@${esc(s.username)}</span>` : ''}
                ${s.email ? `<span><i class="fas fa-envelope"></i> ${esc(s.email)}</span>` : ''}
                <span style="margin-left:auto"><i class="fas fa-calendar-check"></i> Enrolled: ${dateStr}</span>
              </div>
            </div>
          </div>`;
      }).join('');
    }
  }

  openModal('classRosterModal');

  // Pull latest from Firestore in background
  if (classCode && typeof firebase !== 'undefined' && firebase.apps.length) {
    try {
      const doc = await firebase.firestore().collection('classrooms').doc(classCode).get();
      if (doc.exists) {
        const fresh = doc.data().enrolledStudents || [];
        if (course) course.enrolledStudents = fresh;
        if (countEl) countEl.textContent = `${fresh.length} Student${fresh.length !== 1 ? 's' : ''} Enrolled`;
        if (listEl && fresh.length) {
          listEl.innerHTML = fresh.map(s => {
            const av = (s.name || s.username || 'S').charAt(0).toUpperCase();
            const dateStr = s.enrolledAt ? new Date(s.enrolledAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Recently';
            return `
              <div class="roster-student-item">
                <div class="roster-av">${av}</div>
                <div class="roster-info">
                  <div class="roster-name">${esc(s.name || s.username || 'Student')}</div>
                  <div class="roster-meta">
                    ${s.username ? `<span>@${esc(s.username)}</span>` : ''}
                    ${s.email ? `<span><i class="fas fa-envelope"></i> ${esc(s.email)}</span>` : ''}
                    <span style="margin-left:auto"><i class="fas fa-calendar-check"></i> Enrolled: ${dateStr}</span>
                  </div>
                </div>
              </div>`;
          }).join('');
        }
      }
    } catch(e) {}
  }
}

// ── Real-Time Classroom Sync (Live onSnapshot) ──
function initClassroomsRealtimeSync() {
  const user = getCurrentUser() || CURRENT_USER;
  if (!user || !user.uid || typeof firebase === 'undefined' || !firebase.apps.length) return;

  if (classroomsUnsubscribe) {
    try { classroomsUnsubscribe(); } catch(e){}
    classroomsUnsubscribe = null;
  }

  const isTeacher = isTeacherRole();
  const dbFs = firebase.firestore();

  try {
    let query;
    if (isTeacher) {
      // Teachers listen to courses they teach to observe student enrollments
      query = dbFs.collection('classrooms').where('instructorUid', '==', user.uid);
    } else {
      // Students listen to courses they are enrolled in to get live assignments & announcements
      query = dbFs.collection('classrooms').where('studentUids', 'array-contains', user.uid);
    }

    classroomsUnsubscribe = query.onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        const classData = change.doc.data();
        if (change.type === 'removed') {
          (globalData.recurring || []).forEach(c => {
            if (c.classCode === classData.classCode) c.isEnrolled = false;
          });
        } else {
          // Find or link recurring course
          let course = (globalData.recurring || []).find(r => r.classCode === classData.classCode || r.id === classData.courseId);
          if (course) {
            const prevAssignmentsCount = (course.assignments || []).length;
            const prevAnnounceCount = (course.announcements || []).length;

            course.title = classData.title || course.title;
            course.start = classData.start || course.start;
            course.end = classData.end || course.end;
            course.location = classData.location || course.location;
            course.enrolledStudents = classData.enrolledStudents || course.enrolledStudents || [];
            course.studentUids = classData.studentUids || course.studentUids || [];
            course.assignments = classData.assignments || course.assignments || [];
            course.announcements = classData.announcements || course.announcements || [];

            // Alert student if new announcement or assignment arrived live
            if (!isTeacher && change.type === 'modified') {
              if ((course.assignments || []).length > prevAssignmentsCount) {
                const latestAsgn = course.assignments[0];
                playNotificationChime();
                showToast(`📝 [${course.title}] New Assignment: ${latestAsgn.title}`, 4500);
              }
              if ((course.announcements || []).length > prevAnnounceCount) {
                const latestAnn = course.announcements[0];
                playNotificationChime();
                showToast(`📢 [${course.title}] Announcement: ${latestAnn.title}`, 4500);
              }
            }
          } else if (!isTeacher && classData.studentUids && classData.studentUids.includes(user.uid)) {
            // Course was added for student
            const newCourse = {
              id: classData.courseId || uid(),
              title: classData.title,
              cat: classData.cat || 'lecture',
              color: classData.color || '#1565C0',
              start: classData.start,
              end: classData.end,
              days: classData.days || [1],
              freq: classData.freq || 'weekly',
              startDate: classData.startDate || todayStr(),
              endDate: classData.endDate || null,
              location: classData.location || '',
              description: classData.description || '',
              classCode: classData.classCode,
              instructorUid: classData.instructorUid || '',
              instructorName: classData.instructorName || 'Professor',
              isEnrolled: true,
              assignments: classData.assignments || [],
              announcements: classData.announcements || [],
              courseNotes: []
            };
            if (!Array.isArray(globalData.recurring)) globalData.recurring = [];
            globalData.recurring.push(newCourse);
          }
        }
      });

      if (isTeacher) {
        renderTeacherDashboard();
      } else {
        renderSchedule();
        renderTasks();
      }
      updateNotificationCenter();
      save();
    }, err => {
      console.warn('Real-time classroom listener note (offline mode active):', err);
    });
  } catch(e) {
    console.warn('initClassroomsRealtimeSync error:', e);
  }
}

// ══════════════════════════════════════════
// PWA
// ══════════════════════════════════════════
function initPWA(){
  if('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.update();
    }).catch(()=>{});

    // Listen for messages from SW (e.g. notification click)
    navigator.serviceWorker.addEventListener('message', e => {
      if(e.data && e.data.type === 'OPEN_COURSE' && e.data.courseId){
        openCourseDetails(e.data.courseId);
      }
    });

    if('caches' in window) {
      caches.keys().then(keys => {
        keys.forEach(k => { if(k !== 'ib-planner-v11') caches.delete(k); });
      });
    }
  }
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();
    deferredInstall=e;
    const btn=document.getElementById('settingInstallBtn');
    if(btn){
      btn.innerHTML = '<i class="fas fa-download"></i> Install App on this Device';
    }
  });
  window.addEventListener('appinstalled',()=>{
    deferredInstall=null;
    showToast('📱 App installed successfully!',4000);
  });
}
function installApp(){
  if(deferredInstall){
    deferredInstall.prompt();
    deferredInstall.userChoice.then(()=>{deferredInstall=null;});
  } else {
    openModal('installHelpModal');
  }
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
function openModal(id){
  if (id === 'recurringModal') {
    renderRecurringList();
  }
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function closeModal(id){
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
document.addEventListener('click',e=>{if(e.target.classList.contains('modal-overlay'))e.target.classList.remove('open');});

// ══════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════
let toastTimer;
function showToast(msg,dur=2800){
  const t=document.getElementById('toast');
  if(!t) return;
  t.textContent=msg;t.classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),dur);
}

// ══════════════════════════════════════════
// USER BADGE & PERSONAL INFORMATION
// ══════════════════════════════════════════
function initUserBadge() {
  const user     = getCurrentUser() || CURRENT_USER || {};
  const settings = globalData.settings || {};
  const name     = user.displayName || user.name || settings.name || user.username || 'Student';
  const initial  = name.charAt(0).toUpperCase() || 'S';
  const role     = (user.role === 'teacher') ? 'Teacher / Dr.' : 'Student';
  const roleIcon = (user.role === 'teacher') ? 'fa-chalkboard-teacher' : 'fa-user-graduate';
  const email    = user.email || (user.username && !user.username.includes('@') ? user.username + '@student.edu' : (user.username || ''));

  const avatarEl = document.getElementById('userAvatar');
  const nameEl   = document.getElementById('userName');
  const udAvatar = document.getElementById('udAvatar');
  const udName   = document.getElementById('udName');
  const udRole   = document.getElementById('udRole');
  const udEmail  = document.getElementById('udEmailSub');

  if (avatarEl) avatarEl.textContent = initial;
  if (nameEl)   nameEl.textContent   = name;
  if (udAvatar) udAvatar.textContent = initial;
  if (udName)   udName.textContent   = name;
  if (udRole)   udRole.innerHTML     = `<i class="fas ${roleIcon}"></i> ${role}`;
  if (udEmail)  udEmail.textContent  = email ? email : 'Personal Info ›';
}

function openPersonalInfoModal() {
  const user     = getCurrentUser() || CURRENT_USER || {};
  const settings = globalData.settings || {};
  const name     = user.displayName || user.name || settings.name || user.username || '';
  const email    = user.email || '';
  const username = user.username || (user.email ? user.email.split('@')[0] : '');
  const role     = user.role || 'student';
  const major    = user.major || settings.major || '';
  const school   = user.school || settings.school || '';

  const nameInp   = document.getElementById('piFullName');
  const emailInp  = document.getElementById('piEmail');
  const userInp   = document.getElementById('piUsername');
  const roleSel   = document.getElementById('piRole');
  const majorInp  = document.getElementById('piMajor');
  const schoolInp = document.getElementById('piSchool');
  const avEl      = document.getElementById('piLargeAvatar');
  const headingEl = document.getElementById('piHeadingName');

  if (nameInp)   nameInp.value   = name;
  if (emailInp)  emailInp.value  = email;
  if (userInp)   userInp.value   = username;
  if (roleSel)   roleSel.value   = role;
  if (majorInp)  majorInp.value  = major;
  if (schoolInp) schoolInp.value = school;
  if (avEl)      avEl.textContent = (name || 'S').charAt(0).toUpperCase();
  if (headingEl) headingEl.textContent = name || 'Student Profile';

  openModal('personalInfoModal');
}

async function savePersonalInfo() {
  const name   = document.getElementById('piFullName').value.trim();
  const email  = document.getElementById('piEmail').value.trim();
  const role   = document.getElementById('piRole').value;
  const major  = document.getElementById('piMajor').value.trim();
  const school = document.getElementById('piSchool').value.trim();

  if (!name) { showToast('⚠️ Name is required.'); return; }
  if (!email || !email.includes('@')) { showToast('⚠️ Valid email is required.'); return; }

  if (!globalData.settings) globalData.settings = {};
  globalData.settings.name   = name;
  globalData.settings.major  = major;
  globalData.settings.school = school;

  let session = getCurrentUser() || {};
  session.displayName = name;
  session.name        = name;
  session.email       = email;
  session.role        = role;
  session.major       = major;
  session.school      = school;

  const sessionStr = JSON.stringify(session);
  sessionStorage.setItem('ib_session', sessionStr);
  if (localStorage.getItem('ib_remember')) {
    localStorage.setItem('ib_remember', sessionStr);
  }

  // Sync to Firestore users collection
  if (typeof firebase !== 'undefined' && firebase.apps.length && session.uid) {
    try {
      await firebase.firestore().collection('users').doc(session.uid).set({
        displayName: name,
        email: email,
        role: role,
        major: major,
        school: school,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch (e) {
      console.warn('Profile update note:', e);
    }
  }

  CURRENT_USER = session;
  USER_KEY     = CURRENT_USER ? (CURRENT_USER.username || CURRENT_USER.email || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '_') : 'guest';
  save();
  initUserBadge();
  applyRoleUI();
  initClassroomsRealtimeSync();
  refreshAll();
  closeModal('personalInfoModal');
  showToast(`✅ Profile saved! Switched to ${role === 'teacher' ? 'Teacher / Instructor' : 'Student'} mode.`, 3500);
}

async function sendPasswordResetFromProfile() {
  const user  = getCurrentUser() || CURRENT_USER || {};
  const email = (document.getElementById('piEmail')?.value || user.email || '').trim();
  if (!email || !email.includes('@')) {
    showToast('⚠️ Please enter a valid email address first.');
    return;
  }
  if (!confirm(`Send password reset email to ${email}?`)) return;
  try {
    if (typeof firebase !== 'undefined' && firebase.auth) {
      await firebase.auth().sendPasswordResetEmail(email);
      showToast('✉️ Reset email sent! Check your inbox.');
    } else {
      showToast('⚠️ Cloud authentication service unavailable.');
    }
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to send reset email.'));
  }
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
  const notifContainer = document.getElementById('notifMenuContainer');
  if (notifContainer && !notifContainer.contains(e.target)) {
    notifContainer.classList.remove('open');
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
document.addEventListener('DOMContentLoaded', () => {
  try {
    // ── One-time cleanup: wipe old auto-seeded data ──
    const cleaned = localStorage.getItem('ib_cleaned_v3');
    if (!cleaned) {
      localStorage.removeItem('ib_db');
      localStorage.removeItem('ib_global');
      localStorage.removeItem('ib_seeded_v2');
      localStorage.removeItem('ib_student_seeded');
      localStorage.removeItem('ib_student_seeded_v2');
      localStorage.setItem('ib_cleaned_v3', '1');
    }
  } catch (e) { console.warn('Clean error:', e); }

  try { load(); } catch (e) { console.error('load error:', e); }
  try { loadSettings(); } catch (e) { console.error('loadSettings error:', e); }
  try { startClock(); } catch (e) { console.error('startClock error:', e); }
  try { initNav(); } catch (e) { console.error('initNav error:', e); }
  try { initPWA(); } catch (e) { console.error('initPWA error:', e); }
  try { initNotifications(); } catch (e) { console.error('initNotifications error:', e); }
  try { initUserBadge(); } catch (e) { console.error('initUserBadge error:', e); }
  try { initCloudSync(); } catch (e) { console.error('initCloudSync error:', e); }
  try { initProjectsRealtimeSync(); } catch (e) { console.error('initProjectsRealtimeSync error:', e); }
  try { applyRoleUI(); } catch (e) { console.error('applyRoleUI error:', e); }
  try { initClassroomsRealtimeSync(); } catch (e) { console.error('initClassroomsRealtimeSync error:', e); }
  try { checkUrlForClassCode(); } catch (e) { console.error('checkUrlForClassCode error:', e); }
  try { updateNotificationCenter(); } catch (e) { console.error('updateNotificationCenter error:', e); }

  currentDate = todayStr();
  const dp = document.getElementById('dayPicker');
  if (dp) dp.value = currentDate;
  const evSd = document.getElementById('evStartDate');
  if (evSd) evSd.value = currentDate;
  currentWeekStart = getWeekStart(new Date());
  const now = new Date();
  currentMonth = { year: now.getFullYear(), month: now.getMonth() };

  try {
    refreshAll();
    renderTasks();
    renderNotes();
    renderContacts();
  } catch (e) { console.error('render error:', e); }

  const u = getCurrentUser() || CURRENT_USER;
  const name = u ? (u.displayName || u.name || u.username) : '';
  showToast(`🎓 Welcome${name ? ' back, ' + name : ''}! Cloud sync active.`, 3500);
});


