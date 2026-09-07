# Public conference calendars → local RSS

An optional sidecar, independent of the desktop app and its private database.
Python 3.10+; works on macOS, Linux and Windows. No account, cookies or AI key required.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m unittest discover -v
.venv/bin/python conference_rss.py refresh --data-dir /absolute/path/to/conference-cache
.venv/bin/python conference_rss.py serve --data-dir /absolute/path/to/conference-cache --port 8768
```

On Windows, replace `.venv/bin/python` with `.venv\Scripts\python.exe` and use an absolute Windows data path.

Only binds `127.0.0.1`. Once `/health` shows four successful caches, import
`conference-starter.opml` in Settings → Subscriptions. It adds two separate
Chinese/English folders with four feeds each. English feeds are upstream-native
RSS: three WikiCFP topics and Calenda's English-language academic announcements.
WikiCFP uses HTTP because its tested HTTPS endpoint did not complete TLS; no
credentials are sent. Calenda also includes non-conference academic announcements.

You can alternatively use the reader's Add Feed UI:

| Endpoint | Public source | Scope |
| --- | --- | --- |
| `/sciencenet.xml` | https://meeting.sciencenet.cn/ | Conference announcements; includes commercial CFP listings |
| `/chemsoc.xml` | https://www.chemsoc.org.cn/meeting/home/calendar.html | Chinese Chemical Society calendar |
| `/cssn.xml` | https://www.cssn.cn/skwxsdt/hyrl/ | Social-science calendar; includes past-event reports |
| `/ccf.xml` | https://bls.ccf.org.cn/calendar/ | CCF Xiuhu only; includes previous editions |

The default refresh interval is six hours (`--refresh-hours 6`). Reader requests
only read the cache and never wait for upstream websites. `/health` reports item
counts, last successful fetch and errors; 503 means at least one source has no
successful cache yet. A nonzero count plus an error means last-good data is being
served, **not** a fresh successful fetch. Errors never delete cached entries.

Meeting dates are preserved in item descriptions, not misused as publication
dates. CSSN publication dates come from its dated article URLs. Other calendars
lack publication timestamps, so RSS dates use persistent first-seen timestamps,
explicitly described in each item. First-seen is not a new/upcoming-event claim.
Source-provided images are included where available; original links are retained.

This is a list adapter, not a full-text crawler, not a meeting-quality endorsement,
and not comprehensive coverage of all conferences. No authentication bypass is
attempted. If upstream structures change or entries cannot be parsed, review the
adapter and `/health`; empty parses preserve the last successful data. The CCF
adapter reads the site's public route metadata as text and never executes it.

Keep the virtual environment, cache, log files and OS startup registration outside
the repository. To undo an installation: remove these four subscriptions and stop
the sidecar's startup registration. Nothing else in the reader needs changing.
