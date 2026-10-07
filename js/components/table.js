import {el, icon, plain, valueAt, openItem, externalLink} from '../data.js';
// Visibility uses the full tab, so search/filter results never change its schema.
export const hasValue = value => value != null && value !== '' && (!Array.isArray(value) || value.some(hasValue));
export function visibleColumns(columns, records, meta) {
  return columns.filter(c => !(meta.id === 'set-bonuses' && c.field === 'ordinal') &&
    (['icon','name'].includes(c.field) || records.some(r => hasValue(valueAt(r,c.field)))));
}
const TIERS = ['S','A','B','C','D','E','F'];
export function compare(a, b, type) {
  if (type === 'metric') {
    const metric = v => {
      const s = plain(v).trim();
      if (s === 'INF') return [1, Infinity, ''];
      const n = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/.exec(s);
      return n ? [0, Number(n[0]), ''] : [2, 0, s];
    };
    const x = metric(a), y = metric(b);
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
  }
  if (type === 'number') {
    const x = a == null || a === '' ? NaN : Number(a), y = b == null || b === '' ? NaN : Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
    if (Number.isFinite(x)) return -1;
    if (Number.isFinite(y)) return 1;
  }
  if (type === 'tier') {
    const rank = v => TIERS.includes(plain(v)) ? TIERS.indexOf(plain(v)) : 7;
    return rank(a) - rank(b);
  }
  return plain(a).localeCompare(plain(b), undefined, {numeric:true});
}
export function comment(text, label = 'Analysis comment') {
  const detail = el('details', 'comment');
  const summary = el('summary', '', 'ⓘ'); summary.setAttribute('aria-label', label);
  detail.append(summary, el('div', 'comment-body', text));
  return detail;
}
export function cell(value, column, record, meta) {
  const wrap = el('div', 'cell-value');
  if (column.type === 'icon') {
    if (Array.isArray(value)) value.forEach(v => wrap.append(icon(v, record.name + ' aspect', 'aspect-icon')));
    else if (value || column.field === 'icon') {
      const image = icon(value, record.name, column.field === 'stunIcon' ? 'stun-icon' : '');
      if (column.field === 'stunIcon' && meta.stunLabels?.[value]) image.title = meta.stunLabels[value];
      wrap.append(image);
      if (column.field === 'stunIcon' && meta.stunLabels?.[value]) wrap.append(el('span','muted',meta.stunLabels[value]));
    } else wrap.append(el('span', 'muted', '—'));
  } else if (column.type === 'tier') wrap.append(el('span', `tier-badge tier-${plain(value) || 'na'}`, plain(value) || '—'));
  else if (column.type === 'ref' || column.type === 'reflist') {
    const values = Array.isArray(value) ? value : [value];
    values.forEach(v => {
      if (v?.ref) { const b = el('button', 'text-link', plain(v)); b.onclick = () => openItem(v.ref); wrap.append(b); }
      else wrap.append(el('span', '', plain(v) || '—'));
    });
  } else if (column.type === 'link') wrap.append(externalLink(value));
  else if (column.field === 'name' && meta.refType && meta.id !== 'archetypes') {
    const b = el('button', 'name-button', record.name); b.onclick = () => openItem({type:meta.refType, id:record.id}); wrap.append(b);
    if (record.variant) wrap.append(el('small', 'variant', record.variant));
  } else {
    const display = column.field === 'reserve' && meta.id === 'exotic-weapons' && value === 0 ? '—' : plain(value) || '—';
    const content = el('span', column.type === 'badge' ? `badge element-${plain(value).toLowerCase()}` : column.type === 'number' || column.field.endsWith('Score') ? 'numeric' : '', display);
    if (column.field === 'notes' && value) {
      const d = el('details', 'notes-detail'); const s = el('summary', '', 'Analysis'); s.title = display; d.append(s, el('p', '', display)); wrap.append(d);
    } else wrap.append(content);
    if (record[`${column.field}Score`] != null) { const score=el('span','numeric',String(record[`${column.field}Score`]));score.setAttribute('aria-label',`${column.label} score`);wrap.append(score); }
    if (column.field === 'name' && record.variant) wrap.append(el('small', 'variant', record.variant));
  }
  if (record.comments?.[column.field]) wrap.append(comment(record.comments[column.field], `${column.label} comment for ${record.name}`));
  return wrap;
}
export function table(records, columns, meta, defaultSort = null) {
  const container = el('div', 'data-table-wrap');
  let sortField = defaultSort, direction = 1;
  function render() {
    const focus = document.activeElement?.dataset.sort;
    container.replaceChildren();
    const t = el('table', 'data-table'); const head = el('thead'); const hr = el('tr');
    columns.forEach(c => {
      const th = el('th'); th.scope = 'col';
      if (c.type !== 'icon') {
        const b = el('button', 'sort-button', c.label + (sortField === c.field ? direction === 1 ? ' ↑' : ' ↓' : ' ↕'));
        b.dataset.sort = c.field;
        b.onclick = () => { direction = sortField === c.field ? -direction : 1; sortField = c.field; render(); };
        th.setAttribute('aria-sort', sortField === c.field ? direction === 1 ? 'ascending' : 'descending' : 'none'); th.append(b);
      } else th.append(el('span', 'sr-only', c.label));
      if (c.comment) th.append(comment(c.comment, `${c.label} header comment`));
      hr.append(th);
    });
    head.append(hr); t.append(head);
    const body = el('tbody');
    const sortColumn = columns.find(c => c.field === sortField);
    const ordered = [...records].sort((a,b) => sortField ? direction * compare(valueAt(a, sortField), valueAt(b, sortField), sortColumn?.type || 'number') : 0);
    ordered.forEach(r => {
      const tr = el('tr');
      columns.forEach(c => {
        const td = el('td'); td.dataset.label = c.label;
        td.append(cell(valueAt(r, c.field), c, r, meta)); tr.append(td);
      }); body.append(tr);
    });
    t.append(body); container.append(t);
    if (!records.length) container.append(el('p', 'empty-state', 'No records match these filters.'));
    if (focus) [...container.querySelectorAll('[data-sort]')].find(b => b.dataset.sort === focus)?.focus();
  }
  render(); return container;
}
