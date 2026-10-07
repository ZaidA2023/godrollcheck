// Comparison is local and conservative: approved identity plus active socket evidence.
const FIELD_NAMES = ['perk1','perk2','barrel','mag','masterwork','originTrait'];
const verified = new WeakSet();
const normalize = name => String(name ?? '').normalize('NFKC').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
const texts = value => (Array.isArray(value) ? value : value == null ? [] : [value]).map(v => typeof v === 'object' ? v.text ?? v.name ?? '' : String(v)).filter(Boolean);
const MASTERWORK = {Reload:'Reload Speed',Range:'Range',Handling:'Handling',Stability:'Stability',Charge:'Charge Time',Draw:'Draw Time',Impact:'Impact'};
export async function verifyMapIntegrity(map, rawFiles) {
  verified.delete(map);
  if (map?.schemaVersion !== 1 || map.identitySubsetApproved !== true || map.language !== 'en' || !map.workbookSha256 || !Object.keys(map.siteDataSha256 || {}).length) return false;
  // Compare original bytes, preserving whitespace and serialization from the audit.
  for (const [filename,expected] of Object.entries(map.siteDataSha256)) {
    const raw = rawFiles instanceof Map ? rawFiles.get(filename) : rawFiles[filename];
    if (raw == null) return false;
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    const digest = await crypto.subtle.digest('SHA-256',bytes);
    const actual = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join('');
    if (actual !== expected) return false;
  }
  verified.add(map); return true;
}
// A matching manifest alone cannot certify the audit; raw-byte verification is also required.
function validMap(map, item) {
  return map?.schemaVersion === 1 && map.identitySubsetApproved === true && map.language === 'en' && (verified.has(map) || map.integrityVerified === true) && item.manifestVersion === map.manifestVersion;
}
function sameName(value, recommendation) { return normalize(value) === normalize(recommendation); }
function matches(plug, field, recommended, map) {
  if (!plug?.resolved) return false;
  if (field === 'perk1' || field === 'perk2' || field === 'originTrait') {
    const identity = map.plugs?.[plug.plugHash];
    const role = field === 'originTrait' ? 'originTrait' : 'perk';
    if (!identity || identity.role !== role || identity.enhanced !== !!plug.enhanced || !sameName(identity.name,plug.name)) return false;
    // Exact context-filtered identity is approved; distinct-name enhanced aliases are not.
    return recommended.some(name => sameName(identity.name,name));
  }
  return recommended.some(name => sameName(plug.name, field === 'masterwork' ? MASTERWORK[name] || '' : name));
}
// An unmatched approved identity is Unknown rather than evidence of a different perk.
function knownIdentity(plug,field,map) {
  if (!plug?.resolved) return false;
  if (field === 'perk1' || field === 'perk2' || field === 'originTrait') {
    const identity = map.plugs?.[plug.plugHash];
    return !!identity && identity.role === (field === 'originTrait' ? 'originTrait' : 'perk') && identity.enhanced === !!plug.enhanced && sameName(identity.name,plug.name);
  }
  return true;
}
// A unique exact name shares recommendations across versions under the user policy.
export function compareItem(item, map, tables) {
  const usableTables = (tables || []).filter(t => t.id !== 'primaries' && (t.kind === 'weapon' || t.id === 'exotic-weapons'));
  const exact = usableTables.flatMap(tab => (tab.records || []).filter(r => r.itemHash != null && String(r.itemHash) === String(item.itemHash)).map(record => ({record,tabId:tab.id})));
  const possible = usableTables.flatMap(tab => (tab.records || []).filter(r => sameName(r.name,item.name)).map(record => ({record,tabId:tab.id})));
  // Aliases are explicit audited hashes; runtime name stripping never establishes identity.
  const nameReferenceRow = exact.length === 0 && possible.length === 1 ? possible[0] : null;
  const alias = exact.length === 0 && possible.length === 0 ? map?.variants?.[String(item.itemHash)] : null;
  const hash = value => /^\d{1,10}$/.test(String(value)) && Number(value) > 0 && Number(value) <= 4294967295;
  const optionsValid = alias?.verifiedOptions && typeof alias.verifiedOptions === 'object' && !Array.isArray(alias.verifiedOptions) && FIELD_NAMES.every(field => Array.isArray(alias.verifiedOptions[field]) && alias.verifiedOptions[field].every(name => typeof name === 'string' && name.trim()));
  const aliasValid = alias?.approved === true && hash(item.itemHash) && hash(alias.baseHash) && typeof alias.name === 'string' && alias.name.trim() && typeof alias.baseName === 'string' && alias.baseName.trim() && sameName(alias.name,item.name) && optionsValid;
  const bases = aliasValid ? usableTables.flatMap(tab => (tab.records || []).filter(record => String(record.itemHash) === String(alias.baseHash)).map(record => ({record,tabId:tab.id,kind:tab.kind}))) : [];
  const aliasReference = bases.length === 1 && bases[0].kind === 'weapon' && bases[0].tabId === alias.tabId && bases[0].record.id === alias.sheetId && sameName(bases[0].record.name,alias.baseName) ? bases[0] : null;
  // Never let a name or alias resolve a collision in a higher-priority path.
  const reference = exact.length === 1 ? exact[0] : exact.length === 0 ? nameReferenceRow || aliasReference : null;
  let reason = null;
  if (item.itemType !== 3) reason = 'Unsupported item type';
  else if (!reference) reason = exact.length > 1 || possible.length > 1 ? 'Ambiguous sheet weapon identity' : 'Not covered by this sheet';
  else if (nameReferenceRow && (!hash(item.itemHash) || ![item.name,reference.record.name,reference.record.id,reference.tabId].every(value => typeof value === 'string' && value.trim()))) reason = 'Weapon name reference needs review';
  else if (!validMap(map,item)) reason = 'Mapping fingerprint or manifest version mismatch; Review required';
  else if (!nameReferenceRow) {
    // The base identity remains audited even when an approved variant points to its row.
    const identity = map.weapons?.[String(reference.record.itemHash)];
    const expectedName = aliasReference ? alias.baseName : item.name;
    if (!identity || identity.sheetId !== reference.record.id || identity.tabId !== reference.tabId || map.unresolved?.[reference.record.id]?.identity || !sameName(reference.record.name,expectedName)) reason = 'Weapon identity needs review';
  }
  // Exact-name sharing establishes a recommendation reference, not identical roll pools.
  const nameReference = !reason && nameReferenceRow ? {verified:true,itemHash:String(item.itemHash),name:item.name,sheetId:reference.record.id,tabId:reference.tabId} : null;
  const variant = !reason && aliasReference ? {verified:true,itemHash:String(item.itemHash),baseHash:String(reference.record.itemHash),name:alias.name,baseName:alias.baseName} : null;
  // Exotics retain descriptive sheet context without fabricated random-roll fields.
  const {record = null,tabId = null} = reference || {};
  if (!reason && tabId === 'exotic-weapons') return {record,tabId,status:'descriptive',fields:{},reason:'Exotic sheet description and tier; no random-roll grade'};
  const fields = {};
  // Every column is independently ANY-of; audit flags stay scoped to their field.
  for (const field of FIELD_NAMES) {
    const source = item.fields?.[field], selected = source?.selected ?? null, recommended = texts(record?.[field]);
    const flagged = variant ? true : map?.unresolved?.[record?.id]?.fields?.includes(field);
    // Variant availability comes from that variant's own socket audit, never its base pool.
    const verifiedOptions = texts(variant ? alias.verifiedOptions[field] : map?.verifiedOptions?.[record?.id]?.[field]);
    let status = 'unknown';
    // A flagged option cannot invalidate another independently verified ANY-of match.
    const activeKnown = source?.status === 'resolved' && !source.ambiguous && selected?.active === true && selected.isEnabled === true && knownIdentity(selected,field,map);
    if (!reason && flagged && activeKnown && matches(selected,field,recommended,map) && matches(selected,field,verifiedOptions,map)) status = 'match';
    else if (!reason && !flagged) {
      if (!recommended.length) status = 'no-recommendation';
      else if (field === 'masterwork' && recommended.some(name => !Object.hasOwn(MASTERWORK,name))) status = 'unknown';
      else if (activeKnown) status = matches(selected,field,recommended,map) ? 'match' : 'different';
    }
    if (!reason && variant && !recommended.length) status = 'no-recommendation';
    else if (!reason && variant && activeKnown && !matches(selected,field,recommended,map)) status = 'different';
    // Rolled selectable alternatives never change the active selected-plug verdict.
    const alternateMatches = !reason && !source?.ambiguous ? (source?.alternates || []).filter(plug => plug.ownership === 'rolled' && plug.selectable === true && plug.canInsert === true && plug.enabled === true && matches(plug,field,recommended,map) && (!flagged || matches(plug,field,verifiedOptions,map))) : [];
    fields[field] = {status,selected,recommended,alternateMatches,reason:variant ? (status === 'unknown' ? 'No verified variant match in this column' : null) : flagged ? (status === 'match' ? 'Other listed options require review' : 'Review required') : reason || (status === 'unknown' ? 'Unsupported, inactive or unresolved socket evidence' : null)};
  }
  const traitStatuses = [fields.perk1.status,fields.perk2.status], count = traitStatuses.filter(s => s === 'match').length;
  const status = reason ? 'unknown' : count === 2 ? 'both-match' : count === 1 ? 'one-match' : traitStatuses.includes('unknown') ? 'unknown' : traitStatuses.every(s => s === 'no-recommendation') ? 'no-recommendation' : 'different';
  return {record,tabId,status,fields,reason,variant,nameReference};
}
// Copies stay distinct; Postmaster and unrelated weapon types cannot enter this list.
export function ownedAlternatives(item, snapshot, map, tables) {
  return snapshot.items.filter(candidate => candidate.itemType === 3 && candidate.instanceId && candidate.instanceId !== item.instanceId && candidate.itemSubType === item.itemSubType && ['vault','character','equipment'].includes(candidate.location)).map(candidate => ({item:candidate,comparison:compareItem({...candidate,manifestVersion:snapshot.manifestVersion},map,tables)})).sort((a,b) => (a.comparison.record?.rank ?? Infinity)-(b.comparison.record?.rank ?? Infinity));
}
