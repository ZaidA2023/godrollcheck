import {el,heading,setParams,externalLink} from '../data.js';
export function changelog(tab,meta,manifest,params) {
  const page=el('section','changelog-page');page.append(heading(meta,'A history of the rankings. Track changes across seasons and expansions.'));
  const filters=el('div','reference-filter');const input=el('input');input.type='search';input.placeholder='Filter names and notes…';input.setAttribute('aria-label','Filter changelog');input.value=params.get('q')||'';
  let timer;input.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>setParams({q:input.value,page:null},true),200);};
  const select=el('select');select.setAttribute('aria-label','Changelog section');select.append(el('option','','All sections'));select.firstChild.value='';
  tab.sections.forEach(s=>{const o=el('option','',s.title);o.value=s.title;select.append(o);});select.value=params.get('section')||'';select.onchange=()=>setParams({section:select.value,page:null});filters.append(input,select);page.append(filters);
  const q=(params.get('q')||'').toLocaleLowerCase();let count=0;const entries=[];
  for(const section of tab.sections) {
    if(params.get('section')&&section.title!==params.get('section'))continue;
    for(const category of section.categories)for(const r of category.rows) {
      if(q&&!Object.values(r).join(' ').toLocaleLowerCase().includes(q))continue;
      entries.push({section:section.title,category:category.title,row:r,index:count});if(r.name)count++;
    }
  }
  const max=Math.max(1,Math.ceil(count/50)),num=Math.min(max,Math.max(1,Number(params.get('page'))||1)),start=(num-1)*50;
  page.append(el('div','results-summary',`${count} changes · Page ${num} of ${max}`));
  let lastSection,lastCategory;
  entries.filter(e=>e.index>=start&&e.index<start+50).forEach(({section,category,row:r})=>{
    if(section!==lastSection){page.append(el('h2','change-section',section));lastSection=section;lastCategory=undefined;}
    if(category!==lastCategory){if(category)page.append(el('h3','change-category',category));lastCategory=category;}
    if(r.raw){page.append(el('p','raw-change',r.raw));return;}
    const article=el('article','change-row');const name=r.tabLink?el('a','change-name',r.name):el('h4','change-name',r.name);if(r.tabLink)name.href=manifest.tabs[r.tabLink].route;
    const movement=el('div','change-movement');movement.append(el('span','',`${r.fromLabel}: ${r.from||'—'}`),el('span','change-arrow','→'),el('span','',`${r.toLabel}: ${r.to||'—'}`));
    article.append(name,movement,el('p','',r.notes));if(r.link)article.append(externalLink(r.link));page.append(article);
  });
  const pagination=el('div','pagination');for(const [label,n,disabled] of [['← Previous',num-1,num<=1],['Next →',num+1,num>=max]]){const b=el('button','',label);b.disabled=disabled;b.onclick=()=>{setParams({page:n});window.scrollTo({top:0,behavior:'smooth'});};pagination.append(b);}page.append(pagination);return page;
}
