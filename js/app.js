import {load,el,routeState} from './data.js';
import {home} from './views/home.js';
import {weapons} from './views/weapons.js';
import {reference} from './views/reference.js';
import {status} from './views/status.js';
import {changelog} from './views/changelog.js';
import {installSearch} from './components/search.js';
import {syncDrawer} from './components/drawer.js';
const app=document.getElementById('app');let generation=0, routeController;
function theme(value) {
  document.documentElement.dataset.theme=value;
  const b=document.getElementById('theme-toggle');b.textContent=value==='dark'?'☼':'☾';b.setAttribute('aria-label',`Switch to ${value==='dark'?'light':'dark'} theme`);
  try{localStorage.setItem('endgame-theme',value);}catch{}
}
try{theme(localStorage.getItem('endgame-theme')||'dark');}catch{theme('dark');}
document.getElementById('theme-toggle').onclick=()=>theme(document.documentElement.dataset.theme==='dark'?'light':'dark');
document.getElementById('menu-toggle').onclick=()=>{const open=document.body.classList.toggle('nav-open');document.getElementById('menu-toggle').setAttribute('aria-expanded',String(open));};
try {
  const manifest=await load('manifest');
  // Hide the retired view without changing audited workbook bytes used by perk matching.
  delete manifest.tabs.primaries;
  manifest.groups=manifest.groups.map(group=>({...group,tabs:group.tabs.filter(id=>id!=='primaries')})).filter(group=>group.tabs.length);
  const nav=document.getElementById('navigation');
  const homeLink=el('a','nav-link','Home');homeLink.href='#/';homeLink.dataset.home='true';nav.append(homeLink);
  const personal=el('div','nav-group');personal.append(el('h2','','Personal tools'));
  const loadoutLink=el('a','nav-link','My Inventory');loadoutLink.href='#/loadout';loadoutLink.dataset.tab='loadout';personal.append(loadoutLink);nav.append(personal);
  manifest.groups.forEach(group=>{
    const section=el('div','nav-group');section.append(el('h2','',group.title));
    group.tabs.forEach(id=>{const tab=manifest.tabs[id];const a=el('a','nav-link');a.href=tab.route;a.append(el('span','',tab.title),el('small','',String(tab.count)));a.dataset.tab=id;section.append(a);});nav.append(section);
  });
  document.getElementById('snapshot-date').textContent=new Date(manifest.generated).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
  installSearch(manifest);
  let previousPath='', previousView='', pendingView='';
  async function render() {
    const version=++generation;const {path,params}=routeState();
    const isHome=path==='#/';const isLoadout=path==='#/loadout';
    const meta=isHome?{id:'home',title:'Home',kind:'home'}:isLoadout?{id:'loadout',title:'My Inventory',kind:'loadout'}:Object.values(manifest.tabs).find(t=>t.route===path);
    const viewParams=new URLSearchParams(params);viewParams.delete('item');const viewKey=path+'?'+viewParams.toString();
    // Item-only navigation keeps table state and the actual opener DOM node alive.
    if(viewKey===previousView&&pendingView===previousView){await syncDrawer(params.get('item'),manifest);return;}
    pendingView=viewKey;
    routeController?.abort();routeController=new AbortController();
    const signal=routeController.signal;
    if(!meta){previousView='';app.replaceChildren(el('h1','','Page not found'),el('p','','Choose a section in the field guide.'));await syncDrawer(null,manifest);return;}
    const active=document.activeElement;const saved=active?.tagName==='INPUT'&&app.contains(active)?{label:active.getAttribute('aria-label'),start:active.selectionStart,end:active.selectionEnd}:null;
    try {
      const tab=isHome||isLoadout?null:await load(meta.id);if(version!==generation)return;
      const renderer={weapon:weapons,reference,status,changelog}[meta.kind];
      // Await personal views so stale routes cannot replace the current page.
      const content=isLoadout?await (await import('./views/loadout.js?v=20261008-perk-choices')).loadout(manifest,params,{signal}):isHome?home(manifest):await renderer(tab,meta,manifest,params);
      if(version!==generation||signal.aborted)return;
      app.replaceChildren(content);document.title=`${meta.title} · Endgame Analysis`;
      nav.querySelectorAll('a').forEach(a=>{const current=isHome?a.dataset.home==='true':a.dataset.tab===meta.id;a.classList.toggle('active',current);if(current)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
      if(previousPath!==path){document.body.classList.remove('nav-open');document.getElementById('menu-toggle').setAttribute('aria-expanded','false');if(previousPath)window.scrollTo(0,0);}
      previousPath=path;previousView=viewKey;
      if(saved){const input=[...app.querySelectorAll('input')].find(i=>i.getAttribute('aria-label')===saved.label);if(input){input.focus();if(input.type!=='search')input.setSelectionRange(saved.start,saved.end);}}
      await syncDrawer(params.get('item'),manifest);
    } catch(error){if(version===generation)app.replaceChildren(el('h1','','Unable to load this view'),el('p','',error.message));}
  }
  window.addEventListener('hashchange',render);
  window.addEventListener('pagehide',()=>routeController?.abort());
  if(!location.hash)history.replaceState(null,'','#/');
  await render();
} catch(error){app.replaceChildren(el('h1','','Unable to load the field guide'),el('p','',error.message));}
