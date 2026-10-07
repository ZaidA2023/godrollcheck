import {load, el} from '../data.js';
export function installSearch(manifest) {
  const input=document.getElementById('global-search'), results=document.getElementById('search-results');
  let timer, generation=0;
  const hide=()=>{results.hidden=true;input.setAttribute('aria-expanded','false');};
  input.addEventListener('input',()=>{
    clearTimeout(timer);const version=++generation;
    const query=input.value.trim().toLocaleLowerCase();
    if (!query) {hide();return;}
    timer=setTimeout(async()=>{
      try {
        const data=await load('search');if(version!==generation)return;
        const rank=n=>n===query?0:n.startsWith(query)?1:n.includes(query)?2:query.split(/\s+/).every(t=>n.includes(t))?3:9;
        const matches=data.map(r=>({...r,rank:rank(r.n.toLocaleLowerCase())})).filter(r=>r.rank<9).sort((a,b)=>a.rank-b.rank||a.n.localeCompare(b.n)).slice(0,20);
        results.replaceChildren(el('div','search-heading',matches.length?'SEARCH RESULTS':'No matching items'));
        matches.forEach(r=>{
          const a=el('a','search-result');
          const params=new URLSearchParams({item:`${r.t}:${r.i}`});
          a.href=manifest.tabs[r.k].route+'?'+params.toString();
          a.append(el('span','',r.n),el('small','',manifest.tabs[r.k].title));a.onclick=hide;results.append(a);
        });
        results.hidden=false;input.setAttribute('aria-expanded','true');
      } catch(error){results.replaceChildren(el('p','',error.message));results.hidden=false;}
    },160);
  });
  input.addEventListener('keydown',e=>{
    if(e.key==='Escape'){hide();input.blur();}
    if(e.key==='ArrowDown'){e.preventDefault();results.querySelector('a')?.focus();}
    if(e.key==='Enter'){const a=results.querySelector('a');if(a){a.click();hide();}}
  });
  results.addEventListener('keydown',e=>{
    const links=[...results.querySelectorAll('a')],i=links.indexOf(document.activeElement);
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();links[(i+(e.key==='ArrowDown'?1:links.length-1))%links.length]?.focus();}
    if(e.key==='Escape'){hide();input.focus();}
  });
  document.addEventListener('click',e=>{if(!e.target.closest('.global-search'))hide();});
  document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!document.getElementById('drawer').open){e.preventDefault();input.focus();}});
}
