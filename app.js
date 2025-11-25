// ==== CONFIG – set these for your org ====
const SF_INSTANCE_URL = 'https://yourInstance.my.salesforce.com';
const SF_ATTENDANCE_ENDPOINT = '/services/apexrest/AttendanceSync/';
const SF_GIRLS_QUERY =
  "/services/data/v61.0/query/?q=" +
  encodeURIComponent("SELECT Id, Name FROM Girls__c ORDER BY Name");
// You’ll need to obtain an OAuth access token and store here or in localStorage.
let accessToken = null;

// =======================
// IndexedDB setup
// =======================
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('AttendanceDB', 1);

    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('pendingAttendance')) {
        db.createObjectStore('pendingAttendance', { keyPath: 'localId' });
      }
    };

    request.onsuccess = event => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = event => reject(event.target.error);
  });
}

function savePending(attendance) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingAttendance', 'readwrite');
    const store = tx.objectStore('pendingAttendance');
    store.put(attendance);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getAllPending() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingAttendance', 'readonly');
    const store = tx.objectStore('pendingAttendance');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function deletePending(localId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingAttendance', 'readwrite');
    const store = tx.objectStore('pendingAttendance');
    store.delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// =======================
// Salesforce helpers
// =======================
async function sfFetch(path, options = {}) {
  if (!accessToken) {
    throw new Error('Missing access token – implement OAuth login flow.');
  }

  const res = await fetch(SF_INSTANCE_URL + path, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res;
}

// Fetch girls from SF when online
async function loadGirls() {
  if (!navigator.onLine) {
    setStatus('Offline – can’t refresh girls list.');
    return;
  }
  try {
    const res = await sfFetch(SF_GIRLS_QUERY);
    const data = await res.json();
    const select = document.getElementById('girlSelect');
    select.innerHTML = '';
    data.records.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.Id;
      opt.textContent = r.Name;
      select.appendChild(opt);
    });
  } catch (e) {
    console.error(e);
    setStatus('Error loading girls: ' + e.message);
  }
}

// =======================
// Sync logic
// =======================
let syncRunning = false;

async function syncPending() {
  if (!navigator.onLine) return;
  if (syncRunning) return;
  syncRunning = true;

  try {
    const pending = await getAllPending();
    if (!pending.length) {
      setStatus('No offline changes to sync.');
      syncRunning = false;
      return;
    }

    const payload = {
      records: pending.map(p => ({
        localId: p.localId,
        girlId: p.girlId,
        monthName: p.monthName,
        week1: p.week1,
        week2: p.week2,
        week3: p.week3,
        week4: p.week4,
        week5: p.week5
      }))
    };

    const res = await sfFetch(SF_ATTENDANCE_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const resp = await res.json();

    for (const r of resp) {
      if (r.status === 'SUCCESS') {
        await deletePending(r.localId);
      }
    }

    setStatus('Synced ' + resp.filter(r => r.status === 'SUCCESS').length + ' record(s).');

  } catch (e) {
    console.error(e);
    setStatus('Sync error: ' + e.message);
  } finally {
    syncRunning = false;
  }
}

// =======================
// UI logic
// =======================
function initWeeksTable() {
  const tbody = document.getElementById('weeksBody');
  tbody.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const tr = document.createElement('tr');
    const tdWeek = document.createElement('td');
    tdWeek.textContent = 'Week ' + i;
    const tdPresent = document.createElement('td');

    const select = document.createElement('select');
    select.dataset.week = String(i);
    ['','Present','Absent','Holiday'].forEach(v => {
      const opt = document.createElement('option');
      opt.value = v || '';
      opt.textContent = v || '--select--';
      select.appendChild(opt);
    });

    tdPresent.appendChild(select);
    tr.appendChild(tdWeek);
    tr.appendChild(tdPresent);
    tbody.appendChild(tr);
  }
}

function getWeekValues() {
  const selects = document.querySelectorAll('#weeksBody select');
  const weeks = {};
  selects.forEach(sel => {
    const w = sel.dataset.week;
    // store as 1/0 or custom encoding
    weeks['week' + w] = sel.value === 'Present' ? 1 : (sel.value ? 0 : null);
  });
  return weeks;
}

function setStatus(msg) {
  document.getElementById('statusText').textContent = msg;
}

// Save button handler
async function handleSave() {
  const girlId = document.getElementById('girlSelect').value;
  const monthValue = document.getElementById('monthInput').value; // "2025-01"

  if (!girlId || !monthValue) {
    setStatus('Select Girl and Month first.');
    return;
  }

  const weekVals = getWeekValues();

  const localId = 'loc-' + Date.now();

  const record = {
    localId,
    girlId,
    monthName: monthValue,
    ...weekVals
  };

  try {
    await savePending(record);
    setStatus('Saved offline. Will sync when online.');
    // Optionally try immediate sync if online:
    if (navigator.onLine) {
      syncPending();
    }
  } catch (e) {
    console.error(e);
    setStatus('Error saving locally: ' + e.message);
  }
}

// =======================
// App bootstrap
// =======================
async function init() {
  await openDB();
  initWeeksTable();
  setStatus(navigator.onLine ? 'Online' : 'Offline');

  // TODO: implement getting access token and saving it
  // accessToken = '...';

  if (navigator.onLine) {
    loadGirls();
    syncPending();
  }

  document.getElementById('saveBtn').addEventListener('click', handleSave);
  window.addEventListener('online', () => {
    setStatus('Back online. Syncing…');
    loadGirls();
    syncPending();
  });
  window.addEventListener('offline', () => setStatus('Offline'));
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js');
}

window.addEventListener('load', init);
