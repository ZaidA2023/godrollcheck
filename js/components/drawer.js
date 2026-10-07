import {el, resolve, icon, setParams, externalLink} from '../data.js';
import {cell, comment, visibleColumns, hasValue} from './table.js';
const dialog = document.getElementById('drawer');
let opener = null, current = null, ticket = 0;
export function closeDrawer() { setParams({item:null}); }
dialog.addEventListener('cancel', e => { e.preventDefault(); closeDrawer(); });
dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDrawer(); } });
// Native modal dialog supplies focus containment and inert background.
export async function syncDrawer(item, manifest) {
  const version = ++ticket;
  if (!item) {
    if (dialog.open) dialog.close();
    if (current) {
      const focusTarget=opener?.isConnected&&!opener.closest('[hidden]')?opener:document.getElementById('global-search');
      focusTarget?.focus();
    }
    current = null; return;
  }
  if (current === item && dialog.open) return;
  const split = item.indexOf(':');
  if (split < 0) return;
  const ref = {type:item.slice(0,split),id:item.slice(split+1)};
  const meta = manifest.tabs[ref.id.split(':')[0]];
  if (!meta?.refType || meta.refType !== ref.type) return;
  try {
    const {tab, record} = await resolve(ref);
    if (version !== ticket) return;
    if (!dialog.open) opener = document.activeElement;
    const root = document.getElementById('drawer-content'); root.replaceChildren();
    const top = el('div', 'drawer-top'); top.append(el('span', 'eyebrow', meta.title));
    const close = el('button', 'icon-button', '×'); close.setAttribute('aria-label','Close details'); close.onclick = closeDrawer; top.append(close);
    const title = el('h2', '', record.name); title.id = 'drawer-title';
    const hero = el('div', 'drawer-hero'); hero.append(icon(record.icon,record.name),title);
    root.append(top,hero);
    if (record.variant) root.append(el('p','variant',record.variant));
    if (record.source) root.append(el('p','muted',record.source));
    const details = el('dl','drawer-details');
    const columns = visibleColumns(tab.columns,tab.records,meta);
    const omitted = ['icon','name','source','icon2'];
    if (record.mods) columns.push({field:'mods',label:'Mods',type:'text'});
    for (const c of columns) {
      if (omitted.includes(c.field)) continue;
      const value = c.field.split('.').reduce((v,k)=>v?.[k],record);
      if (!hasValue(value)) continue;
      const block = el('div','detail-block'); block.append(el('dt','',c.label),el('dd'));
      if(c.field==='notes') { block.lastChild.append(el('p','',value));if(record.comments?.notes)block.lastChild.append(comment(record.comments.notes)); }
      else block.lastChild.append(cell(value,c,record,{...meta,stunLabels:manifest.stunLabels}));
      if (c.comment) block.firstChild.append(comment(c.comment));
      details.append(block);
    }
    root.append(details);
    // Comments on title/source/display-only fields remain visible in the detail view.
    for(const [field,text] of Object.entries(record.comments||{})) {
      if(meta.id==='set-bonuses' && field==='ordinal') continue;
      if(!columns.some(c=>c.field===field&&!omitted.includes(c.field))) {
        const note=el('div','detail-block');note.append(el('span','muted',field+' comment'),el('p','',text));root.append(note);
      }
    }
    if (tab.symbolLegend) root.append(el('p','legend-line',tab.symbolLegend.map(x=>`${x.symbol} ${x.text}`).join(' · ')));
    if (record.itemHash) root.append(externalLink({text:'View on light.gg ↗',url:`https://www.light.gg/db/items/${record.itemHash}/`}));
    current=item;
    if (!dialog.open) dialog.showModal();
    close.focus();
  } catch (error) {
    if (version !== ticket) return;
    const root=document.getElementById('drawer-content');root.replaceChildren(el('p','',error.message));
    const b=el('button','','Close');b.onclick=closeDrawer;root.append(b);
    if (!dialog.open) dialog.showModal();
  }
}
