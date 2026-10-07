import {el,heading,externalLink} from '../data.js';
export function status(tab,meta,manifest) {
  const page=el('section','status-page');page.append(heading(meta,'Snapshot coverage and the latest workbook news.'));
  if(tab.newsBlock){const news=el('aside','news-block');news.append(el('h2','','Field notes'),el('p','',tab.newsBlock));page.append(news);}
  const grid=el('div','status-grid');
  tab.rows.forEach(r=>{
    const card=el('article','status-card');const name=r.tabId?el('a','',r.tab):el('h3','',r.tab);if(r.tabId)name.href=manifest.tabs[r.tabId].route;
    card.append(name,el('span','status-label',r.status||'—'),el('p','muted',r.updated||'—'));grid.append(card);
  });page.append(grid);
  const footer=el('div','status-footnotes');tab.footnotes.forEach(f=>footer.append(el('p','',f)));tab.links.forEach(l=>footer.append(externalLink(l)));page.append(footer);return page;
}
