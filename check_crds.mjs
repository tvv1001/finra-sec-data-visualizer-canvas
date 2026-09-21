const crds = [
  283003, 32241, 329502, 337307, 7603, 37042, 285252, 165127,
  14052, 151428, 157210, 140470, 171898, 172470
];

async function checkApi(crd) {
  try {
    const finraRes = await fetch(`https://api.brokercheck.finra.org/search/firm/${crd}?hl=true&wt=json`);
    const finraData = await finraRes.json();
    const secRes = await fetch(`https://api.adviserinfo.sec.gov/search/firm/${crd}?hl=true&wt=json`);
    const secData = await secRes.json();
    
    console.log(`CRD ${crd} - FINRA hits: ${finraData.hits?.total || 0}, SEC hits: ${secData.hits?.total || 0}`);
  } catch (err) {
    console.log(`CRD ${crd} - Error: ${err.message}`);
  }
}

async function run() {
  for (const crd of crds) {
    await checkApi(crd);
  }
}

run();
