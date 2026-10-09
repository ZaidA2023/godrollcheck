// Public definition transport is independent of credentials and player snapshot writes.
import {loadPublicTable, savePublicTable} from './storage.js';
import {mapLimit} from './bungie.js';
export const TYPES = ['DestinyInventoryItemDefinition','DestinyInventoryBucketDefinition','DestinySocketTypeDefinition','DestinyStatDefinition','DestinyPlugSetDefinition'];
export const LIMITS = Object.freeze({body:256*1024*1024,record:2*1024*1024,depth:64,retained:64*1024*1024,deadline:60000});
const encoder = new TextEncoder();
const plain = value => !!value && typeof value === 'object' && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const validHash = hash => /^(0|[1-9]\d{0,9})$/.test(String(hash)) && Number(hash) <= 4294967295;
export function sourcePath(manifest,type) {
  const path = manifest?.jsonWorldComponentContentPaths?.en?.[type];
  return TYPES.includes(type) && typeof path === 'string' && new RegExp(`^/common/destiny2_content/json/en/${type}-[A-Za-z0-9_-]+\\.json$`).test(path) ? path : null;
}
export function trimDefinition(type, definition) {
  if (type !== TYPES[0]) return definition;
  const fields = ['hash','redacted','displayProperties','inventory','itemType','itemSubType','itemTypeDisplayName','sockets','plug','investmentStats'];
  const pick = (value, keys) => plain(value) ? Object.fromEntries(keys.filter(key => Object.hasOwn(value,key)).map(key => [key,value[key]])) : value;
  const result=pick(definition,fields);
  // Nested pruning preserves absence/malformed values and every ownership gate.
  if (Object.hasOwn(result,'displayProperties')) result.displayProperties=pick(result.displayProperties,['name','icon']);
  if (Object.hasOwn(result,'inventory')) result.inventory=pick(result.inventory,['bucketTypeHash','tierType']);
  if (Object.hasOwn(result,'plug')) result.plug=pick(result.plug,['plugCategoryIdentifier','plugCategoryHash','insertionRules','enabledRules','isDummyPlug','insertionMaterialRequirementHash','enabledMaterialRequirementHash']);
  if (Object.hasOwn(result,'sockets')) {
    result.sockets=pick(result.sockets,['socketEntries']);
    if (Array.isArray(result.sockets?.socketEntries)) result.sockets.socketEntries=result.sockets.socketEntries.map(entry=>{
      const value=pick(entry,['socketTypeHash','singleInitialItemHash','plugSources','randomizedPlugSetHash','reusablePlugSetHash','reusablePlugItems']);
      // Keep crafting/rule presence exactly: missing evidence cannot become approval.
      if (Array.isArray(value?.reusablePlugItems)) value.reusablePlugItems=value.reusablePlugItems.map(plug=>pick(plug,['plugItemHash','currentlyCanRoll','craftingRequirements']));
      return value;
    });
  }
  if (Array.isArray(result.investmentStats)) result.investmentStats=result.investmentStats.map(stat=>pick(stat,['statTypeHash','value']));
  return result;
}
export function validDefinition(definition,hash) {
  return plain(definition) && validHash(hash) && String(definition.hash) === String(hash) && !definition.redacted;
}
function validCachedDefinition(type,definition,hash,allowLegacyMissingRarity=false) {
  if (!validDefinition(definition,hash)) return false;
  if (type !== TYPES[0] || Number(definition.itemType) !== 3) return true;
  const inventory=definition.inventory;
  // Legacy API records retain identity-only compatibility; new public records need rarity.
  if (allowLegacyMissingRarity && (inventory === undefined || (plain(inventory) && !Object.hasOwn(inventory,'tierType')))) return true;
  return definition.itemType === 3 && plain(inventory) && Number.isInteger(inventory.tierType) && inventory.tierType >= 1 && inventory.tierType <= 6;
}
export function validEntry(entry,version,type,hash,path) {
  return plain(entry) && TYPES.includes(type) && entry.version === version && entry.language === 'en' && entry.type === type &&
    entry.hash === String(hash) && entry.key === `${version}/en/${type}/${hash}` &&
    (entry.sourcePath === undefined || (path !== null && entry.sourcePath === path)) && validCachedDefinition(type,entry.definition,hash,entry.sourcePath === undefined);
}
function record(version,type,hash,definition,path) {
  return {key:`${version}/en/${type}/${hash}`,version,language:'en',type,hash:String(hash),definition:trimDefinition(type,definition),...(path ? {sourcePath:path} : {})};
}
// The scanner retains at most one raw object, never the decoded table body.
export async function parseTable(reader,type,{signal,limits=LIMITS}={}) {
  const decoder = new TextDecoder('utf-8',{fatal:true}), definitions = Object.create(null), seen = new Set();
  let phase='start', key='', raw='', stack=[], quoted=false, escaped=false, bodyBytes=0, retainedBytes=2, count=0, recordBytes=0;
  function consume(text) {
    for (const ch of text) {
      if (phase === 'record') {
        // Count decoded UTF-8 bytes while retaining this one balanced object.
        raw += ch;
        const cp=ch.codePointAt(0); recordBytes+=cp<=0x7f ? 1 : cp<=0x7ff ? 2 : cp<=0xffff ? 3 : 4;
        if (recordBytes > limits.record) throw new Error('Public definition record too large.');
        // Inside strings, escaped quotes and braces cannot change structural depth.
        if (quoted) { if (escaped) escaped=false; else if (ch === '\\') escaped=true; else if (ch === '"') quoted=false; }
        else if (ch === '"') quoted=true;
        else if (ch === '{' || ch === '[') { stack.push(ch); if (stack.length + 1 > limits.depth) throw new Error('Public definition nesting too deep.'); }
        else if (ch === '}' || ch === ']') {
          if (stack.pop() !== (ch === '}' ? '{' : '[')) throw new Error('Mismatched public definition nesting.');
          if (!stack.length) {
            // JSON.parse validates only a completed record, never a partial table.
            if (encoder.encode(raw).byteLength > limits.record) throw new Error('Public definition record too large.');
            const definition=JSON.parse(raw); raw='';
            if (!plain(definition) || String(definition.hash) !== key) throw new Error('Public definition hash mismatch.');
            // Redacted or rarity-incomplete rows cannot fill required hashes; API fallback can.
            if (validCachedDefinition(type,definition,key)) {
              const trimmed=trimDefinition(type,definition);
              retainedBytes += encoder.encode(JSON.stringify(key)+':'+JSON.stringify(trimmed)).byteLength + (count++ ? 1 : 0);
              if (retainedBytes > limits.retained) throw new Error('Public table exceeds retained budget.');
              definitions[key]=trimmed;
            }
            // Finishing a row still requires an explicit separator or the root's final brace.
            phase='separator';
          }
        }
        continue;
      }
      // Outside records only the top-level object's strict key/separator grammar is legal.
      if (/^[\t\n\r ]$/.test(ch) && phase !== 'key') continue;
      if (phase === 'start' && ch === '{') phase='first';
      else if ((phase === 'first' || phase === 'next') && ch === '"') { key=''; phase='key'; }
      else if (phase === 'first' && ch === '}') phase='done';
      else if (phase === 'key' && /[0-9]/.test(ch)) { key+=ch; if (key.length>10) throw new Error('Invalid public hash.'); }
      else if (phase === 'key' && ch === '"') {
        if (!validHash(key) || seen.has(key)) throw new Error('Invalid or duplicate public hash.');
        seen.add(key); phase='colon';
      }
      // After each numeric key require a colon and an object, then comma or final brace.
      else if (phase === 'colon' && ch === ':') phase='value';
      else if (phase === 'value' && ch === '{') { if (limits.depth < 2) throw new Error('Public definition nesting too deep.'); raw='{'; recordBytes=1; stack=['{']; quoted=false; escaped=false; phase='record'; }
      else if (phase === 'separator' && ch === ',') phase='next';
      else if (phase === 'separator' && ch === '}') phase='done';
      else throw new Error('Malformed public definition table.');
    }
  }
  // Cancellation around every read prevents a late chunk from publishing a table.
  while (true) {
    signal?.throwIfAborted();
    const {done,value}=await reader.read();
    signal?.throwIfAborted();
    if (done) break;
    // Fatal streaming decode preserves split code points and rejects invalid encoding.
    bodyBytes+=value.byteLength;
    if (bodyBytes>limits.body) throw new Error('Public table body too large.');
    consume(decoder.decode(value,{stream:true}));
  }
  // Flush pending UTF-8 bytes and demand a finished root before returning any cache.
  consume(decoder.decode());
  if (phase !== 'done') throw new Error('Incomplete public definition table.');
  return {definitions,bytes:retainedBytes};
}
export async function downloadTable(path,type,{signal,fetchImpl=globalThis.fetch,limits=LIMITS}={}) {
  if (sourcePath({jsonWorldComponentContentPaths:{en:{[type]:path}}},type) !== path || !path) throw new Error('Unsafe public definition path.');
  signal?.throwIfAborted();
  const controller=new AbortController(), expiresAt=Date.now()+limits.deadline; let reader;
  const cancelReader=() => { if (reader) Promise.resolve(reader.cancel(controller.signal.reason)).catch(()=>{}); };
  const abort=()=>controller.abort(signal.reason);
  signal?.addEventListener('abort',abort,{once:true});
  controller.signal.addEventListener('abort',cancelReader,{once:true});
  const timer=setTimeout(()=>controller.abort(new Error('Public table timed out.')),limits.deadline);
  // Race the entire operation so an unresponsive header/body cannot outlive its deadline.
  let rejectAbort;
  const interrupted=new Promise((_,reject)=>{ rejectAbort=()=>reject(controller.signal.reason); controller.signal.addEventListener('abort',rejectAbort,{once:true}); });
  try {
    const work=(async()=>{
      const response=await fetchImpl('https://www.bungie.net'+path,{method:'GET',credentials:'omit',mode:'cors',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
      controller.signal.throwIfAborted();
      if (!response.ok || response.redirected || !response.body?.getReader) throw new Error('Public table unavailable.');
      reader=response.body.getReader();
      return await parseTable(reader,type,{signal:controller.signal,limits});
    })();
    const result=await Promise.race([work,interrupted]); signal?.throwIfAborted();
    if (Date.now() >= expiresAt) throw new Error('Public table timed out.');
    return result;
  } catch(error) { signal?.throwIfAborted(); throw error; }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort',abort);
    controller.signal.removeEventListener('abort',rejectAbort); controller.signal.removeEventListener('abort',cancelReader);
    if (reader) Promise.resolve(reader.cancel()).catch(()=>{});
  }
}
// Cache reads are untrusted: verify every row and the same serialized UTF-8 budget.
function cachedTable(value,version,type,path,limits) {
  if (!plain(value) || value.schema !== 1 || value.version !== version || value.language !== 'en' || value.type !== type || value.sourcePath !== path || !plain(value.definitions)) return null;
  let bytes=2, count=0;
  const definitions=value.definitions;
  for (const [hash,definition] of Object.entries(definitions)) {
    if (!validDefinition(definition,hash)) return null;
    bytes+=encoder.encode(JSON.stringify(hash)+':'+JSON.stringify(definition)).byteLength+(count++ ? 1 : 0);
    if (bytes>limits.retained) return null;
  }
  // Reuse the incoming map: rebuilding a second full table would double peak references.
  // An unused test weapon without rarity must not invalidate the rest of a warm table.
  bytes=2; count=0;
  for (const hash of Object.keys(definitions)) {
    if (!validCachedDefinition(type,definitions[hash],hash)) { delete definitions[hash]; continue; }
    const trimmed=trimDefinition(type,definitions[hash]);
    bytes+=encoder.encode(JSON.stringify(hash)+':'+JSON.stringify(trimmed)).byteLength+(count++ ? 1 : 0);
    definitions[hash]=trimmed;
  }
  return {definitions,bytes};
}
export function createDefinitionLoader({manifest,client,signal,onProgress,entries=[],readTable=loadPublicTable,writeTable=savePublicTable,fetchImpl=globalThis.fetch,limits=LIMITS}) {
  const version=manifest.version, definitions=new Map(), saved=new Map(), tables=new Map(), failed=new Set();
  let retained=0, reserved=0, gate=Promise.resolve();
  for (const entry of entries) {
    if (validEntry(entry,version,entry?.type,entry?.hash,sourcePath(manifest,entry?.type))) {
      const key=`${entry.type}/${entry.hash}`;
      // Conflicting historical keys cannot pick a winner by array order.
      if (saved.has(key)) saved.set(key,null); else saved.set(key,entry);
    }
  }
  async function table(type,missing) {
    const path=sourcePath(manifest,type); if (!path) return null;
    if (tables.has(type)) { const value=tables.get(type); tables.delete(type); tables.set(type,value); return value; }
    // A miss can bring in a full-budget table: drop older references before yielding.
    // Serial batches make this a single reservation, including the persistent write.
    tables.clear(); retained=0; reserved=limits.retained;
    try {
      let value;
      try { signal?.throwIfAborted(); value=await readTable(type,{signal}); signal?.throwIfAborted(); value=cachedTable(value,version,type,path,limits); }
      catch { signal?.throwIfAborted(); value=null; }
      if (!value && missing>=12 && !failed.has(type)) {
        try {
          signal?.throwIfAborted(); value=await downloadTable(path,type,{signal,fetchImpl,limits}); signal?.throwIfAborted();
          try {
            signal?.throwIfAborted();
            await writeTable({schema:1,version,language:'en',type,sourcePath:path,definitions:value.definitions},{signal});
            signal?.throwIfAborted();
          } catch { signal?.throwIfAborted(); /* Optional public caching cannot block a complete import. */ }
        } catch { signal?.throwIfAborted(); failed.add(type); value=null; }
      }
      if (value) { tables.set(type,value); retained=value.bytes; }
      return value;
    } finally { reserved=0; }
  }
  async function batch(type,hashes) {
    signal?.throwIfAborted();
    const path=sourcePath(manifest,type), missing=[];
    for (const hash of new Set(hashes.filter(Boolean).map(String))) {
      const key=`${type}/${hash}`;
      if (definitions.has(key)) continue;
      const entry=saved.get(key);
      if (entry) definitions.set(key,record(version,type,hash,entry.definition,path)); else missing.push(hash);
    }
    if (!missing.length) return;
    const bulk=await table(type,missing.length); signal?.throwIfAborted();
    const fallback=[];
    for (const hash of missing) {
      const definition=bulk?.definitions[hash];
      if (validDefinition(definition,hash)) definitions.set(`${type}/${hash}`,record(version,type,hash,definition,path)); else fallback.push(hash);
    }
    // The existing client continues to own request concurrency, pacing and retries.
    await mapLimit(fallback,async hash=>{
      const definition=await client.request(`/Platform/Destiny2/Manifest/${type}/${hash}/`); signal?.throwIfAborted();
      if (!validDefinition(definition,hash)) throw new Error(`Incomplete inventory: required definition ${hash} unavailable.`);
      definitions.set(`${type}/${hash}`,record(version,type,hash,definition,path));
      onProgress?.({phase:'definitions',resolved:definitions.size,attempts:client.attempts,message:`Resolved ${definitions.size} definitions.`});
    });
  }
  return {definitions,
    // Account for table references plus the maximum incoming table, not heap/GC timing.
    get retainedTableBytes() { return retained; },
    get reservedTableBytes() { return reserved; },
    resolveBatch(type,hashes) {
      // Serial batches also serialize bulk downloads, including concurrent callers.
      const result=gate.then(()=>batch(type,hashes)); gate=result.catch(()=>{}); return result;
    }};
}
