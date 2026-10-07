// These helpers review the saved snapshot locally; they never request account data.
const FIELDS = ['barrel','mag','masterwork','perk1','perk2','originTrait'];
const names = value => (Array.isArray(value) ? value : value == null ? [] : [value]).map(v => typeof v === 'object' ? v?.text ?? v?.name ?? '' : String(v)).filter(Boolean);
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en').trim();
const postmaster = item => item.isPostmaster || item.location === 'postmaster' || String(item.bucketHash) === '215593132';
// Rarity is read from saved, version-matched definitions; sheet presence proves no rarity.
function savedRarities(snapshot) {
  const rarities = new Map();
  for (const entry of snapshot.definitions || []) {
    if (entry.type !== 'DestinyInventoryItemDefinition' || entry.version !== snapshot.manifestVersion || entry.language !== 'en') continue;
    const hash = String(entry.hash), definition = entry.definition;
    const tier = Number(definition?.inventory?.tierType);
    const rarity = definition?.hash != null && String(definition.hash) === hash && Number.isInteger(tier) && tier > 0 ? tier === 5 ? 'legendary' : tier === 6 ? 'exotic' : 'other' : 'unverified';
    // Conflicting cached definitions must never promote an item into scoring eligibility.
    rarities.set(hash,rarities.has(hash) && rarities.get(hash) !== rarity ? 'unverified' : rarity);
  }
  return rarities;
}
export function classifyItem(item, comparison = {}, meta, rarity = 'unverified') {
  // Every nonempty recommendation column can earn at most one independently proven point.
  const required = FIELDS.filter(field => names(comparison.fields?.[field]?.recommended ?? comparison.record?.[field]).length);
  const evidence = comparison.variant;
  const hash = value => typeof value === 'string' && /^\d{1,10}$/.test(value) && Number(value) > 0 && Number(value) <= 4294967295;
  const identityName = value => normalize(value).replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\s+/g,' ');
  // Exact evidence binds both names and hashes; a merely similar name earns no alias credit.
  const variantExact = evidence && typeof evidence === 'object' && !Array.isArray(evidence) && evidence.verified === true && hash(evidence.itemHash) && hash(evidence.baseHash) && typeof evidence.name === 'string' && evidence.name.trim() && typeof evidence.baseName === 'string' && evidence.baseName.trim() && evidence.itemHash === String(item.itemHash) && evidence.baseHash === String(comparison.record?.itemHash) && identityName(evidence.name) === identityName(item.name) && identityName(evidence.baseName) === identityName(comparison.record?.name);
  const exact = comparison.record?.itemHash != null && (String(comparison.record.itemHash) === String(item.itemHash) || Boolean(variantExact));
  const eligible = Number(item.itemType) === 3 && rarity === 'legendary' && meta?.kind === 'weapon' && comparison.tabId !== 'exotic-weapons' && exact && !comparison.reason;
  // Whole-record failures disallow all credit; unresolved fields only lose their own point.
  const scored = Boolean(eligible && required.length > 0);
  const satisfied = scored ? required.filter(field => comparison.fields?.[field]?.status === 'match' || comparison.fields?.[field]?.alternateMatches?.length > 0) : [];
  const changeFields = satisfied.filter(field => comparison.fields?.[field]?.status !== 'match');
  const matchCount = satisfied.length, requiredCount = required.length;
  const status = !scored ? 'unscored' : matchCount === requiredCount ? 'complete' : matchCount > 0 ? 'partial' : 'different';
  const selectionNeeded = changeFields.length > 0;
  const label = scored ? `${matchCount} of ${requiredCount} recommendations matched${status === 'complete' ? ' · Full recommendation match' : ''}` : '';
  return {status,scored,matchCount,requiredCount,complete:status === 'complete',selectionNeeded,required,satisfied,changeFields,label};
}

