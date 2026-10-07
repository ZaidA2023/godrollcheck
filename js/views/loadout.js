import {el, load, plain, openItem} from '../data.js';
import {buildEntries, selectEntries, locationScopes} from '../account/inventory-review.js';

const fieldLabels={barrel:'Barrel / string / blade',mag:'Magazine / battery / guard',masterwork:'Masterwork',perk1:'Perk column 1',perk2:'Perk column 2',originTrait:'Origin trait'};
const isPostmaster=item=>item.isPostmaster||String(item.bucketHash)==='215593132'||/postmaster/i.test(String(item.location));
const accountKey=value=>value?.accountKey || (value?.membershipType!=null&&value?.membershipId!=null?`${value.membershipType}:${value.membershipId}`:'');
const timestamp=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'Unavailable';
const statusLabels={match:'Recommended match',different:'Different from recommendation','no-recommendation':'No recommendation','both-match':'Both recommended columns match','one-match':'One recommended column matches',descriptive:'Descriptive exotic recommendations'};
const words=value=>statusLabels[value]||String(value||'').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[-_]/g,' ');
function display(value) {
  if(Array.isArray(value))return value.map(display).filter(Boolean).join(', ');
  if(value&&typeof value==='object') {
    const name=value.name??value.text??value.label??'';
    const state=value.active===false||value.isEnabled===false||value.enabled===false?' (selected, inactive)':value.isEnabled==null&&value.enabled==null&&value.plugHash?' (activation not verified)':'';
    return String(name)+state;
  }
  return value==null?'':String(value);
}
function selectedText(field,imported,verdict) {
  const selected=verdict?.selected??imported?.selected;
  // Absence is established only by a normalized field with no socket/plug evidence.
  if(field==='originTrait'&&imported&&!selected&&!imported.alternates?.length&&imported.socketIndex==null&&!imported.ambiguous)return 'No origin trait recorded';
  if(imported?.ambiguous||selected?.resolved===false)return 'No verified match';
  return display(selected)||(field==='originTrait'?'No verified match':'Not recorded');
}
function selectableOwned(imported) {
  // Ownership and explicit selection flags must be proven on this copy, not its possible pool.
  return imported?.ambiguous?[]:(imported?.alternates||[]).filter(plug=>plug?.resolved===true&&plug.ownership==='rolled'&&plug.selectable===true&&plug.canInsert===true&&plug.enabled===true&&!plug.enableFailIndexes?.length&&!plug.insertFailIndexes?.length);
}
// Available names combine the inserted plug and proven copy-owned choices without pool guesses.
function availableNames(field, imported, verdict) {
  const fallback=selectedText(field,imported,verdict);
  const absent=['Not recorded','No verified match','No origin trait recorded'];
  const inserted=verdict?.selected??imported?.selected;
  const name=plug=>typeof plug==='object'?String(plug?.name??plug?.text??plug?.label??''):String(plug??'');
  const available=[...(!absent.includes(fallback)?[name(inserted)]:[]),...selectableOwned(imported).map(name)].filter(Boolean);
  const seen=new Set();
  // Selection/activation suffixes are display-only; scoring still uses verified comparison evidence.
  const unique=available.filter(value=>{const key=value.normalize('NFKC').trim().toLocaleLowerCase('en');if(seen.has(key))return false;seen.add(key);return true;});
  return {names:unique,fallback};
}
function availableText(field, imported, verdict) {
  const available=availableNames(field,imported,verdict);
  return available.names.length?available.names.join(', '):available.fallback;
}
// Perk colors reuse verified column evidence; no new matching or scoring is inferred.
function availablePerks(field, imported, verdict, inventoryVerdict) {
  const available=availableNames(field,imported,verdict),line=el('p','inventory-perks','Available perks: ');
  if(!available.names.length){line.append(el('span','muted',available.fallback));return line;}
  const normalize=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase('en');
  const matchedNames=new Set((verdict?.alternateMatches||[]).map(plug=>normalize(plug.name)));
  if(verdict?.status==='match')matchedNames.add(normalize(verdict.selected?.name));
  const graded=inventoryVerdict.scored&&inventoryVerdict.required.includes(field);
  for(const [index,name] of available.names.entries()){
    if(index)line.append(el('span','',' · '));
    const state=graded&&matchedNames.has(normalize(name))?'match':graded&&['match','different'].includes(verdict?.status)?'different':'neutral';
    const perk=el('span',`inventory-perk inventory-perk-${state}`,name);
    if(state!=='neutral')perk.append(el('span','inventory-perk-state',state==='match'?' ✓ Match':' ✕ No match'));
    line.append(perk);
  }
  return line;
}
function bungieIcon(path,name) {
  if(typeof path!=='string'||!path.trim())return el('span','icon-placeholder','◇');
  // Only Bungie's static content directory can supply imported images.
  try {
    const url=new URL(path,'https://www.bungie.net');
    if(url.protocol!=='https:'||url.hostname!=='www.bungie.net'||url.port||url.username||url.password||!url.pathname.startsWith('/common/destiny2_content/')||url.search||url.hash)throw new Error();
    const image=el('img','item-icon');image.src=url.href;image.alt=name||'';image.loading='lazy';image.referrerPolicy='no-referrer';image.width=48;image.height=48;
    image.onerror=()=>image.replaceWith(el('span','icon-placeholder','◇'));return image;
  } catch{return el('span','icon-placeholder','◇');}
}

