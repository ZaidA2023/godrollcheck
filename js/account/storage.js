// Account snapshots, cache entries and selection commit in one IndexedDB transaction.
import {getSession, selectAccount, operationSignal, savedSnapshotEpoch, withConnectionLock} from './auth.js';
const DB_NAME = 'endgame-loadout', VERSION = 1;
function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('Local inventory storage is unavailable in this browser.'));
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('snapshots', {keyPath:'accountKey'});
      db.createObjectStore('definitions', {keyPath:'key'});
      // The pointer is stored locally and never represents a Bungie credential.
      db.createObjectStore('local', {keyPath:'key'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open saved inventory. Check browser storage permissions.'));
    request.onblocked = () => reject(new Error('Close other inventory tabs to update local storage.'));
  });
}
// Invalid saved data produces an actionable error without silently deleting it.
export function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.accountKey !== `${snapshot.membershipType}:${snapshot.membershipId}` || !/^\d+$/.test(snapshot.membershipId) || ![1,2,3,4,5,6].includes(snapshot.membershipType) || !Array.isArray(snapshot.characters) || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.currencies) || !snapshot.manifestVersion || !Array.isArray(snapshot.definitions) || snapshot.completeness?.complete !== true || !Number.isFinite(Date.parse(snapshot.responseMintedTimestamp)) || !Number.isFinite(Date.parse(snapshot.savedAt))) throw new Error('Saved inventory schema is invalid. Import again or clear this saved account.');
  const ids = new Set();
  for (const item of snapshot.items) {
    if (item.instanceId != null && (typeof item.instanceId !== 'string' || ids.has(item.instanceId))) throw new Error('Saved inventory contains invalid or duplicated instances.');
    if (item.instanceId) ids.add(item.instanceId);
  }
  for (const entry of snapshot.definitions) if (entry.version !== snapshot.manifestVersion || entry.language !== 'en' || entry.key !== `${entry.version}/${entry.language}/${entry.type}/${entry.hash}` || !entry.definition) throw new Error('Saved definition version is invalid. Import again.');
  return snapshot;
}
// This checksum detects corrupted snapshot content independently of the workbook audit.
async function digest(snapshot) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
async function read(store, key) {
  const db = await open();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not read saved inventory.'));
  // Close the connection on read failure as well as success.
  }); } finally { db.close(); }
}
// Invalid historical evidence disables only the new-weapons baseline, not current inventory.
async function withPreviousRefresh(snapshot, previous) {
  let previousRefresh = null;
  try {
    if (previous) {
      const prior = validateSnapshot(previous.snapshot);
      if (prior.accountKey === snapshot.accountKey && Date.parse(prior.responseMintedTimestamp) <= Date.parse(snapshot.responseMintedTimestamp) && previous.integritySha256 && await digest(prior) === previous.integritySha256) {
        previousRefresh = {savedAt:prior.savedAt,weaponInstanceIds:prior.items.filter(item => Number(item.itemType) === 3 && typeof item.instanceId === 'string' && item.instanceId).map(item => item.instanceId)};
      }
    }
  } catch { /* A malformed baseline must not turn a committed save into an apparent failure. */ }
  return {...snapshot,previousRefresh};
}
export async function loadSnapshot(accountKey) {
  if (accountKey === undefined) {
    const session = getSession();
    // A new/ambiguous connection hides the old pointer until deliberate selection.
    accountKey = session ? session.selectedAccount : (await read('local','selectedAccount'))?.value;
  }
  if (!accountKey) return null;
  const record = await read('snapshots', accountKey); if (!record) return null;
  validateSnapshot(record.snapshot);
  if (!record.integritySha256 || await digest(record.snapshot) !== record.integritySha256) throw new Error('Saved inventory fingerprint is invalid. Import again or clear this saved account.');
  return withPreviousRefresh(record.snapshot,record.previous);
}
export async function saveSnapshot(snapshot, {signal} = {}) {
  const connectionEpoch=savedSnapshotEpoch(snapshot);
  // Clone before yielding so caller mutations cannot diverge snapshot/cache content.
  snapshot = structuredClone(validateSnapshot(snapshot));
  // Derived browsing metadata is never hashed into snapshots or recursively retained.
  delete snapshot.previousRefresh;
  const operation = operationSignal(signal);
  let db, previous = null;
  try {
    operation.signal.throwIfAborted();
    const integritySha256 = await digest(snapshot);
    // Cancellation may arrive during hashing or opening the database.
    operation.signal.throwIfAborted();
    db = await open();
    operation.signal.throwIfAborted();
    await withConnectionLock(connectionEpoch,()=>new Promise((resolve, reject) => {
      operation.assertCurrent();
      const tx = db.transaction(['snapshots','definitions','local'], 'readwrite');
      let failure;
      const cancel = () => { failure = operation.signal.reason; tx.abort(); };
      operation.signal.addEventListener('abort',cancel,{once:true});
      const release = () => operation.signal.removeEventListener('abort',cancel);
      tx.oncomplete = () => { release(); resolve(); };
      // Failed or aborted writes cannot claim Saved or leave partial cache entries.
      tx.onabort = tx.onerror = () => { release(); reject(failure || new Error('Inventory could not be saved. The previous snapshot was retained.')); };
      // Cancellation aborts this transaction while preserving all previous account data.
      const snapshots = tx.objectStore('snapshots');
      const old = snapshots.get(snapshot.accountKey);
      // Freshness is checked inside the write transaction, including competing saves.
      old.onsuccess = () => {
        if (old.result && Date.parse(old.result?.snapshot?.responseMintedTimestamp) > Date.parse(snapshot.responseMintedTimestamp)) {
          failure = new Error('Bungie returned an older inventory. The newer saved snapshot was retained.'); tx.abort(); return;
        }
        // Every write belongs to the same transaction: no partial definition cache.
        // Keep exactly the previous committed current snapshot, never its history chain.
        previous = old.result ? {snapshot:old.result.snapshot,integritySha256:old.result.integritySha256} : null;
        snapshots.put({accountKey:snapshot.accountKey,snapshot,integritySha256,previous});
        for (const entry of snapshot.definitions) tx.objectStore('definitions').put(entry);
        tx.objectStore('local').put({key:'selectedAccount',value:snapshot.accountKey});
      };
    }),operation.signal);
    // Remember a successful explicit refresh for reload; this never resolves memberships.
    const session = getSession();
    if (!connectionEpoch && session?.kind!=='backend' && session?.memberships?.some(m => `${m.membershipType}:${m.membershipId}` === snapshot.accountKey)) await selectAccount(snapshot.accountKey);
    return await withPreviousRefresh(snapshot,previous);
  } finally { db?.close(); operation.dispose(); }
}
export async function listSnapshots() {
  const db = await open();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction('snapshots').objectStore('snapshots').getAll();
    request.onsuccess = () => resolve(request.result.map(({snapshot:s}) => ({accountKey:s.accountKey,membershipId:s.membershipId,membershipType:s.membershipType,savedAt:s.savedAt,responseMintedTimestamp:s.responseMintedTimestamp,characters:s.characters.length,items:s.items.length})));
    // Listing saved accounts never reads remote memberships.
    request.onerror = () => reject(new Error('Could not list saved accounts.'));
  }); } finally { db.close(); }
}
// Clear is deliberately account-scoped and independent of credential disconnection.
export async function clearSnapshot(accountKey) {
  if (!accountKey) throw new Error('Choose the saved account to clear.');
  const db = await open();
  try { await new Promise((resolve, reject) => {
    const tx = db.transaction(['snapshots','definitions','local'], 'readwrite');
    tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(new Error('Could not clear saved inventory.'));
    const snapshots = tx.objectStore('snapshots'); snapshots.delete(accountKey);
    const pointer = tx.objectStore('local').get('selectedAccount');
    pointer.onsuccess = () => { if (pointer.result?.value === accountKey) tx.objectStore('local').delete('selectedAccount'); };
    const remaining = snapshots.getAll();
    // Check remaining account references before deleting shared definition versions.
    remaining.onsuccess = () => {
      // Shared definitions survive clear while any remaining account references their version.
      const versions = new Set(remaining.result.map(r => r.snapshot.manifestVersion));
      const cursor = tx.objectStore('definitions').openCursor();
      cursor.onsuccess = () => { const row = cursor.result; if (!row) return; if (!versions.has(row.value.version)) row.delete(); row.continue(); };
    };
  }); } finally { db.close(); }
}
// Reads are version/language scoped; failed imports cannot write through this helper.
export async function loadDefinitions(version, language = 'en') {
  const db = await open();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction('definitions').objectStore('definitions').getAll();
    request.onsuccess = () => resolve(request.result.filter(d => d.version === version && d.language === language));
    request.onerror = () => reject(new Error('Could not read saved definitions.'));
  }); } finally { db.close(); }
}
