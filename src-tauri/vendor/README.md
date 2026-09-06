# Embedded web theme

`darkreader.js` is Dark Reader **4.9.130**, from the pinned npm development
dependency, with CRLF normalized to LF. `DARKREADER-LICENSE` is the upstream MIT
license. Upstream: https://github.com/darkreader/darkreader

Registry integrity: `sha512-hLYjyUszzRc7n+EGbK+LYJV9uCp0JwwvRNgXgKyMkqCoetwkheefWUIxbxKiqQaSWLrCQuQuv55f2cHQMopJ2w==`

Vendoring makes standalone Rust builds independent of Node dependency paths.
The license is included in the native executable alongside the source. Updating
requires updating the exact dependency, both vendor files, and regression tests.

The controller is injected into the main remote page only. It does not use CDN
scripts, AI, a native fetch proxy, cookies, or remote app capabilities. Optional
stylesheet reads use ordinary credential-free browser CORS with a bounded request
budget. Images are excluded from colour analysis. Native dark content is skipped
when detected. Disable removes engine styles/observers; source HTML, stored RSS,
Markdown, and login state are not replaced. Cross-origin frames, closed shadow
roots, strict CSP and unusual image-based layouts may remain unstyled; the user
can restore the website's original appearance from the web toolbar.
