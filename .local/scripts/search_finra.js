#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const ROOT = process.cwd();
const EXTERNAL = path.join(ROOT, 'data', 'external');
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; research-tool/1.0)', Accept: 'application/json' };

function secSearchUrl(term, start = 0) {
  return `https://api.adviserinfo.sec.gov/search?q=${encodeURIComponent(term)}&hl=true&nrows=100&start=${start}&wt=json`;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchSearchResults(term) {
  try {
    const url = secSearchUrl(term);
    console.log('Searching SEC for:', term);
    const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    const data = res.data;
    const filename = `sec_search_${term.replace(/[^a-z0-9]/gi, '_')}.json`;
    await fs.mkdir(EXTERNAL, { recursive: true });
    await fs.writeFile(path.join(EXTERNAL, filename), JSON.stringify(data, null, 2), 'utf-8');
    console.log(`Saved ${filename}`);
    return data;
  } catch (e) {
    console.warn('Search failed for', term, e.message);
    return null;
  }
}

async function main() {
  for (const term of [
    'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'rodriguez', 'martinez',
    'hernandez', 'lopez', 'gonzalez', 'wilson', 'anderson', 'thomas', 'taylor', 'moore', 'jackson', 'martin',
    'lee', 'perez', 'thompson', 'white', 'harris', 'sanchez', 'clark', 'ramirez', 'lewis', 'robinson',
  ]) {
    await fetchSearchResults(term);
    await sleep(1000); // Be polite
  }
  console.log('Search complete');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
