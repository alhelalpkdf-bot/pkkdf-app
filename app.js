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
  OFFICE_LAT: 23.8103,   // used to compute "distance from office" — set to your office
  OFFICE_LNG: 90.4125,
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
  return cached ? cached.value : { locations: [], crops: [], employees: [] };
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
    landSize: document.getElementById('f_landSize').value,
    seedQtyKg: document.getElementById('f_seedQtyKg').value,
    cropName: document.getElementById('f_cropName').value,
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
  const localRecord = Object.assign({}, record, {
    regPhotoUrl: record.regPhotoBase64, // local preview until synced
    status: 'নিবন্ধিত', step1Json: '', step2Json: '', step3Json: '', step4Json: '',
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
  const results = farmers.filter(f =>
    (f.formNo || '').toLowerCase().includes(q) ||
    (f.nid || '').toLowerCase().includes(q) ||
    (f.farmerName || '').toLowerCase().includes(q)
  ).slice(0, 20);

  list.innerHTML = results.length ? results.map(f => `
    <li>
      <div><strong>${escapeHtml(f.farmerName)}</strong><br>
      <span class="small text-muted">ফর্ম: ${escapeHtml(f.formNo)} • ${escapeHtml(f.status || '')}</span></div>
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
  ACTIVE_FARMER = farmer;
  document.getElementById('fuFarmerName').textContent = farmer.farmerName;
  document.getElementById('fuFarmerMeta').textContent =
    'ফর্ম: ' + farmer.formNo + ' • ' + farmer.cropName + ' • ' + farmer.village;
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

  document.getElementById('stepForm').reset();
  document.getElementById('s_photoPreview').classList.add('d-none');
  document.getElementById('s_gpsResult').textContent = 'GPS নেওয়া হয়নি';
  document.getElementById('s_distance').textContent = 'অফিস থেকে দূরত্ব: —';
  document.getElementById('s_date').value = new Date().toISOString().slice(0, 10);
  stepGps = null; stepPhotoBase64 = null;

  const existing = ACTIVE_FARMER['step' + step + 'Json'];
  if (existing) {
    try {
      const d = JSON.parse(existing);
      document.getElementById('s_date').value = d.date || '';
      document.getElementById('s_cropAge').value = d.cropAge || '';
      document.getElementById('s_disease').value = d.disease || '';
      document.getElementById('s_remedy').value = d.remedy || '';
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
}

document.getElementById('s_rating').addEventListener('input', function () {
  document.getElementById('s_ratingVal').textContent = toBnNum(this.value);
});

let stepGps = null, stepPhotoBase64 = null;
document.getElementById('s_gpsBtn').addEventListener('click', () => captureGps('s_gpsResult', (pos) => {
  stepGps = pos;
  const distKm = haversineKm(Number(pos.lat), Number(pos.lng), CONFIG.OFFICE_LAT, CONFIG.OFFICE_LNG);
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

  const data = {
    date: document.getElementById('s_date').value,
    cropAge: document.getElementById('s_cropAge').value,
    disease: document.getElementById('s_disease').value,
    remedy: document.getElementById('s_remedy').value,
    rating: document.getElementById('s_rating').value,
    gps: stepGps, expense, expense_total: expenseTotal
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
  ACTIVE_FARMER.totalExpense = (Number(ACTIVE_FARMER.totalExpense) || 0) + expenseTotal;
  if (ACTIVE_STEP === 4) {
    ACTIVE_FARMER.yieldQty = data.yieldQty;
    ACTIVE_FARMER.marketPrice = data.marketPrice;
    ACTIVE_FARMER.profitLoss = (data.yieldQty * data.marketPrice) - ACTIVE_FARMER.totalExpense;
    ACTIVE_FARMER.status = 'সম্পন্ন';
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
document.getElementById('printProfileBtn').addEventListener('click', () => {
  if (!ACTIVE_FARMER) return;
  buildPrintArea(ACTIVE_FARMER);
  setTimeout(() => window.print(), 100);
});

function buildPrintArea(f) {
  const steps = [1, 2, 3, 4].map(s => {
    try { return JSON.parse(f['step' + s + 'Json'] || '{}'); } catch (e) { return {}; }
  });
  const html = `
    <div class="print-page">
      <div class="print-head">
        <img src="icons/icon-192.png">
        <div><h1>পল্লী ক্ষুদ্র কৃষি উন্নয়ন ফাউন্ডেশন</h1><p>কৃষক প্রোফাইল — ফর্ম নম্বর: ${esc(f.formNo)}</p></div>
      </div>
      <div class="print-section-title">মূল তথ্য</div>
      <div class="print-grid">
        <div><span>নাম:</span> ${esc(f.farmerName)}</div>
        <div><span>পিতার নাম:</span> ${esc(f.fatherName)}</div>
        <div><span>NID:</span> ${esc(f.nid)}</div>
        <div><span>মোবাইল:</span> ${esc(f.mobile)}</div>
        <div><span>ঠিকানা:</span> ${esc(f.village)}, ${esc(f.union)}, ${esc(f.upazila)}, ${esc(f.district)}</div>
        <div><span>জমির পরিমাণ:</span> ${esc(f.landSize)} একর</div>
        <div><span>ফসল:</span> ${esc(f.cropName)}</div>
        <div><span>বীজ:</span> ${esc(f.seedQtyKg)} কেজি</div>
        <div><span>দায়িত্বরত অফিসার:</span> ${esc(f.officerName)}</div>
        <div><span>নিবন্ধনের তারিখ:</span> ${esc(f.regDate ? formatBnDate(f.regDate.slice(0,10)) : '')}</div>
      </div>
      <div class="print-section-title">পর্যবেক্ষণ ধাপসমূহ (১ ও ২)</div>
      <div class="print-steps">
        ${printStepCard(steps[0], 1)}
        ${printStepCard(steps[1], 2)}
      </div>
    </div>
    <div class="print-page">
      <div class="print-section-title">পর্যবেক্ষণ ধাপসমূহ (৩ ও ৪)</div>
      <div class="print-steps">
        ${printStepCard(steps[2], 3)}
        ${printStepCard(steps[3], 4)}
      </div>
      <div class="print-section-title">আর্থিক সারসংক্ষেপ</div>
      <div class="print-fin">
        <div>মোট খরচ: ৳ ${esc(f.totalExpense || 0)}</div>
        <div>উৎপাদন: ${esc(f.yieldQty || 0)} কেজি × বাজার দর ৳${esc(f.marketPrice || 0)}</div>
        <div class="big">${(Number(f.profitLoss) || 0) >= 0 ? 'লাভ' : 'ক্ষতি'}: ৳ ${esc(Math.abs(Number(f.profitLoss) || 0))}</div>
      </div>
    </div>
  `;
  document.getElementById('printArea').innerHTML = html;
}
function printStepCard(d, n) {
  if (!d || !d.date) return `<div class="print-step-card"><strong>ধাপ ${n}</strong><br><span style="color:#999">তথ্য নেই</span></div>`;
  return `<div class="print-step-card">
    <strong>ধাপ ${n} — ${esc(formatBnDate(d.date))}</strong><br>
    ফসলের বয়স: ${esc(d.cropAge || '-')} দিন<br>
    রোগ/পোকা: ${esc(d.disease || '-')}<br>
    প্রতিকার: ${esc(d.remedy || '-')}<br>
    অবস্থা: ${esc(d.rating || '-')}%<br>
    খরচ: ৳ ${esc(d.expense_total || 0)}
  </div>`;
}
function esc(v) { return escapeHtml(String(v == null ? '' : v)); }

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
  farmers.forEach(f => { const c = f.cropName || 'অজানা'; seedByCrop[c] = (seedByCrop[c] || 0) + (Number(f.seedQtyKg) || 0); });
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
  farmers.forEach(f => { const c = f.cropName || 'অজানা'; seedByCrop[c] = (seedByCrop[c] || 0) + (Number(f.seedQtyKg) || 0); });
  drawBarChart('chartSeed', Object.keys(seedByCrop), Object.values(seedByCrop), '#2E9E52');
}

function computeOverdue(farmers) {
  const now = new Date();
  return farmers.filter(f => f.status !== 'সম্পন্ন').map(f => {
    const ref = f.lastFollowUpDate || f.regDate;
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

  document.getElementById('historyNidInput').oninput = debounce(async function () {
    const nid = this.value.trim();
    const box = document.getElementById('historyResults');
    if (!nid) { box.innerHTML = ''; return; }
    const matches = farmers.filter(f => String(f.nid) === nid);
    box.innerHTML = matches.length ? matches.map(f => `
      <div class="section-card" style="box-shadow:none;border:1px solid var(--border);">
        <strong>${escapeHtml(f.farmerName)}</strong> — ${escapeHtml(f.cropName)}<br>
        <span class="small text-muted">ফর্ম: ${escapeHtml(f.formNo)} • ${escapeHtml(f.status)} • নিবন্ধন: ${escapeHtml(f.regDate ? f.regDate.slice(0,10) : '')}</span>
      </div>`).join('') : '<p class="text-muted small">কোনো রেকর্ড পাওয়া যায়নি</p>';
  }, 250);
}

function drawBarChart(canvasId, labels, values, color) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (ctx._chart) ctx._chart.destroy();
  ctx._chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: color, borderRadius: 6 }] },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } },
      responsive: true
    }
  });
}

/* ================================================================
   MODULE 4 — GIS MAP
   ================================================================ */
let leafletMap = null;
async function renderMap() {
  const farmers = await idbGetAll('farmers');
  const withGps = farmers.filter(f => f.gpsLat && f.gpsLng);

  if (!leafletMap) {
    leafletMap = L.map('gisMap').setView([CONFIG.OFFICE_LAT, CONFIG.OFFICE_LNG], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19
    }).addTo(leafletMap);
  } else {
    leafletMap.eachLayer(l => { if (l instanceof L.Marker) leafletMap.removeLayer(l); });
  }

  L.marker([CONFIG.OFFICE_LAT, CONFIG.OFFICE_LNG], {
    icon: L.divIcon({ className: '', html: '📍', iconSize: [26, 26] })
  }).addTo(leafletMap).bindPopup('<strong>PKKDF অফিস</strong>');

  withGps.forEach(f => {
    const dist = haversineKm(Number(f.gpsLat), Number(f.gpsLng), CONFIG.OFFICE_LAT, CONFIG.OFFICE_LNG);
    L.marker([Number(f.gpsLat), Number(f.gpsLng)], {
      icon: L.divIcon({ className: '', html: '📌', iconSize: [22, 22] })
    }).addTo(leafletMap).bindPopup(
      `<strong>${escapeHtml(f.farmerName)}</strong><br>অফিসার: ${escapeHtml(f.officerName || '-')}<br>ফসলের ধাপ: ${escapeHtml(f.status || '-')}<br>দূরত্ব: ${dist.toFixed(1)} কিমি`
    );
  });
}

/* ================================================================
   ADMIN PANEL (admin / super_admin only)
   ================================================================ */
async function renderAdmin() {
  document.getElementById('myRoleLabel').textContent =
    CURRENT_USER.role === 'super_admin' ? 'সুপার অ্যাডমিন' : 'অ্যাডমিন — ' + (CURRENT_USER.region || '');

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

  const farmers = await idbGetAll('farmers'); // already scoped, refreshed at boot / reports visit
  renderAdminFarmerList(farmers);
  document.getElementById('adminFarmerSearch').oninput = debounce(function () {
    const q = this.value.trim().toLowerCase();
    const filtered = !q ? farmers : farmers.filter(f =>
      (f.farmerName || '').toLowerCase().includes(q) || (f.formNo || '').toLowerCase().includes(q));
    renderAdminFarmerList(filtered);
  }, 200);
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
  const name = prompt('কর্মীর নাম:'); if (!name) return;
  const nid = prompt('NID নম্বর:'); if (!nid) return;
  const mobile = prompt('মোবাইল নম্বর:') || '';
  const pin = prompt('৪ সংখ্যার পিন:') || '1234';
  const officeName = prompt('অফিসের নাম:') || '';
  let role = 'officer';
  let region = '';
  if (CURRENT_USER.role === 'super_admin') {
    role = prompt('রোল লিখুন (officer / admin / super_admin):', 'officer') || 'officer';
    if (role === 'admin') region = prompt('এই অ্যাডমিনের দায়িত্বে থাকা জেলার নাম:') || '';
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
