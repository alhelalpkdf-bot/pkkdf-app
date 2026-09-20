/**
 * ================================================================
 *  PKKDF — পল্লী ক্ষুদ্র কৃষি উন্নয়ন ফাউন্ডেশন
 *  Farmer MIS + Offline-First PWA — Backend (Google Apps Script)
 * ================================================================
 *  Architecture:
 *   - This script is deployed as a Web App and works ONLY as a
 *     JSON API (doGet / doPost). It does NOT serve the PWA's HTML,
 *     because Apps Script web app URLs cannot host a Service Worker
 *     at scope "/" (a hard platform limitation — SWs must be served
 *     from the same origin+path they control). See DEPLOYMENT_GUIDE.md
 *     for why the frontend is hosted separately (Firebase Hosting /
 *     GitHub Pages) and calls this API over fetch().
 *
 *   - Sheets used (create them exactly with these names/headers —
 *     see DEPLOYMENT_GUIDE.md for the full column list):
 *       "MasterData"   -> Employees, Locations, Crops (config sheet)
 *       "Farmers"      -> One row per Form No. All 4 follow-up steps
 *                          and financials are columns on that row.
 *       "SyncLog"      -> Append-only audit of every sync from field.
 * ================================================================
 */

const SS = SpreadsheetApp.getActiveSpreadsheet();
const SHEET_FARMERS = 'Farmers';
const SHEET_MASTER = 'MasterData';
const SHEET_EMPLOYEES = 'Employees';
const SHEET_LOCATIONS = 'Locations';
const SHEET_CROPS = 'Crops';
const SHEET_SYNCLOG = 'SyncLog';
const PHOTO_FOLDER_NAME = 'PKKDF_Farmer_Photos';

// Column order for the Farmers sheet — single source of truth.
// (Keep in sync with the header row you create in the sheet.)
const FARMER_COLUMNS = [
  'formNo', 'nid', 'farmerName', 'fatherName', 'mobile', 'gender', 'age',
  'district', 'upazila', 'union', 'village',
  'landSize', 'cropName', 'seedQtyKg',
  'gpsLat', 'gpsLng', 'regPhotoUrl',
  'officerId', 'officerName', 'officeName',
  'regDate', 'status',
  // Step 1..4 follow-up (JSON blobs, one per step)
  'step1Json', 'step2Json', 'step3Json', 'step4Json',
  'lastFollowUpDate', 'totalExpense', 'yieldQty', 'marketPrice', 'profitLoss',
  'updatedAt'
];

/* ------------------------------------------------------------------ *
 *  ENTRY POINTS
 * ------------------------------------------------------------------ */

function doGet(e) {
  try {
    const action = (e.parameter.action || '').toString();
    let result;
    switch (action) {
      case 'ping':          result = { ok: true, time: new Date().toISOString() }; break;
      case 'masterData':    result = getMasterData_(); break;
      case 'farmers':       result = getFarmers_(e.parameter); break;
      case 'farmerByNid':   result = getFarmerHistoryByNid_(e.parameter.nid); break;
      case 'dashboard':     result = getDashboardStats_(e.parameter); break;
      case 'overdue':       result = getOverdueFollowUps_(Number(e.parameter.days || 20), e.parameter); break;
      case 'mapData':       result = getMapData_(e.parameter); break;
      case 'employees':     result = getEmployeesForAdmin_(e.parameter); break;
      default:              result = { error: 'Unknown action: ' + action };
    }
    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ error: err.message, stack: err.stack });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    let result;
    switch (action) {
      case 'login':          result = login_(body); break;
      case 'addLocation':    result = addLocation_(body); break;
      case 'submitFarmer':   result = submitFarmer_(body); break;
      case 'submitFollowUp': result = submitFollowUp_(body); break;
      // Bulk sync: array of queued offline actions replayed in order.
      case 'syncBatch':      result = syncBatch_(body.items || []); break;
      case 'addOfficer':     result = addOfficer_(body); break;
      case 'updateOfficer':  result = updateOfficer_(body); break;
      case 'deleteFarmer':   result = deleteFarmer_(body); break;
      default:                result = { error: 'Unknown action: ' + action };
    }
    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ error: err.message, stack: err.stack });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ *
 *  AUTH
 * ------------------------------------------------------------------ */

