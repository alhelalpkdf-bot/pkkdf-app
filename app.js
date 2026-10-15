/* ================================================================
   PKKDF — Frontend application logic
   Offline-first: every read renders from IndexedDB first; every
   write goes to IndexedDB immediately and is queued for sync.
   ================================================================ */

/* ---------- CONFIG ---------- */
const CONFIG = {
  // Paste your deployed Google Apps Script Web App URL here.
  // See DEPLOYMENT_GUIDE.md — must end in /exec
  API_BASE: 'https://script.google.com/macros/s/AKfycbyGf9YTI9kQ7JTz_yO_qR4StF49zy1EUqm1JPQ3hzIJ_I3S_Qtk4v_r-SILj6CEs7k/exec',
  // Used only if a farmer's own branch office (see Offices sheet) can't
  // be found — should rarely trigger once every officer's officeName
  // matches an Offices sheet row.
  FALLBACK_OFFICE_LAT: 23.8103,
  FALLBACK_OFFICE_LNG: 90.4125,
  OVERDUE_DAYS: 20
};

/* ================================================================
   INDEXEDDB WRAPPER
   ================================================================ */
const DB_NAME = 'pkkdf_db';
const DB_VERSION = 1;
let dbInstance = null;

function openDb() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('session')) db.createObjectStore('session', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('masterData')) db.createObjectStore('masterData', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('farmers')) db.createObjectStore('farmers', { keyPath: 'formNo' });
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'localId', autoIncrement: true });
    };
    req.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbTx(storeName, mode) {
  return openDb().then(db => db.transaction(storeName, mode).objectStore(storeName));
}
function idbGet(store, key) {
  return idbTx(store, 'readonly').then(os => new Promise((res, rej) => {
    const r = os.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
function idbGetAll(store) {
  return idbTx(store, 'readonly').then(os => new Promise((res, rej) => {
    const r = os.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
function idbPut(store, value) {
  return idbTx(store, 'readwrite').then(os => new Promise((res, rej) => {
    const r = os.put(value); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
// একই ট্রানজেকশনে পড়া+লেখা — দুই জায়গা একসাথে লিখলে একে অপরের নতুন ডাটা মুছে দিতে পারবে না।
function idbUpdate(store, key, fn) {
  return openDb().then(db => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    let out;
    const g = os.get(key);
    g.onsuccess = () => { out = fn(g.result); if (out) os.put(out); };
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('IDB abort'));
  }));
}
function idbDelete(store, key) {
  return idbTx(store, 'readwrite').then(os => new Promise((res, rej) => {
    const r = os.delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
}

/* ================================================================
   NETWORK HELPERS
   ================================================================ */
// fetch + টাইমআউট + নিরাপদ JSON পার্স। সার্ভার HTML ত্রুটি পাঠালে (যেমন পুরনো ডেপ্লয়মেন্ট) পরিষ্কার বার্তা দেয়।
async function fetchJson_(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 90000);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    const txt = await r.text();
    try { return JSON.parse(txt); }
    catch (e) { throw new Error('সার্ভারের উত্তর বোঝা যায়নি — Apps Script "New version" দিয়ে ডেপ্লয় করা হয়েছে কি?'); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('সার্ভার সময়মতো সাড়া দেয়নি');
    throw e;
  } finally { clearTimeout(timer); }
}
function apiGet(action, params) {
  const qs = new URLSearchParams(Object.assign({ action }, params || {})).toString();
  return fetchJson_(CONFIG.API_BASE + '?' + qs, {}, 60000);
}
function apiPost(action, payload) {
  return fetchJson_(CONFIG.API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight on Apps Script
    body: JSON.stringify(Object.assign({ action }, payload))
  }, 120000);
}
function apiOk_(res) { return !!res && res.ok !== false && !res.error; }
function apiErr_(res) { return (res && (res.message || res.error)) || 'সার্ভারে সমস্যা'; }

function isOnline() { return navigator.onLine; }

/* ================================================================
   TOASTS
   ================================================================ */
function toast(msg, type) {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = 'app-toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* ================================================================
   AUTH
   ================================================================ */
let CURRENT_USER = null;

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('loginId').value.trim();
  const pin = document.getElementById('loginPin').value.trim();
  const errBox = document.getElementById('loginError');
  errBox.textContent = '';

  // Offline: check cached session credentials
  if (!isOnline()) {
    const cached = await idbGet('session', 'user');
    if (cached && cached.value && (cached.value.nid === id || cached.value.mobile === id) && cached.value._pin === pin) {
      startApp(cached.value);
      return;
    }
    errBox.textContent = 'অফলাইনে থাকা অবস্থায় প্রথমবার লগইন করতে ইন্টারনেট সংযোগ প্রয়োজন';
    return;
  }

  try {
    const res = await apiPost('login', { nidOrMobile: id, pin });
    if (res.ok) {
      const user = Object.assign({}, res.employee, { _pin: pin }); // pin cached locally only, for offline re-login
      await idbPut('session', { key: 'user', value: user });
      startApp(user);
    } else {
      errBox.textContent = res.message || 'লগইন ব্যর্থ হয়েছে';
    }
  } catch (err) {
    errBox.textContent = 'সার্ভারে সংযোগ করা যায়নি';
  }
});

async function tryAutoLogin() {
  const cached = await idbGet('session', 'user');
  if (cached && cached.value) startApp(cached.value);
}

function startApp(user) {
  CURRENT_USER = user;
  document.getElementById('screen-login').classList.remove('active-screen');
  document.getElementById('app-shell').classList.remove('d-none');
  if (user.role === 'admin' || user.role === 'super_admin') {
    document.getElementById('adminNavBtn').classList.remove('d-none');
  }
  bootApp();
}

function requesterId() { return CURRENT_USER.id || CURRENT_USER.nid; }
function isAdmin() { return CURRENT_USER && (CURRENT_USER.role === 'admin' || CURRENT_USER.role === 'super_admin'); }

/* ================================================================
   APP BOOT
   ================================================================ */
async function bootApp() {
  updateNetPill();
  await refreshMasterDataCache();
  // Pull farmer records from the server BEFORE the first paint, so a
  // fresh device/browser doesn't show "0" until you happen to revisit
  // the screen. Safe to skip if offline — local cache (if any) is used.
  await refreshFarmersCache();
  await renderLocationDropdowns();
  await renderCropDropdown();
  navigateTo('home');
  updateSyncBanner();
  if (isOnline()) syncQueue();
}

// "মোট জমি" only counts land for farmers who have actually been approved
// (and beyond) — an application still awaiting approval hasn't had its
// land verified/acted on yet, so it shouldn't count toward the total.
function totalApprovedLandBigha(farmers) {
  return farmers
    .filter(f => f.status && f.status !== 'নিবন্ধিত')
    .reduce((s, f) => s + (Number(f.landSize) || 0), 0);
}

// A farmer's map pin normally uses the GPS captured at registration
// (f.gpsLat/gpsLng). Many officers only capture GPS later, during a
// follow-up step — so if registration GPS is missing, fall back to the
// most recent follow-up step that has one, rather than showing nothing.
function getFarmerMapCoords(f) {
  if (f.gpsLat && f.gpsLng && isFinite(Number(f.gpsLat)) && isFinite(Number(f.gpsLng))) return { lat: Number(f.gpsLat), lng: Number(f.gpsLng) };
  for (const s of [4, 3, 2, 1]) {
    try {
      const d = JSON.parse(f['step' + s + 'Json'] || '{}');
      if (d.gps && d.gps.lat && d.gps.lng) return { lat: Number(d.gps.lat), lng: Number(d.gps.lng) };
    } catch (e) {}
  }
  return null;
}

// Merges a server-fetched farmer record into IndexedDB WITHOUT letting it
// regress data that's already stored locally. This guards against a race
// where a background refresh (kicked off just before a step/approval
// finished saving) returns a slightly-stale sheet row and would otherwise
// overwrite a step the person just completed — which was making a fully
// finished farmer appear to jump back to "ধাপ ১" again.
const STATUS_ORDER = ['নিবন্ধিত', 'অনুমোদিত', 'ধাপ ১ সম্পন্ন', 'ধাপ ২ সম্পন্ন', 'ধাপ ৩ সম্পন্ন', 'সম্পন্ন'];

// স্ট্যাটাস সবসময় আসল তথ্য (ধাপ/অনুমোদন) থেকে হিসাব হয় — কখনো পিছিয়ে "অনুমোদিত"-এ ফিরবে না।
function deriveStatus_(f) {
  let best = STATUS_ORDER.indexOf(f.status);
  if (f.approvedDate || f.approvedSeedKg) best = Math.max(best, 1);
  [1, 2, 3, 4].forEach(n => { if (f['step' + n + 'Json']) best = Math.max(best, n + 1); });
  if (best > 0) f.status = STATUS_ORDER[best];
  return f;
}
function stepExpenseOf_(d) {
  if (!d) return 0;
  if (d.expense_total != null && d.expense_total !== '' && isFinite(Number(d.expense_total))) return Number(d.expense_total);
  if (d.expense && typeof d.expense === 'object') return Object.values(d.expense).reduce((a, b) => a + (Number(b) || 0), 0);
  return 0;
}
function parseStep_(f, n) { try { return f['step' + n + 'Json'] ? JSON.parse(f['step' + n + 'Json']) : null; } catch (e) { return null; } }
// মোট খরচ = ৪ ধাপের খরচের যোগফল (একই ধাপ আবার সেভ করলে দ্বিগুণ হয় না)
function totalExpenseOf_(f, exceptStep) {
  return [1, 2, 3, 4].reduce((s, n) => n === exceptStep ? s : s + stepExpenseOf_(parseStep_(f, n)), 0);
}
function recomputeTotals_(f) {
  f.totalExpense = totalExpenseOf_(f);
  if (parseStep_(f, 4)) f.profitLoss = (Number(f.yieldQty) || 0) * (Number(f.marketPrice) || 0) - f.totalExpense;
  return f;
}

// কিউতে কোন কৃষকের কোন ধাপ/অনুমোদন এখনো সার্ভারে যায়নি — মার্জের সময় সেগুলো লোকালটাই জিতবে।
async function getPendingMap_() {
  const items = await idbGetAll('queue');
  const m = {};
  items.forEach(it => {
    const fn = it.payload && it.payload.formNo; if (!fn) return;
    m[fn] = m[fn] || { steps: new Set(), approve: false, reg: false };
    if (it.action === 'submitFollowUp') m[fn].steps.add(Number(it.payload.step));
    if (it.action === 'approveFarmer') m[fn].approve = true;
    if (it.action === 'submitFarmer') m[fn].reg = true;
  });
  return m;
}

function mergeFarmerRecords_(server, local, pending) {
  const out = Object.assign({}, server);
  if (local) {
    // সার্ভারে যে ঘর খালি, সেখানে লোকালের মান রাখো (যেমন GPS, জমির বিঘা/কাঠা, ছবি)
    Object.keys(local).forEach(k => {
      const v = out[k];
      if ((v === undefined || v === null || v === '') && local[k] !== undefined && local[k] !== null && local[k] !== '') out[k] = local[k];
    });
    if (pending) {
      pending.steps.forEach(n => { if (local['step' + n + 'Json']) out['step' + n + 'Json'] = local['step' + n + 'Json']; });
      if (pending.approve) ['approvedSeedKg', 'approvedDate', 'approvedBy'].forEach(k => { if (local[k]) out[k] = local[k]; });
      if (pending.steps.has(4)) { out.yieldQty = local.yieldQty; out.marketPrice = local.marketPrice; }
      if (pending.steps.has(1) && local.sowingDate) out.sowingDate = local.sowingDate;
      if (pending.reg) out._pendingSync = true; else delete out._pendingSync;
    } else { delete out._pendingSync; }
  }
  recomputeTotals_(out);
  return deriveStatus_(out);
}

// আগের ভার্সনের মতো নয়: এখন পড়া+মার্জ+লেখা একটাই ট্রানজেকশনে, তাই স্টেল ডাটা নতুন ধাপ মুছতে পারে না।
async function mergeFarmerFromServer(f, pendingMap) {
  const pending = pendingMap ? pendingMap[f.formNo] : null;
  await idbUpdate('farmers', f.formNo, existing => mergeFarmerRecords_(f, existing, pending));
}

async function mergeAllFromServer_(farmers) {
  const pendingMap = await getPendingMap_();
  for (const f of farmers) await mergeFarmerFromServer(f, pendingMap);
}

async function refreshFarmersCache() {
  if (!isOnline()) return;
  try {
    const res = await apiGet('farmers', { requesterId: requesterId() });
    if (res.farmers) {
      await repairServerGaps_(res.farmers);   // সার্ভারে যা নেই কিন্তু এই ডিভাইসে আছে, কিউতে তুলে দাও
      await mergeAllFromServer_(res.farmers);
    }
  } catch (e) { /* offline or server hiccup — local cache still used */ }
}

// 🔧 পুরনো ভার্সনে সার্ভারে সেভ না হওয়া তথ্য (জমি, বীজ, ধাপ, ছবি, কৃষক নিজেই) এই ডিভাইসের লোকাল কপি থেকে
// সার্ভারে/শিটে আবার পাঠানো হয়। সার্ভার ইডেমপোটেন্ট, তাই ডুপ্লিকেট হয় না।
let repairRan_ = false;
async function repairServerGaps_(serverFarmers) {
  if (repairRan_) return;
  repairRan_ = true;
  const serverMap = {};
  serverFarmers.forEach(s => serverMap[String(s.formNo)] = s);
  const queue = await idbGetAll('queue');
  const queued = new Set(queue.map(q => q.action + '|' + (q.payload && q.payload.formNo) + '|' + (q.payload && q.payload.step || '')));
  const locals = await idbGetAll('farmers');
  const dataUrl = v => typeof v === 'string' && v.indexOf('data:') === 0;
  let added = 0;
  const q = async (action, payload) => {
    const key = action + '|' + payload.formNo + '|' + (payload.step || '');
    if (queued.has(key)) return;
    queued.add(key); await queueAction(action, payload); added++;
  };

  for (const l of locals) {
    const sv = serverMap[String(l.formNo)];
    const mine = String(l.officerId) === String(requesterId());
    // ১) কৃষক সার্ভারে একেবারেই নেই (আগে "সফল" দেখালেও সেভ হয়নি)
    if (!sv) {
      if (l._pendingSync && mine) {
        await q('submitFarmer', {
          formNo: l.formNo, nid: l.nid, farmerName: l.farmerName, fatherName: l.fatherName, mobile: l.mobile,
          gender: l.gender, age: l.age, district: l.district, upazila: l.upazila, union: l.union, village: l.village,
          landBigha: l.landBigha, landShotangsho: l.landShotangsho, landKatha: l.landKatha, landSize: l.landSize,
          cropName: l.cropName, soilType: l.soilType, season: l.season, gpsLat: l.gpsLat, gpsLng: l.gpsLng,
          regPhotoBase64: dataUrl(l.regPhotoUrl) ? l.regPhotoUrl : '', officerId: l.officerId, officerName: l.officerName,
          officeName: l.officeName, regDate: l.regDate, deviceId: getDeviceId()
        });
      }
      continue;
    }
    // ২) নিবন্ধনের তথ্য অসম্পূর্ণ (জমি/মাটি/মৌসুম সার্ভারে যায়নি)
    if (mine && (!sv.landSize || !sv.soilType) && (l.landSize || l.soilType)) {
      await q('submitFarmer', {
        formNo: l.formNo, nid: l.nid, farmerName: l.farmerName, landBigha: l.landBigha, landShotangsho: l.landShotangsho,
        landKatha: l.landKatha, landSize: l.landSize, soilType: l.soilType, season: l.season,
        gpsLat: l.gpsLat, gpsLng: l.gpsLng,
        regPhotoBase64: (!sv.regPhotoUrl && dataUrl(l.regPhotoUrl)) ? l.regPhotoUrl : '', deviceId: getDeviceId()
      });
    }
    // ৩) অনুমোদন সার্ভারে নেই — শুধু অ্যাডমিন ডিভাইস থেকে
    if (isAdmin() && l.approvedDate && !sv.approvedDate) {
      await q('approveFarmer', { requesterId: requesterId(), formNo: l.formNo, seedKg: Number(l.approvedSeedKg) || 0,
        approvedDate: l.approvedDate, approvedBy: l.approvedBy, deviceId: getDeviceId() });
    }
    // ৪) ধাপের তথ্য সার্ভারে নেই (ছবি + GPS সহ)
    if (mine || isAdmin()) {
      for (const n of [1, 2, 3, 4]) {
        if (l['step' + n + 'Json'] && !sv['step' + n + 'Json']) {
          const d = parseStep_(l, n) || {};
          const photoB64 = dataUrl(d.photo) ? d.photo : undefined;
          delete d.photo;
          await q('submitFollowUp', { formNo: l.formNo, step: n, data: d, observationDate: d.date, photoBase64: photoB64, deviceId: getDeviceId() });
        }
      }
    }
  }
  if (added) { await updateSyncBanner(); setTimeout(() => syncQueue(), 500); }
}

/* ================================================================
   NAVIGATION
   ================================================================ */
const PAGE_TITLES = {
  home: 'হোম', register: 'নতুন কৃষক নিবন্ধন', 'followup-search': 'পর্যবেক্ষণ এন্ট্রি',
  followup: 'পর্যবেক্ষণ', reports: 'রিপোর্ট', map: 'ম্যাপ ভিউ', admin: 'অ্যাডমিন প্যানেল'
};

function navigateTo(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active-screen'));
  const target = document.getElementById('screen-' + screen);
  if (target) target.classList.add('active-screen');
  document.getElementById('pageTitle').textContent = PAGE_TITLES[screen] || '';

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navKey = screen === 'followup' ? 'followup-search' : screen;
  const navBtn = document.querySelector('.nav-btn[data-nav="' + navKey + '"]');
  if (navBtn) navBtn.classList.add('active');

  if (screen === 'home') renderDashboard();
  if (screen === 'register') prepFarmerForm();
  if (screen === 'reports') renderReports();
  if (screen === 'map') renderMap();
  if (screen === 'admin') renderAdmin();
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { e.preventDefault(); navigateTo(nav.getAttribute('data-nav')); }
});

/* ================================================================
   NETWORK STATUS + AUTO SYNC
   ================================================================ */
function updateNetPill() {
  const pill = document.getElementById('netPill');
  const text = document.getElementById('netPillText');
  if (isOnline()) { pill.classList.remove('offline'); text.textContent = 'অনলাইন'; }
  else { pill.classList.add('offline'); text.textContent = 'অফলাইন'; }
}

window.addEventListener('online', () => { updateNetPill(); toast('ইন্টারনেট সংযোগ ফিরে এসেছে — সিঙ্ক করা হচ্ছে', 'success'); syncQueue(); });
window.addEventListener('offline', () => { updateNetPill(); toast('আপনি এখন অফলাইনে আছেন', 'error'); });
document.getElementById('netPill').addEventListener('click', () => { if (isOnline()) syncQueue(true); });
document.getElementById('syncNowBtn').addEventListener('click', () => syncQueue(true));

async function queueAction(action, payload, lastError) {
  const localId = await idbPut('queue', { action, payload, ts: Date.now(), lastError: lastError || '' });
  await updateSyncBanner();
  return localId;
}

// অনলাইনে থাকলে সরাসরি পাঠাও; সার্ভার ব্যর্থ বা {ok:false} দিলে কিউতে রাখো। (আগে ব্যর্থ উত্তরেও "সফল" দেখানো হতো
// এবং কিছুই কিউতে যেত না — তাই কিছু কৃষক/লোকেশন শিটে যোগ হতো না।) ফেরত: 'sent' | 'queued'
async function sendOrQueue(action, payload) {
  if (isOnline()) {
    try {
      const res = await apiPost(action, payload);
      if (apiOk_(res)) return 'sent';
      await queueAction(action, payload, apiErr_(res));
      return 'queued';
    } catch (err) {
      await queueAction(action, payload, err.message || String(err));
      return 'queued';
    }
  }
  await queueAction(action, payload);
  return 'queued';
}

async function updateSyncBanner() {
  const items = await idbGetAll('queue');
  const banner = document.getElementById('syncBanner');
  const kpiPending = document.getElementById('kpiPending');
  if (items.length > 0) {
    banner.classList.remove('d-none');
    const err = (items.find(i => i.lastError) || {}).lastError;
    document.getElementById('syncBannerText').textContent = items.length + 'টি ফর্ম সিঙ্কের অপেক্ষায়' + (err ? ' — কারণ: ' + err : '');
  } else {
    banner.classList.add('d-none');
  }
  if (kpiPending) kpiPending.textContent = toBnNum(items.length);
}

let syncInProgress = false;
// প্রতিটি আইটেম আলাদা রিকোয়েস্টে পাঠানো হয় (আগে সব ছবিসহ এক রিকোয়েস্টে — একটা ভারী/ব্যর্থ আইটেম সবাইকে আটকে দিত)।
async function syncQueue(manual) {
  manual = manual === true;
  if (!isOnline()) { if (manual) toast('ইন্টারনেট সংযোগ নেই', 'error'); return; }
  if (syncInProgress) { if (manual) toast('সিঙ্ক চলছে, একটু অপেক্ষা করুন'); return; }
  const items = (await idbGetAll('queue')).sort((a, b) => a.localId - b.localId);
  if (items.length === 0) { if (manual) toast('সিঙ্ক করার মতো কিছু নেই', 'success'); return; }
  syncInProgress = true;
  let ok = 0, failed = 0, lastErr = '';
  const btn = document.getElementById('syncNowBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'সিঙ্ক হচ্ছে...'; }
  try {
    for (const item of items) {
      try {
        const res = await apiPost(item.action, item.payload);
        if (apiOk_(res)) {
          await idbDelete('queue', item.localId);
          if (item.action === 'submitFarmer') {
            await idbUpdate('farmers', item.payload.formNo, f => { if (f) { delete f._pendingSync; return f; } });
          }
          ok++;
        } else {
          failed++; lastErr = apiErr_(res);
          await idbPut('queue', Object.assign({}, item, { lastError: lastErr, attempts: (item.attempts || 0) + 1 }));
        }
      } catch (err) {
        failed++; lastErr = err.message || String(err);
        await idbPut('queue', Object.assign({}, item, { lastError: lastErr, attempts: (item.attempts || 0) + 1 }));
        if (!isOnline()) break;
      }
    }
  } finally {
    syncInProgress = false;
    if (btn) { btn.disabled = false; btn.textContent = 'এখনই সিঙ্ক করুন'; }
    await updateSyncBanner();
    if (failed === 0) toast(ok + 'টি তথ্য সফলভাবে সিঙ্ক হয়েছে', 'success');
    else toast(failed + 'টি সিঙ্ক হয়নি: ' + lastErr, 'error');
    if (ok) { await refreshFarmersCache(); }
    renderDashboard();
  }
}

/* ================================================================
   MASTER DATA CACHE (locations / crops / employees)
   ================================================================ */
async function refreshMasterDataCache() {
  if (isOnline()) {
    try {
      const data = await apiGet('masterData');
      await idbPut('masterData', { key: 'data', value: data });
    } catch (e) { /* fall through to cache */ }
  }
}
async function getMasterData() {
  const cached = await idbGet('masterData', 'data');
  return cached ? cached.value : { locations: [], crops: [], employees: [], offices: [] };
}

// Finds a branch office's GPS by name (falls back to CONFIG default if
// the office isn't in the Offices sheet, or has no coordinates yet).
async function getOfficeCoords(officeName) {
  const data = await getMasterData();
  const off = (data.offices || []).find(o => o.officeName === officeName);
  if (off && off.lat && off.lng) return { lat: Number(off.lat), lng: Number(off.lng) };
  return { lat: CONFIG.FALLBACK_OFFICE_LAT, lng: CONFIG.FALLBACK_OFFICE_LNG };
}

async function renderLocationDropdowns() {
  const data = await getMasterData();
  const districts = [...new Set(data.locations.map(l => l.district))].filter(Boolean);
  fillSelect('f_district', districts, 'জেলা নির্বাচন করুন');
  cascadeLocation(data.locations);
}

function fillSelect(id, options, placeholder) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.innerHTML = '<option value="">' + placeholder + '</option>' +
    options.map(o => '<option value="' + o + '">' + o + '</option>').join('');
}

function cascadeLocation(locations) {
  document.getElementById('f_district').addEventListener('change', function () {
    const upazilas = [...new Set(locations.filter(l => l.district === this.value).map(l => l.upazila))].filter(Boolean);
    fillSelect('f_upazila', upazilas, 'উপজেলা নির্বাচন করুন');
    fillSelect('f_union', [], 'ইউনিয়ন নির্বাচন করুন');
    fillSelect('f_village', [], 'গ্রাম নির্বাচন করুন');
  });
  document.getElementById('f_upazila').addEventListener('change', function () {
    const district = document.getElementById('f_district').value;
    const unions = [...new Set(locations.filter(l => l.district === district && l.upazila === this.value).map(l => l.union))].filter(Boolean);
    fillSelect('f_union', unions, 'ইউনিয়ন নির্বাচন করুন');
    fillSelect('f_village', [], 'গ্রাম নির্বাচন করুন');
  });
  document.getElementById('f_union').addEventListener('change', function () {
    const district = document.getElementById('f_district').value;
    const upazila = document.getElementById('f_upazila').value;
    const villages = [...new Set(locations.filter(l => l.district === district && l.upazila === upazila && l.union === this.value).map(l => l.village))].filter(Boolean);
    fillSelect('f_village', villages, 'গ্রাম নির্বাচন করুন');
  });
}

document.getElementById('addLocationBtn').addEventListener('click', async () => {
  const district = prompt('জেলার নাম লিখুন:'); if (!district) return;
  const upazila = prompt('উপজেলার নাম লিখুন:'); if (!upazila) return;
  const union = prompt('ইউনিয়নের নাম লিখুন:') || '';
  const village = prompt('গ্রামের নাম লিখুন:') || '';
  const payload = { district, upazila, union, village };
  await sendOrQueue('addLocation', payload);
  const data = await getMasterData();
  data.locations.push(payload);
  await idbPut('masterData', { key: 'data', value: data });
  await renderLocationDropdowns();
  toast('নতুন লোকেশন যোগ করা হয়েছে', 'success');
});

async function renderCropDropdown() {
  const data = await getMasterData();
  const crops = data.crops.length ? data.crops.map(c => c.cropName || c.name) : ['ধান', 'গম', 'ভুট্টা', 'আলু', 'পাট', 'সবজি'];
  fillSelect('f_cropName', crops, '');
  fillSelect_noPlaceholder('f_cropName', crops);
}
function fillSelect_noPlaceholder(id, options) {
  document.getElementById(id).innerHTML = options.map(o => '<option value="' + o + '">' + o + '</option>').join('');
}

/* ================================================================
   MODULE 1 — FARMER REGISTRATION
   ================================================================ */
let capturedGps = null;
let capturedPhotoBase64 = null;

function prepFarmerForm() {
  document.getElementById('farmerForm').reset();
  document.getElementById('f_formNo').value = 'PKKDF-' + Date.now().toString().slice(-8);
  capturedGps = null; capturedPhotoBase64 = null;
  document.getElementById('gpsResult').textContent = 'GPS নেওয়া হয়নি';
  document.getElementById('photoPreview').classList.add('d-none');
  document.getElementById('f_landTotal').textContent = '০';
}

['f_landBigha', 'f_landShotangsho', 'f_landKatha'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateLandTotal);
});
function updateLandTotal() {
  const bigha = Number(document.getElementById('f_landBigha').value) || 0;
  const shotangsho = Number(document.getElementById('f_landShotangsho').value) || 0;
  const katha = Number(document.getElementById('f_landKatha').value) || 0;
  const total = bigha + (shotangsho / 33) + (katha / 20);
  document.getElementById('f_landTotal').textContent = toBnNum(total.toFixed(2));
}

document.getElementById('gpsBtn').addEventListener('click', () => captureGps('gpsResult', (pos) => { capturedGps = pos; }));

function captureGps(resultElId, cb) {
  const el = document.getElementById(resultElId);
  if (!navigator.geolocation) { el.textContent = 'GPS সমর্থিত নয়'; return; }
  el.textContent = 'GPS নেওয়া হচ্ছে...';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude.toFixed(6), lng = pos.coords.longitude.toFixed(6);
      el.textContent = '✅ ' + lat + ', ' + lng;
      cb({ lat, lng });
    },
    () => { el.textContent = 'GPS নেওয়া যায়নি — লোকেশন পারমিশন চেক করুন'; },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

document.getElementById('photoBtn').addEventListener('click', () => document.getElementById('photoInput').click());
document.getElementById('photoInput').addEventListener('change', (e) => handlePhoto(e, 'photoPreview', (b64) => capturedPhotoBase64 = b64));

function handlePhoto(e, previewId, cb) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    compressImage(reader.result, 1000, 0.7).then(compressed => {
      const preview = document.getElementById(previewId);
      preview.src = compressed; preview.classList.remove('d-none');
      cb(compressed);
    });
  };
  reader.readAsDataURL(file);
}

// Keeps offline photo queue small: downscale + re-encode as JPEG before storing.
function compressImage(dataUrl, maxDim, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > h && w > maxDim) { h = h * (maxDim / w); w = maxDim; }
      else if (h > maxDim) { w = w * (maxDim / h); h = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataUrl;
  });
}

document.getElementById('farmerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!capturedGps && !confirm('GPS লোকেশন নেওয়া হয়নি — ম্যাপে এই কৃষকের পিন দেখাবে না।\nতবুও সংরক্ষণ করবেন?')) return;
  const totalBighaForRecord = (Number(document.getElementById('f_landBigha').value) || 0)
    + (Number(document.getElementById('f_landShotangsho').value) || 0) / 33
    + (Number(document.getElementById('f_landKatha').value) || 0) / 20;
  const record = {
    formNo: document.getElementById('f_formNo').value,
    nid: document.getElementById('f_nid').value,
    farmerName: document.getElementById('f_farmerName').value,
    fatherName: document.getElementById('f_fatherName').value,
    mobile: document.getElementById('f_mobile').value,
    gender: document.getElementById('f_gender').value,
    age: document.getElementById('f_age').value,
    district: document.getElementById('f_district').value,
    upazila: document.getElementById('f_upazila').value,
    union: document.getElementById('f_union').value,
    village: document.getElementById('f_village').value,
    landBigha: document.getElementById('f_landBigha').value,
    landShotangsho: document.getElementById('f_landShotangsho').value,
    landKatha: document.getElementById('f_landKatha').value,
    landSize: Math.round(totalBighaForRecord * 100) / 100,   // মোট বিঘা — আগে সার্ভারে যেতই না, তাই রিপোর্টে জমি ০ আসত
    cropName: document.getElementById('f_cropName').value,
    soilType: document.getElementById('f_soilType').value,
    season: document.getElementById('f_season').value,
    gpsLat: capturedGps ? capturedGps.lat : '',
    gpsLng: capturedGps ? capturedGps.lng : '',
    regPhotoBase64: capturedPhotoBase64 || '',
    officerId: CURRENT_USER.id || CURRENT_USER.nid,
    officerName: CURRENT_USER.name,
    officeName: CURRENT_USER.officeName || '',
    regDate: new Date().toISOString(),
    deviceId: getDeviceId()
  };

  // Save locally immediately (source of truth for offline use)
  const totalBigha = (Number(record.landBigha) || 0) + (Number(record.landShotangsho) || 0) / 33 + (Number(record.landKatha) || 0) / 20;
  const localRecord = Object.assign({}, record, {
    regPhotoUrl: record.regPhotoBase64, // local preview until synced
    landSize: Math.round(totalBigha * 100) / 100,
    status: 'নিবন্ধিত', // application only — approval (and seed kg) comes later from admin
    approvedSeedKg: '', approvedDate: '', approvedBy: '',
    step1Json: '', step2Json: '', step3Json: '', step4Json: '',
    totalExpense: 0, profitLoss: 0, _pendingSync: true
  });
  delete localRecord.regPhotoBase64;
  await idbPut('farmers', localRecord);

  const wasOnline = isOnline();
  const result = await sendOrQueue('submitFarmer', record);
  if (result === 'sent') {
    await idbUpdate('farmers', record.formNo, f => { if (f) { delete f._pendingSync; return f; } });
    toast('কৃষক সফলভাবে নিবন্ধিত হয়েছে', 'success');
  } else {
    toast(wasOnline ? 'সংরক্ষিত হয়েছে — সার্ভারে পাঠানো যায়নি, পরে সিঙ্ক হবে' : 'অফলাইনে সংরক্ষিত হয়েছে — ইন্টারনেট এলে সিঙ্ক হবে', 'success');
  }
  navigateTo('home');
});

function getDeviceId() {
  let id = localStorage.getItem('pkkdf_device_id');
  if (!id) { id = 'dev-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('pkkdf_device_id', id); }
  return id;
}

/* ================================================================
   MODULE 2 — FOLLOW-UP (search + 3-column step entry)
   ================================================================ */
document.getElementById('fuSearchInput').addEventListener('input', debounce(runFarmerSearch, 250));

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function runFarmerSearch() {
  const q = document.getElementById('fuSearchInput').value.trim().toLowerCase();
  const list = document.getElementById('fuSearchResults');
  if (!q) { list.innerHTML = ''; return; }
  const farmers = await idbGetAll('farmers');
  // String(...) guards against NID/formNo being stored as a NUMBER (Google
  // Sheets does this automatically for plain-digit cells) — calling
  // .toLowerCase() directly on a number throws and silently blanks the
  // whole results list, which was the bug here.
  const matches = farmers.filter(f =>
    String(f.formNo || '').toLowerCase().includes(q) ||
    String(f.nid || '').toLowerCase().includes(q) ||
    String(f.farmerName || '').toLowerCase().includes(q)
  );

  // Relevance: a name/form/NID that STARTS WITH the query ranks above
  // one that merely contains it somewhere in the middle.
  const rank = (f) => {
    const name = String(f.farmerName || '').toLowerCase();
    if (name.startsWith(q)) return 0;
    if (String(f.formNo || '').toLowerCase().startsWith(q) || String(f.nid || '').toLowerCase().startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return 3;
  };
  const results = matches.sort((a, b) => rank(a) - rank(b) || String(a.farmerName || '').localeCompare(String(b.farmerName || ''))).slice(0, 20);

  list.innerHTML = results.length ? results.map(f => `
    <li>
      <div class="farmer-row-left">
        <img class="farmer-thumb" src="${escapeHtml(f.regPhotoUrl || '')}" onerror="this.style.visibility='hidden'">
        <div><strong>${escapeHtml(f.farmerName)}</strong><br>
        <span class="small text-muted">ফর্ম: ${escapeHtml(f.formNo)} • ${escapeHtml(f.status || '')}</span></div>
      </div>
      <button data-open-followup="${escapeHtml(f.formNo)}">খুলুন</button>
    </li>`).join('') : '<li class="text-muted small">কোনো কৃষক পাওয়া যায়নি</li>';
}

document.getElementById('fuSearchResults').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-open-followup]');
  if (btn) openFollowUp(btn.getAttribute('data-open-followup'));
});

