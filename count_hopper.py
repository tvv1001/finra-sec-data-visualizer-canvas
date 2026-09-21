import gzip
import json

with gzip.open('public/search-indexes/search-index.sec.individual.json.gz', 'rt') as f:
    data1 = json.load(f)

count = 0
for doc in data1.get('docs', []):
    name = doc.get('nameSearchText', '')
    if 'hopper' in name:
        count += 1
print("SEC Individual Hoppers:", count)

with gzip.open('public/search-indexes/search-index.sec.firm.json.gz', 'rt') as f:
    data2 = json.load(f)

count = 0
for doc in data2.get('docs', []):
    name = doc.get('nameSearchText', '')
    if 'hopper' in name:
        count += 1
print("SEC Firm Hoppers:", count)
