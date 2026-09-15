# Windows public RSS companion

`grant_rss.py` and `social_scholar_rss.py` are the existing first-party local collectors, moved into the source package without caches, bootstrap articles or account state. `bridge.py` also reuses `../conferences/conference_rss.py`.

The Windows bundle embeds Python with PyInstaller. Build-only dependencies are pinned in `scripts/prepare-public-bridge.mjs`; they are installed from PyPI into a dedicated build virtual environment, not the user's global Python. Runtime includes Python (PSF), Requests (Apache-2.0), Beautiful Soup (MIT), certifi (MPL-2.0), tzdata (Apache-2.0) and their dependencies. PyInstaller's bootloader exception permits bundled application distribution. Preserve upstream license metadata in release distributions.

Only public sources are requested. No AI call, credential import, browser profile, open proxy, arbitrary path serving, writable HTTP endpoint or firewall change. Ports 8765/8766/8768 bind loopback only. Unknown paths return 404; initial missing caches return 503. Collector failures retain prior data. A Windows process handle ties lifetime to the owning desktop process. No samples are shipped as real feed contents.

RSS validity does not establish that upstream content is current, complete, or endorsed. Reddit and other sites can independently deny anonymous access. Zhihu is intentionally not included in this credential-free companion.
