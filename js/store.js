/**
 * StudyFlow – store.js
 * Tiny promise wrapper around IndexedDB (local, on-device storage).
 *   kv     → the encrypted vault (tasks, modules, settings…)
 *   photos → each camera photo encrypted separately, so saving a task does not
 *            re-encrypt every image (keeps writes fast and memory use low).
 */

const DB_NAME = 'studyflow';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked by another tab'));
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

export const get = (store, key) => tx(store, 'readonly', s => s.get(key));
export const put = (store, key, value) => tx(store, 'readwrite', s => { s.put(value, key); });
export const del = (store, key) => tx(store, 'readwrite', s => { s.delete(key); });
export const keys = (store) => tx(store, 'readonly', s => s.getAllKeys());
export const clear = (store) => tx(store, 'readwrite', s => { s.clear(); });

export async function wipeAll() {
  await clear('kv');
  await clear('photos');
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch { return false; }
}

export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}