let ACTIVE_FARMER = null;
let ACTIVE_STEP = 1;

async function openFollowUp(formNo) {
  const farmer = await idbGet('farmers', formNo);
  if (!farmer) return;
  if (farmer.status === 'নিবন্ধিত') {
    toast('এই কৃষকের আবেদন এখনও অনুমোদিত হয়নি — অ্যাডমিন অনুমোদন করলে পর্যবেক্ষণ শুরু করা যাবে', 'error');
    return;
  }
  ACTIVE_FARMER = farmer;
  document.getElementById('fuFarmerName').textContent = farmer.farmerName;
  document.getElementById('fuFarmerMeta').textContent =
    'ফর্ম: ' + farmer.formNo + ' • ' + farmer.cropName + ' • ' + farmer.village;
  const photoEl = document.getElementById('fuFarmerPhoto');
  if (farmer.regPhotoUrl) {
    photoEl.src = farmer.regPhotoUrl;
    photoEl.classList.remove('d-none');
    photoEl.onerror = () => photoEl.classList.add('d-none');
  } else {
    photoEl.classList.add('d-none');
  }
  renderStepTabs();
  const firstOpenStep = [1, 2, 3, 4].find(s => !farmer['step' + s + 'Json']) || 4;
  selectStep(firstOpenStep);
  navigateTo('followup');
}

