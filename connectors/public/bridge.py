"""Bundled public RSS collectors, bound only to loopback, owned by app lifetime.

No credentials, browser sessions, private bootstrap data, or installed service.
The HTTP surface only serves nine known public RSS files and health status.
"""
import argparse
import ctypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit

import grant_rss
import social_scholar_rss
import conference_rss


def watch_parent(pid):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if not handle:
        raise RuntimeError('Parent process unavailable')
    def wait():
        kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        os._exit(0)
    threading.Thread(target=wait, daemon=True).start()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--parent-pid', type=int, required=True)
    args = parser.parse_args()
    watch_parent(args.parent_pid)
    root = args.data_dir
    root.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=root / 'public-bridge.log', level=logging.INFO)
    grant_dir, social_dir, conference_dir = [root / key for key in ('funding', 'social', 'conferences')]
    for directory in (grant_dir, social_dir, conference_dir):
        directory.mkdir(parents=True, exist_ok=True)
    conference = conference_rss.Cache(str(conference_dir))
    workers = {
        8765: (grant_rss.GrantAggregator(grant_dir).refresh, grant_dir, {'funding.xml'}),
        8766: (social_scholar_rss.Aggregator(social_dir).refresh, social_dir,
               {str(meta['filename']) for meta in social_scholar_rss.FEED_META.values()}),
        8768: (conference.refresh, conference_dir, {key + '.xml' for key in conference_rss.SOURCES}),
    }
    def run(port, refresh, directory, allowed):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                name = urlsplit(self.path).path.removeprefix('/')
                if name == 'health':
                    payload = json.dumps({'service': 'scholay-public-rss', 'ready': sum((directory / key).is_file() for key in allowed), 'total': len(allowed)}).encode()
                    content_type, status = 'application/json', 200
                elif name in allowed:
                    try:
                        payload = (directory / name).read_bytes()
                        content_type, status = 'application/rss+xml; charset=utf-8', 200
                    except FileNotFoundError:
                        payload, content_type, status = b'Public source is being collected; retry shortly', 'text/plain', 503
                else:
                    payload, content_type, status = b'Not found', 'text/plain', 404
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(payload)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *_args):
                pass
        # Bind before refreshing. Never displace an existing local service.
        server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        def collect():
            while True:
                try:
                    refresh()
                    if port == 8768:
                        with conference.lock:
                            for key, record in conference.records.items():
                                if record.get('items'):
                                    (directory / (key + '.xml')).write_bytes(conference_rss.rss_bytes(key, record))
                except Exception:
                    logging.exception('Public collection failed on port %s', port)
                time.sleep(4 * 3600)
        threading.Thread(target=collect, daemon=True).start()
        server.serve_forever()
    for port, spec in workers.items():
        threading.Thread(target=run, args=(port, *spec), daemon=True).start()
    while True:
        time.sleep(60)


if __name__ == '__main__':
    main()