function login_(body) {
  const idInput = (body.nidOrMobile || '').toString().trim();
  const pin = (body.pin || '').toString().trim();
  const sh = SS.getSheetByName(SHEET_EMPLOYEES);
  const rows = sh.getDataRange().getValues();
  const header = rows[0];
  const iNid = header.indexOf('nid');
  const iMobile = header.indexOf('mobile');
  const iPin = header.indexOf('pin');
  const iActive = header.indexOf('active');

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const matches = (row[iNid] == idInput || row[iMobile] == idInput);
    if (matches && String(row[iPin]) === pin) {
      if (iActive > -1 && row[iActive] === false) {
        return { ok: false, message: 'অ্যাকাউন্টটি নিষ্ক্রিয় করা হয়েছে' };
      }
      const employee = {};
      header.forEach((h, i) => { if (h !== 'pin') employee[h] = row[i]; });
      if (!employee.role) employee.role = 'officer'; // default for rows created before roles existed
      return { ok: true, employee: employee };
    }
  }
  return { ok: false, message: 'NID/মোবাইল অথবা পিন সঠিক নয়' };
}

/* ------------------------------------------------------------------ *
 *  ROLE / ACCESS CONTROL
 * ------------------------------------------------------------------ *
 *  IMPORTANT — honest limitation: this API has no login session
 *  tokens (Apps Script web apps don't give you server-side sessions
 *  for "Anyone" access). Every privileged call trusts the requesterId
 *  the client sends and looks up that person's role/region from the
 *  Employees sheet. This stops accidental misuse from the app's own
 *  UI, but a technically sophisticated person could forge a
 *  requesterId. For 300+ users incl. sensitive government data, plan
 *  a follow-up to add real auth (e.g. Firebase Auth in front of this
 *  API) before wider rollout — flagged here so it isn't forgotten.
 * ------------------------------------------------------------------ */

function getEmployeeById_(id) {
  const rows = sheetToObjects_(SHEET_EMPLOYEES);
  return rows.find(r => String(r.id) === String(id) || String(r.nid) === String(id)) || null;
}

// Throws if requester isn't one of allowedRoles. Returns the employee record.
function requireRole_(requesterId, allowedRoles) {
  const emp = getEmployeeById_(requesterId);
  if (!emp) throw new Error('অনুমোদিত ব্যবহারকারী পাওয়া যায়নি');
  const role = emp.role || 'officer';
  if (allowedRoles.indexOf(role) === -1) {
    throw new Error('এই কাজের জন্য আপনার অনুমতি নেই');
  }
  return emp;
}

/* ------------------------------------------------------------------ *
 *  ADMIN: manage officers
 * ------------------------------------------------------------------ */

function getEmployeesForAdmin_(params) {
  const requester = requireRole_(params.requesterId, ['admin', 'super_admin']);
  let list = sheetToObjects_(SHEET_EMPLOYEES).map(e => { const c = Object.assign({}, e); delete c.pin; return c; });
  if (requester.role === 'admin') {
    list = list.filter(e => e.region === requester.region);
  }
  return { employees: list };
}

