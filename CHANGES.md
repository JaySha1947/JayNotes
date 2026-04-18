# Changes in this version (security hardening)

## Files modified
- `server.ts` — fully rewritten with all security fixes (path-traversal,
  SSRF, JWT secret requirement, multer filename sanitization, rate limiting,
  current-password check on change, CORS lockdown, hidden-file protection for
  admin, username validation, zip-slip defense, atomic writes, token versioning
  for session invalidation on password change/reset, timing-safe login).
- `vite.config.ts` — removed the `GEMINI_API_KEY` `define` that was baking the
  key into the client bundle. Add a server-side `/api/ai/*` route when you wire
  AI back in.
- `src/components/SettingsModal.tsx` — password change UI now requires the
  current password and stores the refreshed token the server returns.
- `package.json` — added `express-rate-limit` dependency.
- `package-lock.json` — regenerated.
- `.env.example` — documents `JWT_SECRET`, `ALLOWED_ORIGIN`, etc.
- `.gitignore` — also excludes `data/` now.

## Files added
- `Dockerfile` — multi-stage, non-root user, healthcheck.
- `.dockerignore`
- `docker-compose.yml` — with a `./data:/data` bind mount so notes live on
  the host, not inside the container.

## Verified
- `npx tsc --noEmit` — no type errors (re-confirmed on a fresh `npm install`).
- `npm run build` — Vite build succeeds.
- **JWT_SECRET startup guard** — confirmed working. Server exits 1 with the
  expected FATAL message when the env var is missing or shorter than 32 chars.
- Runtime HTTP smoke test — **session 3 run: 22/23 passed.** The `setsid` +
  single-shell-script approach worked. One real failure surfaced (see
  section 1 below): the zip-slip handler silently skips malicious entries
  and returns 200 instead of rejecting the archive with 400. No file
  actually escaped the vault — the traversal is neutralized — but the
  server should fail closed. Fix before re-running to 23/23.
- Rate-limit calibration note in section 1 said "429 around attempt #21."
  Actual: #19 (Tests 4's two bad logins are consumed by the same limiter).
  Not a bug, just updating the expected number.

## Migration note for existing deployments
Because the JWT payload now includes `tokenVersion`, any tokens issued by the
old server will not verify against the new one. All users must log in again
after upgrading — nothing breaks, they just see the login screen.

Also note: `JWT_SECRET` is now REQUIRED (≥32 chars). The server will refuse
to start without it. Generate one with:

    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

## Sessions 4 & 5 complete

### Zip-slip fix: verified end-to-end

**Correction to the session 3 diagnosis.** Session 3 said the handler
"silently skips malicious entries and returns 200." That wasn't quite right.
The handler's pre-scan logic was already correct and fail-closed. The real
bug was in the **test**: `adm-zip`'s `addFile('../evil.md', ...)` normalizes
the entry name at write time, stripping the leading `../`. So the uploaded
archive actually contained an entry named `evil.md` (not `../evil.md`) — a
benign archive. The server correctly returned 200 because there was nothing
unsafe to reject, and `/tmp/evil.md` didn't exist because the traversal
never made it into the zip bytes.

**Changes shipped:**

- **`server.ts` `/api/admin/storage/unzip` handler** — kept the resolved-path
  check and added belt-and-suspenders syntactic pre-checks on raw
  `entryName`: reject absolute paths (POSIX `/...`, Windows `C:\...` / `\...`),
  any `..` path component (covers `../x`, `a/../../x`, `./../x`, backslash
  variants), and NUL bytes. Logs the offending entry name to console on
  reject. Still returns 400 without extracting anything.

- **`smoke-test.sh` Test 13** — rewrote the malicious-zip builder. Adds
  `evil.md` safely, then mutates `entryName = '../evil.md'` on the
  `ZipEntry` **before** `writeZip`. Added a post-write assertion in the
  node snippet that exits 1 if the entry name wasn't preserved. The zip on
  disk now genuinely contains `../evil.md` as an entry — verified by the
  node snippet's own `console.log` output:
  `wrote /tmp/malicious.zip with entries: ["../evil.md","normal.md"]`.

**Session 5 smoke test result: 23/23 passed.** The server returned
`HTTP=400 body={"error":"Archive contains unsafe entries"}` on the unzip
call, and `/tmp/evil.md` did not exist afterward. Server log showed the
expected `[unzip] rejecting archive: unsafe entry name "../evil.md"`
warning.

### Documentation

- **`README.md`** rewritten from scratch. Covers: what the app is → Docker
  Compose quick start → full env var table (`JWT_SECRET`, `ALLOWED_ORIGIN`,
  `VAULT_PATH`, `MAX_UPLOAD_SIZE`, `ENABLE_IFRAME_PROXY`, `PORT`, `HOST`,
  `NODE_ENV`) → local dev without Docker → data/backups (the `./data`
  bind mount) → upgrading (rebuild + restart; all users re-log-in because
  of `tokenVersion`) → security model summary → troubleshooting section
  with the common failure modes (fatal JWT_SECRET, CORS mismatch, 429
  after a few logins, missing bootstrap screen, unhealthy container,
  out-of-band password reset).

