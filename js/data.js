// One promise per file prevents duplicate loads while route and drawer resolve.
const cache = new Map();
export function load(id) {
  if (!cache.has(id)) cache.set(id, fetch(`data/${encodeURIComponent(id)}.json`).then(r => {
    if (!r.ok) throw new Error(`Could not load ${id} (${r.status})`);
    return r.json();
  }).catch(error => { cache.delete(id); throw error; }));
  return cache.get(id);
}
export const valueAt = (record, field) => field.split('.').reduce((v, k) => v?.[k], record);
export const plain = value => value == null ? '' : Array.isArray(value) ? value.map(plain).join('\n') : typeof value === 'object' ? value.text ?? '' : String(value);
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
export function icon(hash, name, className = '') {
  if (!hash) return el('span', `icon-placeholder ${className}`, '◇');
  const img = el('img', `item-icon ${className}`);
  img.src = `img/${hash}.webp`; img.alt = name || ''; img.loading = 'lazy'; img.width = 48; img.height = 48;
  return img;
}
export function routeState() {
  const hash = location.hash || '#/';
  const split = hash.indexOf('?');
  return {path: split < 0 ? hash : hash.slice(0, split), params: new URLSearchParams(split < 0 ? '' : hash.slice(split + 1))};
}
export function setParams(updates, replace = false) {
  const {path, params} = routeState();
  for (const [key, value] of Object.entries(updates)) value == null || value === '' ? params.delete(key) : params.set(key, value);
  const hash = path + (params.size ? '?' + params.toString() : '');
  if (replace) { history.replaceState(null, '', hash); window.dispatchEvent(new Event('hashchange')); }
  else if (hash !== location.hash) location.hash = hash;
}
export function openItem(ref, tab) {
  if (!ref) return;
  const {path, params} = routeState();
  params.set('item', `${ref.type}:${ref.id}`);
  const nextPath = tab?.route || path;
  location.hash = nextPath + '?' + params.toString();
}
export async function resolve(ref) {
  const tabId = ref.id.split(':')[0];
  const tab = await load(tabId);
  const record = tab.records.find(r => r.id === ref.id);
  if (!record) throw new Error('This item is not in the current snapshot.');
  return {tab, record};
}
export function externalLink(link) {
  if (!link?.url?.startsWith('https://')) return el('span', '', link?.text || '');
  const a = el('a', 'external-link', link.text || 'Source ↗'); a.href = link.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
export function heading(meta, subtitle) {
  const block = el('div', 'page-heading');
  block.append(el('div', 'eyebrow', 'DESTINY 2 / ' + meta.group.toUpperCase()), el('h1', '', meta.title));
  if(subtitle)block.append(el('p', 'page-description', subtitle));
  return block;
}
