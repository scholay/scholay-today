"""Read counts and feed outcomes, never credential values or article bodies."""
import argparse
import json
from pathlib import Path
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument('database', type=Path)
args = parser.parse_args()
conn = sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True)
conn.row_factory = sqlite3.Row
report = {'counts': {table: conn.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in ('feeds', 'folders', 'articles')}}
report['sources'] = [dict(row) for row in conn.execute('SELECT f.title,f.feed_url,f.last_fetched_at,f.fetch_error,count(a.id) AS articles FROM feeds f LEFT JOIN articles a ON a.feed_id=f.id GROUP BY f.id ORDER BY f.id')]
report['configured_sensitive_setting_count'] = conn.execute("SELECT count(*) FROM settings WHERE (key LIKE '%key%' OR key LIKE '%token%' OR key LIKE '%secret%' OR key LIKE '%password%') AND value NOT IN ('', 'null', 'false')").fetchone()[0]
print(json.dumps(report, ensure_ascii=False, indent=2))
