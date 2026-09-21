import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Parse the names list
const text = readFileSync('data/names_master_list.txt', 'utf-8');
const lines = text.split('\n').map(line => line.trim()).filter(line => line.includes('–') || line.includes('-'));

const searchList = lines.map(line => {
    // split by either – (en dash) or - (hyphen)
    const parts = line.split(/–|-/);
    return {
        original: line,
        name: parts[0].trim(),
        location: parts[1] ? parts[1].trim() : ''
    };
});

console.log(`Parsed ${searchList.length} names to search.`);

// Try to find them in the local sidecar indexes
let finraData = { docs: [] };
try {
    const finraRaw = readFileSync('data/national/search-index.finra.individual.json', 'utf-8');
    finraData = JSON.parse(finraRaw);
    console.log(`Loaded ${finraData.docs?.length || 0} FINRA docs.`);
} catch (e) {
    console.error('Failed to load FINRA index:', e.message);
}

const matchToCrd = new Map();

for (const person of searchList) {
    // Simple naive match: check if the exact name exists in the index
    // The FINRA docs array contains objects. Let's look at the shape.
    // Usually it's hit: { _source: { name: "...", firm_name: "..." } } or similar
    // We'll search nameSearchText or strictSearchText
    const query = person.name.toLowerCase();
    
    // Find all matching docs
    const matches = (finraData.docs || []).filter(d => 
        (d.nameSearchText || '').toLowerCase().includes(query) || 
        (d.strictSearchText || '').toLowerCase().includes(query) ||
        (d.hit && d.hit.name && d.hit.name.toLowerCase().includes(query))
    );

    if (matches.length === 1) {
        matchToCrd.set(person.name, matches[0].id);
    } else if (matches.length > 1) {
        // Try to filter by location if possible
        const locQuery = person.location.split(',')[0].trim().toLowerCase();
        const refined = matches.filter(d => {
            const locText = JSON.stringify(d).toLowerCase();
            return locText.includes(locQuery);
        });
        
        if (refined.length > 0) {
            matchToCrd.set(person.name, refined[0].id + (refined.length > 1 ? ' (Multiple matches, took first)' : ''));
        } else {
            matchToCrd.set(person.name, 'Multiple Matches (' + matches.length + ') - No location match');
        }
    } else {
        matchToCrd.set(person.name, 'Not Found');
    }
}

// Generate output
const outLines = ['Original Name,Extracted Name,Location,Mapped CRD'];
for (const person of searchList) {
    const crd = matchToCrd.get(person.name) || 'Not Found';
    outLines.push(`"${person.original}","${person.name}","${person.location}","${crd}"`);
}

writeFileSync('data/matched_crds.csv', outLines.join('\n'), 'utf-8');
console.log('Done! Wrote results to data/matched_crds.csv');
