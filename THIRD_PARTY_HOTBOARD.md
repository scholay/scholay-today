# Local hot-board adapters

scholay tody's optional hot board adapts public-source extraction strategies and endpoint
schemas from the following MIT projects. It does not embed their hosted service,
login system, telemetry, cookies, or user accounts. The Rust cache and desktop UI
run locally on macOS or Windows; normal requests go to the original public platforms.

- NewsNow — <https://github.com/ourongxing/newsnow>, inspected commit
  `2173126f804bec0201769f59d933add6c4632d17`.
- DailyHotApi — <https://github.com/imsyy/DailyHotApi>, inspected commit
  `36c77e3bd891c11642d314cfb229bf31646704de`.

Other adapters use public provider interfaces: Lobsters, Forem/DEV,
Stack Exchange, Google Trends RSS, Wikimedia Pageviews, and publisher RSS/Atom.
Each source exposes its provider/project URL in the local source catalog.
Source content belongs to its original publisher; these software licenses do
not license republishing third-party news. Links, limited snippets and platform
rankings are cached for the user's local reading. A feed is labelled "latest",
not "hot", unless the provider actually supplies a popularity ranking. Daily
statistics are labelled separately, with their statistical day where available.

The separate, optional Product Hunt ranking adapter requires a user-provided
developer API token. Provider API terms still apply, including its default
non-commercial-use restriction: <https://api.producthunt.com/v2/docs>.
The unauthenticated Product Hunt feed remains a distinct "latest" source.

## NewsNow license

MIT License

Copyright (c) 2024 ourongxing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## DailyHotApi license

MIT License

Copyright (c) 2023 imsyy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
