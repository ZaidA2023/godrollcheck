// Import is explicit and read-only; persistence belongs to the caller after validation.
import {createClient, PROFILE_COMPONENTS, mapLimit} from './bungie.js';
import {getSession, operationSignal, validateConfig} from './auth.js';
import {loadDefinitions, validateSnapshot} from './storage.js';
const ITEM = 'DestinyInventoryItemDefinition', BUCKET = 'DestinyInventoryBucketDefinition', SOCKET = 'DestinySocketTypeDefinition', STAT = 'DestinyStatDefinition', SET = 'DestinyPlugSetDefinition';
const FIELDS = ['perk1','perk2','barrel','mag','masterwork','originTrait'];
let importing = false;
function required(value, message) { if (!value) throw new Error(`Incomplete inventory: ${message}. Previous saved inventory is unchanged.`); return value; }
function itemsAt(component, label) { return required(Array.isArray(component?.items) && component.items, `${label} is unavailable`); }
function stringId(value, label) { return required(typeof value === 'string' && /^\d+$/.test(value) && value, `${label} must be a string ID`); }
export function collectContainers(profile) {
  // The profile character list defines required coverage for every character container.
  const ids = required(Array.isArray(profile.profile?.data?.characterIds) && profile.profile.data.characterIds, 'character list is unavailable').map(id => stringId(id,'character'));
  const characters = required(profile.characters?.data, 'characters are unavailable');
  required(ids.length === new Set(ids).size && Object.keys(characters).length === ids.length && ids.every(id => characters[id]), 'character coverage differs from profile');
  const containers = [{location:'vault',characterId:null,items:itemsAt(profile.profileInventory?.data,'vault')}];
  const currencies = itemsAt(profile.profileCurrencies?.data,'profile currencies');
  for (const id of ids) {
    containers.push({location:'character',characterId:id,items:itemsAt(profile.characterInventories?.data?.[id],`character ${id} inventory`)});
    containers.push({location:'equipment',characterId:id,items:itemsAt(profile.characterEquipment?.data?.[id],`character ${id} equipment`)});
  }
  // Profile currencies remain a separate container; never add them to item totals.
  return {ids,characters,containers,currencies};
}
// Only official HTTPS Bungie image URLs leave the local inventory view.
function iconUrl(path) {
  if (!path) return null;
  try { const url = new URL(path, 'https://www.bungie.net'); return url.origin === 'https://www.bungie.net' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
// A display label alone is insufficient: the socket whitelist must admit its category.
function category(plug, socketType) {
  const p = plug?.plug;
  if (!p || !socketType?.plugWhitelist?.some(entry => String(entry.categoryHash) === String(p.plugCategoryHash) || entry.categoryIdentifier === p.plugCategoryIdentifier)) return null;
  const c = p.plugCategoryIdentifier, type = plug.itemTypeDisplayName;
  if (['barrels','bowstrings','blades','scopes','frames'].includes(c) && /^(Enhanced )?(Barrel|Bowstring|Blade|Scope|Sight)$/.test(type) && (c !== 'frames' || type === 'Blade')) return 'barrel';
  if (['magazines','magazines_gl','arrows','batteries','guards'].includes(c) && /^(Enhanced )?(Magazine|Arrow|Battery|Guard)$/.test(type)) return 'mag';
  if (c === 'frames' && ['Trait','Enhanced Trait'].includes(type)) return 'trait';
  if (c === 'origins' && ['Origin Trait','Enhanced Origin Trait'].includes(type)) return 'originTrait';
  if (/^v\d+\.plugs\.weapons\.masterworks\.stat\./.test(c)) return 'masterwork';
  return null;
// Unrecognized or generic plug categories intentionally have no comparison field.
}
// Unsupported stat labels never become a guessed masterwork recommendation.
const MASTERWORK_STATS = new Set(['Reload Speed','Range','Handling','Stability','Charge Time','Draw Time','Impact']);
function plugValue(hash, def, state, lookup, role) {
  let name = def?.displayProperties?.name, resolved = !!name;
  if (role === 'masterwork') {
    const stats = (def?.investmentStats || []).filter(s => s.value !== 0).map(s => lookup(STAT,s.statTypeHash)?.displayProperties?.name);
    const unique = [...new Set(stats)];
    resolved = unique.length === 1 && MASTERWORK_STATS.has(unique[0]); name = resolved ? unique[0] : name;
  }
  return {plugHash:String(hash),name:name || 'Unknown plug',resolved,enhanced:/^Enhanced /.test(def?.itemTypeDisplayName || ''),...state};
}
// Only unconditional fixed roll sockets can use definition choices as owned options.
function fixedSocketRole(raw, entry, live, lookup) {
  const type = lookup(SOCKET,entry.socketTypeHash);
  if (!raw.itemInstanceId || !Number.isInteger(raw.state) || raw.state < 0 || (raw.state & 8) ||
      entry.randomizedPlugSetHash || type?.alwaysRandomizeSockets === true ||
      !Number.isInteger(entry.plugSources) || !(entry.plugSources & 2) ||
      live?.isEnabled !== true || live.isVisible !== true || !live.plugHash) return null;
  const inserted = category(lookup(ITEM,live.plugHash),type);
  const initial = category(lookup(ITEM,entry.singleInitialItemHash),type);
  return inserted && inserted !== 'masterwork' && (!initial || initial === inserted) ? inserted : null;
}
function fixedList(entry, lookup) {
  // Reusable sets contain fixed choices; randomized sets are never consulted here.
  const set = entry.reusablePlugSetHash ? lookup(SET,entry.reusablePlugSetHash) : null;
  return entry.reusablePlugSetHash ? set?.reusablePlugItems : entry.reusablePlugItems;
}
function fixedChoices(raw, entry, live, lookup) {
  const role = fixedSocketRole(raw,entry,live,lookup), list = fixedList(entry,lookup);
  if (!role || !Array.isArray(list) || !list.some(p => String(p.plugItemHash) === String(live.plugHash))) return [];
  const seen = new Set();
  // Rules or material costs mean availability needs runtime evidence, not a static guess.
  return list.filter(p => {
    const hash = p?.plugItemHash, def = lookup(ITEM,hash), plug = def?.plug;
    if (!Number.isInteger(hash) || hash <= 0 || hash > 4294967295 || seen.has(hash) ||
        p.currentlyCanRoll === false || p.craftingRequirements || category(def,lookup(SOCKET,entry.socketTypeHash)) !== role ||
        !Array.isArray(plug?.insertionRules) || plug.insertionRules.length ||
        !Array.isArray(plug.enabledRules) || plug.enabledRules.length || plug.isDummyPlug ||
        plug.insertionMaterialRequirementHash || plug.enabledMaterialRequirementHash) return false;
    seen.add(hash);return true;
  }).map(p => ({plugItemHash:p.plugItemHash,canInsert:true,enabled:true,enableFailIndexes:[],insertFailIndexes:[],evidenceSource:'fixed-definition'}));
}
// Socket indexes join the live instance to the same ordered weapon-definition entry.
export function analyzeSockets(rawItem, weapon, sockets, reusable, lookup) {
  const fields = Object.fromEntries(FIELDS.map(f => [f,{selected:null,alternates:[],status:'unknown',alternateStatus:'unknown'}]));
  const entries = weapon.sockets?.socketEntries || [], traits = [], categorized = [], socketDetails = [];
  let traitAmbiguous = false;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index], live = sockets?.[index], type = lookup(SOCKET,entry.socketTypeHash);
    const inserted = live?.plugHash ? lookup(ITEM,live.plugHash) : null;
    const initial = entry.singleInitialItemHash ? lookup(ITEM,entry.singleInitialItemHash) : null;
    const role = category(inserted, type) || category(initial, type);
    // Both initial and live evidence must agree; intrinsic frames never establish traits.
    const insertedRole = category(inserted,type), initialRole = category(initial,type);
    const conflict = !!(insertedRole && initialRole && insertedRole !== initialRole) ||
      (insertedRole === 'trait' && initial?.itemTypeDisplayName === 'Intrinsic');
    // Do not discard a conflicted trait entry and renumber the remaining two.
    if (conflict && (insertedRole === 'trait' || initialRole === 'trait')) traitAmbiguous = true;
    // Preserve inserted, enabled and visibility independently for offline explanations.
    const selected = live?.plugHash ? plugValue(live.plugHash, inserted, {isEnabled:live.isEnabled,isVisible:live.isVisible,active:live.isEnabled === true}, lookup, role) : null;
    socketDetails.push({index,socketTypeHash:String(entry.socketTypeHash),plugSources:entry.plugSources,selected});
    if (!role || conflict) continue;
    const candidate = {index,entry,type,role,selected,inserted};
    categorized.push(candidate); if (role === 'trait') traits.push(candidate);
  }
  for (const candidate of categorized) {
    const {index,entry,type,role,selected,inserted} = candidate;
    const field = role === 'trait' ? (traits.length === 2 && !traitAmbiguous ? `perk${traits.indexOf(candidate)+1}` : null) : role;
    if (!field) continue;
    // Multiple sockets claiming one non-trait field are ambiguous rather than merged.
    const previous = fields[field];
    if (previous.socketIndex !== undefined) { previous.status = 'unknown'; previous.ambiguous = true; continue; }
    // A resolved inserted plug must have the same role that established this socket.
    const selectedRole = category(inserted,type);
    const status = selected?.resolved && selectedRole === role ? (selected.isEnabled === true ? 'resolved' : selected.isEnabled === false ? 'inactive' : 'unknown') : 'unknown';
    const runtime = reusable?.plugs?.[index];
    const runtimeAlternatesPresent = Array.isArray(runtime);
    const values = runtimeAlternatesPresent ? runtime : fixedChoices(rawItem,entry,sockets?.[index],lookup);
    // Runtime choices belong to this instance; source flags and enhancement are not ownership gates.
    const rolled = !!rawItem.itemInstanceId && Number.isInteger(rawItem.state) && rawItem.state >= 0 && !(rawItem.state & 8);
    const alternates = Array.isArray(values) ? values.filter(p => String(p.plugItemHash) !== selected?.plugHash).map(p => {
      const def = lookup(ITEM,p.plugItemHash), supported = category(def,type) === role;
      return plugValue(p.plugItemHash,def,{canInsert:p.canInsert,enabled:p.enabled,enableFailIndexes:p.enableFailIndexes || [],insertFailIndexes:p.insertFailIndexes || [],...(p.evidenceSource === 'fixed-definition' ? {evidenceSource:p.evidenceSource} : {}),ownership:rolled && supported ? 'rolled' : 'unknown',selectable:rolled && supported && p.canInsert === true && p.enabled === true && !(p.enableFailIndexes?.length) && !(p.insertFailIndexes?.length)},lookup,role);
    }) : [];
    fields[field] = {socketIndex:index,selected,alternates,status,runtimeAlternatesPresent,alternateStatus:(runtimeAlternatesPresent || values.length > 0) && rolled ? 'resolved' : 'unknown'};
  }
  return {fields,sockets:socketDetails};
}
// Rebuild only retained instance evidence; never read Bungie or mutate saved history.
export function reconcileSavedInventory(snapshot) {
  if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.definitions)) return snapshot;
  const definitions = new Map(), duplicates = new Set();
  for (const record of snapshot.definitions) {
    const key = `${record?.type}/${record?.hash}`;
    // Reject conflicting definitions rather than choosing whichever happens to come last.
    if (definitions.has(key)) duplicates.add(key);
    definitions.set(key,record);
  }
  // Each lookup must match the complete saved identity, not merely its hash.
  const lookup = (type,hash) => {
    const key = `${type}/${hash}`, record = definitions.get(key);
    return !duplicates.has(key) && record?.version === snapshot.manifestVersion && record.language === snapshot.language &&
      record.key === `${snapshot.manifestVersion}/${snapshot.language}/${key}` && String(record.definition?.hash) === String(hash) &&
      !record.definition?.redacted ? record.definition : undefined;
  };
  const completePlug = hash => {
    const def = lookup(ITEM,hash);
    // Masterwork names require the actual investment-stat definitions too.
    const stats = def?.investmentStats ?? [];
    return !!def && (!/^v\d+\.plugs\.weapons\.masterworks\.stat\./.test(def.plug?.plugCategoryIdentifier || '') ||
      (Array.isArray(stats) && stats.every(stat => stat && lookup(STAT,stat.statTypeHash))));
  };
  const items = snapshot.items.map(item => {
    // Revalidate derived static claims every time; incomplete evidence cannot preserve them.
    if (Object.values(item?.fields || {}).some(field => field?.alternates?.some(plug => plug.evidenceSource === 'fixed-definition'))) {
      item = {...item,fields:Object.fromEntries(Object.entries(item.fields).map(([name,field]) =>
        [name,{...field,alternates:(field.alternates || []).filter(plug => plug.evidenceSource !== 'fixed-definition')}]))};
    }
    try {
      if (item?.itemType !== 3 || !item.instanceId || !Number.isInteger(item.state) || item.state < 0) return item;
      const weapon = lookup(ITEM,item.itemHash), entries = weapon?.sockets?.socketEntries;
      if (!Array.isArray(entries) || !entries.length || !Array.isArray(item.sockets) || item.sockets.length !== entries.length) return item;
      const sockets = [], plugs = {}, mapped = new Set();
      // Missing, duplicated or misjoined socket evidence keeps the original visible facts.
      for (const socket of item.sockets) {
        const index = socket?.index, entry = entries[index];
        if (!Number.isInteger(index) || !entry || sockets[index] || String(entry.socketTypeHash) !== socket.socketTypeHash ||
          !lookup(SOCKET,entry.socketTypeHash) || (entry.singleInitialItemHash && !completePlug(entry.singleInitialItemHash)) ||
          (socket.selected && !completePlug(socket.selected.plugHash))) return item;
        sockets[index] = socket.selected ? {plugHash:socket.selected.plugHash,isEnabled:socket.selected.isEnabled,isVisible:socket.selected.isVisible} : {};
      }
      // Reconstruct roles before attaching choices; a bad join cannot migrate a perk column.
      const expected = analyzeSockets({...item,itemInstanceId:item.instanceId},weapon,sockets,null,lookup).fields;
      for (const name of FIELDS) {
        const field = item.fields?.[name];
        if (!field || typeof field !== 'object' || field.ambiguous) return item;
        if (field.socketIndex !== expected[name].socketIndex) return item;
        if (field.socketIndex === undefined) { if (field.alternates?.length || field.selected) return item; continue; }
        const index = field.socketIndex;
        if (!Number.isInteger(index) || !entries[index] || mapped.has(index) || !Array.isArray(field.alternates)) return item;
        mapped.add(index);
        // Both retained selected representations must agree before replacing any legacy facts.
        const selected = expected[name].selected;
        if (Boolean(field.selected) !== Boolean(selected) || (selected &&
          (field.selected.plugHash !== selected.plugHash || field.selected.isEnabled !== selected.isEnabled ||
           field.selected.isVisible !== selected.isVisible))) return item;
        // This importer retains rejected instance choices as unknown; potential pools cannot be promoted.
        if (field.alternates.some(plug => !['unknown','rolled'].includes(plug?.ownership) ||
          typeof plug.canInsert !== 'boolean' || typeof plug.enabled !== 'boolean' ||
          !Array.isArray(plug.enableFailIndexes) || !Array.isArray(plug.insertFailIndexes) || !completePlug(plug.plugHash))) return item;
        const retainedRuntime = field.alternates.filter(plug => plug.evidenceSource !== 'fixed-definition');
        // Presence is independent of contents: explicit empty runtime arrays block fallback.
        // Legacy unknown presence cannot distinguish an absent list from a rejected empty list.
        const runtimePresent = typeof field.runtimeAlternatesPresent === 'boolean' ? field.runtimeAlternatesPresent : true;
        if (runtimePresent) plugs[index] = retainedRuntime.map(plug => ({plugItemHash:plug.plugHash,canInsert:plug.canInsert,enabled:plug.enabled,
          enableFailIndexes:plug.enableFailIndexes,insertFailIndexes:plug.insertFailIndexes}));
      }
      const analysis = analyzeSockets({...item,itemInstanceId:item.instanceId},weapon,sockets,{plugs},lookup);
      return {...item,...analysis};
    } catch {
      // Malformed saved nested definitions affect only this item, never the whole view.
      return item;
    }
  });
  return {...snapshot,items};
}
export function normalizeProfile(profile, membership, version, definitions) {
  // Validation happens before constructing a complete snapshot envelope.
  const {ids,characters,containers,currencies} = collectContainers(profile);
  required(Number.isFinite(Date.parse(profile.responseMintedTimestamp)), 'Bungie response timestamp is invalid');
  const lookup = (type,hash) => definitions.get(`${type}/${hash}`)?.definition;
  const instances = new Set(), items = [], equipmentByCharacter = Object.fromEntries(ids.map(id => [id,[]]));
  for (const container of containers) for (const raw of container.items) {
    const instanceId = raw.itemInstanceId ? stringId(raw.itemInstanceId,'item instance') : null;
    required(!instanceId || !instances.has(instanceId),'duplicate instance or conflicting location');
    if (instanceId) instances.add(instanceId);
    const def = required(lookup(ITEM,raw.itemHash),`item definition ${raw.itemHash} missing`);
    const bucketHash = raw.bucketHash ?? def.inventory?.bucketTypeHash;
    const bucket = bucketHash ? required(lookup(BUCKET,bucketHash),`bucket definition ${bucketHash} missing`) : null;
    const postmaster = bucket?.displayProperties?.name === 'Lost Items' || bucket?.displayProperties?.name === 'Postmaster';
    const location = postmaster ? 'postmaster' : container.location;
    const weapon = def.itemType === 3, armor = def.itemType === 2;
    // Item coverage is required even for armor that receives no roll verdict.
    if (instanceId && (weapon || armor)) required(profile.itemComponents?.instances?.data?.[instanceId],`instance component ${instanceId} missing`);
    const liveSockets = profile.itemComponents?.sockets?.data?.[instanceId]?.sockets;
    if (instanceId && weapon && def.sockets?.socketEntries?.length) required(Array.isArray(liveSockets) && liveSockets.length >= def.sockets.socketEntries.length,`weapon sockets ${instanceId} missing`);
    const analysis = instanceId && weapon ? analyzeSockets(raw,def,liveSockets,profile.itemComponents?.reusablePlugs?.data?.[instanceId],lookup) : {fields:{},sockets:[]};
    // Weapon Power comes from this instance's primary stat, never its level or definition.
    const primaryPower = profile.itemComponents?.instances?.data?.[instanceId]?.primaryStat?.value;
    const power = weapon && Number.isInteger(primaryPower) && primaryPower >= 0 ? primaryPower : null;
    const item = {...raw,power,instanceId,itemHash:String(raw.itemHash),name:def.displayProperties?.name || 'Unnamed item',icon:iconUrl(def.displayProperties?.icon),itemType:def.itemType,itemSubType:def.itemSubType,bucketHash:bucketHash == null ? null : String(bucketHash),equipmentBucketHash:String(def.inventory?.bucketTypeHash || bucketHash || ''),bucketName:bucket?.displayProperties?.name || '',characterId:container.characterId,location,equipped:container.location === 'equipment',quantity:raw.quantity,manifestVersion:version,...analysis};
    items.push(item);
    if (item.equipped && instanceId) equipmentByCharacter[container.characterId].push(instanceId);
  }
  // Class selection uses saved timestamps only, never a second character API read.
  const characterList = ids.map(id => ({...characters[id],id,className:['Titan','Hunter','Warlock'][characters[id].classType] || 'Unknown',dateLastPlayed:characters[id].dateLastPlayed}));
  const selected = [...characterList].sort((a,b) => (Date.parse(b.dateLastPlayed)||0)-(Date.parse(a.dateLastPlayed)||0))[0];
  return validateSnapshot({schemaVersion:1,accountKey:`${membership.membershipType}:${membership.membershipId}`,membershipId:membership.membershipId,membershipType:membership.membershipType,bungieMembershipId:membership.bungieMembershipId || '',selectedCharacterId:selected?.id || null,characters:characterList,items,currencies:currencies.map(raw => ({...raw,itemHash:String(raw.itemHash),name:lookup(ITEM,raw.itemHash)?.displayProperties?.name || 'Unnamed currency',icon:iconUrl(lookup(ITEM,raw.itemHash)?.displayProperties?.icon),location:'profileCurrencies'})),equipmentByCharacter,savedAt:new Date().toISOString(),responseMintedTimestamp:profile.responseMintedTimestamp,secondaryComponentsMintedTimestamp:profile.secondaryComponentsMintedTimestamp || null,manifestVersion:version,language:'en',definitions:[...definitions.values()],completeness:{complete:true,noCharacters:!ids.length}});
}
export async function importInventory(config, membership, {signal,onProgress} = {}) {
  if (importing) throw new Error('An inventory refresh is already running.');
  validateConfig(config);
  stringId(membership?.membershipId,'membership');
  required([1,2,3,4,5,6].includes(membership.membershipType),'unsupported membership type');
  const session = getSession(); if (!session) throw new Error('Reconnect to Bungie before refreshing inventory.');
  // Imported membership must belong to the cached connected account.
  if (!session.memberships?.some(m => m.membershipId === membership.membershipId && m.membershipType === membership.membershipType)) throw new Error('Choose a membership belonging to the connected account.');
  // Refuse parallel refreshes before starting any reads or definition-cache work.
  importing = true;
  const operation = operationSignal(signal), controller = new AbortController();
  const cancel = () => controller.abort(operation.signal.reason);
  operation.signal.addEventListener('abort',cancel,{once:true}); if (operation.signal.aborted) cancel();
  const client = createClient(config,{signal:controller.signal,token:session.accessToken});
  try {
    onProgress?.({phase:'manifest',message:'Reading Bungie manifest version.'});
    const manifest = await client.request('/Platform/Destiny2/Manifest/');
    required(typeof manifest.version === 'string' && manifest.version,'manifest version missing');
    const version = manifest.version;
    // One exact profile request defines the complete inventory boundary.
    const profile = await client.request(`/Platform/Destiny2/${membership.membershipType}/Profile/${membership.membershipId}/?components=${PROFILE_COMPONENTS.join(',')}`);
    const {containers,currencies} = collectContainers(profile);
    required(Number.isFinite(Date.parse(profile.responseMintedTimestamp)),'Bungie response timestamp missing');
    const definitions = new Map((await loadDefinitions(version)).map(d => [`${d.type}/${d.hash}`,d]));
    const pending = new Map();
    async function resolve(type,hash) {
      if (!hash) return;
      const key = `${type}/${hash}`; if (definitions.has(key)) return definitions.get(key).definition;
      if (!pending.has(key)) pending.set(key,(async () => {
        const definition = await client.request(`/Platform/Destiny2/Manifest/${type}/${hash}/`);
        // An unresolved or redacted required definition prevents a complete import.
        required(String(definition.hash) === String(hash) && !definition.redacted,`required definition ${hash} unavailable`);
        // Definitions are held in memory until the caller atomically saves the snapshot.
        definitions.set(key,{key:`${version}/en/${type}/${hash}`,version,language:'en',type,hash:String(hash),definition});
        onProgress?.({phase:'definitions',resolved:definitions.size,attempts:client.attempts,message:`Resolved ${definitions.size} definitions.`});
        return definition;
      })());
      return pending.get(key);
    }
    // Resolve by dependency layer to keep every batch bounded to four requests.
    const rawItems = containers.flatMap(c => c.items).concat(currencies);
    await mapLimit([...new Set(rawItems.map(i => i.itemHash))],hash => resolve(ITEM,hash));
    const buckets = rawItems.map(i => i.bucketHash || definitions.get(`${ITEM}/${i.itemHash}`)?.definition.inventory?.bucketTypeHash).filter(Boolean);
    await mapLimit([...new Set(buckets)],hash => resolve(BUCKET,hash));
    // Socket analysis is weapon-only; other inventory items still get offline names/icons.
    const weapons = rawItems.filter(i => i.itemInstanceId && definitions.get(`${ITEM}/${i.itemHash}`).definition.itemType === 3);
    const socketEntries = weapons.flatMap(i => definitions.get(`${ITEM}/${i.itemHash}`).definition.sockets?.socketEntries || []);
    await mapLimit([...new Set(socketEntries.map(e => e.socketTypeHash))],hash => resolve(SOCKET,hash));
    // Resolve inserted and instance candidates before unconditional fixed-set fallback.
    const plugHashes = new Set(socketEntries.map(e => e.singleInitialItemHash).filter(Boolean));
    for (const item of weapons) {
      for (const socket of profile.itemComponents?.sockets?.data?.[item.itemInstanceId]?.sockets || []) if (socket.plugHash) plugHashes.add(socket.plugHash);
      for (const plugs of Object.values(profile.itemComponents?.reusablePlugs?.data?.[item.itemInstanceId]?.plugs || {})) for (const plug of plugs) if (plug.plugItemHash) plugHashes.add(plug.plugItemHash);
    }
    await mapLimit([...plugHashes],hash => resolve(ITEM,hash));
    // Component 310 omits state-independent fixed choices; resolve only eligible roll sockets.
    const fixedEntries = [];
    for (const item of weapons) {
      const entries = definitions.get(`${ITEM}/${item.itemHash}`).definition.sockets?.socketEntries || [];
      const live = profile.itemComponents?.sockets?.data?.[item.itemInstanceId]?.sockets;
      const runtime = profile.itemComponents?.reusablePlugs?.data?.[item.itemInstanceId]?.plugs;
      const lookup = (type,hash) => definitions.get(`${type}/${hash}`)?.definition;
      entries.forEach((entry,index) => {
        if (!Array.isArray(runtime?.[index]) && fixedSocketRole(item,entry,live?.[index],lookup)) fixedEntries.push(entry);
      });
    }
    const fixedSets = [...new Set(fixedEntries.map(entry => entry.reusablePlugSetHash).filter(Boolean))];
    await mapLimit(fixedSets,hash => resolve(SET,hash));
    const fixedLookup = (type,hash) => definitions.get(`${type}/${hash}`)?.definition;
    for (const entry of fixedEntries) for (const plug of fixedList(entry,fixedLookup) || []) if (plug.plugItemHash) plugHashes.add(plug.plugItemHash);
    await mapLimit([...plugHashes],hash => resolve(ITEM,hash));
    // Masterwork verdicts require the names of actual investment stats, not tier levels.
    const statHashes = [...plugHashes].flatMap(hash => {
      const plug = definitions.get(`${ITEM}/${hash}`).definition;
      return /^v\d+\.plugs\.weapons\.masterworks\.stat\./.test(plug.plug?.plugCategoryIdentifier || '') ? (plug.investmentStats || []).map(s => s.statTypeHash) : [];
    });
    await mapLimit([...new Set(statHashes)],hash => resolve(STAT,hash));
    controller.signal.throwIfAborted();
    // Prune unrelated cached definitions so each snapshot remains independently renderable.
    const used = new Set([...rawItems.map(i => `${ITEM}/${i.itemHash}`),...buckets.map(h => `${BUCKET}/${h}`),...socketEntries.map(e => `${SOCKET}/${e.socketTypeHash}`),...[...plugHashes].map(h => `${ITEM}/${h}`),...statHashes.map(h => `${STAT}/${h}`),...fixedSets.map(h => `${SET}/${h}`)]);
    const selectedDefinitions = new Map([...definitions].filter(([key]) => used.has(key)));
    const snapshot = normalizeProfile(profile,{...membership,bungieMembershipId:session.bungieMembershipId},version,selectedDefinitions);
    onProgress?.({phase:'complete',message:'Inventory complete. Ready to save.'});
    return snapshot;
  } catch (error) { controller.abort(error); throw error; }
  finally { operation.signal.removeEventListener('abort',cancel); operation.dispose(); importing = false; }
}
