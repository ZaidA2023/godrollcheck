import {el, plain, icon, openItem, setParams, heading} from '../data.js';
import {table, comment, visibleColumns} from '../components/table.js';
export function weapons(tab, meta, manifest, params) {
  const page=el('section','weapons-page');
  page.append(heading(meta));
  const switcher=el('div','type-switcher');
  const label=el('label','','Weapon type'); const select=el('select');select.setAttribute('aria-label','Weapon type');
  manifest.groups.find(g=>g.id==='weapons').tabs.forEach(id=>{const o=el('option','',manifest.tabs[id].title);o.value=id;o.selected=id===tab.id;select.append(o);});
  select.onchange=()=>{location.hash=manifest.tabs[select.value].route;};label.append(select);switcher.append(label);
  const segments=el('div','segmented');
  ['tier','table'].forEach(v=>{const b=el('button',params.get('view')===v||v==='tier'&&!params.get('view')?'active':'',v==='tier'?'Tier view':'Table view');b.setAttribute('aria-pressed',String(b.className==='active'));b.onclick=()=>setParams({view:v});segments.append(b);});
  switcher.append(segments);page.append(switcher);
  const controls=el('div','filter-panel');
  const q=el('input');q.type='search';q.placeholder='Filter names, perks, notes…';q.setAttribute('aria-label','Filter weapons');q.value=params.get('q')||'';
  let timer;q.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>setParams({q:q.value},true),200);};controls.append(q);
  for(const [field,labelText] of [['element','Element'],['frame','Frame'],['source','Source'],['season','Season'],['tier','Tier']]) {
    if(!tab.records.some(r=>plain(r[field])))continue;
    const label=el('label','filter-label',labelText);const s=el('select');s.setAttribute('aria-label',labelText);
    const all=el('option','',`All ${labelText.toLowerCase()}s`);all.value='';s.append(all);
    [...new Set(tab.records.map(r=>plain(r[field])).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).forEach(v=>{const o=el('option','',v);o.value=v;s.append(o);});
    s.value=params.get(field)||'';s.onchange=()=>setParams({[field]:s.value});label.append(s);controls.append(label);
  }
  const reset=el('button','reset-button','Reset');reset.onclick=()=>setParams({q:null,element:null,frame:null,source:null,season:null,tier:null});controls.append(reset);page.append(controls);
  const query=(params.get('q')||'').toLocaleLowerCase();
  const records=tab.records.filter(r=>['element','frame','source','season','tier'].every(f=>!params.get(f)||plain(r[f])===params.get(f))&&(!query||Object.values(r).map(plain).join(' ').toLocaleLowerCase().includes(query)));
  const summary=el('div','results-summary');summary.append(el('span','',`${records.length} / ${tab.records.length} weapons`),el('span','muted','SELECT AN ITEM FOR ROLLS & ANALYSIS'));page.append(summary);
  if(params.get('view')==='table') {
    // Evaluation and recommended rolls lead; descriptive metadata stays to the right.
    const defaults=['tier','rank','icon','name','barrel','mag','masterwork','perk1','perk2','originTrait','notes','element','frame','source'];
    const selector=el('details','column-selector');selector.append(el('summary','','Columns'));
    const choices=el('div','column-choices');const chosen=new Set(defaults);
    const visible=visibleColumns(tab.columns,tab.records,meta);
    const columns=defaults.map(field=>visible.find(column=>column.field===field)).filter(Boolean).concat(visible.filter(column=>!defaults.includes(column.field)));
    const host=el('div');const render=()=>host.replaceChildren(table(records,columns.filter(column=>chosen.has(column.field)),{...meta,stunLabels:manifest.stunLabels},'rank'));
    columns.forEach(c=>{const l=el('label');const checkbox=el('input');checkbox.type='checkbox';checkbox.checked=chosen.has(c.field);checkbox.onchange=()=>{checkbox.checked?chosen.add(c.field):chosen.delete(c.field);render();};l.append(checkbox,document.createTextNode(c.label));choices.append(l);});selector.append(choices);page.append(selector,host);render();
  } else {
    const tiers=['S','A','B','C','D','E','F',...new Set(records.map(r=>r.tier||'N/A').filter(t=>!['S','A','B','C','D','E','F'].includes(t)))];
    tiers.forEach(t=>{
      const rows=records.filter(r=>(r.tier||'N/A')===t).sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity));if(!rows.length)return;
      const section=el('section',`tier-section tier-${t}`);const bar=el('div','tier-heading');
      bar.append(el('h2','',`${t} TIER`),el('span','',`${rows.length} WEAPONS`));section.append(bar);
      const grid=el('div','weapon-grid');rows.forEach(r=>{
        const card=el('article','weapon-card');const b=el('button','weapon-card-main');
        b.onclick=()=>openItem({type:'weapon',id:r.id});
        const image=icon(r.icon,r.name);const info=el('div','weapon-card-info');info.append(el('span','weapon-rank',`Rank ${r.rank}`),el('h3','',r.name));
        if(r.variant)info.append(el('small','variant',r.variant));
        const line=el('div','card-meta');line.append(el('span',`element-dot element-${(r.element||'').toLowerCase()}`,r.element||'—'),el('span','',plain(r.frame)));info.append(line,el('p','card-source',r.source||'—'));
        b.append(image,info);card.append(b);
        if(r.stunIcon){const stun=icon(r.stunIcon,manifest.stunLabels[r.stunIcon]||'Champion stun','stun-icon');stun.title=manifest.stunLabels[r.stunIcon]||'';card.append(stun);}
        if(r.notes){const d=el('details','card-notes');const s=el('summary','','Analysis');s.title=r.notes;d.append(s,el('p','',r.notes));card.append(d);}
        if(r.comments?.name)card.append(comment(r.comments.name));grid.append(card);
      });section.append(grid);page.append(section);
    });
    if(!records.length)page.append(el('p','empty-state','No weapons match these filters. Try resetting them.'));
  }
  return page;
}
