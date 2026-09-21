#!/usr/bin/env python3
"""
Fetch FINRA BrokerCheck API data for individual CRDs using cloudscraper.
Tries the API first and saves responses to the local cache directory
without overwriting existing files (writes a *.new.json when a file
already exists). This script deliberately only augments the cache and
never replaces existing files unless --apply is passed.

Usage:
  python scripts/fetch_individual_cloudscraper.py 1359210
  python scripts/fetch_individual_cloudscraper.py --file crd-list.txt

Note: Requires cloudscraper (pip install cloudscraper). See README in
the repository for more details.
"""
import argparse
import json
import os
from pathlib import Path
import sys

try:
    import cloudscraper
except Exception:
    print("Missing dependency: cloudscraper. Install with: pip install cloudscraper")
    sys.exit(1)


DATA_DIR = Path(__file__).resolve().parents[1] / 'data' / 'national' / 'brokercheck.finra.org'
DATA_DIR.mkdir(parents=True, exist_ok=True)


def fetch_crd(crd: str, overwrite: bool = False, delay: int = 5):
    url = f"https://api.brokercheck.finra.org/search/individual/{crd}?wt=json"
    print(f"Fetching CRD {crd} -> {url}")
    scraper = cloudscraper.create_scraper(interpreter='js2py', delay=delay, enable_stealth=True)
    try:
        resp = scraper.get(url, timeout=30)
    except Exception as e:
        print(f"Request failed for {crd}: {e}")
        return False

    out_file = DATA_DIR / f"api.brokercheck.finra.org_search_individual_{crd}.json"
    if out_file.exists() and not overwrite:
        new_file = DATA_DIR / f"api.brokercheck.finra.org_search_individual_{crd}.json.new"
        new_file.write_text(resp.text, encoding='utf-8')
        print(f"Existing file present, wrote augmented response to: {new_file}")
    else:
        out_file.write_text(resp.text, encoding='utf-8')
        print(f"Wrote API response to: {out_file}")

    return True


def parse_args():
    p = argparse.ArgumentParser(description="Fetch BrokerCheck API data via cloudscraper and augment local cache")
    p.add_argument('crds', nargs='*', help='CRD ids to fetch')
    p.add_argument('--file', '-f', help='File with one CRD per line')
    p.add_argument('--apply', action='store_true', help='Overwrite existing cache files (dangerous)')
    p.add_argument('--delay', type=int, default=5, help='Delay seconds hint for cloudscraper when solving challenges')
    return p.parse_args()


def main():
    args = parse_args()
    crds = list(args.crds or [])
    if args.file:
        p = Path(args.file)
        if not p.exists():
            print(f"Input file not found: {args.file}")
            sys.exit(2)
        for line in p.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line:
                continue
            crds.append(line)

    if not crds:
        print("No CRDs provided. Use --file or pass CRD ids on the command line.")
        sys.exit(0)

    for crd in crds:
        fetch_crd(crd, overwrite=args.apply, delay=args.delay)


if __name__ == '__main__':
    main()