export async function loadout(manifest,params,{signal}={}) {
  const page=el('section','loadout-page');
  const insecureHttp=location.protocol==='http:';
  let secureLink;
  const heading=el('div','page-heading');heading.append(el('div','eyebrow','DESTINY 2 / PERSONAL TOOL'),el('h1','','My Inventory'));page.append(heading);
  const notice=el('p','loadout-notice');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');page.append(notice);
  if(insecureHttp){secureLink=el('a','loadout-secure-link','Open hosted HTTPS site ↗');secureLink.href='https://godrollcheck.ut-austin-ed-0958.chatgpt.site/#/loadout';page.append(secureLink);}
  const controls=el('section','loadout-controls');controls.setAttribute('aria-label','Account and saved inventory');
  const connection=el('p','muted');const actions=el('div','loadout-actions');
  const connect=el('button','','Connect Bungie');const choose=el('button','','Choose account');const refresh=el('button','loadout-primary','Refresh and Save');const disconnect=el('button','','Disconnect');
  actions.append(connect,choose,refresh,disconnect);controls.append(connection,actions);page.append(controls);
  const selectors=el('div','loadout-selectors');controls.append(selectors);
  function selector(labelText) {
    const label=el('label','filter-label',labelText);const select=el('select');select.setAttribute('aria-label',labelText);label.append(select);selectors.append(label);return select;
  }
  const membershipSelect=selector('Connected Destiny account');const savedSelect=selector('Saved accounts');
  const savedMeta=el('div','loadout-saved-meta');const gear=el('div','loadout-gear');page.append(savedMeta,gear);
  const clear=el('button','','Clear saved inventory');const confirmation=el('div','loadout-confirm');confirmation.hidden=true;
  const confirmClear=el('button','','Delete this saved account');const cancelClear=el('button','','Keep saved inventory');confirmation.append(el('p','','Delete the saved inventory for this account from this browser?'),confirmClear,cancelClear);controls.append(clear,confirmation);
  let auth,storage,inventory,compare,config,map,tables=[],snapshot=null,memberships=[],membership=null,savedAccounts=[],entrySnapshot,entries=[],inventoryState={query:'',verdict:'all',tab:'characters',characterId:null,pages:{main:1,postmaster:1,other:1},disclosures:{},pageSize:50},inventoryGeneration=0,inventoryControls=[],busy=false,disconnecting=false,operation,revision=0;
  const stopped=()=>signal?.aborted;
  const startupRevision=revision;const startupCurrent=()=>!stopped()&&revision===startupRevision;
  const cancel=()=>{revision++;operation?.abort();busy=false;};
  signal?.addEventListener('abort',cancel,{once:true});
  const report=(message,error=false)=>{if(stopped())return;notice.textContent=message;notice.classList.toggle('loadout-error',error);notice.setAttribute('role',error?'alert':'status');};
  function options(select,rows,placeholder,key,label) {
    select.replaceChildren();const empty=el('option','',placeholder);empty.value='';select.append(empty);
    for(const row of rows){const option=el('option','',label(row));option.value=key(row);select.append(option);}
  }
  function updateControls() {
    const session=auth?.getSession();
    connection.textContent=session?(membership?`Connected session · Destiny account ${accountKey(membership)}.`:'Connected session. Choose a Destiny account before refreshing.'):'Disconnected. Saved inventory remains available offline.';
    connect.disabled=busy||insecureHttp||!auth||!config;choose.disabled=busy||insecureHttp||!session||!config;refresh.disabled=busy||insecureHttp||!session||!membership||!inventory||!storage||!config;
    disconnect.disabled=!session||disconnecting;membershipSelect.disabled=busy||!memberships.length;savedSelect.disabled=busy||!savedAccounts.length;clear.disabled=busy||!snapshot||!storage;
    for(const {node,disabled} of inventoryControls)node.disabled=busy||Boolean(disabled?.());
    page.setAttribute('aria-busy',String(busy));
  }
  async function savedList(current=()=>!stopped()) {
    const accounts=await storage.listSnapshots();
    if(!current())return false;
    savedAccounts=accounts;
    options(savedSelect,savedAccounts,'Choose saved inventory',accountKey,row=>`${accountKey(row)} · ${timestamp(row.savedAt)}`);
    savedSelect.value=accountKey(snapshot);
    return true;
  }
  function comparison(item) {
    if(!compare||!map?.integrityVerified)return {status:'unknown',reason:'Comparison unavailable until the local mapping and comparison module are ready.',fields:{}};
    try{return compare.compareItem({...item,manifestVersion:snapshot?.manifestVersion},map,tables);}catch{return {status:'unknown',reason:'This item could not be compared with the reviewed map.',fields:{}};}
  }
  function itemDetails(entry,current) {
    const {item,comparison:result}=entry;const detail=el('div','inventory-detail-content');
    const record=result?.record;const meta=manifest.tabs[result?.tabId];
    detail.append(el('p','muted',`${entry.locationLabel}${item.instanceId?` · Instance ${item.instanceId}`:` · Inventory entry ${entry.index+1}`}${item.bucketName?` · ${item.bucketName}`:''}`));
    if(result?.reason)detail.append(el('p','muted',result.reason));
    // Verified comparison evidence supplies attribution; owned names and perks stay intact.
    const variant=result?.variant;
    if(variant?.verified===true&&!result?.reason&&['itemHash','baseHash','name','baseName'].every(field=>typeof variant[field]==='string'&&variant[field].trim()))detail.append(el('p','muted',`Recommendations from ${variant.baseName}`));
    // Rank is reference context only; it never affects row sorting or highlighting.
    if(record&&meta){
      const reference=el('button','text-link',`Sheet reference · ${meta.title}${record.tier?` · Tier ${plain(record.tier)}`:''}${meta.kind==='weapon'&&record.rank!=null?` · Rank ${record.rank} in ${meta.title}`:''}`);
      reference.onclick=()=>{if(current())openItem({type:meta.refType||'weapon',id:record.id});};detail.append(reference);
    }
    const exotic=entry.rarity==='exotic'||result?.tabId==='exotic-weapons';
    // Explain missing scoring eligibility without assigning a roll label or guessing rarity.
    if(Number(item.itemType)===3&&!entry.verdict.scored&&!result?.reason){
      const explanation=exotic?'Exotic items and references are shown without roll grading.':entry.rarity==='unverified'?'Saved weapon rarity could not be verified. This copy is not scored.':entry.rarity!=='legendary'?'This weapon is not legendary and is not scored.':!record?'No trusted sheet reference is available.':!entry.verdict.requiredCount?'The sheet provides no recommendation columns for this copy.':'No verified recommendation score is available.';
      detail.append(el('p','muted',explanation));
    }
    // Exotics keep descriptive references and copy-owned choices without a roll grid.
    if(exotic){
      for(const [field,label] of Object.entries(fieldLabels)){
        const available=availableText(field,item.fields?.[field],result?.fields?.[field]);
        if(!['Not recorded','No verified match','No origin trait recorded'].includes(available))detail.append(el('p','muted',`${label} · Available perks: ${available}`));
      }
      for(const field of ['description','usage'])if(record?.[field])detail.append(el('p','',plain(record[field])));
    }else if(Number(item.itemType)===3){
      const legendary=entry.rarity==='legendary';
      const fields=el('dl',legendary?'loadout-fields':'inventory-item-facts');
      // Imported facts survive missing rarity/audit evidence; badges require a trusted legendary score.
      for(const [field,label] of Object.entries(fieldLabels)){
        const verdict=result?.fields?.[field];const imported=item.fields?.[field];const row=el('div');row.append(el('dt','',label));const content=el('dd');
        const available=availableText(field,imported,verdict);content.append(availablePerks(field,imported,verdict,entry.verdict));
        const matched=entry.verdict.scored&&entry.verdict.satisfied.includes(field);
        if(legendary){
          content.append(el('p','muted',`Recommended: ${display(verdict?.recommended??record?.[field])||'No recommendation'}`));
          // Any verified owned option satisfies the column, independent of its selected state.
          if(matched)content.append(el('span','badge inventory-perk-match',words('match')));
          else if(entry.verdict.scored&&['different','no-recommendation'].includes(verdict?.status))content.append(el('span',`badge${verdict.status==='different'?' inventory-perk-different':''}`,words(verdict.status)));
          else if(verdict?.status==='unknown'&&!['No origin trait recorded','No verified match'].includes(available))content.append(el('p','muted','No verified match'));
        }
        // Preserve recommendation-audit context; omit only selected-state failures after an owned match.
        const reason=verdict?.reason;
        const selectedOnlyReason=['Unsupported, inactive or unresolved socket evidence','No verified variant match in this column'].includes(reason);
        if(reason&&(!matched||!selectedOnlyReason))content.append(el('p','muted',matched&&reason==='Review required'?'Other listed options require review':reason));
        row.append(content);fields.append(row);
      }
      detail.append(fields);
    }else detail.append(el('p','muted','Not graded. This entry is saved inventory context.'));
    if(record?.notes)detail.append(el('p','loadout-notes',plain(record.notes)));
    return detail;
  }
  function inventoryRow(entry,current) {
    const {item,verdict}=entry;const row=el('article',`inventory-row${verdict.scored&&verdict.complete?' inventory-complete':''}${!verdict.scored?' inventory-unscored':''}`);
    row.setAttribute('data-entry-index',String(entry.index));
    const details=el('details','inventory-details');const summary=el('summary','inventory-row-summary');const info=el('div','inventory-row-info');
    info.append(el('h3','',item.name||'Unresolved item'),el('p','muted',`${entry.typeLabel}${item.itemTypeDisplayName||item.itemSubTypeName?` · ${item.itemTypeDisplayName||item.itemSubTypeName}`:''} · ${entry.locationLabel}${item.equipped&&!/equipped/i.test(entry.locationLabel)?' · Equipped':''}${item.quantity!=null?` · Quantity ${item.quantity}`:''}`));
    // Only trusted legendary scores expose matched-column summaries.
    if(verdict.scored&&entry.rarity==='legendary'&&entry.comparison?.tabId!=='exotic-weapons'){
      const satisfied=Array.isArray(verdict.satisfied)?verdict.satisfied:[];
      if(satisfied.length)info.append(el('p','inventory-match-fields',`Matched recommendations: ${satisfied.map(field=>fieldLabels[field]||field).join(' · ')}`));
    }
    summary.setAttribute('aria-label',`${item.name||'Unresolved item'} · ${entry.locationLabel}${verdict.scored?` · ${verdict.label}`:''}`);
    summary.append(bungieIcon(item.icon,item.name),info);
    if(verdict.scored)summary.append(el('span','inventory-match-label',verdict.label));details.append(summary);row.append(details);
    // Detached rows cannot build details for a replaced snapshot, action or page.
    let populated=false;details.addEventListener('toggle',()=>{
      if(!details.open||populated||!current())return;
      populated=true;details.append(itemDetails(entry,current));
    });
    return row;
  }
  function renderGear() {
    savedMeta.replaceChildren();gear.replaceChildren();confirmation.hidden=true;inventoryControls=[];
    const ownerSnapshot=snapshot,ownerRevision=revision,ownerGeneration=++inventoryGeneration;
    const current=()=>!stopped()&&snapshot===ownerSnapshot&&revision===ownerRevision&&inventoryGeneration===ownerGeneration;
    // A replacement resets filters/page/details and builds each indexed comparison once.
    if(entrySnapshot!==snapshot){
      entrySnapshot=snapshot;inventoryState={query:'',verdict:'all',tab:'characters',characterId:null,pages:{main:1,postmaster:1,other:1},disclosures:{},pageSize:50};
      // Resolve the saved owner locally; replacement snapshots get fresh browsing defaults.
      // Keep complete saved snapshots intact; only the displayed entries are weapon-only.
      entries=snapshot?buildEntries(snapshot,comparison,manifest).filter(entry=>entry.type==='weapons'):[];
      inventoryState.characterId=locationScopes(entries,snapshot?.characters||[],snapshot?.selectedCharacterId).selectedCharacterId;
      if(!snapshot?.characters?.length)inventoryState.tab='vault';
    }
    if(!snapshot){gear.append(el('p','empty-state','No saved inventory selected. Connect, choose your Destiny account, then Refresh and Save.'));updateControls();return;}
    savedMeta.append(el('h2','','Saved inventory'),el('p','muted',`Account ${accountKey(snapshot)} · Saved in this browser; may be stale.\nLast saved: ${timestamp(snapshot.savedAt)}\nBungie response: ${timestamp(snapshot.responseMintedTimestamp)}${snapshot.secondaryComponentsMintedTimestamp?`\nSecondary components: ${timestamp(snapshot.secondaryComponentsMintedTimestamp)}`:''}\nSheet snapshot: ${timestamp(manifest.generated)}`));
    const counts={Vault:0,Carried:0,Postmaster:0,Other:0};
    // Global imported totals are distinct from the per-section browsing counts.
    for(const {item} of entries){const group=isPostmaster(item)?'Postmaster':String(item.location).toLowerCase()==='vault'?'Vault':item.characterId?'Carried':'Other';counts[group]++;}
    savedMeta.append(el('p','loadout-inventory-count',`Saved weapons: ${entries.length.toLocaleString()} · ${Object.entries(counts).map(([label,count])=>`${label}: ${count.toLocaleString()}`).join(' · ')}\nLegendary weapons sort by matched recommendation count. Each nonempty field needs one listed option; selectable owned perks count. Equipped items are included in Carried.`));
    if(!snapshot.characters.length)gear.append(el('p','muted','This saved profile has no characters. Vault and account weapons are still listed.'));
    // Keep the tab buttons attached while switching panels, preserving keyboard focus.
    const tabs=el('div','inventory-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Inventory storage');
    const panel=el('section','inventory-panel');panel.id='inventory-location-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('tabindex','0');
    const tabButtons=[];
    const resetPages=()=>{inventoryState.pages={main:1,postmaster:1,other:1};};
    function switchTab(tab){
      if(!current()||busy||inventoryState.tab===tab)return;
      inventoryState.tab=tab;resetPages();inventoryState.disclosures={};renderScope();
    }
    for(const [value,label] of [['characters','Characters'],['vault','Vault']]){
      const button=el('button','inventory-tab',label);button.id=`inventory-tab-${value}`;
      button.setAttribute('role','tab');button.setAttribute('aria-controls',panel.id);
      button.onclick=()=>switchTab(value);tabButtons.push({node:button,value});tabs.append(button);inventoryControls.push({node:button});
      // Automatic activation wraps across the two tabs without detaching focus.
      button.addEventListener('keydown',event=>{
        if(!current()||busy)return;
        const index=tabButtons.findIndex(tab=>tab.node===button);
        const next=event.key==='Home'?0:event.key==='End'?1:event.key==='ArrowLeft'||event.key==='ArrowRight'?1-index:null;
        if(next==null)return;event.preventDefault();switchTab(tabButtons[next].value);tabButtons[next].node.focus();
      });
    }
    // Shared filters operate on the active scopes without any account reads.
    const toolbar=el('div','inventory-toolbar');toolbar.setAttribute('aria-label','Inventory filters');
    const searchLabel=el('label','inventory-search','Search inventory');const search=el('input');search.type='search';search.placeholder='Names and owned perks…';search.setAttribute('aria-label','Search inventory');search.value=inventoryState.query;searchLabel.append(search);toolbar.append(searchLabel);inventoryControls.push({node:search});
    // Shared filters reset every visible section page while preserving location choices.
    function filter(field,labelText,choices){
      const label=el('label','filter-label',labelText);const input=el('select');input.setAttribute('aria-label',labelText);
      for(const [value,text] of choices){const option=el('option','',text);option.value=value;input.append(option);}input.value=inventoryState[field];label.append(input);toolbar.append(label);inventoryControls.push({node:input});
      input.onchange=()=>{if(!current()||busy)return;inventoryState[field]=input.value;resetPages();renderSections();};
    }
    filter('verdict','Recommendation match',[['all','All weapons'],['complete','Full matches'],['partial','Some matches'],['different','No matches'],['unscored','Unscored']]);
    search.oninput=()=>{if(!current()||busy)return;inventoryState.query=search.value;resetPages();renderSections();};
    const scopeHeading=el('div','inventory-scope-heading'),main=el('div','inventory-main'),auxiliary=el('div','inventory-auxiliary');
    panel.append(scopeHeading,main);gear.append(tabs,toolbar,panel,auxiliary);
    // Re-register only current section controls; detached page buttons are never enabled again.
    const baseControls=inventoryControls.slice();let scopeGeneration=0,sectionGeneration=0,characterControl;
    let scopes;
    function renderScope(){
      if(!current())return;
      const generation=++scopeGeneration;const scopeCurrent=()=>current()&&scopeGeneration===generation;
      scopes=locationScopes(entries,snapshot.characters,inventoryState.characterId);inventoryState.characterId=scopes.selectedCharacterId;
      // Scope generation guards the selector; section generation guards rows and disclosure state.
      for(const tab of tabButtons){const selected=inventoryState.tab===tab.value;tab.node.setAttribute('aria-selected',String(selected));tab.node.setAttribute('tabindex',selected?'0':'-1');}
      panel.setAttribute('aria-labelledby',`inventory-tab-${inventoryState.tab}`);
      scopeHeading.replaceChildren();characterControl=null;
      if(inventoryState.tab==='characters'&&snapshot.characters.length){
        const label=el('label','filter-label','Character'),selector=el('select');selector.setAttribute('aria-label','Inventory character');
        for(const character of snapshot.characters){const option=el('option','',`${character.className||'Character'} · ${character.id}`);option.value=String(character.id);selector.append(option);}
        // Reuse the attached selector through character changes to preserve its focus.
        selector.value=inventoryState.characterId;label.append(selector);scopeHeading.append(label);characterControl={node:selector};
        selector.onchange=()=>{
          if(!scopeCurrent()||busy||!snapshot.characters.some(character=>String(character.id)===selector.value))return;
          inventoryState.characterId=selector.value;resetPages();inventoryState.disclosures={};
          scopes=locationScopes(entries,snapshot.characters,inventoryState.characterId);renderSections();
        };
      } else scopeHeading.append(el('h2','',inventoryState.tab==='vault'?'Vault':'Characters'));
      renderSections();
    }
    function renderSections(){
      if(!current())return;
      const generation=++sectionGeneration;const sectionCurrent=()=>current()&&sectionGeneration===generation;
      inventoryControls=baseControls.slice();if(characterControl)inventoryControls.push(characterControl);
      // Filter changes restore auxiliary disclosure state while rebuilding lazy item rows.
      main.replaceChildren();auxiliary.replaceChildren();
      const character=snapshot.characters.find(c=>String(c.id)===inventoryState.characterId);
      const owner=character?`${character.className||'Character'} · ${character.id}`:'Characters';
      const title=inventoryState.tab==='vault'?'Vault':`${owner} — equipped and carried`;
      renderList(main,inventoryState.tab==='vault'?scopes.vault:scopes.character,'main',title,sectionCurrent);
      if(inventoryState.tab==='characters'&&scopes.postmaster.length)renderDisclosure(scopes.postmaster,'postmaster',`Postmaster · ${owner}`,sectionCurrent);
      if(scopes.other.length)renderDisclosure(scopes.other,'other','Account / other',sectionCurrent);
      updateControls();
    }
    // Auxiliary stores remain separate from carried/vault rows and paginate independently.
    function renderDisclosure(rows,key,title,sectionCurrent){
      const disclosure=el('details','inventory-extra');disclosure.open=Boolean(inventoryState.disclosures[key]);
      disclosure.append(el('summary','',`${title} · ${rows.length.toLocaleString()} weapons`));const content=el('div','inventory-extra-content');disclosure.append(content);auxiliary.append(disclosure);
      disclosure.addEventListener('toggle',()=>{if(sectionCurrent())inventoryState.disclosures[key]=disclosure.open;});
      renderList(content,rows,key,title,sectionCurrent);
    }
    function renderList(container,scopedEntries,key,title,sectionCurrent){
      const count=el('p','inventory-results');count.setAttribute('role','status');count.setAttribute('aria-live','polite');
      const list=el('div',key==='main'?'inventory-list':'inventory-list inventory-extra-list');list.setAttribute('aria-label',`${title} weapons`);
      const pagination=el('div','inventory-pagination');const previous=el('button','','Previous page'),next=el('button','','Next page'),pageLabel=el('span','muted');
      // Distinct page labels let assistive technology identify the controlled scope.
      previous.setAttribute('aria-label',`Previous page — ${title}`);next.setAttribute('aria-label',`Next page — ${title}`);pagination.append(previous,pageLabel,next);container.append(count,list,pagination);
      let selection,pageGeneration=0;
      inventoryControls.push({node:previous,disabled:()=>!selection||selection.page<=1},{node:next,disabled:()=>!selection||selection.page>=selection.pageCount});
      function renderRows(){
        if(!sectionCurrent())return;
        selection=selectEntries(scopedEntries,{...inventoryState,page:inventoryState.pages[key]});inventoryState.pages[key]=selection.page;
        // A stale page or scope cannot open details or navigate to its sheet row.
        const generation=++pageGeneration;const rowCurrent=()=>sectionCurrent()&&pageGeneration===generation;
        count.textContent=`${title}: Showing ${selection.from}–${selection.to} of ${selection.filteredCount.toLocaleString()} filtered / ${selection.totalCount.toLocaleString()} weapons · ${selection.completeCount.toLocaleString()} complete matches in this section`;
        list.replaceChildren(...selection.rows.map(entry=>inventoryRow(entry,rowCurrent)));
        if(!selection.rows.length)list.append(el('p','empty-state',!snapshot.characters.length&&inventoryState.tab==='characters'&&key==='main'?'This saved profile has no characters. Choose Vault to browse stored items.':'No weapons match these filters.'));
        // Page generation invalidates detached lazy details and their sheet references.
        pageLabel.textContent=`Page ${selection.page} of ${selection.pageCount}`;
        previous.onclick=()=>{if(!rowCurrent()||busy||selection.page<=1)return;inventoryState.pages[key]=selection.page-1;renderRows();};
        next.onclick=()=>{if(!rowCurrent()||busy||selection.page>=selection.pageCount)return;inventoryState.pages[key]=selection.page+1;renderRows();};
        updateControls();
      }
      renderRows();
    }
    renderScope();
    updateControls();
  }
  async function readSaved(key,current=()=>!stopped()) {
    const value=await storage.loadSnapshot(key);
    // Storage reads may finish after cancellation; only the current action owns the view.
    if(!current())return false;
    if(value&&(!accountKey(value)||!Array.isArray(value.characters)||!Array.isArray(value.items)))throw new Error('Saved inventory has an unsupported format. Refresh this account to replace it; the saved data has been retained.');
    snapshot=value;renderGear();return true;
  }
  async function run(action) {
    if(busy||stopped())return;busy=true;const controller=new AbortController();operation=controller;const token=++revision;const current=()=>!stopped()&&!controller.signal.aborted&&revision===token;
    // Bind each action to its own controller; disconnect invalidates its revision.
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});updateControls();
    try{await action(controller.signal,current);}catch(error){if(current())report(error.message||'The action failed. Your previous saved inventory is retained.',true);}
    // Rebind retained-snapshot handlers to the completed action's generation.
    finally{signal?.removeEventListener('abort',abort);if(revision===token){busy=false;renderGear();}}
  }
  connect.onclick=()=>run(async()=>{snapshot=null;membership=null;memberships=[];options(membershipSelect,[],'Choose account',accountKey,accountKey);renderGear();report('Opening Bungie sign-in…');await auth.connect(config);});
  choose.onclick=()=>run(async(actionSignal,current)=>{
    report('Resolving Destiny accounts…');const list=await auth.getMemberships(config,{signal:actionSignal});if(!current())return;
    memberships=list;membership=null;snapshot=null;renderGear();options(membershipSelect,list,'Choose Destiny account',accountKey,m=>`${m.displayName||'Destiny account'} · ${accountKey(m)}`);
    const selected=auth.getSession()?.selectedAccount;const primary=list.find(m=>accountKey(m)===selected)||(list.length===1?list[0]:null);
    // Persist the selected Destiny membership before reading account-partitioned data.
    if(primary){membership=primary;auth.selectAccount(accountKey(membership));membershipSelect.value=accountKey(membership);if(!await readSaved(accountKey(membership),current))return;savedSelect.value=accountKey(snapshot);}
    if(!current())return;
    report(primary?'Destiny account selected. Refresh and Save to update inventory.':list.length?'Choose an account, then Refresh and Save.':'This session has no available Destiny memberships.');
  });
  membershipSelect.onchange=()=>run(async(_actionSignal,current)=>{
    membership=memberships.find(m=>accountKey(m)===membershipSelect.value)||null;
    // Account selection cancels prior account operations and never relabels old gear.
    snapshot=null;renderGear();
    if(membership){auth.selectAccount(accountKey(membership));if(!await readSaved(accountKey(membership),current))return;}
    if(!current())return;
    savedSelect.value=accountKey(snapshot);report('Account selected. Refresh and Save remains explicit.');
  });
  savedSelect.onchange=()=>run(async(_actionSignal,current)=>{
    const key=savedSelect.value;membership=null;membershipSelect.value='';snapshot=null;renderGear();
    if(key&&!await readSaved(key,current))return;
    if(!current())return;
    report('Viewing saved offline inventory. Choose a connected account to refresh.');
  });
  refresh.onclick=()=>run(async(actionSignal,current)=>{
    // Capture the account at the start; only a complete import may reach storage.
    const selected=membership;report('Reading inventory… Previous saved inventory is retained until the completed import saves.');
    const next=await inventory.importInventory(config,selected,{signal:actionSignal,onProgress:progress=>{if(current())report(typeof progress==='string'?progress:progress?.message||'Reading inventory and item definitions…');}});
    // A disconnected or superseded action cannot commit gear from its old account.
    if(!current())return;
    if(accountKey(next)!==accountKey(selected))throw new Error('The import returned a different account. Nothing was saved.');
    if(!Number.isFinite(Date.parse(next.responseMintedTimestamp)))throw new Error('The import has no valid Bungie timestamp. Nothing was saved.');
    if(!Array.isArray(next.characters)||!Array.isArray(next.items))throw new Error('The import is incomplete. Nothing was saved.');
    // Storage owns atomicity, freshness and cancellation up to transaction commit.
    await storage.saveSnapshot(next,{signal:actionSignal});if(!current())return;
    snapshot=next;renderGear();report('Saved. This inventory is available offline in this browser.');
    try{await savedList(current);}catch{if(current())report('Inventory saved, but the saved-account list could not be updated.',true);}
  });
  disconnect.onclick=async()=>{
    cancel();const token=revision;const current=()=>!stopped()&&revision===token;
    busy=true;disconnecting=true;updateControls();
    try{await auth.disconnect();if(!current())return;membership=null;memberships=[];options(membershipSelect,[],'Choose account',accountKey,accountKey);report('Disconnected. The labelled saved inventory is still available offline.');}
    catch(error){if(current())report(error.message,true);}
    finally{if(current()){busy=false;disconnecting=false;renderGear();}}
  };
  clear.onclick=()=>{confirmation.hidden=false;confirmClear.focus();};cancelClear.onclick=()=>{confirmation.hidden=true;clear.focus();};
  confirmClear.onclick=()=>run(async(_actionSignal,current)=>{
    const key=accountKey(snapshot);await storage.clearSnapshot(key);if(!current())return;
    snapshot=null;renderGear();if(!await savedList(current))return;
    report('Saved inventory cleared for this account.');clear.focus();
  });

  // Loading modules and local JSON is safe on entry; never resolve memberships here.
  const dependencies=await Promise.allSettled([import('../account/auth.js'),import('../account/storage.js'),import('../account/inventory.js'),import('../account/compare.js'),import('../account/config.js'),load('bungie-map')]);
  if(stopped())return page;
  [auth,storage,inventory,compare,,map]=dependencies.map(r=>r.status==='fulfilled'?r.value:null);
  const configuration=dependencies[4].status==='fulfilled'?dependencies[4].value:null;
  let setupError,integrityError;
  if(configuration){
    try{const loaded=await configuration.loadConfig();if(!startupCurrent())return page;config=loaded;}catch(error){if(!startupCurrent())return page;setupError=error;}
    if(setupError?.secureUrl){
      // Configuration supplies the HTTPS origin registered for the OAuth callback.
      try{
        const destination=new URL(setupError.secureUrl);
        if(destination.protocol==='https:'&&!destination.username&&!destination.password){
          destination.hash='/loadout';
          if(!secureLink){secureLink=el('a','loadout-secure-link','Open hosted HTTPS site ↗');notice.after(secureLink);}
          secureLink.href=destination.href;
        }
      }catch{/* Keep the assigned hosted destination when setup metadata is invalid. */}
    }
    if(map){
      try{
        const comparisonManifest={...manifest,tabs:Object.fromEntries(Object.entries(manifest.tabs).filter(([id])=>id!=='primaries'))};
        const verifiedTables=await configuration.loadVerifiedTables(comparisonManifest,map,{signal});
        if(!startupCurrent())return page;tables=verifiedTables;
        if(!map.integrityVerified)throw new Error('Recommendation fingerprints have not been verified.');
      }catch(error){if(!startupCurrent())return page;integrityError=error;map=null;}
    }
  }
  if(stopped())return page;
  options(membershipSelect,[],'Choose account',accountKey,accountKey);options(savedSelect,[],'Choose saved inventory',accountKey,accountKey);
  renderGear();
  const errors=[];
  const session=auth?.getSession();
  memberships=Array.isArray(session?.memberships)?session.memberships:[];
  membership=memberships.find(m=>accountKey(m)===session?.selectedAccount)||null;
  options(membershipSelect,memberships,'Choose Destiny account',accountKey,m=>`${m.displayName||'Destiny account'} · ${accountKey(m)}`);
  membershipSelect.value=accountKey(membership);
  // An ambiguous/new connected account must not inherit the last offline pointer.
  if(storage){try{
    if(!session){if(!await readSaved(undefined,startupCurrent))return page;}
    else if(session.selectedAccount){if(!await readSaved(session.selectedAccount,startupCurrent))return page;if(snapshot&&accountKey(snapshot)!==session.selectedAccount){snapshot=null;renderGear();}}
    if(!await savedList(startupCurrent))return page;
  }catch(error){if(!startupCurrent())return page;errors.push(error.message);}}else errors.push('Local inventory storage is unavailable.');
  if(!startupCurrent())return page;
  if(!config)errors.push(`Bungie setup required: ${setupError?.message||dependencies[4].reason?.message||'configure the public API key, client ID and registered HTTPS callback.'}`);
  if(!auth||!inventory)errors.push('Account modules are unavailable. Connection and refresh require the account integration.');
  if(!map?.integrityVerified||!compare)errors.push(integrityError?.message||'The local comparison map or tables are unavailable. Saved gear can still be reviewed.');
  if(errors.length)report(errors.join('\n'),true);else report(membership?'Account selected from this session. Refresh and Save to update inventory.':'Showing local saved data. Choose account and Refresh and Save to update it.');
  updateControls();return page;
}
