const keywords = ['island', 'epstein', 'wig', 'quante', 'vamp', 'vacc', 'vax', 'vamp', 'quake', 'tornado'];

async function doSearch() {
  let totalFound = 0;
  for (const q of keywords) {
    try {
      const r1 = await fetch(`http://localhost:4444/api/finra/search?query=${q}&type=firm`).then(r => r.json());
      const r2 = await fetch(`http://localhost:4444/api/finra/search?query=${q}&type=individual`).then(r => r.json());
      
      const count1 = r1?.hits?.total || r1?.results?.length || 0;
      const count2 = r2?.hits?.total || r2?.results?.length || 0;
      totalFound += count1 + count2;
      console.log(`Keyword "${q}": found ${count1} firms, ${count2} individuals.`);
    } catch(e) {
      console.error(`Error searching ${q}:`, e.message);
    }
  }
  console.log(`Total new/existing CRDs found matching queries: ${totalFound}`);
}
doSearch();