function addOfficer_(body) {
  requireRole_(body.requesterId, ['admin', 'super_admin']);
  const sh = SS.getSheetByName(SHEET_EMPLOYEES);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const row = header.map(h => body[h] !== undefined ? body[h] : (h === 'active' ? true : (h === 'role' ? 'officer' : '')));
    sh.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function updateOfficer_(body) {
  const requester = requireRole_(body.requesterId, ['admin', 'super_admin']);
  const sh = SS.getSheetByName(SHEET_EMPLOYEES);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const idCol = header.indexOf('id') + 1;
  const row = findRowByValue_(sh, 'id', body.id);
  if (!row) return { ok: false, message: 'কর্মী খুঁজে পাওয়া যায়নি' };

  // A plain admin may only edit officers inside their own region.
  if (requester.role === 'admin') {
    const regionCol = header.indexOf('region') + 1;
    const targetRegion = sh.getRange(row, regionCol).getValue();
    if (targetRegion !== requester.region) throw new Error('আপনার এলাকার বাইরের কর্মী এডিট করার অনুমতি নেই');
    if (body.role === 'super_admin') throw new Error('শুধু সুপার অ্যাডমিন super_admin রোল দিতে পারবেন');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ['name', 'designation', 'officeName', 'region', 'role', 'active'].forEach(field => {
      if (body[field] !== undefined) {
        const col = header.indexOf(field) + 1;
        if (col > 0) sh.getRange(row, col).setValue(body[field]);
      }
    });
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function deleteFarmer_(body) {
  const requester = requireRole_(body.requesterId, ['admin', 'super_admin']);
  const sh = SS.getSheetByName(SHEET_FARMERS);
  const row = findRowByValue_(sh, 'formNo', body.formNo);
  if (!row) return { ok: false, message: 'রেকর্ড পাওয়া যায়নি' };

  if (requester.role === 'admin') {
    const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const officeCol = header.indexOf('officeName') + 1;
    const officeName = sh.getRange(row, officeCol).getValue();
    if (officeName !== requester.officeName) throw new Error('আপনার এলাকার বাইরের রেকর্ড মুছতে পারবেন না');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sh.deleteRow(row);
  } finally {
    lock.releaseLock();
  }
  logSync_('deleteFarmer by ' + body.requesterId, body.formNo, body.deviceId);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 *  MASTER DATA (locations / crops / employees for dropdowns)
 * ------------------------------------------------------------------ */

function getMasterData_() {
  return {
    locations: sheetToObjects_(SHEET_LOCATIONS),
    crops: sheetToObjects_(SHEET_CROPS),
    employees: sheetToObjects_(SHEET_EMPLOYEES).map(function (emp) {
      delete emp.pin;
      return emp;
    })
  };
}

function addLocation_(body) {
  const sh = SS.getSheetByName(SHEET_LOCATIONS);
  // columns: district, upazila, union, village
  sh.appendRow([body.district || '', body.upazila || '', body.union || '', body.village || '']);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 *  FARMER REGISTRATION (Module 1)
 * ------------------------------------------------------------------ */

function submitFarmer_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // 300+ users may sync at once (e.g. all online at 9am) — serialize sheet writes
  try {
    return submitFarmerLocked_(body);
  } finally {
    lock.releaseLock();
  }
}

function submitFarmerLocked_(body) {
  const sh = SS.getSheetByName(SHEET_FARMERS);
  ensureHeader_(sh, FARMER_COLUMNS);

  // Check duplicate NID -> if exists, treat as repeat farmer (link, do not duplicate)
  const existingRow = findRowByValue_(sh, 'nid', body.nid);
  const photoUrl = body.regPhotoBase64 ? saveBase64Image_(body.regPhotoBase64, body.formNo + '_reg') : '';

  const record = {
    formNo: body.formNo,
    nid: body.nid,
    farmerName: body.farmerName,
    fatherName: body.fatherName,
    mobile: body.mobile,
    gender: body.gender,
    age: body.age,
    district: body.district,
    upazila: body.upazila,
    union: body.union,
    village: body.village,
    landSize: body.landSize,
    cropName: body.cropName,
    seedQtyKg: body.seedQtyKg,
    gpsLat: body.gpsLat,
    gpsLng: body.gpsLng,
    regPhotoUrl: photoUrl,
    officerId: body.officerId,
    officerName: body.officerName,
    officeName: body.officeName,
    regDate: body.regDate || new Date().toISOString(),
    status: 'নিবন্ধিত',
    step1Json: '', step2Json: '', step3Json: '', step4Json: '',
    lastFollowUpDate: '', totalExpense: 0, yieldQty: 0, marketPrice: 0, profitLoss: 0,
    updatedAt: new Date().toISOString()
  };

  writeRecordRow_(sh, record, FARMER_COLUMNS, existingRow);
  logSync_('submitFarmer', body.formNo, body.deviceId);
  return { ok: true, formNo: body.formNo };
}

/* ------------------------------------------------------------------ *
 *  FOLLOW-UP (Module 2) — steps 1-4, sequential lock enforced server-side too
 * ------------------------------------------------------------------ */

function submitFollowUp_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return submitFollowUpLocked_(body);
  } finally {
    lock.releaseLock();
  }
}

function submitFollowUpLocked_(body) {
  const sh = SS.getSheetByName(SHEET_FARMERS);
  const row = findRowByValue_(sh, 'formNo', body.formNo);
  if (!row) return { ok: false, message: 'ফর্ম নম্বরটি খুঁজে পাওয়া যায়নি' };

  const step = Number(body.step); // 1..4
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const colIndex = {};
  header.forEach((h, i) => colIndex[h] = i + 1);

  // Sequential lock: step N requires step N-1 already filled (except step 1)
  if (step > 1) {
    const prevVal = sh.getRange(row, colIndex['step' + (step - 1) + 'Json']).getValue();
    if (!prevVal) {
      return { ok: false, message: 'ধাপ ' + (step - 1) + ' সম্পন্ন না হলে এই ধাপ পূরণ করা যাবে না' };
    }
  }

  if (body.photoBase64) {
    body.photoUrl = saveBase64Image_(body.photoBase64, body.formNo + '_step' + step);
    delete body.photoBase64;
  }

  const payload = JSON.stringify(body.data || {});
  sh.getRange(row, colIndex['step' + step + 'Json']).setValue(payload);
  sh.getRange(row, colIndex['lastFollowUpDate']).setValue(body.observationDate || new Date().toISOString());
  sh.getRange(row, colIndex['updatedAt']).setValue(new Date().toISOString());

  if (body.data && body.data.expense != null) {
    const prevExpense = Number(sh.getRange(row, colIndex['totalExpense']).getValue()) || 0;
    sh.getRange(row, colIndex['totalExpense']).setValue(prevExpense + Number(body.data.expense));
  }

  // Step 4 -> final financial calculation: Profit/Loss = (Yield * Market Price) - Total Expense
  if (step === 4 && body.data) {
    const yieldQty = Number(body.data.yieldQty || 0);
    const marketPrice = Number(body.data.marketPrice || 0);
    const totalExpense = Number(sh.getRange(row, colIndex['totalExpense']).getValue()) || 0;
    const profitLoss = (yieldQty * marketPrice) - totalExpense;
    sh.getRange(row, colIndex['yieldQty']).setValue(yieldQty);
    sh.getRange(row, colIndex['marketPrice']).setValue(marketPrice);
    sh.getRange(row, colIndex['profitLoss']).setValue(profitLoss);
    sh.getRange(row, colIndex['status']).setValue('সম্পন্ন');
  }

  logSync_('submitFollowUp step' + step, body.formNo, body.deviceId);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 *  BULK SYNC — replays a queue of offline actions in order, atomically
 *  per item (one failure doesn't block the rest); returns per-item result
 *  so the client can drop only the successfully-synced items from its
 *  IndexedDB queue.
 * ------------------------------------------------------------------ */

function syncBatch_(items) {
  const results = [];
  items.forEach(function (item) {
    try {
      let r;
      if (item.action === 'submitFarmer') r = submitFarmer_(item.payload);
      else if (item.action === 'submitFollowUp') r = submitFollowUp_(item.payload);
      else if (item.action === 'addLocation') r = addLocation_(item.payload);
      else r = { ok: false, message: 'অজানা অ্যাকশন' };
      results.push({ localId: item.localId, ok: r.ok !== false, result: r });
    } catch (err) {
      results.push({ localId: item.localId, ok: false, message: err.message });
    }
  });
  return { results: results };
}

/* ------------------------------------------------------------------ *
 *  MIS / REPORTS (Module 3)
 * ------------------------------------------------------------------ */

function getFarmers_(params) {
  let out = sheetToObjects_(SHEET_FARMERS);
  out = scopeByRequester_(out, params);
  if (params.officerId) out = out.filter(f => String(f.officerId) === String(params.officerId));
  if (params.status) out = out.filter(f => f.status === params.status);
  if (params.crop) out = out.filter(f => f.cropName === params.crop);
  return { farmers: out };
}

// Applies each role's data scope: officer -> only their own entries,
// admin -> only their region, super_admin -> everything. If no
// requesterId is sent (e.g. first-run before roles existed), returns
// data unscoped so the app doesn't break — tighten this once every
// Employees row has a role assigned.
function scopeByRequester_(farmers, params) {
  if (!params.requesterId) return farmers;
  const emp = getEmployeeById_(params.requesterId);
  if (!emp) return farmers;
  if (emp.role === 'super_admin') return farmers;
  // An admin's "region" (set on their Employees row) is matched against
  // either the farmer's district or their registering office — whichever
  // your organization uses to define an admin's coverage area.
  if (emp.role === 'admin') return farmers.filter(f => f.district === emp.region || f.officeName === emp.officeName);
  return farmers.filter(f => String(f.officerId) === String(emp.id || emp.nid));
}

function getFarmerHistoryByNid_(nid) {
  const all = sheetToObjects_(SHEET_FARMERS);
  return { records: all.filter(f => String(f.nid) === String(nid)) };
}

function getDashboardStats_(params) {
  const all = scopeByRequester_(sheetToObjects_(SHEET_FARMERS), params || {});
  const totalFarmers = all.length;
  const totalLand = all.reduce((s, f) => s + (Number(f.landSize) || 0), 0);

  const seedByCrop = {};
  const profitByOfficer = {};
  const countByCrop = {};

  all.forEach(function (f) {
    const crop = f.cropName || 'অজানা';
    seedByCrop[crop] = (seedByCrop[crop] || 0) + (Number(f.seedQtyKg) || 0);
    countByCrop[crop] = (countByCrop[crop] || 0) + 1;

    const officer = f.officerName || 'অজানা';
    profitByOfficer[officer] = (profitByOfficer[officer] || 0) + (Number(f.profitLoss) || 0);
  });

  return {
    totalFarmers: totalFarmers,
    totalLand: totalLand,
    seedByCrop: seedByCrop,
    countByCrop: countByCrop,
    profitByOfficer: profitByOfficer
  };
}

function getOverdueFollowUps_(days, params) {
  const all = scopeByRequester_(sheetToObjects_(SHEET_FARMERS), params || {});
  const now = new Date();
  const overdue = all.filter(function (f) {
    if (f.status === 'সম্পন্ন') return false;
    const ref = f.lastFollowUpDate || f.regDate;
    if (!ref) return false;
    const diffDays = (now - new Date(ref)) / (1000 * 60 * 60 * 24);
    return diffDays > days;
  }).map(function (f) {
    const ref = f.lastFollowUpDate || f.regDate;
    const diffDays = Math.floor((now - new Date(ref)) / (1000 * 60 * 60 * 24));
    return {
      formNo: f.formNo, farmerName: f.farmerName, officerName: f.officerName,
      village: f.village, daysSince: diffDays
    };
  }).sort((a, b) => b.daysSince - a.daysSince);
  return { overdue: overdue };
}

function getMapData_(params) {
  const all = scopeByRequester_(sheetToObjects_(SHEET_FARMERS), params || {});
  return {
    farmers: all.filter(f => f.gpsLat && f.gpsLng).map(function (f) {
      return {
        formNo: f.formNo, name: f.farmerName, officerName: f.officerName,
        cropName: f.cropName, lat: Number(f.gpsLat), lng: Number(f.gpsLng),
        status: f.status
      };
    })
  };
}

/* ------------------------------------------------------------------ *
 *  HELPERS
 * ------------------------------------------------------------------ */

function sheetToObjects_(sheetName) {
  const sh = SS.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const header = values.shift();
  return values.map(function (row) {
    const obj = {};
    header.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function ensureHeader_(sh, columns) {
  if (sh.getLastRow() === 0) {
    sh.appendRow(columns);
  }
}

function findRowByValue_(sh, colName, value) {
  if (sh.getLastRow() < 2) return null;
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const idx = header.indexOf(colName);
  if (idx === -1) return null;
  const values = sh.getRange(2, idx + 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value)) return i + 2; // sheet row number
  }
  return null;
}

function writeRecordRow_(sh, record, columns, existingRow) {
  const rowValues = columns.map(c => record[c] !== undefined ? record[c] : '');
  if (existingRow) {
    sh.getRange(existingRow, 1, 1, columns.length).setValues([rowValues]);
  } else {
    sh.appendRow(rowValues);
  }
}

function saveBase64Image_(base64Data, fileName) {
  const folder = getOrCreatePhotoFolder_();
  const matches = base64Data.match(/^data:(image\/\w+);base64,(.+)$/);
  const mime = matches ? matches[1] : 'image/jpeg';
  const data = matches ? matches[2] : base64Data;
  const blob = Utilities.newBlob(Utilities.base64Decode(data), mime, fileName + '.jpg');
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?id=' + file.getId();
}

function getOrCreatePhotoFolder_() {
  const it = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

function logSync_(action, formNo, deviceId) {
  const sh = SS.getSheetByName(SHEET_SYNCLOG);
  if (!sh) return;
  sh.appendRow([new Date().toISOString(), action, formNo, deviceId || '']);
}
