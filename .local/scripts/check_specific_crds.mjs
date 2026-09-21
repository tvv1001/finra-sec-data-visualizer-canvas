const crds = [103990, 29722, 16944, 2913, 300279, 35730, 114207, 111458, 310684];

async function checkCrd(crd) {
    const finraUrl = `https://api.brokercheck.finra.org/search/firm/${crd}?hl=true&wt=json`;
    const secUrl = `https://api.adviserinfo.sec.gov/search/firm/${crd}?hl=true&wt=json`;
    
    let isLive = false;
    let finraFound = false;
    let secFound = false;

    try {
        const finraRes = await fetch(finraUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (finraRes.ok) {
            const data = await finraRes.json();
            if (data.hits && data.hits.total > 0) finraFound = true;
        }
    } catch (e) {}

    try {
        const secRes = await fetch(secUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (secRes.ok) {
            const data = await secRes.json();
            if (data.hits && data.hits.total > 0) secFound = true;
        }
    } catch (e) {}

    if (finraFound || secFound) isLive = true;
    
    console.log(`CRD ${crd.toString().padEnd(8)} | Live: ${isLive.toString().padEnd(5)} | FINRA: ${finraFound.toString().padEnd(5)} | SEC: ${secFound.toString().padEnd(5)}`);
}

async function run() {
    for (const crd of crds) {
        await checkCrd(crd);
        await new Promise(r => setTimeout(r, 200));
    }
}

run();