- **`DEPLOY.md`** added. VPS deployment walkthrough for Ubuntu 22.04/24.04:
  prereqs → initial hardening (non-root user, SSH lockdown, ufw 22/80/443,
  unattended-upgrades) → install Docker + compose plugin → clone repo,
  generate `JWT_SECRET`, write `.env` → `docker compose up -d` → Nginx
  reverse-proxy config → `certbot --nginx` → verify `/api/auth/status`
  over HTTPS → bootstrap admin → ongoing ops (logs, cron backup of
  `./data`, `git pull && docker compose build && docker compose up -d`
  upgrade path, `JWT_SECRET` rotation) → GitHub-side `v2.0.0-hardened`
  tag with release-note template.

### Smoke test calibration notes (carried over from session 3, still accurate)
- Rate limiter tripped at attempt #19, not #21 — the two bad logins in
  Test 4 eat into the same 20-req window. Fine as-is; just don't be
  surprised by the number.
- Test 7 path traversal: all four variants returned 400/403/404 correctly.
  The dotfile block on `/api/admin/storage/file?path=.users.json` returned
  403 as expected via `assertAdminPathAllowed`.
- Timing-safe login (session 5 run): wrong-pw against valid user = 530ms,
  wrong-pw against nonexistent user = 574ms. Both clearly hit bcrypt.

---

**Original smoke-test context (still accurate, kept for reference):**

The script at `smoke-test.sh` uses the `setsid` + single-shell approach so
the server survives long enough to be curled. Run it with:

```bash
npm install                   # if node_modules isn't present
bash smoke-test.sh
```

The script expects the project to live flat at `/home/claude/` (line 8:
`cd /home/claude`). If the zip extracts to a subdirectory, either copy
the contents up one level first (what session 3 did) or patch line 8.

Test cases covered (all 13 from the original plan):
- `GET /api/auth/status` on fresh vault → `{needsBootstrap: true}`.
- `POST /api/auth/bootstrap` with valid user → returns token + role=admin.
- Repeat bootstrap → 403.
- `POST /api/auth/login` wrong password → 401; time it next to a
  valid-user/wrong-password login to confirm both hit bcrypt (timing-safe path).
- `POST /api/auth/login` right password → token.
- `GET /api/files` without auth → 401; with token → 200.
- **Path traversal:** `GET /api/file?path=../.users.json` → 400/403.
- **SSRF loopback:** `GET /api/proxy/iframe?url=http://127.0.0.1:3100/...` → blocked.
- **SSRF cloud metadata:** `?url=http://169.254.169.254/` → blocked.
- **Username validation:** bootstrap with `"../evil"` → 400.
- **Rate limit:** 6 bad logins → last one 429.
- **Change password requires current:** wrong current → 401; right current →
  new token issued, old token stops working on `/api/files` (tokenVersion bump).
- **Zip-slip:** POST a zip containing `../evil.md` to
  `/api/admin/storage/unzip` → entry rejected or skipped.

**Calibration notes when reviewing script output:**
- **Rate limit.** The original plan said "6 bad logins → 429" but the actual
  `authLimiter` in `server.ts` is 20 req / 15 min. The script loops up to 22
  attempts. In session 3 it tripped at attempt #19 (Test 4's 2 bad logins
  count against the same 15-min window). Expect 429 somewhere in the #18–#21
  range — anywhere in there is correct behavior.
- **Path traversal pass criteria.** 400/403/404 all count as pass for
  `/api/file?path=../.users.json`. `safeJoin` returns a vault-scoped path that
  doesn't exist, producing 404 — not an escape. The cleaner assertion is on
  `/api/admin/storage/file?path=.users.json` which must return 403 via
  `assertAdminPathAllowed` (dotfile block).
- **Bootstrap username test.** Bootstrap is one-shot per vault, so after Test
  2 consumes it, the script restarts the server against a second fresh
  `VAULT_PATH` to test `../evil` rejection on bootstrap. Still one bash call
  total — the restart is inline.
- **Zip-slip mechanics.** The malicious zip is built in-process with
  `adm-zip` (same lib the server uses), uploaded via
  `/api/admin/storage/upload`, then unzip is invoked. The script also checks
  `/tmp/evil.md` does not exist after unzip as a belt-and-suspenders.

## Deferred (not in this release)

- **Move JWT out of localStorage into httpOnly cookies.** Requires adding
  CSRF tokens to every state-changing request — bigger refactor, deferred
  to a follow-up. Current storage is acceptable given the CORS lockdown
  and the lack of untrusted rich-content rendering.
