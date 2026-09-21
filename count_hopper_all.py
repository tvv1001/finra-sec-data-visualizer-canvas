import gzip
import json

with gzip.open('public/search-indexes/search-index.finra.individual.json.gz', 'rt') as f:
    text = f.read()

count = text.lower().count('hopper')
print("Total 'hopper' occurrences:", count)