export function locationText(item, characters = []) {
  const character = characters.find(c => String(c.id) === String(item.characterId));
  const owner = item.characterId ? `${character?.className || 'Character'} · ${item.characterId}` : '';
  // Postmaster keeps its character owner even though it has a separate location filter.
  if (postmaster(item)) return `Postmaster${owner ? ` · ${owner}` : ''}`;
  if (item.location === 'vault') return 'Vault';
  if (owner) return `${owner}${item.equipped ? ' · Equipped' : ' · Carried'}`;
  return item.bucketName ? `Account · ${item.bucketName}` : 'Account';
}
// Imported numeric item types are stable; unsupported types remain ungraded.
export function itemTypeText(item) {
  return Number(item.itemType) === 3 ? 'Weapon' : Number(item.itemType) === 2 ? 'Armor' : 'Other item';
}
export function buildEntries(snapshot, compareFn, manifest = {}) {
  const rarities = savedRarities(snapshot);
  const entries = (snapshot.items || []).map((item,index) => {
    const comparison = Number(item.itemType) === 3 ? compareFn(item) : {fields:{}};
    const rarity = rarities.get(String(item.itemHash)) || 'unverified';
    const verdict = classifyItem(item,comparison,manifest.tabs?.[comparison.tabId],rarity);
    const type = Number(item.itemType) === 3 ? 'weapons' : Number(item.itemType) === 2 ? 'armor' : 'other';
    const locationKey = postmaster(item) ? 'postmaster' : item.location === 'vault' ? 'vault' : item.characterId ? `character:${item.characterId}` : 'other';
    // Search selected plugs and copy-owned choices without adding possible roll pools.
    const ownedNames = Object.values(item.fields || {}).flatMap(field => [field.selected,...(field.alternates || []).filter(plug => plug.ownership === 'rolled' && plug.selectable === true)]).filter(plug => plug?.resolved).map(plug => plug.name);
    return {item,index,comparison,verdict,rarity,type,typeLabel:itemTypeText(item),locationKey,locationLabel:locationText(item,snapshot.characters),searchText:normalize([item.name,...ownedNames].join(' '))};
  });
  // Absolute matched count leads; completeness, rarity, sheet rank and percentage never break ties.
  // Original index preserves individually discoverable duplicate copies and stacks.
  return entries.sort((a,b) => b.verdict.matchCount-a.verdict.matchCount || String(a.item.name).localeCompare(String(b.item.name),'en') || a.locationLabel.localeCompare(b.locationLabel,'en') || String(a.item.instanceId ?? '').localeCompare(String(b.item.instanceId ?? ''),'en') || a.index-b.index);
}

// Select locations without changing cached scores, order, copies or stack identity.
export function locationScopes(entries, characters = [], selectedCharacterId = null) {
  const ids = new Set(characters.map(character => String(character.id)));
  const selected = ids.has(String(selectedCharacterId)) ? String(selectedCharacterId) : characters.length ? String(characters[0].id) : null;
  const scopes = {selectedCharacterId:selected,character:[],vault:[],postmaster:[],other:[]};
  for (const entry of entries) {
    const owner = entry.item.characterId == null ? null : String(entry.item.characterId);
    if (entry.locationKey === 'vault') scopes.vault.push(entry);
    else if (entry.locationKey === 'postmaster') {
      if (!ids.has(owner)) scopes.other.push(entry);
      else if (owner === selected) scopes.postmaster.push(entry);
    // Orphaned owners go to other, rather than disappearing from the saved inventory.
    } else if (entry.locationKey === `character:${owner}` && ids.has(owner)) {
      // Valid unselected owners stay discoverable through the character selector.
      if (owner === selected) scopes.character.push(entry);
    } else scopes.other.push(entry);
  }
  return scopes;
}

export function selectEntries(entries, {query='',type='all',location='all',verdict='all',page=1,pageSize=50} = {}) {
  const needle = normalize(query);
  const filtered = entries.filter(entry => (!needle || entry.searchText.includes(needle)) && (type === 'all' || entry.type === type) && (location === 'all' || entry.locationKey === location) && (verdict === 'all' || entry.verdict.status === verdict));
  // Clamp invalid or out-of-range pages, including after a smaller snapshot replaces one.
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 50;
  const pageCount = Math.max(1,Math.ceil(filtered.length/size));
  const selectedPage = Math.max(1,Math.min(pageCount,Number.isSafeInteger(page) ? page : 1));
  const start = (selectedPage-1)*size;
  return {rows:filtered.slice(start,start+size),filteredCount:filtered.length,totalCount:entries.length,page:selectedPage,pageCount,from:filtered.length ? start+1 : 0,to:Math.min(start+size,filtered.length),completeCount:entries.filter(entry => entry.verdict.complete).length};
}
