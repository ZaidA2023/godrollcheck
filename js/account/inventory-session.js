// Tab-session evidence contains identities and observation metadata, never item data.
const KEY = 'loadout.inventory-session.v1';
const fallback = new Map();
const failedStores = new WeakMap();
const LIMIT = 5000;
const idValid = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const accountValid = value => typeof value === 'string' && /^[1-6]:\d{1,20}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numericId = (a,b) => a.length-b.length || a.localeCompare(b,'en');
function defaultStorage() {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}
function validEvidence(value, account) {
  // Bind the supported evidence schema to its account before trusting chronology.
  return plain(value) && value.schema === 1 && value.account === account &&
    Number.isFinite(value.timestamp) && value.timestamp >= 0 &&
    Number.isSafeInteger(value.nextSequence) && value.nextSequence > 0 &&
    // Bounded unique IDs prevent corrupt ownership or duplicate discovery markers.
    Array.isArray(value.baseline) && value.baseline.length <= LIMIT &&
    value.baseline.every(idValid) && new Set(value.baseline).size === value.baseline.length &&
    Array.isArray(value.markers) && value.markers.length <= LIMIT &&
    new Set(value.markers.map(marker => marker?.id)).size === value.markers.length &&
    // Each marker belongs to an allocated batch strictly before the next sequence.
    value.markers.every(marker => plain(marker) && idValid(marker.id) &&
      Number.isFinite(marker.time) && marker.time >= 0 && Number.isSafeInteger(marker.sequence) &&
      marker.sequence > 0 && marker.sequence < value.nextSequence);
}
function weaponIds(snapshot) {
  if (!accountValid(snapshot?.accountKey) || !Array.isArray(snapshot.items) ||
      !Number.isFinite(Date.parse(snapshot.responseMintedTimestamp))) return null;
  const ids = snapshot.items.filter(item => Number(item?.itemType) === 3 && item.instanceId != null)
    .map(item => item.instanceId);
  return ids.every(idValid) && new Set(ids).size === ids.length ? ids.sort(numericId) : null;
}
export function createInventorySession({storage = defaultStorage()} = {}) {
  const storageObject = storage && (typeof storage === 'object' || typeof storage === 'function');
  let accounts = new Map(), memoryOnly = !storageObject;
  // Reuse evidence after quota failure, even when reading the old stored value works.
  if (storageObject && failedStores.has(storage)) {
    accounts = new Map(failedStores.get(storage)); memoryOnly = true;
  } else if (!storageObject) accounts = new Map(fallback);
  else {
    let raw;
    try { raw = storage.getItem(KEY); }
    catch { memoryOnly = true; }
    if (!memoryOnly) {
      // Corrupt evidence resets; it must not resurrect unrelated fallback history.
      try {
        const parsed = raw == null ? [] : JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length > 10) throw new Error('Invalid session partitions');
        for (const value of parsed) {
          if (!accountValid(value?.account) || accounts.has(value.account)) throw new Error('Invalid account');
          if (validEvidence(value,value.account)) accounts.set(value.account,value);
        }
      } catch { accounts = new Map(); }
    }
  }
  function persist() {
    // Evict whole least-recently-observed partitions, never arbitrary discovery rows.
    // Returning to an evicted account establishes a fresh baseline and empty feed.
    while (accounts.size > 10) accounts.delete(accounts.keys().next().value);
    if (!memoryOnly) {
      try { storage.setItem(KEY,JSON.stringify([...accounts.values()])); return; }
      catch { memoryOnly = true; }
    }
    if (storageObject) failedStores.set(storage,new Map(accounts));
    else {
      fallback.clear();
      for (const [account,value] of accounts) fallback.set(account,value);
    }
  }
  function baseline(snapshot,ids,timestamp) {
    return {schema:1,account:snapshot.accountKey,baseline:ids,timestamp,markers:[],nextSequence:1};
  }
  function observe(snapshot,{committed=false}={}) {
    const ids = weaponIds(snapshot);
    if (!ids) return;
    const account = snapshot.accountKey, timestamp = Date.parse(snapshot.responseMintedTimestamp);
    // Oversized ownership cannot establish a safely bounded baseline.
    if (ids.length > LIMIT) { accounts.delete(account); persist(); return; }
    let evidence = accounts.get(account);
    if (!validEvidence(evidence,account)) evidence = baseline(snapshot,ids,timestamp);
    else if (timestamp > evidence.timestamp) {
      const previous = new Set(evidence.baseline), marked = new Set(evidence.markers.map(marker => marker.id));
      const added = committed ? ids.filter(id => !previous.has(id) && !marked.has(id)) : [];
      if (evidence.markers.length + added.length > LIMIT || evidence.nextSequence >= Number.MAX_SAFE_INTEGER) {
        evidence = baseline(snapshot,ids,timestamp);
      } else {
        const time = Date.now(), sequence = evidence.nextSequence;
        evidence = {...evidence,baseline:ids,timestamp,
          markers:[...evidence.markers,...added.map(id => ({id,time,sequence}))],
          nextSequence:sequence + (added.length ? 1 : 0)};
      }
    }
    // Equal/older responses keep baseline, markers and chronology intact.
    accounts.delete(account); accounts.set(account,evidence); persist();
  }
  function entries(snapshot,gradedEntries) {
    const ids = weaponIds(snapshot), evidence = accounts.get(snapshot?.accountKey);
    if (!ids || !validEvidence(evidence,snapshot.accountKey)) return [];
    const owned = new Set(ids), markers = new Map(evidence.markers.map(marker => [marker.id,marker]));
    return gradedEntries.filter(entry => Number(entry.item?.itemType) === 3 &&
      owned.has(entry.item.instanceId) && markers.has(entry.item.instanceId)).slice().sort((a,b) =>
      markers.get(b.item.instanceId).sequence-markers.get(a.item.instanceId).sequence ||
      String(a.item.name ?? '').localeCompare(String(b.item.name ?? ''),'en') ||
      numericId(a.item.instanceId,b.item.instanceId));
  }
  function clear(account) { accounts.delete(account); persist(); }
  return {observe,entries,clear};
}
