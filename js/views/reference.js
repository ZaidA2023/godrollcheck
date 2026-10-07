import {el, heading, plain, setParams, externalLink} from '../data.js';
import {table, visibleColumns} from '../components/table.js';
export function reference(tab,meta,manifest,params) {
  const page=el('section','reference-page');
  page.append(heading(meta,meta.id==='primaries'?'Primary weapon roles and alternatives. A separate view of the workbook’s recommendations.':'The author’s analysis, preserved in full. Explore, sort and follow linked entries.'));
  const legends=el('div','legends');
  for(const entry of tab.tierLegend||[]) {const row=el('div','legend-entry');row.append(el('span',`tier-badge tier-${entry.tier}`,entry.tier),el('span','',entry.text));legends.append(row);}
  for(const entry of tab.symbolLegend||[])legends.append(el('span','symbol-legend',`${entry.symbol} ${entry.text}`));
  for(const note of tab.legendNotes||[])legends.append(el('p','legend-note',note));
  if(legends.childNodes.length)page.append(legends);
  (tab.links||[]).forEach(link=>page.append(externalLink(link)));
  const filters=el('div','reference-filter');const input=el('input');input.type='search';input.placeholder=`Search ${meta.title.toLowerCase()}…`;input.setAttribute('aria-label',`Search ${meta.title}`);input.value=params.get('q')||'';
  let timer;input.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>setParams({q:input.value},true),200);};filters.append(input);page.append(filters);
  const q=(params.get('q')||'').toLocaleLowerCase();
  const records=tab.records.filter(r=>!q||[...Object.values(r).map(plain),...Object.values(r.values||{}).map(plain)].join(' ').toLocaleLowerCase().includes(q));
  page.append(el('div','results-summary',`${records.length} / ${tab.records.length} entries`));
  page.append(table(records,visibleColumns(tab.columns,tab.records,meta),{...meta,stunLabels:manifest.stunLabels}));return page;
}
