import { readFileSync, writeFileSync } from 'fs';

const text = readFileSync('data/names_master_list.txt', 'utf-8');
const lines = text.split('\n').map(line => line.trim()).filter(line => line.includes('–') || line.includes('-'));

const searchList = lines.map(line => {
    const parts = line.split(/–|-/);
    return {
        original: line,
        name: parts[0].trim(),
        location: parts[1] ? parts[1].trim() : ''
    };
});

let finraData = { docs: [] };
try {
    finraData = JSON.parse(readFileSync('data/national/search-index.finra.individual.json', 'utf-8'));
} catch (e) {
    console.error('Failed to load FINRA index:', e.message);
}

const crds = [];

for (const person of searchList) {
    const query = person.name.toLowerCase();
    
    // Find all matches
    const matches = (finraData.docs || []).filter(d => 
        (d.nameSearchText || '').toLowerCase().includes(query) || 
        (d.strictSearchText || '').toLowerCase().includes(query) ||
        (d.hit && d.hit.name && d.hit.name.toLowerCase().includes(query))
    );

    if (matches.length > 0) {
        // Try location refine first
        const locQuery = person.location.split(',')[0].trim().toLowerCase();
        const refined = matches.filter(d => JSON.stringify(d).toLowerCase().includes(locQuery));
        
        // Take the first match from refined if any, else the first from all matches
        const bestMatch = (refined.length > 0 ? refined[0] : matches[0]);
        
        // Extract the CRD number from "finra:individual:12345"
        const idParts = bestMatch.id.split(':');
        const crdNum = idParts[idParts.length - 1];
        crds.push(crdNum);
    }
}

// deduplicate
const uniqueCrds = [...new Set(crds)];

console.log(JSON.stringify(uniqueCrds, null, 2));
writeFileSync('data/import_crds.json', JSON.stringify(uniqueCrds, null, 2), 'utf-8');