function renderStepTabs() {
  document.querySelectorAll('.step-tab').forEach(tab => {
    const s = Number(tab.getAttribute('data-step'));
    tab.classList.remove('done', 'active', 'locked');
    if (ACTIVE_FARMER['step' + s + 'Json']) tab.classList.add('done');
    if (s > 1 && !ACTIVE_FARMER['step' + (s - 1) + 'Json']) tab.classList.add('locked');
    tab.onclick = () => {
      if (tab.classList.contains('locked')) { toast('আগের ধাপ সম্পন্ন করুন প্রথমে', 'error'); return; }
      selectStep(s);
    };
  });
}

function selectStep(step) {
  ACTIVE_STEP = step;
  document.querySelectorAll('.step-tab').forEach(t => t.classList.toggle('active', Number(t.getAttribute('data-step')) === step));
  document.getElementById('step4Extra').classList.toggle('d-none', step !== 4);
  document.getElementById('s_sowingWrap').classList.toggle('d-none', step !== 1);

  document.getElementById('stepForm').reset();
  document.getElementById('s_photoPreview').classList.add('d-none');
  document.getElementById('s_gpsResult').textContent = 'GPS নেওয়া হয়নি';
  document.getElementById('s_distance').textContent = 'অফিস থেকে দূরত্ব: —';
  document.getElementById('s_date').value = new Date().toISOString().slice(0, 16);
  if (step === 1) document.getElementById('s_sowingDate').value = ACTIVE_FARMER.sowingDate || '';
  stepGps = null; stepPhotoBase64 = null; ACTIVE_STEP_EXISTING = null;

  const existing = ACTIVE_FARMER['step' + step + 'Json'];
  if (existing) {
    try {
      const d = JSON.parse(existing);
      ACTIVE_STEP_EXISTING = d; // remembered so a resubmit without retaking GPS/photo doesn't erase them
      document.getElementById('s_date').value = d.date || '';
      if (step === 1) document.getElementById('s_sowingDate').value = d.sowingDate || ACTIVE_FARMER.sowingDate || '';
      document.getElementById('s_disease').value = d.disease || '';
      document.getElementById('s_remedy').value = d.remedy || '';
      document.getElementById('s_comment').value = d.comment || '';
      document.getElementById('s_rating').value = d.rating || 70;
      document.getElementById('s_ratingVal').textContent = toBnNum(d.rating || 70);

      // Restore the previously captured GPS reading and distance —
      // these were being shown as "not taken yet" on reopen, and a
      // resubmit would then genuinely wipe them out.
      if (d.gps && d.gps.lat) {
        stepGps = d.gps;
        document.getElementById('s_gpsResult').textContent = '✅ ' + d.gps.lat + ', ' + d.gps.lng;
        getOfficeCoords(ACTIVE_FARMER.officeName).then(office => {
          const distKm = haversineKm(Number(d.gps.lat), Number(d.gps.lng), office.lat, office.lng);
          document.getElementById('s_distance').textContent = 'অফিস থেকে দূরত্ব: ' + toBnNum(distKm.toFixed(1)) + ' কিমি';
        });
      }
      // Restore the previously taken photo preview (from the permanent
      // Drive link once synced, or the local copy if not yet synced).
      const existingPhoto = d.photoUrl || d.photo;
      if (existingPhoto) {
        const preview = document.getElementById('s_photoPreview');
        preview.src = existingPhoto;
        preview.classList.remove('d-none');
        preview.onerror = () => preview.classList.add('d-none');
      }

      if (d.expense) {
        ['landPrep', 'weeding', 'fertilizer', 'pesticide', 'irrigation', 'labor'].forEach(k => {
          const el = document.getElementById('e_' + k);
          if (el && d.expense[k] != null) el.value = d.expense[k];
        });
        updateExpenseTotal();
      }
      if (step === 4) {
        document.getElementById('p_yield').value = d.yieldQty || '';
        document.getElementById('p_price').value = d.marketPrice || '';
        updateProfitPreview();
      }
    } catch (e) {}
  } else {
    updateExpenseTotal();
  }
  updateCropAgeDisplay();
}
let ACTIVE_STEP_EXISTING = null;

