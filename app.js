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
function idbDelete(store, key) {
  return idbTx(store, 'readwrite').then(os => new Promise((res, rej) => {
    const r = os.delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
}

/* ================================================================
   NETWORK HELPERS
   ================================================================ */
function apiGet(action, params) {
  const qs = new URLSearchParams(Object.assign({ action }, params || {})).toString();
  return fetch(CONFIG.API_BASE + '?' + qs).then(r => r.json());
}
function apiPost(action, payload) {
  return fetch(CONFIG.API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight on Apps Script
    body: JSON.stringify(Object.assign({ action }, payload))
  }).then(r => r.json());
}

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

async function refreshFarmersCache() {
  if (!isOnline()) return;
  try {
    const res = await apiGet('farmers', { requesterId: requesterId() });
    if (res.farmers) {
      for (const f of res.farmers) await idbPut('farmers', f);
    }
  } catch (e) { /* offline or server hiccup — local cache still used */ }
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
document.getElementById('netPill').addEventListener('click', () => { if (isOnline()) syncQueue(); });
document.getElementById('syncNowBtn').addEventListener('click', syncQueue);

async function queueAction(action, payload) {
  const localId = await idbPut('queue', { action, payload, ts: Date.now() });
  await updateSyncBanner();
  return localId;
}

async function updateSyncBanner() {
  const items = await idbGetAll('queue');
  const banner = document.getElementById('syncBanner');
  const kpiPending = document.getElementById('kpiPending');
  if (items.length > 0) {
    banner.classList.remove('d-none');
    document.getElementById('syncBannerText').textContent = items.length + 'টি ফর্ম সিঙ্কের অপেক্ষায়';
  } else {
    banner.classList.add('d-none');
  }
  if (kpiPending) kpiPending.textContent = toBnNum(items.length);
}

let syncInProgress = false;
async function syncQueue() {
  if (syncInProgress || !isOnline()) return;
  const items = await idbGetAll('queue');
  if (items.length === 0) return;
  syncInProgress = true;
  try {
    const res = await apiPost('syncBatch', { items });
    if (res.results) {
      for (const r of res.results) {
        if (r.ok) await idbDelete('queue', r.localId);
      }
      const failed = res.results.filter(r => !r.ok).length;
      if (failed === 0) toast('সব ফর্ম সফলভাবে সিঙ্ক হয়েছে', 'success');
      else toast(failed + 'টি ফর্ম সিঙ্ক করা যায়নি, পরে আবার চেষ্টা করা হবে', 'error');
    }
  } catch (err) {
    toast('সিঙ্ক ব্যর্থ হয়েছে — ইন্টারনেট সংযোগ পরীক্ষা করুন', 'error');
  } finally {
    syncInProgress = false;
    await updateSyncBanner();
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
  if (isOnline()) { try { await apiPost('addLocation', payload); } catch (e) {} }
  else { await queueAction('addLocation', payload); }
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

  if (isOnline()) {
    try {
      await apiPost('submitFarmer', record);
      toast('কৃষক সফলভাবে নিবন্ধিত হয়েছে', 'success');
    } catch (err) {
      await queueAction('submitFarmer', record);
      toast('সংরক্ষিত হয়েছে, ইন্টারনেট এলে সিঙ্ক হবে', 'success');
    }
  } else {
    await queueAction('submitFarmer', record);
    toast('অফলাইনে সংরক্ষিত হয়েছে — ৩ ধাপে সিঙ্ক অপেক্ষমান', 'success');
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
  stepGps = null; stepPhotoBase64 = null;

  const existing = ACTIVE_FARMER['step' + step + 'Json'];
  if (existing) {
    try {
      const d = JSON.parse(existing);
      document.getElementById('s_date').value = d.date || '';
      if (step === 1) document.getElementById('s_sowingDate').value = d.sowingDate || ACTIVE_FARMER.sowingDate || '';
      document.getElementById('s_disease').value = d.disease || '';
      document.getElementById('s_remedy').value = d.remedy || '';
      document.getElementById('s_comment').value = d.comment || '';
      document.getElementById('s_rating').value = d.rating || 70;
      document.getElementById('s_ratingVal').textContent = toBnNum(d.rating || 70);
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
  const priorExpense = Number(ACTIVE_FARMER.totalExpense) || 0;
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
    gps: stepGps, expense, expense_total: expenseTotal,
    // Kept locally so the print profile can show a step photo even
    // before this step has synced and the server has returned a
    // permanent Drive link (data.photoUrl, merged in by the server).
    photo: stepPhotoBase64 || null
  };
  if (ACTIVE_STEP === 4) {
    data.yieldQty = Number(document.getElementById('p_yield').value) || 0;
    data.marketPrice = Number(document.getElementById('p_price').value) || 0;
  }

  const payload = {
    formNo: ACTIVE_FARMER.formNo, step: ACTIVE_STEP, data,
    expense: expenseTotal, observationDate: data.date,
    photoBase64: stepPhotoBase64 || undefined,
    deviceId: getDeviceId()
  };

  // Update local cache immediately
  ACTIVE_FARMER['step' + ACTIVE_STEP + 'Json'] = JSON.stringify(data);
  ACTIVE_FARMER.lastFollowUpDate = data.date;
  if (ACTIVE_STEP === 1 && sowingVal) ACTIVE_FARMER.sowingDate = sowingVal;
  ACTIVE_FARMER.totalExpense = (Number(ACTIVE_FARMER.totalExpense) || 0) + expenseTotal;
  if (ACTIVE_STEP === 4) {
    ACTIVE_FARMER.yieldQty = data.yieldQty;
    ACTIVE_FARMER.marketPrice = data.marketPrice;
    ACTIVE_FARMER.profitLoss = (data.yieldQty * data.marketPrice) - ACTIVE_FARMER.totalExpense;
    ACTIVE_FARMER.status = 'সম্পন্ন';
  } else {
    ACTIVE_FARMER.status = 'ধাপ ' + ACTIVE_STEP + ' সম্পন্ন';
  }
  await idbPut('farmers', ACTIVE_FARMER);

  if (isOnline()) {
    try { await apiPost('submitFollowUp', payload); toast('ধাপ ' + toBnNum(ACTIVE_STEP) + ' সংরক্ষণ হয়েছে', 'success'); }
    catch (err) { await queueAction('submitFollowUp', payload); toast('সংরক্ষিত, সিঙ্ক অপেক্ষমান', 'success'); }
  } else {
    await queueAction('submitFollowUp', payload);
    toast('অফলাইনে সংরক্ষিত হয়েছে', 'success');
  }

  renderStepTabs();
  if (ACTIVE_STEP < 4) selectStep(ACTIVE_STEP + 1);
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
  document.getElementById('kpiLand').textContent = toBnNum(farmers.reduce((s, f) => s + (Number(f.landSize) || 0), 0).toFixed(1));

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
        Promise.all(res.farmers.map(f => idbPut('farmers', f))).then(() => {
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
  document.getElementById('kpiLand').textContent = toBnNum(farmers.reduce((s, f) => s + (Number(f.landSize) || 0), 0).toFixed(1));
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
  renderMonthlySummary(farmers);
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
  const nid = normalizeDigits(inputEl.value.trim());
  const box = document.getElementById('historyResults');
  if (!nid) { box.innerHTML = ''; return; }
  idbGetAll('farmers').then(farmers => {
    const matches = farmers.filter(f => normalizeDigits(String(f.nid || '')) === nid);
    box.innerHTML = matches.length ? matches.map(f => `
      <div class="section-card" style="box-shadow:none;border:1px solid var(--border);">
        <strong>${escapeHtml(f.farmerName)}</strong> — ${escapeHtml(f.cropName)}<br>
        <span class="small text-muted">ফর্ম: ${escapeHtml(f.formNo)} • ${escapeHtml(f.status)} • নিবন্ধন: ${escapeHtml(f.regDate ? f.regDate.slice(0,10) : '')}</span>
      </div>`).join('') : '<p class="text-muted small">কোনো রেকর্ড পাওয়া যায়নি</p>';
  });
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
  const withGps = farmers.filter(f => f.gpsLat && f.gpsLng);
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

  // Every branch office gets its own pin at its own GPS location.
  offices.forEach(o => {
    if (!o.lat || !o.lng) return;
    L.marker([Number(o.lat), Number(o.lng)], {
      icon: L.divIcon({ className: '', html: '<div class="map-pin map-pin-office"><span class="map-pin-emoji">🏢</span></div>', iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] })
    }).addTo(leafletMap).bindPopup('<strong>' + escapeHtml(o.officeName) + '</strong><br>শাখা অফিস');
  });

  withGps.forEach(f => {
    const office = offices.find(o => o.officeName === f.officeName);
    const officeLat = office ? Number(office.lat) : CONFIG.FALLBACK_OFFICE_LAT;
    const officeLng = office ? Number(office.lng) : CONFIG.FALLBACK_OFFICE_LNG;
    const dist = haversineKm(Number(f.gpsLat), Number(f.gpsLng), officeLat, officeLng);
    L.marker([Number(f.gpsLat), Number(f.gpsLng)], {
      icon: L.divIcon({ className: '', html: '<div class="map-pin map-pin-farmer"><span class="map-pin-emoji">📌</span></div>', iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] }),
      zIndexOffset: 1000 // keeps farmer pins clickable above office pins when they overlap
    }).addTo(leafletMap).bindPopup(
      `<strong>${escapeHtml(f.farmerName)}</strong><br>অফিসার: ${escapeHtml(f.officerName || '-')}<br>শাখা: ${escapeHtml(f.officeName || '-')}<br>ফসলের ধাপ: ${escapeHtml(f.status || '-')}<br>দূরত্ব: ${dist.toFixed(1)} কিমি`
    );
  });
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
  const payload = { requesterId: requesterId(), formNo, seedKg: Number(seedKg), deviceId: getDeviceId() };
  if (isOnline()) {
    try {
      await apiPost('approveFarmer', payload);
      toast('কৃষক অনুমোদিত হয়েছে', 'success');
    } catch (err) {
      await queueAction('approveFarmer', payload);
      toast('সংরক্ষিত, ইন্টারনেট এলে সিঙ্ক হবে', 'success');
    }
  } else {
    await queueAction('approveFarmer', payload);
    toast('অফলাইনে সংরক্ষিত হয়েছে', 'success');
  }
  const farmer = await idbGet('farmers', formNo);
  if (farmer) {
    farmer.status = 'অনুমোদিত'; farmer.approvedSeedKg = Number(seedKg);
    farmer.approvedDate = new Date().toISOString(); farmer.approvedBy = CURRENT_USER.name;
    await idbPut('farmers', farmer);
  }
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

// Month-by-month, office-by-office: applications, approved count, seed kg.
function renderMonthlySummary(farmers) {
  const key = (dateStr, office) => (dateStr ? dateStr.slice(0, 7) : 'অজানা') + '|' + (office || 'অজানা');
  const rows = {};
  const ensure = (k, month, office) => {
    if (!rows[k]) rows[k] = { month, office, applications: 0, approved: 0, seedKg: 0 };
    return rows[k];
  };
  farmers.forEach(f => {
    if (f.regDate) {
      const month = f.regDate.slice(0, 7);
      const k = key(f.regDate, f.officeName);
      ensure(k, month, f.officeName).applications += 1;
    }
    if (f.approvedDate) {
      const month = f.approvedDate.slice(0, 7);
      const k = key(f.approvedDate, f.officeName);
      const row = ensure(k, month, f.officeName);
      row.approved += 1;
      row.seedKg += Number(f.approvedSeedKg) || 0;
    }
  });
  const sorted = Object.values(rows).sort((a, b) => b.month.localeCompare(a.month) || a.office.localeCompare(b.office));
  const table = document.getElementById('monthlySummaryTable');
  if (!sorted.length) {
    table.innerHTML = '<tr><td class="text-muted small">কোনো তথ্য নেই</td></tr>';
    return;
  }
  table.innerHTML = `
    <tr><th>মাস</th><th>শাখা অফিস</th><th>নতুন আবেদন</th><th>বীজ পাওয়া কৃষক</th><th>মোট বীজ (কেজি)</th></tr>
    ${sorted.map(r => `<tr>
      <td>${esc_(bnMonthLabel(r.month))}</td>
      <td>${esc_(r.office)}</td>
      <td>${toBnNum(r.applications)}</td>
      <td>${toBnNum(r.approved)}</td>
      <td>${toBnNum(r.seedKg)}</td>
    </tr>`).join('')}
  `;
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
