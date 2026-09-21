import * as path from 'node:path';

export const SCRAPER_PATH = path.resolve(process.cwd(), '..', 'finra-data-chart', 'server', 'services', 'crawler', 'finraScraper.py');
export const ANTI_SCRAPER_PATH = path.resolve(process.cwd(), '..', 'finra-data-chart', 'server', 'services', 'crawler', 'anti_bot_scraper.py');
