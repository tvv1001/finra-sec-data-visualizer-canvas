const fs = require('fs');
const path = require('path');

function usage() {
	console.error('Usage: node scripts/generate_firm_connection_docs.js --firm <CRD>');
	process.exit(2);
}

const argv = process.argv.slice(2);
let firm = '';
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--firm' && argv[i + 1]) {
		firm = argv[i + 1];
		break;
	}
}
if (!firm) usage();
if (!/^[0-9]+$/.test(firm)) usage();

const inPath = path.join(process.cwd(), 'data', 'firm-connections', `${firm}.json`);
if (!fs.existsSync(inPath)) {
	console.error('Firm connections file not found:', inPath);
	process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const entries = [...(data.currentConnections || []), ...(data.previousConnections || [])];

const out = entries.map((e) => {
	const crd = String(e.individualId || e.ind_crd || e.individualId);
	const name = e.name || '';
	const brokercheckPath = path.join(process.cwd(), 'data', 'national', 'brokercheck.finra.org', `api.brokercheck.finra.org_search_individual_${crd}.json`);
	const adviserPath = path.join(process.cwd(), 'data', 'national', 'adviserinfo.sec.gov', `api.adviserinfo.sec.gov_search_individual_${crd}.json`);
	const primedPath = path.join(process.cwd(), 'data', 'national', 'primed-cache', 'finra-individual.json');
	const hasBroker = fs.existsSync(brokercheckPath);
	const hasAdviser = fs.existsSync(adviserPath);
	// Primed is a bundle — we can check if the CRD appears in the file index via build_manifest if present
	const buildManifestPath = path.join(process.cwd(), 'data', 'build_manifest.json');
	let inPrimed = false;
	try {
		if (fs.existsSync(buildManifestPath)) {
			const bm = JSON.parse(fs.readFileSync(buildManifestPath, 'utf-8'));
			const key1 = `\"finra:individual:${crd}:hl=true&includePrevious=true&wt=json\"`;
			// crude: check for file entries that include the crd
			inPrimed = Object.keys(bm).some((k) => String(k).includes(`individual_${crd}`) || String(bm[k]).includes(`individual_${crd}`));
		}
	} catch (err) {}

	return {
		individualId: crd,
		name,
		relationship: e.relationship,
		isCurrent: !!e.isCurrent,
		startDate: e.startDate || null,
		endDate: e.endDate || null,
		sources: {
			brokercheckLocal: hasBroker,
			adviserLocal: hasAdviser,
			primedBundle: inPrimed,
			brokercheckUrl: `https://brokercheck.finra.org/individual/summary/${crd}`,
			adviserUrl: `https://adviserinfo.sec.gov/IAPD/Content/Search/iapd_Search.aspx?search=${crd}`,
		},
	};
});

const outPath = path.join(process.cwd(), 'data', 'firm-connections', `${firm}-docs.json`);
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), firm, entries: out }, null, 2));
console.log('Wrote', outPath, 'entries=', out.length);
