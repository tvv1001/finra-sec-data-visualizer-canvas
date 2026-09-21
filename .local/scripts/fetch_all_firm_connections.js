const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function main() {
  const firmIds = new Set();
  const output = execSync('find data/national -type f -name "*firm*.json"', { encoding: 'utf-8' });
  
  for (const file of output.split('\n')) {
    if (!file.trim()) continue;
    const match = file.match(/_firm_(\d+)\.json/);
    if (match && match[1]) {
      firmIds.add(match[1]);
    }
  }
  
  const firms = Array.from(firmIds);
  console.log(`Found ${firms.length} unique firms in data/national. Fetching connections...`);
  
  for (let i = 0; i < firms.length; i++) {
    const firmId = firms[i];
    console.log(`[${i + 1}/${firms.length}] Fetching connections for firm ${firmId}...`);
    try {
      const res = await fetch(`http://localhost:4444/api/finra/firm/${firmId}/connections`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      
      const curr = data.currentConnections?.length || 0;
      const prev = data.previousConnections?.length || 0;
      console.log(`  -> current: ${curr}, previous: ${prev}`);
      
      // Sleep to prevent rate limits
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`  -> Failed for ${firmId}:`, e.message);
    }
  }
  
  console.log('Finished updating all firm connections in local Redis!');
}

main().catch(console.error);
