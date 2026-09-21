#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
(async function main(){
  try{
    const f = path.join(process.cwd(),'data','national','finra-graph.json');
    const txt = await fs.readFile(f,'utf-8');
    const j = JSON.parse(txt);
    const nodes = Array.isArray(j.nodes)? j.nodes: [];
    const links = Array.isArray(j.links)? j.links: [];
    const totalIndividuals = nodes.filter(n => (n.group==='individual') || (String(n.id||'').startsWith('person:'))).length;
    const totalFirms = nodes.filter(n => (n.group==='firm') || (String(n.id||'').startsWith('firm:'))).length;
    const totalLinks = links.length;
    j.meta = { ...(j.meta||{}), generated: new Date().toISOString(), totalIndividuals, totalFirms, totalLinks };
    await fs.writeFile(f, JSON.stringify(j, null, 2), 'utf-8');
    console.log('Rewrote', f, 'meta:', { totalIndividuals, totalFirms, totalLinks });
  }catch(e){
    console.error(e);
    process.exit(1);
  }
})();
