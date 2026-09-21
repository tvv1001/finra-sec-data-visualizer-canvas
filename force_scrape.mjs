import { execSync } from 'child_process';
const crds = [283003,32241,329502,337307,7603,37042,285252,165127,14052,151428,157210,140470,171898,172470];
for (const crd of crds) {
  console.log(`Force scraping ${crd}`);
  execSync(`FORCE=1 npx tsx --env-file=.env.local .local/scripts/scrape.mjs fetch --kind=firm --crd=${crd}`, {stdio:'inherit'});
}
