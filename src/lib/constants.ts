import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
const FALLBACK_DATA_DIR = path.join(os.tmpdir(), 'finra-data-chart-next-02', 'data');

export const DATA_DIR = existsSync(DEFAULT_DATA_DIR) ? DEFAULT_DATA_DIR : FALLBACK_DATA_DIR;
export const GRAPH_FILE = path.join(DATA_DIR, 'national', 'finra-graph.json');
export const SEEDS_FILE = path.join(DATA_DIR, 'national', 'finra-seeds.json');
export const SEED_BANK_FILE = path.join(DATA_DIR, 'national', 'finra-seed-bank.json');
export const RECENT_SEEDS_FILE = path.join(DATA_DIR, 'national', 'finra-recent-seeds.json');
export const PRIMED_CACHE_DIR = path.join(DATA_DIR, 'national', 'primed-cache');
export const SEED_PROFILES_FILE = path.join(DATA_DIR, 'seed-profiles.json');

// Python scrapers live in the original server directory
export const SCRAPER_PATH = path.resolve(process.cwd(), '..', 'finra-data-chart', 'server', 'services', 'crawler', 'finraScraper.py');
export const ANTI_SCRAPER_PATH = path.resolve(process.cwd(), '..', 'finra-data-chart', 'server', 'services', 'crawler', 'anti_bot_scraper.py');

export const DEFAULT_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (compatible; research-tool/1.0)',
	'Accept': 'application/json',
};