// Crop age is computed automatically from the sowing date (step 1) or
// the farmer's already-saved sowing date (steps 2-4) — the officer no
// longer types this in by hand.
function updateCropAgeDisplay() {
  const obsVal = document.getElementById('s_date').value;
  const sowing = ACTIVE_STEP === 1 ? document.getElementById('s_sowingDate').value : ACTIVE_FARMER.sowingDate;
  const disp = document.getElementById('s_cropAgeDisplay');
  if (!obsVal || !sowing) { disp.textContent = '—'; return; }
  const obsDate = new Date(obsVal);
  const sowDate = new Date(sowing);
  if (isNaN(obsDate) || isNaN(sowDate)) { disp.textContent = '—'; return; }
  const days = Math.floor((obsDate - sowDate) / 86400000);
  disp.textContent = toBnNum(Math.max(0, days)) + ' দিন';
}
document.getElementById('s_date').addEventListener('input', updateCropAgeDisplay);
document.getElementById('s_sowingDate').addEventListener('input', updateCropAgeDisplay);

document.getElementById('s_rating').addEventListener('input', function () {
  document.getElementById('s_ratingVal').textContent = toBnNum(this.value);
});

let stepGps = null, stepPhotoBase64 = null;
document.getElementById('s_gpsBtn').addEventListener('click', () => captureGps('s_gpsResult', async (pos) => {
  stepGps = pos;
  const office = await getOfficeCoords(ACTIVE_FARMER ? ACTIVE_FARMER.officeName : '');
  const distKm = haversineKm(Number(pos.lat), Number(pos.lng), office.lat, office.lng);
  document.getElementById('s_distance').textContent = 'অফিস থেকে দূরত্ব: ' + toBnNum(distKm.toFixed(1)) + ' কিমি';
}));
document.getElementById('s_photoBtn').addEventListener('click', () => document.getElementById('s_photoInput').click());
document.getElementById('s_photoInput').addEventListener('change', (e) => {
  handlePhoto(e, 's_photoPreview', (b64) => { stepPhotoBase64 = b64; });
  const dateStr = document.getElementById('s_date').value;
  const age = document.getElementById('s_cropAge').value;
  document.getElementById('s_photoCaption').textContent = (dateStr ? formatBnDate(dateStr) : '') + (age ? ' • বয়স ' + toBnNum(age) + ' দিন' : '');
});

document.querySelectorAll('.exp-input').forEach(inp => inp.addEventListener('input', updateExpenseTotal));
function updateExpenseTotal() {
  const total = ['landPrep', 'weeding', 'fertilizer', 'pesticide', 'irrigation', 'labor']
    .reduce((s, k) => s + (Number(document.getElementById('e_' + k).value) || 0), 0);
  document.getElementById('e_total').textContent = '৳ ' + toBnNum(total);
  return total;
}
document.getElementById('p_yield').addEventListener('input', updateProfitPreview);
document.getElementById('p_price').addEventListener('input', updateProfitPreview);
function updateProfitPreview() {
  const yieldQty = Number(document.getElementById('p_yield').value) || 0;
  const price = Number(document.getElementById('p_price').value) || 0;
  const priorExpense = totalExpenseOf_(ACTIVE_FARMER, ACTIVE_STEP);
  const thisExpense = updateExpenseTotal();
  const pl = (yieldQty * price) - (priorExpense + thisExpense);
  const box = document.getElementById('profitBox');
  box.textContent = (pl >= 0 ? 'লাভ: ৳ ' : 'ক্ষতি: ৳ ') + toBnNum(Math.abs(Math.round(pl)));
  box.classList.toggle('loss', pl < 0);
}

