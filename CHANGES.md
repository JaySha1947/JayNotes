# JayNotes — Changelog

## v2.1.0 — Security hardening & build improvements (2026-04-19)

### Security fixes

- **CRITICAL: Removed GEMINI_API_KEY from frontend bundle.** `vite.config.ts` was
  injecting the key into client JS via Vite's `define:` option. Removed entirely —
  no Gemini calls exist in the current frontend, and any future AI calls must be
  proxied through the server.

- **CRITICAL: JWT secret now required in all environments.** Previously a hard-coded
  fallback secret was used in non-production mode, allowing token forgery by anyone
  who read the source. The server now exits immediately if `JWT_SECRET` is missing
  or shorter than 32 characters, regardless of `NODE_ENV`.

- **Added `helmet()` for HTTP security headers.** Covers `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security` (when
  behind HTTPS), and more — one middleware, all the standard headers.

- **MIME type allowlist on all file uploads.** Both user and admin multer instances
  now validate `file.mimetype` against an explicit allowlist before writing to disk.
  An upload with a blocked type is rejected with HTTP 400. Previously any file type
  was accepted, allowing e.g. an HTML file disguised as an image to be served back
  and potentially rendered in the app's origin.

- **SSRF proxy: redirect targets are now validated.** The iframe proxy previously
  called `res.redirect(parsed.toString())` for non-HTML responses, which could leak
  redirect chains to private addresses (DNS rebinding). Non-HTML content now returns
  HTTP 400; HTML redirects are re-validated through the SSRF guard before following.

- **`Content-Disposition` + `X-Content-Type-Options` on attachment serving.**
  Prevents MIME-sniff XSS when browsers serve uploaded files.

- **`mkdir -p` guard added to `POST /api/file`.** Previously a save to a new
  sub-path would throw `ENOENT` if the parent directory didn't exist. Now created
  automatically.

### Build improvements

- **Server TypeScript pre-compiled in Docker.** The production image now runs
  `node dist-server/server.js` instead of `npx tsx server.ts`. This eliminates
  the ~400ms startup overhead from the TypeScript transpiler and surfaces compile
  errors at build time rather than runtime.
  - New `tsconfig.server.json` for server-only compilation
  - New `npm run build:server` and `npm run build:all` scripts
  - New `npm start` script for production

- **Code splitting improved.** Vite now splits `react-dom`, editor (CodeMirror),
  graph (react-force-graph-2d), and flow (xyflow) into separate async chunks. The
  main bundle dropped from 1.5 MB to ~584 KB (gzip: 164 KB).

- **`dist-server/` added to `.gitignore`.** Compiled server output is a build
  artefact and does not belong in version control.

### Smoke test fix

- **Zip-slip test now works correctly.** The test used `node -e "const AdmZip =
  require('adm-zip')..."` which fails silently in an ESM package (`"type":"module"`
  in `package.json` makes `require()` unavailable in `node -e`). The malicious
  archive was never created, so the upload failed quietly and the unzip endpoint
  returned 200 on a missing path. Fixed by writing a temporary `.mjs` file and
  running it with `node`. The underlying zip-slip guard in `server.ts` was always
  correct — only the test harness was broken.

## v2.0.0 — Security-hardened rewrite

- JWT secret enforcement
- Path-traversal / SSRF / zip-slip defenses
- Rate limiting
- Token versioning on password change
- CORS lockdown
- Atomic writes
