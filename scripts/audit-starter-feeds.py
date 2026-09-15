"""Read-only, credential-free network audit; never copies an app database."""
import concurrent.futures
import json
from pathlib import Path
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
feeds = json.loads((ROOT / 'crates/papr-core/src/starter-feeds.json').read_text(encoding='utf-8'))

def check(feed):
    out = {'title': feed['title'], 'url': feed['url'], 'folder': feed['folder']}
    if feed['url'].startswith('http://127.0.0.1:'):
        return {**out, 'status': 'requires-local-connector'}
    start = time.monotonic()
    try:
        request = urllib.request.Request(feed['url'], headers={'User-Agent': 'ScholayToday/0.16 RSS reader', 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'})
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read(8 * 1024 * 1024)
            out['http'] = response.status
            doc = ET.fromstring(body)
            kind = doc.tag.split('}')[-1].lower()
            if kind not in ('rss', 'feed', 'rdf'):
                raise ValueError('response is not RSS/Atom/RDF')
            out.update(status='ok', items=sum(el.tag.split('}')[-1] in ('item', 'entry') for el in doc.iter()))
    except urllib.error.HTTPError as error:
        out.update(status='http-error', http=error.code)
    except Exception as error:
        out.update(status='failed', error=type(error).__name__ + ': ' + str(error)[:180])
    out['seconds'] = round(time.monotonic() - start, 2)
    return out

results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    for result in pool.map(check, feeds):
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
(ROOT / 'starter-network-audit.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print('SUMMARY', {key: sum(row['status'] == key for row in results) for key in sorted({row['status'] for row in results})}, flush=True)