document.getElementById('stepForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const expense = {
    landPrep: Number(document.getElementById('e_landPrep').value) || 0,
    weeding: Number(document.getElementById('e_weeding').value) || 0,
    fertilizer: Number(document.getElementById('e_fertilizer').value) || 0,
    pesticide: Number(document.getElementById('e_pesticide').value) || 0,
    irrigation: Number(document.getElementById('e_irrigation').value) || 0,
    labor: Number(document.getElementById('e_labor').value) || 0
  };
  const expenseTotal = Object.values(expense).reduce((a, b) => a + b, 0);

  const obsVal = document.getElementById('s_date').value;
  const sowingVal = ACTIVE_STEP === 1 ? document.getElementById('s_sowingDate').value : ACTIVE_FARMER.sowingDate;
  const computedAge = (obsVal && sowingVal && !isNaN(new Date(obsVal)) && !isNaN(new Date(sowingVal)))
    ? Math.max(0, Math.floor((new Date(obsVal) - new Date(sowingVal)) / 86400000)) : '';

  const data = {
    date: obsVal,
    sowingDate: ACTIVE_STEP === 1 ? sowingVal : undefined,
    cropAge: computedAge,
    disease: document.getElementById('s_disease').value,
    remedy: document.getElementById('s_remedy').value,
    comment: document.getElementById('s_comment').value,
    rating: document.getElementById('s_rating').value,
    // If GPS/photo weren't retaken while editing an already-filled step,
    // fall back to what was saved before instead of wiping it out.
    gps: stepGps || (ACTIVE_STEP_EXISTING && ACTIVE_STEP_EXISTING.gps) || null,
    expense, expense_total: expenseTotal,
    // Kept locally so the print profile can show a step photo even
    // before this step has synced and the server has returned a
    // permanent Drive link (data.photoUrl, merged in by the server).
    photo: stepPhotoBase64 || (ACTIVE_STEP_EXISTING && ACTIVE_STEP_EXISTING.photo) || null,
    // The already-uploaded Drive link, carried forward as-is unless a
    // new photo is taken now (in which case the server overwrites this
    // with the new upload's link).
    photoUrl: (ACTIVE_STEP_EXISTING && ACTIVE_STEP_EXISTING.photoUrl) || undefined
  };
  if (ACTIVE_STEP === 4) {
    data.yieldQty = Number(document.getElementById('p_yield').value) || 0;
    data.marketPrice = Number(document.getElementById('p_price').value) || 0;
  }

  // সার্ভারে পাঠানোর ডাটায় ছবির base64 থাকবে না (আলাদা photoBase64 হিসেবে যাবে) — নইলে শিটের ঘরের সীমা পেরিয়ে সিঙ্ক ফেল করত।
  const dataForServer = Object.assign({}, data);
  delete dataForServer.photo;
  const photoForServer = stepPhotoBase64 || (!data.photoUrl && data.photo && String(data.photo).indexOf('data:') === 0 ? data.photo : undefined);
  const step = ACTIVE_STEP;
  const payload = {
    formNo: ACTIVE_FARMER.formNo, step, data: dataForServer,
    expense: expenseTotal, observationDate: data.date,
    photoBase64: photoForServer,
    deviceId: getDeviceId()
  };

  // লোকাল ক্যাশ আপডেট — সর্বশেষ সেভ করা রেকর্ড পড়ে তার উপর বসানো (এক ট্রানজেকশনে), পুরনো ACTIVE_FARMER কপি দিয়ে ওভাররাইট নয়।
  const updated = await idbUpdate('farmers', ACTIVE_FARMER.formNo, fresh => {
    const f = Object.assign({}, fresh || ACTIVE_FARMER);
    f['step' + step + 'Json'] = JSON.stringify(data);
    f.lastFollowUpDate = data.date;
    if (step === 1 && sowingVal) f.sowingDate = sowingVal;
    if (step === 4) { f.yieldQty = data.yieldQty; f.marketPrice = data.marketPrice; }
    recomputeTotals_(f);
    return deriveStatus_(f);
  });
  ACTIVE_FARMER = updated || ACTIVE_FARMER;

  const wasOnline = isOnline();
  const result = await sendOrQueue('submitFollowUp', payload);
  if (result === 'sent') toast('ধাপ ' + toBnNum(step) + ' সংরক্ষণ হয়েছে', 'success');
  else toast(wasOnline ? 'সংরক্ষিত — সার্ভারে যায়নি, পরে সিঙ্ক হবে' : 'অফলাইনে সংরক্ষিত হয়েছে', 'success');

  renderStepTabs();
  if (step < 4) selectStep(step + 1);
});

/* ---------- Print profile (2 A4 pages) ---------- */
document.getElementById('printProfileBtn').addEventListener('click', async () => {
  if (!ACTIVE_FARMER) return;
  const office = await getOfficeCoords(ACTIVE_FARMER.officeName); // same office used for the live distance shown while filling a step
  buildPrintArea(ACTIVE_FARMER, office);
  await waitForPrintImages_(); // avoid printing a step photo before it has actually loaded (was showing up solid black)
  window.print();
});

// Resolves once every <img> inside the print area has either loaded or
// failed (with a short overall timeout so a slow/broken image link can
// never block printing indefinitely).
function waitForPrintImages_() {
  const imgs = Array.from(document.querySelectorAll('#printArea img'));
  if (!imgs.length) return Promise.resolve();
  const loaders = imgs.map(img => new Promise(resolve => {
    if (img.complete) return resolve();
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  }));
  return Promise.race([Promise.all(loaders), new Promise(r => setTimeout(r, 4000))]);
}

function buildPrintArea(f, office) {
  const steps = [1, 2, 3, 4].map(s => {
    try { return JSON.parse(f['step' + s + 'Json'] || '{}'); } catch (e) { return {}; }
  });
  const totalExpense = numOr0_(f.totalExpense);
  const yieldQty = numOr0_(f.yieldQty);
  const marketPrice = numOr0_(f.marketPrice);
  const profitLoss = numOr0_(f.profitLoss);
  // One continuous container — the browser paginates naturally at print
  // time (a short profile stays on 1 page; a fuller one flows onto a
  // 2nd without us forcing a fixed 2-page split).
  const html = `
    <div class="print-page">
      <div class="print-head">
        <img src="icons/icon-192.png">
        <div><h1>পল্লী ক্ষুদ্র কৃষি উন্নয়ন ফাউন্ডেশন</h1><p>কৃষক প্রোফাইল — ফর্ম নম্বর: ${esc(f.formNo)}</p></div>
        ${f.regPhotoUrl ? `<img class="print-farmer-photo" src="${esc(f.regPhotoUrl)}">` : ''}
      </div>
      <div class="print-section-title">মূল তথ্য</div>
      <div class="print-grid">
        <div><span>নাম:</span> ${esc(f.farmerName)}</div>
        <div><span>পিতার নাম:</span> ${esc(f.fatherName)}</div>
        <div><span>NID:</span> ${esc(f.nid)}</div>
        <div><span>মোবাইল:</span> ${esc(f.mobile)}</div>
        <div><span>ঠিকানা:</span> ${esc(f.village)}, ${esc(f.union)}, ${esc(f.upazila)}, ${esc(f.district)}</div>
        <div><span>জমির পরিমাণ:</span> ${esc(f.landBigha || 0)} বিঘা ${esc(f.landShotangsho || 0)} শতাংশ ${esc(f.landKatha || 0)} কাঠা (মোট ${esc(f.landSize || 0)} বিঘা)</div>
        <div><span>ফসল:</span> ${esc(f.cropName)}</div>
        <div><span>মাটির ধরন / মৌসুম:</span> ${esc(f.soilType || '-')} / ${esc(f.season || '-')}</div>
        <div><span>বীজ বপন/রোপনের তারিখ:</span> ${esc(f.sowingDate ? formatBnDate(f.sowingDate) : '-')}</div>
        <div><span>অনুমোদিত বীজ:</span> ${esc(f.approvedSeedKg || 0)} কেজি</div>
        <div><span>দায়িত্বরত অফিসার:</span> ${esc(f.officerName)} (${esc(f.officeName || '')})</div>
        <div><span>নিবন্ধনের তারিখ:</span> ${esc(f.regDate ? formatBnDate(f.regDate.slice(0,10)) : '')}</div>
      </div>
      <div class="print-section-title">পর্যবেক্ষণ ধাপসমূহ</div>
      <div class="print-steps">
        ${printStepCard(steps[0], 1, office)}
        ${printStepCard(steps[1], 2, office)}
        ${printStepCard(steps[2], 3, office)}
        ${printStepCard(steps[3], 4, office)}
      </div>
      <div class="print-section-title">আর্থিক সারসংক্ষেপ</div>
      <div class="print-fin">
        <div>মোট খরচ (৪ ধাপ মিলিয়ে): ৳ ${esc(totalExpense)}</div>
        <div>উৎপাদন: ${esc(yieldQty)} কেজি × বাজার দর ৳${esc(marketPrice)}/কেজি</div>
        <div class="big">${profitLoss >= 0 ? 'লাভ' : 'ক্ষতি'}: ৳ ${esc(Math.abs(profitLoss))}</div>
      </div>
      <div class="print-signatures">
        <div>সহকারী মাঠকর্মকর্তা</div>
        <div>পরিদর্শক</div>
        <div>মাঠ কর্মকর্তা</div>
      </div>
    </div>
  `;
  document.getElementById('printArea').innerHTML = html;
}

