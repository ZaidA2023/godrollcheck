import {el} from '../data.js';

// Descriptions explain the section without inventing analysis beyond the snapshot.
const descriptions = {
  'exotic-weapons':'Exotic weapon effects, uses and endgame tier analysis.',
  perks:'Triggers, effects, enhancements and recommended uses.',
  'origin-traits':'Intrinsic traits and the notable weapons that carry them.',
  'set-bonuses':'Armor set bonuses, piece requirements and effect analysis.',
  subclasses:'Supers, offense, defense and complete subclass analysis.',
  aspects:'Class aspects, fragment slots, effects and recommended uses.',
  fragments:'Subclass fragments, stat changes and effect analysis.',
  'artifact-mods':'Seasonal artifact mods, unlock levels and effects.',
  'shopping-list':'Acquisition priorities, recommended rolls and alternatives.',
  encounters:'Encounter strategies, difficulty factors and scores.',
  status:'Workbook updates, section status and author news.',
  changelog:'Historical additions, tier changes and analysis updates.',
  primaries:'Primary weapon roles, recommendations and alternatives.'
};
export function catalogSections(manifest) {
  return manifest.groups.map(group=>({...group,sections:group.tabs.map(id=>{
    const tab=manifest.tabs[id];
    return {...tab,description:descriptions[id] || `${tab.title} ranked for the endgame, with recommended rolls, sources and analysis.`};
  })}));
}
export function home(manifest) {
  const page=el('section','home-page');
  const groups=catalogSections(manifest);
  const tabs=groups.flatMap(g=>g.sections);
  const hero=el('div','home-hero');
  const stats=el('div','home-stats');
  for(const [count,label] of [[tabs.length,'Workbook sections'],[tabs.reduce((n,t)=>n+t.count,0),'Total entries'],[tabs.filter(t=>t.kind==='weapon').reduce((n,t)=>n+t.count,0),'Ranked weapons']]) {
    const stat=el('div','home-stat');stat.append(el('strong','',count.toLocaleString()),el('span','',label));stats.append(stat);
  }
  hero.append(stats);page.append(hero);
  const tools=el('section','personal-tools');tools.append(el('h2','','Personal tools'));
  const loadout=el('a','catalog-card personal-tool');loadout.href='#/loadout';
  loadout.append(el('h3','','My Inventory'),el('p','','Browse every saved inventory item and highlight complete recommendation matches. Refresh and save only when you choose.'),el('span','catalog-arrow','Open My Inventory ↗'));tools.append(loadout);page.append(tools);
  const header=el('div','catalog-header');const intro=el('div');intro.append(el('h2','','Explore the catalog'),el('p','muted','Every section, organized by what you’re looking for.'));
  const search=el('input');search.type='search';search.placeholder='Find a section…';search.setAttribute('aria-label','Search catalog sections');header.append(intro,search);page.append(header);
  const summary=el('p','catalog-summary');summary.setAttribute('role','status');
  const catalog=el('div','catalog');page.append(summary,catalog);
  function render() {
    const query=search.value.trim().toLocaleLowerCase();let shown=0;catalog.replaceChildren();
    for(const group of groups) {
      const sections=group.sections.filter(t=>`${t.title} ${t.description}`.toLocaleLowerCase().includes(query));
      if(!sections.length)continue;
      shown+=sections.length;
      const section=el('section','catalog-group');const title=el('div','catalog-group-heading');
      title.append(el('h3','',group.title),el('span','muted',`${sections.length} / ${group.sections.length} sections`));section.append(title);
      const grid=el('div','catalog-grid');
      for(const tab of sections) {
        const card=el('a','catalog-card');card.href=tab.route;
        card.append(el('h4','',tab.title),el('p','',tab.description));
        const footer=el('div','catalog-card-footer');footer.append(el('span','',`${tab.count.toLocaleString()} entries`),el('span','catalog-arrow','↗'));card.append(footer);grid.append(card);
      }
      section.append(grid);catalog.append(section);
    }
    summary.textContent=`${shown} / ${tabs.length} sections`;
    if(!shown)catalog.append(el('p','empty-state','No sections match. Try a weapon type, perks or subclasses.'));
  }
  search.oninput=render;render();return page;
}
