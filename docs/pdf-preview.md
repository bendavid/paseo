# PDF preview

Opening a `.pdf` in the file panel renders it with pdf.js. One renderer serves
every platform: a generated, self-contained HTML document that runs in an
iframe on web/Electron and in a `WebView` on iOS/Android.

## Why a bundled document instead of importing pdf.js

`pdfjs-dist` cannot go through Metro. It ships ES modules that use
`import.meta.url` to locate optional assets, and it wants a separate worker
script — neither of which Metro resolves. So the viewer is built with esbuild
instead:

```
packages/app/scripts/build-pdf-webview-html.mjs
  → src/pdf/webview/pdf-viewer-webview-html.ts   (generated, committed, ~2 MB)
```

This mirrors the terminal's `build-terminal-webview-html.mjs`. Both run from
`npm run build:webviews` in `packages/app`, which `eas-build-post-install`
calls. **Re-run `npm run build:pdf-webview` after editing
`src/pdf/webview/pdf-viewer-webview-entry.ts`** — the generated file is what
ships, and nothing rebuilds it automatically during dev.

Two details in that script are load-bearing:

- **The worker is inlined as base64.** pdf.js is full of non-ASCII characters,
  and embedding the worker as a JS string literal costs a six-byte `\uXXXX`
  escape for each one — about a megabyte. The viewer decodes the base64 and
  turns it into a blob-URL `Worker`, so page rendering stays off the shell's
  main thread. If blob workers are refused, it evaluates the same bundle in the
  viewer scope, which registers `globalThis.pdfjsWorker` and lets pdf.js fall
  back to its main-thread handler.
- **`legacy/build/*.min.mjs` is deliberate.** The bundle targets `ios15`, the
  same baseline as the terminal webview. The default (non-legacy) build assumes
  newer engines.

## What is not shipped

pdf.js's optional assets — `cmaps/` (1.7 MB), `standard_fonts/` (800 KB), and
the wasm image decoders (~1 MB) — stay out of the bundle, and there is no URL
for the viewer to fetch them from. Consequences, all of them per-file rather
than fatal:

- Documents relying on the 14 standard fonts render with a system fallback font
  (`useSystemFonts: true`), so metrics can differ slightly from a desktop
  viewer.
- CJK text that depends on predefined Adobe CMaps may show missing glyphs.
- JBIG2 and JPEG2000 images fall back to pdf.js's pure-JS decoders, and can
  fail on their own without failing the page.

Adding any of these means either growing the bundle or giving the viewer a real
origin to fetch from. Do not reach for a CDN — the app must work offline and
over the relay.

## The shell/viewer contract

`src/pdf/pdf-viewer-protocol.ts` is the whole contract. The shells
(`components/pdf-preview.web.tsx`, `components/pdf-preview.tsx`) differ only in
transport:

|                | web / Electron                                              | iOS / Android                                                                     |
| -------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Host           | `<iframe srcdoc sandbox="allow-scripts allow-same-origin">` | `react-native-webview` with `source={{ html }}`                                   |
| Shell → viewer | `postMessage`, bytes as `Uint8Array` (structured clone)     | `injectJavaScript` calling `__PASEO_PDF_VIEWER_RECEIVE__`, bytes as base64 chunks |
| Viewer → shell | `window.parent.postMessage(json)`                           | `window.ReactNativeWebView.postMessage(json)`                                     |

`allow-same-origin` on the iframe is what permits the blob worker; the sandbox
still denies navigation, popups, forms, and downloads.

The handshake matters: the viewer posts `ready` when it boots, and the shell
answers with `open` → `chunk`\* → `commit`. A shell that sends bytes before
`ready` is talking to a document that does not exist yet, so first-mount sends
are expected to be dropped and re-sent on `ready`.

`rendered` means **the first page is painted**, not merely that the document
parsed — the shell drops its loading overlay on that message, and page-shaped
blanks are not a preview.

## Memory shape

A long document is laid out as placeholder boxes sized from page one's aspect
ratio, and an `IntersectionObserver` renders pages as they approach the
viewport. At most `MAX_RENDERED_PAGES` (8) canvases exist at once; the farthest
page reverts to a placeholder. A 600-page file is therefore 600 divs and 8
bitmaps, not 600 bitmaps.

## Transport: why file reads are chunked

The daemon's file-read path used to emit a whole file as a single binary frame.
That is fine for a 40 KB screenshot and fatal for a PDF: the daemon terminates
any physical socket whose outbound buffer passes
`MAX_PHYSICAL_SOCKET_BUFFERED_BYTES` (8 MiB), so a large single-frame read
killed the very connection it was answering on.

`session/files/file-transfer-emitter.ts` now emits `FileBegin`, N × 256 KiB
`FileChunk`, `FileEnd`, and paces the chunks against the client's buffered
amount — the same signal the terminal uses to decide a client is not keeping
up. A client that stops draining for 30 s gets the transfer aborted with an
error response rather than a socket that hangs waiting for `FileEnd`.

Two bounds worth knowing:

- `MAX_PREVIEWABLE_FILE_BYTES` (32 MiB, `file-explorer/service.ts`) is checked
  against `stat` before any bytes are read. Downloads are not affected — they
  stream from disk through `/api/files/download`.
- Clients accumulate chunks and size the result from the chunks themselves, not
  from the advertised size, so a file that changes mid-read cannot truncate the
  payload.

## Mixed versions

The mime **is** the capability check — there is no `server_info.features` flag,
because a daemon that predates this feature simply never sends
`application/pdf`. A new app against an old daemon therefore reaches the
"binary preview unavailable" branch, and the pane says "Update the host to
preview PDFs" when the path ends in `.pdf`. An old app against a new daemon
ignores the mime it doesn't know and shows the same generic binary state. No
fallback renderer exists in either direction.

## Adding another previewable binary type

Add the extension to `BINARY_MIME_TYPES` in
`packages/server/src/server/file-explorer/service.ts` and branch on the mime in
the app. **Do not add a new value to the wire `kind` enum**
(`"text" | "image" | "binary"`): widening it breaks parsing on older clients.
The kind stays `"binary"`, the mime carries the meaning, and a client that
doesn't recognize the mime falls back to "Binary preview unavailable".

Note that for declared binary extensions the mime is decided by extension
before content sniffing runs, so an all-ASCII PDF still arrives as a PDF rather
than as `text/plain`.