function printStepCard(d, n, office) {
  if (!d || !d.date) return `<div class="print-step-card"><strong>ধাপ ${n}</strong><br><span style="color:#999">তথ্য নেই</span></div>`;
  const photo = d.photoUrl || d.photo;
  const exp = d.expense || {};
  const expLines = [
    ['জমি প্রস্তুতি', exp.landPrep], ['নিড়ানি', exp.weeding], ['সার', exp.fertilizer],
    ['কীটনাশক', exp.pesticide], ['সেচ', exp.irrigation], ['শ্রমিক', exp.labor]
  ].filter(([, v]) => numOr0_(v) > 0).map(([label, v]) => `${label}: ৳${esc(numOr0_(v))}`).join(', ');
  const distKm = (d.gps && d.gps.lat && office) ? haversineKm(Number(d.gps.lat), Number(d.gps.lng), office.lat, office.lng) : null;
  return `<div class="print-step-card">
    ${photo ? `<img src="${esc(photo)}">` : ''}
    <strong>ধাপ ${n} — ${esc(formatBnDateTime(d.date))}</strong><br>
    ফসলের বয়স: ${esc(d.cropAge || '-')} দিন<br>
    রোগ/পোকা: ${esc(d.disease || '-')}<br>
    প্রতিকার: ${esc(d.remedy || '-')}<br>
    অবস্থা: ${esc(d.rating || '-')}%<br>
    ${d.comment ? `মন্তব্য: ${esc(d.comment)}<br>` : ''}
    ${distKm != null ? `অফিস থেকে দূরত্ব: ${distKm.toFixed(1)} কিমি<br>` : ''}
    ${expLines ? `খরচের বিবরণ: ${expLines}<br>` : ''}
    মোট খরচ: ৳ ${esc(numOr0_(d.expense_total))}
  </div>`;
}
function esc(v) { return escapeHtml(String(v == null ? '' : v)); }
// Defensive numeric coercion for anything printed — a legacy bad cell
// value (e.g. a stray spreadsheet error) will show as ০ instead of
// repeating the error text (this was the "৳ #NUM!" bug).
function numOr0_(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/* ================================================================
   MODULE 3 — DASHBOARD + REPORTS
   ================================================================ */
let chartSeed, chartOfficer, chartCrop;

async function renderDashboard() {
  const farmers = await idbGetAll('farmers');
  document.getElementById('kpiFarmers').textContent = toBnNum(farmers.length);
  document.getElementById('kpiLand').textContent = toBnNum(totalApprovedLandBigha(farmers).toFixed(2));

  const overdue = computeOverdue(farmers);
  document.getElementById('kpiOverdue').textContent = toBnNum(overdue.length);
  renderOverdueList('overdueListHome', overdue.slice(0, 5));

  const seedByCrop = {};
  farmers.forEach(f => { const c = f.cropName || 'অজানা'; seedByCrop[c] = (seedByCrop[c] || 0) + (Number(f.approvedSeedKg) || 0); });
  drawBarChart('chartSeed', Object.keys(seedByCrop), Object.values(seedByCrop), '#2E9E52');

  await updateSyncBanner();
  if (isOnline()) {
    // Best-effort background refresh from server (doesn't block UI).
    // requesterId lets the server return only what this role is scoped to see.
    apiGet('farmers', { requesterId: requesterId() }).then(res => {
      if (res.farmers) {
        mergeAllFromServer_(res.farmers).then(() => {
          // Re-render if the user is still looking at the home screen,
          // so newly-synced counts/charts show up without a manual nav.
          if (document.getElementById('screen-home').classList.contains('active-screen')) {
            renderDashboardNumbersOnly();
          }
        });
      }
    }).catch(() => {});
  }
}

// Lightweight re-render used after a background refresh — avoids
// re-triggering another network call (renderDashboard() would loop).
async function renderDashboardNumbersOnly() {
  const farmers = await idbGetAll('farmers');
  document.getElementById('kpiFarmers').textContent = toBnNum(farmers.length);
  document.getElementById('kpiLand').textContent = toBnNum(totalApprovedLandBigha(farmers).toFixed(2));
  const overdue = computeOverdue(farmers);
  document.getElementById('kpiOverdue').textContent = toBnNum(overdue.length);
  renderOverdueList('overdueListHome', overdue.slice(0, 5));
  const seedByCrop = {};
  farmers.forEach(f => { const c = f.cropName || 'অজানা'; seedByCrop[c] = (seedByCrop[c] || 0) + (Number(f.approvedSeedKg) || 0); });
  drawBarChart('chartSeed', Object.keys(seedByCrop), Object.values(seedByCrop), '#2E9E52');
}

function computeOverdue(farmers) {
  const now = new Date();
  return farmers.filter(f => f.status !== 'সম্পন্ন' && f.status !== 'নিবন্ধিত').map(f => {
    const ref = f.lastFollowUpDate || f.approvedDate || f.regDate;
    if (!ref) return null;
    const days = Math.floor((now - new Date(ref)) / 86400000);
    return days > CONFIG.OVERDUE_DAYS ? { formNo: f.formNo, farmerName: f.farmerName, officerName: f.officerName, village: f.village, daysSince: days } : null;
  }).filter(Boolean).sort((a, b) => b.daysSince - a.daysSince);
}

function renderOverdueList(elId, list) {
  const el = document.getElementById(elId);
  el.innerHTML = list.length ? list.map(o => `
    <li>
      <div>${escapeHtml(o.farmerName)}<br><span class="small text-muted">${escapeHtml(o.officerName || '')} • ${escapeHtml(o.village || '')}</span></div>
      <span class="overdue-badge">${toBnNum(o.daysSince)} দিন</span>
    </li>`).join('') : '<li class="overdue-empty">কোনো ডিউ ফলো-আপ নেই</li>';
}

async function renderReports() {
  await refreshFarmersCache(); // keep report numbers current when other officers have synced since boot
  const farmers = await idbGetAll('farmers');
  await renderMonthlySummary(farmers);
  const profitByOfficer = {};
  const countByCrop = {};
  farmers.forEach(f => {
    const off = f.officerName || 'অজানা';
    profitByOfficer[off] = (profitByOfficer[off] || 0) + (Number(f.profitLoss) || 0);
    const crop = f.cropName || 'অজানা';
    countByCrop[crop] = (countByCrop[crop] || 0) + 1;
  });
  drawBarChart('chartOfficer', Object.keys(profitByOfficer), Object.values(profitByOfficer), '#3FB6E8');
  drawBarChart('chartCrop', Object.keys(countByCrop), Object.values(countByCrop), '#EFA512');
  renderOverdueList('overdueListReports', computeOverdue(farmers));

  document.getElementById('historyNidInput').oninput = debounce(runNidHistorySearch, 250);
  runNidHistorySearch(); // also run immediately, in case a value is already sitting in the box from before
}

function runNidHistorySearch() {
  const inputEl = document.getElementById('historyNidInput');
  const raw = inputEl.value.trim();
  const q = normalizeDigits(raw).toLowerCase();
  const box = document.getElementById('historyResults');
  if (!q) { box.innerHTML = ''; return; }
  idbGetAll('farmers').then(farmers => {
    const matches = farmers.filter(f => {
      const nid = normalizeDigits(String(f.nid || ''));
      if (nid === q) return true;
      if (q.length < 3) return false;
      return nid.includes(q) || String(f.formNo || '').toLowerCase().includes(q) ||
        normalizeDigits(String(f.mobile || '')).includes(q) || String(f.farmerName || '').toLowerCase().includes(q);
    }).slice(0, 20);
    box.innerHTML = matches.length ? matches.map(farmerHistoryHtml_).join('') : '<p class="text-muted small">কোনো রেকর্ড পাওয়া যায়নি</p>';
  });
}

// একজন কৃষকের সব ধাপের তথ্য, ছবি ও লোকেশন — শিট থেকে ফিরিয়ে এনে এখানে দেখানো হয়।
function mapLink_(lat, lng) { return 'https://www.google.com/maps?q=' + encodeURIComponent(lat + ',' + lng); }
function farmerHistoryHtml_(f) {
  const stepsHtml = [1, 2, 3, 4].map(n => {
    const d = parseStep_(f, n);
    if (!d || !d.date) return `<div class="small text-muted">ধাপ ${toBnNum(n)}: তথ্য নেই</div>`;
    const photo = d.photoUrl || d.photo;
    return `<div class="small" style="border-top:1px dashed var(--border);padding:6px 0;">
      <strong>ধাপ ${toBnNum(n)} — ${esc_(formatBnDateTime(d.date))}</strong>${d.cropAge !== undefined && d.cropAge !== '' ? ' • বয়স ' + toBnNum(d.cropAge) + ' দিন' : ''}<br>
      রোগ/পোকা: ${esc_(d.disease || '-')} • প্রতিকার: ${esc_(d.remedy || '-')} • অবস্থা: ${esc_(d.rating || '-')}%<br>
      ${d.comment ? 'মন্তব্য: ' + esc_(d.comment) + '<br>' : ''}
      খরচ: ৳ ${toBnNum(stepExpenseOf_(d))}
      ${d.gps && d.gps.lat ? ` • <a href="${esc_(mapLink_(d.gps.lat, d.gps.lng))}" target="_blank" rel="noopener">📍 লোকেশন (${esc_(d.gps.lat)}, ${esc_(d.gps.lng)})</a>` : ' • লোকেশন নেই'}
      ${photo ? `<br><a href="${esc_(photo)}" target="_blank" rel="noopener"><img src="${esc_(photo)}" style="max-width:140px;max-height:100px;border-radius:6px;margin-top:4px;" onerror="this.style.display='none'"></a>` : ''}
    </div>`;
  }).join('');
  const regGps = f.gpsLat && f.gpsLng ? ` • <a href="${esc_(mapLink_(f.gpsLat, f.gpsLng))}" target="_blank" rel="noopener">📍 নিবন্ধনের লোকেশন</a>` : '';
  return `
    <div class="section-card" style="box-shadow:none;border:1px solid var(--border);">
      <strong>${esc_(f.farmerName)}</strong> — ${esc_(f.cropName)}<br>
      <span class="small text-muted">ফর্ম: ${esc_(f.formNo)} • ${esc_(f.status)} • নিবন্ধন: ${esc_(f.regDate ? formatBnDate(f.regDate) : '')} • ${esc_(f.officeName || '')}</span><br>
      <span class="small">জমি: ${bigha2_(Number(f.landSize) || 0)} বিঘা • অনুমোদিত বীজ: ${toBnNum(f.approvedSeedKg || 0)} কেজি${regGps}</span>
      <details class="mt-1"><summary class="small" style="cursor:pointer;">সব ধাপের বিস্তারিত দেখুন</summary>${stepsHtml}
        <div class="small mt-1">মোট খরচ: ৳ ${toBnNum(Math.round(Number(f.totalExpense) || 0))} • উৎপাদন: ${toBnNum(f.yieldQty || 0)} কেজি • ${(Number(f.profitLoss) || 0) >= 0 ? 'লাভ' : 'ক্ষতি'}: ৳ ${toBnNum(Math.abs(Math.round(Number(f.profitLoss) || 0)))}</div>
      </details>
    </div>`;
}
// Converts Bengali digits (০-৯) to plain English digits so a search box
// works the same whether the phone's keyboard types NID numbers in
// Bengali or English numerals.
function normalizeDigits(s) {
  return String(s).replace(/[০-৯]/g, d => String(BN_DIGITS.indexOf(d)));
}

function drawBarChart(canvasId, labels, values, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const cssWidth = (canvas.parentElement && canvas.parentElement.clientWidth) || canvas.clientWidth || 300;
  // Fixed CSS height per chart — NOT read from canvas.getAttribute('height'),
  // because we overwrite that same attribute below with the device-scaled
  // pixel size; reading it back on a later redraw would compound the size
  // larger every time (the bug that made charts grow huge on refresh).
  const cssHeight = CHART_HEIGHTS[canvasId] || 200;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.textAlign = 'center';
  ctx.font = "11px 'Hind Siliguri', sans-serif";

  if (!labels.length || values.every(v => !v)) {
    ctx.fillStyle = '#9AA5A0';
    ctx.font = "13px 'Hind Siliguri', sans-serif";
    ctx.fillText('কোনো তথ্য নেই', cssWidth / 2, cssHeight / 2);
    return;
  }

  const padding = { top: 24, right: 10, bottom: 30, left: 10 };
  const chartW = cssWidth - padding.left - padding.right;
  const chartH = cssHeight - padding.top - padding.bottom;
  const maxVal = Math.max(...values, 1);
  const n = labels.length;
  const gap = 10;
  const barW = Math.max(14, (chartW - gap * (n - 1)) / n);

  labels.forEach((label, i) => {
    const x = padding.left + i * (barW + gap);
    const val = values[i] || 0;
    const barH = Math.max(2, (val / maxVal) * chartH);
    const y = padding.top + (chartH - barH);

    ctx.fillStyle = color;
    roundRectPath_(ctx, x, y, barW, barH, Math.min(5, barW / 2, barH));
    ctx.fill();

    ctx.fillStyle = '#16211C';
    ctx.fillText(toBnNum(Math.round(val)), x + barW / 2, Math.max(12, y - 6));

    ctx.fillStyle = '#66766C';
    const shortLabel = label.length > 8 ? label.slice(0, 7) + '…' : label;
    ctx.fillText(shortLabel, x + barW / 2, padding.top + chartH + 16);
  });
}
const CHART_HEIGHTS = { chartSeed: 200, chartOfficer: 220, chartCrop: 220 };

function roundRectPath_(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/* ================================================================
   MODULE 4 — GIS MAP
   ================================================================ */
let leafletMap = null;
async function renderMap() {
  await refreshFarmersCache(); // Map tab wasn't pulling fresh data from the server —
                                // it only showed whatever was cached the last time the
                                // app booted, so a farmer registered afterward (even on
                                // this same device) wouldn't show until next reload.
  const farmers = await idbGetAll('farmers');
  // Use each farmer's registration GPS if present, else fall back to the
  // most recent follow-up step's GPS (see getFarmerMapCoords) — many
  // officers only capture location during a follow-up visit, not at
  // registration, so requiring registration GPS was hiding most pins.
  const validCoord = c => c && isFinite(c.lat) && isFinite(c.lng) && Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180 && (c.lat !== 0 || c.lng !== 0);
  const withGps = farmers
    .map(f => ({ f, coords: getFarmerMapCoords(f) }))
    .filter(x => validCoord(x.coords));
  const noGps = farmers.filter(f => !validCoord(getFarmerMapCoords(f)));
  const noteEl = document.getElementById('mapNote');
  if (noteEl) {
    noteEl.textContent = 'ম্যাপে ' + toBnNum(withGps.length) + ' জন কৃষকের পিন আছে' +
      (noGps.length ? ' • ' + toBnNum(noGps.length) + ' জনের GPS লোকেশন নেওয়া হয়নি: ' + noGps.slice(0, 5).map(f => f.farmerName).join(', ') + (noGps.length > 5 ? '…' : '') : '');
  }
  const data = await getMasterData();
  const offices = data.offices || [];

  const centerLat = offices.length ? Number(offices[0].lat) : CONFIG.FALLBACK_OFFICE_LAT;
  const centerLng = offices.length ? Number(offices[0].lng) : CONFIG.FALLBACK_OFFICE_LNG;

  if (!leafletMap) {
    leafletMap = L.map('gisMap').setView([centerLat, centerLng], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19
    }).addTo(leafletMap);
  } else {
    leafletMap.eachLayer(l => { if (l instanceof L.Marker) leafletMap.removeLayer(l); });
  }
  setTimeout(() => leafletMap.invalidateSize(), 50); // লুকানো ট্যাবে তৈরি হলে ম্যাপের সাইজ ভুল হয়

  // Every branch office gets its own pin at its own GPS location.
  offices.forEach(o => {
    if (!o.lat || !o.lng) return;
    L.marker([Number(o.lat), Number(o.lng)], {
      icon: L.divIcon({ className: '', html: '<div class="map-pin map-pin-office"><span class="map-pin-emoji">🏢</span></div>', iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] })
    }).addTo(leafletMap).bindPopup('<strong>' + escapeHtml(o.officeName) + '</strong><br>শাখা অফিস');
  });

  const bounds = [];
  withGps.forEach(({ f, coords }) => {
    bounds.push([coords.lat, coords.lng]);
    const office = offices.find(o => o.officeName === f.officeName);
    const officeLat = office ? Number(office.lat) : CONFIG.FALLBACK_OFFICE_LAT;
    const officeLng = office ? Number(office.lng) : CONFIG.FALLBACK_OFFICE_LNG;
    const dist = haversineKm(coords.lat, coords.lng, officeLat, officeLng);
    L.marker([coords.lat, coords.lng], {
      icon: L.divIcon({ className: '', html: '<div class="map-pin map-pin-farmer"><span class="map-pin-emoji">📌</span></div>', iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] }),
      zIndexOffset: 1000 // keeps farmer pins clickable above office pins when they overlap
    }).addTo(leafletMap).bindPopup(
      `<strong>${escapeHtml(f.farmerName)}</strong><br>অফিসার: ${escapeHtml(f.officerName || '-')}<br>শাখা: ${escapeHtml(f.officeName || '-')}<br>ফসলের ধাপ: ${escapeHtml(f.status || '-')}<br>দূরত্ব: ${dist.toFixed(1)} কিমি`
    );
  });
  if (bounds.length) leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
}

/* ================================================================
   ADMIN PANEL (admin / super_admin only)
   ================================================================ */
async function renderAdmin() {
  document.getElementById('myRoleLabel').textContent =
    CURRENT_USER.role === 'super_admin' ? 'সুপার অ্যাডমিন' : 'অ্যাডমিন — ' + (CURRENT_USER.region || '');

  const farmers = await idbGetAll('farmers'); // already scoped, refreshed at boot / reports visit

  renderPendingApprovals(farmers);
  renderApprovedFarmers(farmers);

  if (!isOnline()) {
    document.getElementById('officerList').innerHTML = '<li class="text-muted small">কর্মী তালিকা দেখতে ইন্টারনেট প্রয়োজন</li>';
  } else {
    try {
      const res = await apiGet('employees', { requesterId: requesterId() });
      const list = document.getElementById('officerList');
      list.innerHTML = (res.employees || []).map(emp => `
        <li>
          <div><strong>${escapeHtml(emp.name || '')}</strong> <span class="small text-muted">(${escapeHtml(emp.role || 'officer')})</span><br>
          <span class="small text-muted">${escapeHtml(emp.officeName || '')} • ${escapeHtml(emp.region || '')} • ${emp.active === false ? 'নিষ্ক্রিয়' : 'সক্রিয়'}</span></div>
          <div class="admin-row-actions">
            <button data-toggle-officer="${escapeHtml(emp.id)}" data-active="${emp.active !== false}">${emp.active === false ? 'সক্রিয় করুন' : 'নিষ্ক্রিয় করুন'}</button>
            <button data-reset-pin="${escapeHtml(emp.id)}" class="btn-reset-pin">পিন রিসেট</button>
          </div>
        </li>`).join('') || '<li class="text-muted small">কোনো কর্মী পাওয়া যায়নি</li>';
    } catch (e) {
      document.getElementById('officerList').innerHTML = '<li class="text-muted small">লোড করা যায়নি</li>';
    }
  }

  renderAdminFarmerList(farmers);
  document.getElementById('adminFarmerSearch').oninput = debounce(function () {
    const q = this.value.trim().toLowerCase();
    const filtered = !q ? farmers : farmers.filter(f =>
      (f.farmerName || '').toLowerCase().includes(q) || (f.formNo || '').toLowerCase().includes(q));
    renderAdminFarmerList(filtered);
  }, 200);
}

function renderPendingApprovals(farmers) {
  const pending = farmers.filter(f => f.status === 'নিবন্ধিত');
  const el = document.getElementById('pendingApprovalList');
  el.innerHTML = pending.length ? pending.map(f => `
    <li>
      <div class="farmer-row-left">
        <img class="farmer-thumb" src="${escapeHtml(f.regPhotoUrl || '')}" onerror="this.style.visibility='hidden'">
        <div><strong>${escapeHtml(f.farmerName)}</strong><br>
        <span class="small text-muted">ফর্ম: ${escapeHtml(f.formNo)} • ${escapeHtml(f.cropName || '')} • ${escapeHtml(f.officeName || '')}</span></div>
      </div>
      <button data-approve="${escapeHtml(f.formNo)}" class="btn-approve">অনুমোদন করুন</button>
    </li>`).join('') : '<li class="overdue-empty">অনুমোদনের অপেক্ষায় কেউ নেই</li>';
}

document.getElementById('pendingApprovalList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-approve]');
  if (!btn) return;
  const formNo = btn.getAttribute('data-approve');
  const seedKg = prompt('কত কেজি বীজ দেওয়া হচ্ছে?');
  if (seedKg === null) return;
  if (!seedKg || isNaN(Number(seedKg))) { toast('বীজের পরিমাণ সংখ্যায় লিখুন', 'error'); return; }
  const approvedDate = new Date().toISOString();
  const payload = { requesterId: requesterId(), formNo, seedKg: Number(seedKg), approvedDate, approvedBy: CURRENT_USER.name, deviceId: getDeviceId() };
  // আগে লোকালে সেভ, তারপর সার্ভারে — সার্ভার ব্যর্থ হলে কিউতে থাকবে
  await idbUpdate('farmers', formNo, f => {
    if (!f) return;
    f.status = 'অনুমোদিত'; f.approvedSeedKg = Number(seedKg); f.approvedDate = approvedDate; f.approvedBy = CURRENT_USER.name;
    return deriveStatus_(f);
  });
  const wasOnline = isOnline();
  const result = await sendOrQueue('approveFarmer', payload);
  if (result === 'sent') toast('কৃষক অনুমোদিত হয়েছে', 'success');
  else toast(wasOnline ? 'সংরক্ষিত — সার্ভারে যায়নি, পরে সিঙ্ক হবে' : 'অফলাইনে সংরক্ষিত হয়েছে', 'success');
  renderAdmin();
});

function renderApprovedFarmers(farmers) {
  const approved = farmers.filter(f => f.status && f.status !== 'নিবন্ধিত');
  const el = document.getElementById('approvedFarmerList');
  el.innerHTML = approved.length ? approved.slice(0, 100).map(f => `
    <li>
      <div><strong>${escapeHtml(f.farmerName)}</strong><br>
      <span class="small text-muted">${escapeHtml(f.officeName || '')} • ${escapeHtml(f.status || '')} • অনুমোদনের তারিখ: ${esc_(f.approvedDate ? formatBnDate(f.approvedDate.slice(0,10)) : '-')}</span></div>
      <span class="overdue-badge" style="background:var(--green-100); color:var(--green-700);">${toBnNum(f.approvedSeedKg || 0)} কেজি</span>
    </li>`).join('') : '<li class="overdue-empty">এখনও কোনো কৃষক অনুমোদিত হয়নি</li>';
}
function esc_(v) { return escapeHtml(String(v == null ? '' : v)); }

// স্থানীয় সময়ের মাস (YYYY-MM) — UTC কাটলে মাসের শেষ/শুরুর রাতের এন্ট্রি ভুল মাসে যেত।
function monthKey_(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v).slice(0, 7);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
const bigha2_ = n => toBnNum((Math.round(n * 100) / 100).toFixed(2));

// শাখা অফিস অনুযায়ী সারাংশ — মাস নির্বাচনের ড্রপডাউনসহ।
// কলাম: নতুন আবেদন | আবেদনের জমি (বিঘা) | বীজ পাওয়া কৃষক | অনুমোদিত জমি (বিঘা) | মোট বীজ (কেজি)
let monthlyFarmersCache_ = [];
async function renderMonthlySummary(farmers) {
  monthlyFarmersCache_ = farmers;
  const sel = document.getElementById('reportMonthSelect');
  const data = await getMasterData();
  const allOffices = (data.offices || []).map(o => o.officeName).filter(Boolean);

  // ড্রপডাউনের মাস: ডাটার প্রথম মাস থেকে এই মাস পর্যন্ত সব মাস (জুন, জুলাই, আগস্ট, সেপ্টেম্বর ২০২৬ ...)
  const months = new Set();
  farmers.forEach(f => { if (f.regDate) months.add(monthKey_(f.regDate)); if (f.approvedDate) months.add(monthKey_(f.approvedDate)); });
  months.delete('');
  const nowKey = monthKey_(new Date());
  months.add(nowKey);
  const sortedAsc = [...months].sort();
  let [y, m] = sortedAsc[0].split('-').map(Number);
  const [ey, em] = nowKey.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { months.add(y + '-' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } }
  const monthList = [...months].sort().reverse();

  const prev = sel.value;
  sel.innerHTML = '<option value="all">সব মাস</option>' + monthList.map(k => `<option value="${k}">${esc_(bnMonthLabel(k))}</option>`).join('');
  sel.value = (prev && [...sel.options].some(o => o.value === prev)) ? prev : 'all';
  sel.onchange = () => drawMonthlyTable_(allOffices);
  drawMonthlyTable_(allOffices);
}

function drawMonthlyTable_(allOffices) {
  const farmers = monthlyFarmersCache_;
  const selected = document.getElementById('reportMonthSelect').value;
  const rows = {};
  const ensure = (month, office) => {
    const k = month + '|' + office;
    if (!rows[k]) rows[k] = { month, office, applications: 0, appLand: 0, approved: 0, apprLand: 0, seedKg: 0 };
    return rows[k];
  };
  const officeOf = f => f.officeName || 'অজানা';
  farmers.forEach(f => {
    const land = Number(f.landSize) || 0;
    if (f.regDate) {
      const month = monthKey_(f.regDate);
      if (selected === 'all' || month === selected) { const r = ensure(month, officeOf(f)); r.applications += 1; r.appLand += land; }
    }
    if (f.approvedDate) {
      const month = monthKey_(f.approvedDate);
      if (selected === 'all' || month === selected) {
        const r = ensure(month, officeOf(f));
        r.approved += 1; r.apprLand += land; r.seedKg += Number(f.approvedSeedKg) || 0;
      }
    }
  });
  // নির্দিষ্ট মাস বাছলে প্রতিটি অফিসই দেখাও (কাজ না থাকলেও ০ সহ)
  if (selected !== 'all') allOffices.forEach(o => ensure(selected, o));

  const list = Object.values(rows).sort((a, b) => b.month.localeCompare(a.month) || a.office.localeCompare(b.office));
  const table = document.getElementById('monthlySummaryTable');
  if (!list.length) { table.innerHTML = '<tr><td class="text-muted small">কোনো তথ্য নেই</td></tr>'; return; }

  const tot = list.reduce((t, r) => ({
    applications: t.applications + r.applications, appLand: t.appLand + r.appLand,
    approved: t.approved + r.approved, apprLand: t.apprLand + r.apprLand, seedKg: t.seedKg + r.seedKg
  }), { applications: 0, appLand: 0, approved: 0, apprLand: 0, seedKg: 0 });

  table.innerHTML = `
    <tr><th>মাস</th><th>শাখা অফিস</th><th>নতুন আবেদন</th><th>আবেদনের জমি (বিঘা)</th><th>বীজ পাওয়া কৃষক</th><th>অনুমোদিত জমি (বিঘা)</th><th>মোট বীজ (কেজি)</th></tr>
    ${list.map(r => `<tr>
      <td>${esc_(bnMonthLabel(r.month))}</td>
      <td>${esc_(r.office)}</td>
      <td>${toBnNum(r.applications)}</td>
      <td>${bigha2_(r.appLand)}</td>
      <td>${toBnNum(r.approved)}</td>
      <td>${bigha2_(r.apprLand)}</td>
      <td>${toBnNum(Math.round(r.seedKg * 100) / 100)}</td>
    </tr>`).join('')}
    <tr style="font-weight:700;background:var(--green-100)">
      <td colspan="2">মোট${selected === 'all' ? '' : ' — ' + esc_(bnMonthLabel(selected))}</td>
      <td>${toBnNum(tot.applications)}</td><td>${bigha2_(tot.appLand)}</td>
      <td>${toBnNum(tot.approved)}</td><td>${bigha2_(tot.apprLand)}</td>
      <td>${toBnNum(Math.round(tot.seedKg * 100) / 100)}</td>
    </tr>`;
}
function bnMonthLabel(ym) {
  if (!ym || ym === 'অজানা') return ym;
  const [y, m] = ym.split('-');
  return BN_MONTHS[Number(m) - 1] + ' ' + toBnNum(y);
}

function renderAdminFarmerList(farmers) {
  const el = document.getElementById('adminFarmerList');
  el.innerHTML = farmers.length ? farmers.slice(0, 100).map(f => `
    <li>
      <div><strong>${escapeHtml(f.farmerName)}</strong><br>
      <span class="small text-muted">ফর্ম: ${escapeHtml(f.formNo)} • ${escapeHtml(f.officerName || '')} • ${escapeHtml(f.status || '')}</span></div>
      <button data-delete-farmer="${escapeHtml(f.formNo)}">মুছুন</button>
    </li>`).join('') : '<li class="text-muted small">কোনো কৃষক পাওয়া যায়নি</li>';
}

document.getElementById('addOfficerBtn').addEventListener('click', async () => {
  if (!isOnline()) { toast('নতুন কর্মী যোগ করতে ইন্টারনেট প্রয়োজন', 'error'); return; }
  const data = await getMasterData();
  const officeNames = (data.offices || []).map(o => o.officeName).join(', ');
  const name = prompt('কর্মীর নাম:'); if (!name) return;
  const nid = prompt('NID নম্বর:'); if (!nid) return;
  const mobile = prompt('মোবাইল নম্বর:') || '';
  const pin = prompt('৪ সংখ্যার পিন:') || '1234';
  const officeName = prompt('অফিসের নাম (হুবহু লিখুন):\n' + officeNames) || '';
  let role = 'officer';
  let region = '';
  if (CURRENT_USER.role === 'super_admin') {
    role = prompt('রোল লিখুন (officer / admin / super_admin):', 'officer') || 'officer';
    if (role === 'admin') region = prompt('এই অ্যাডমিনের দায়িত্বে থাকা শাখা অফিসের নাম:\n' + officeNames) || '';
  } else {
    region = CURRENT_USER.region || '';
  }
  try {
    await apiPost('addOfficer', {
      requesterId: requesterId(), id: 'emp-' + Date.now().toString().slice(-8),
      nid, mobile, pin, name, officeName, role, region, active: true
    });
    toast('নতুন কর্মী যোগ করা হয়েছে', 'success');
    renderAdmin();
  } catch (e) { toast('কর্মী যোগ করা যায়নি', 'error'); }
});

document.getElementById('officerList').addEventListener('click', async (e) => {
  const toggleBtn = e.target.closest('[data-toggle-officer]');
  const resetBtn = e.target.closest('[data-reset-pin]');

  if (toggleBtn) {
    const id = toggleBtn.getAttribute('data-toggle-officer');
    const nowActive = toggleBtn.getAttribute('data-active') === 'true';
    try {
      await apiPost('updateOfficer', { requesterId: requesterId(), id, active: !nowActive });
      toast('আপডেট করা হয়েছে', 'success');
      renderAdmin();
    } catch (e2) { toast('আপডেট করা যায়নি', 'error'); }
    return;
  }

  if (resetBtn) {
    const id = resetBtn.getAttribute('data-reset-pin');
    const newPin = prompt('নতুন ৪ সংখ্যার পিন লিখুন:');
    if (!newPin) return;
    if (!/^\d{4}$/.test(newPin)) { toast('পিন অবশ্যই ৪ সংখ্যার হতে হবে', 'error'); return; }
    if (!isOnline()) { toast('পিন রিসেট করতে ইন্টারনেট প্রয়োজন', 'error'); return; }
    try {
      await apiPost('updateOfficer', { requesterId: requesterId(), id, pin: newPin });
      toast('নতুন পিন সেট করা হয়েছে — কর্মীকে জানিয়ে দিন', 'success');
    } catch (e2) { toast('পিন রিসেট করা যায়নি', 'error'); }
  }
});

document.getElementById('adminFarmerList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete-farmer]');
  if (!btn) return;
  const formNo = btn.getAttribute('data-delete-farmer');
  if (!confirm('আপনি কি নিশ্চিত এই কৃষকের রেকর্ড মুছে ফেলতে চান? এটি ফিরিয়ে আনা যাবে না।')) return;
  if (!isOnline()) { toast('রেকর্ড মুছতে ইন্টারনেট প্রয়োজন', 'error'); return; }
  try {
    await apiPost('deleteFarmer', { requesterId: requesterId(), formNo, deviceId: getDeviceId() });
    await idbDelete('farmers', formNo);
    toast('রেকর্ড মুছে ফেলা হয়েছে', 'success');
    renderAdmin();
  } catch (e2) { toast('মুছে ফেলা যায়নি — অনুমতি নেই অথবা সংযোগ সমস্যা', 'error'); }
});

/* ================================================================
   UTILITIES
   ================================================================ */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
const BN_DIGITS = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
function toBnNum(n) { return String(n).replace(/[0-9]/g, d => BN_DIGITS[d]); }
const BN_MONTHS = ['জানুয়ারি','ফেব্রুয়ারি','মার্চ','এপ্রিল','মে','জুন','জুলাই','আগস্ট','সেপ্টেম্বর','অক্টোবর','নভেম্বর','ডিসেম্বর'];
function formatBnDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (isNaN(d)) return isoDate;
  return toBnNum(d.getDate()) + ' ' + BN_MONTHS[d.getMonth()] + ' ' + toBnNum(d.getFullYear());
}
// Same as formatBnDate but also shows the time (AM/PM) — used for the
// observation date+time captured per follow-up step.
function formatBnDateTime(isoDateTime) {
  if (!isoDateTime) return '';
  const d = new Date(isoDateTime);
  if (isNaN(d)) return isoDateTime;
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return formatBnDate(isoDateTime) + ', ' + toBnNum(h) + ':' + toBnNum(String(m).padStart(2, '0')) + ' ' + ampm;
}

/* ================================================================
   SERVICE WORKER REGISTRATION
   ================================================================ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

/* ================================================================
   INIT
   ================================================================ */
tryAutoLogin();
