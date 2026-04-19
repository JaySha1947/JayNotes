# JayNotes

<img width="385" height="148" alt="logo" src="https://github.com/user-attachments/assets/08c1cc3c-a334-44f4-8e4e-f94dcbac79af" />


A self-hosted, browser-based markdown note-taking app backed by a plain
filesystem vault. Notes are just `.md` files on disk — no database, no
proprietary format, no lock-in. Ships with a built-in admin UI for managing
the vault's file tree and is designed to run behind an Nginx + TLS reverse
proxy on a small VPS.

This repo is the security-hardened v2 branch. See `CHANGES.md` for the full
list of fixes (JWT secret enforcement, path-traversal / SSRF / zip-slip
defenses, rate limiting, token versioning on password change, CORS lockdown,
atomic writes, etc.). If you're deploying to a VPS for the first time, read
`DEPLOY.md` — it walks through everything from `apt update` to `certbot`.

## Quick start (Docker Compose)

Prerequisites: Docker Engine 20.10+ with the Compose plugin. Tested on Ubuntu
22.04 and 24.04.

```bash
git clone <your-fork-url> jaynotes
cd jaynotes

# Generate a strong JWT secret (48 bytes hex)
echo "JWT_SECRET=$(node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\")" > .env
echo "ALLOWED_ORIGIN=http://localhost:3000" >> .env

docker compose up -d
```

Then open http://localhost:3000 and create the first admin user on the
bootstrap screen. The server is bound to `127.0.0.1:3000` by default so it's
not reachable from outside the host until you put Nginx in front of it —
that's covered in `DEPLOY.md`.

## Environment variables

All env vars are read at startup. Required ones must be set or the server
exits with a fatal error.

| Variable              | Required | Default                    | Purpose |
|-----------------------|:--------:|----------------------------|---------|
| `JWT_SECRET`          | yes      | —                          | Secret used to sign session tokens. Must be ≥32 chars. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Rotating this invalidates every existing session. |
| `ALLOWED_ORIGIN`      | no       | `http://localhost:3000`    | CORS allow-list. Set to the public URL users hit in the browser (e.g. `https://notes.example.com`). Non-matching origins are rejected. |
| `VAULT_PATH`          | no       | `/data` in Docker          | Absolute path to the notes vault on disk. In Docker this is a bind-mount target; outside Docker, point it at any host directory you want. |
| `MAX_UPLOAD_SIZE`     | no       | `52428800` (50 MB)         | Per-file upload cap in bytes. Applies to both user uploads and admin storage uploads. |
| `ENABLE_IFRAME_PROXY` | no       | `true`                     | Set to `false` to disable the iframe preview proxy. The proxy is SSRF-hardened (blocks loopback, RFC1918, cloud-metadata IPs) but if you don't need it, turning it off narrows the attack surface. |
| `PORT`                | no       | `3000`                     | Port the Node process listens on. In Docker, leave at 3000 and map at the compose level. |
| `HOST`                | no       | `0.0.0.0` in Docker        | Interface to bind. Use `127.0.0.1` for direct local-only runs. |
| `NODE_ENV`            | no       | `production` in Docker     | Standard Node convention; production mode tightens a few defaults. |

A starter file is in `.env.example`. Copy it to `.env` and fill in
`JWT_SECRET` before bringing the stack up.

## Local development without Docker

Useful when you're iterating on the frontend or server code.

```bash
npm install

# Dev server (tsx runs server.ts directly, serves the Vite build)
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))") \
ALLOWED_ORIGIN=http://localhost:3000 \
VAULT_PATH=/tmp/jaynotes-dev \
npm run dev
```

The Vite build is served from `dist/` after `npm run build`. During
development, edit-reload-refresh works against `npm run dev` directly —
there's no separate frontend dev server in this setup.

Type-check only: `npm run lint` (runs `tsc --noEmit`).

To run the full HTTP smoke test suite against a local server:

```bash
bash smoke-test.sh
```

Expected output: `Total: 23  Passed: 23  Failed: 0`. The script spawns its
own server on port 3100 against `/tmp/vault`, so it won't collide with a
running dev server.

## Data and backups

Your notes live entirely inside the bind-mounted `./data` directory (or
whatever you pointed the bind mount at in `docker-compose.yml`). The
structure is:

```
data/
├── .users.json         # hashed credentials + tokenVersion (do not edit by hand)
├── <username>/         # each user's private vault
│   └── *.md
└── shared/             # shared notes visible to all users (admin-managed)
```

To back up, stop the container briefly and copy the folder — or snapshot it
live if your filesystem supports it (ZFS, LVM, etc.). A simple approach:

```bash
docker compose stop jaynotes
tar czf jaynotes-backup-$(date +%F).tar.gz data/
docker compose start jaynotes
```

Restoring is the inverse: stop the container, replace `./data`, start it
again. Nothing in the image depends on the vault contents, so a clean image
with a restored `./data` is a fully working deployment.

## Upgrading

```bash
git pull
docker compose build
docker compose up -d
```

Every user has to log in again after an upgrade. This is by design — the
JWT payload includes a `tokenVersion` that gets checked against the stored
user record, and rebuilds typically coincide with token format changes or
secret rotations. Nothing breaks; users just see the login screen on their
next request.

If you want to force-log-out everyone without redeploying, rotate
`JWT_SECRET` in `.env` and run `docker compose up -d` to apply it.

## Security model

A quick summary of what this app does and doesn't protect against. The full
changelog is in `CHANGES.md`.

**Authentication.** bcrypt-hashed passwords in `.users.json`, JWT session
tokens signed with `JWT_SECRET`. Login is timing-safe (bogus-user and
wrong-password paths both run bcrypt). Login and bootstrap endpoints are
rate-limited (20 requests per 15 minutes per IP).

**Authorization.** Every user has their own namespace under the vault.
Admin-only endpoints (`/api/admin/*`) check the JWT role claim. The admin
storage API refuses to read or write dotfiles like `.users.json` so the
admin UI can't be used to exfiltrate or corrupt the credential store.

**Path traversal.** All filesystem paths go through a `safeJoin` helper that
resolves the input and confirms it stays inside the vault root. Absolute
paths, `..` components, and NUL bytes are rejected before the resolve step.

**Zip-slip.** The `/api/admin/storage/unzip` handler pre-scans every entry
in an uploaded archive and fail-closes the whole archive if any entry has
`..` components, is absolute, or resolves outside the destination.

**SSRF.** The iframe preview proxy resolves the target hostname and rejects
loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16, including
cloud-metadata at 169.254.169.254), RFC1918 private ranges, and multicast
targets before fetching. Only `http://` and `https://` schemes are allowed.

**Session invalidation.** User records carry a `tokenVersion`. Password
change or admin reset bumps the version, which invalidates every previously
issued token for that user immediately.

**Transport.** The app does not terminate TLS itself — always deploy behind
Nginx (or equivalent) with a real certificate. See `DEPLOY.md`.

**What this does NOT protect against.** A compromised admin account has
full control of the vault. Client-side JavaScript still has access to the
JWT via localStorage (moving to httpOnly cookies is deferred — requires
adding CSRF tokens). A malicious note with embedded HTML/JS would render
inside the app's origin; don't paste untrusted notes into a shared vault.

## Troubleshooting

**Server exits immediately with a fatal JWT_SECRET message.** The secret
is missing or shorter than 32 characters. Check `.env` and regenerate with
the `node -e` one-liner above.

**`docker compose up` succeeds but the browser shows a CORS error.**
`ALLOWED_ORIGIN` doesn't match the URL in the browser's address bar. It
must be an exact match including scheme and port — `http://localhost:3000`
is not the same as `http://127.0.0.1:3000`.

**Login returns 429 after a few attempts.** You're hitting the auth rate
limiter (20/15min per IP). Wait it out or restart the container. If this
happens in normal use, you probably have a proxy misconfiguration causing
all requests to appear to come from the same IP — set `trust proxy`
appropriately or fix the `X-Forwarded-For` header on your reverse proxy.

**Bootstrap screen is gone but I never made an admin account.** Another
client hit `/api/auth/bootstrap` first. Bootstrap is one-shot per vault.
Either log in as whoever claimed it, or delete `.users.json` from the
bind-mount (stop the container first) and start over.

**Tokens stopped working after upgrade.** Expected — the token format
includes a version field that's rechecked on every request. Log in again.

**Container is unhealthy.** Check `docker compose logs jaynotes`. The
healthcheck polls `/api/auth/status`, which is the simplest endpoint that
exercises the full request path; if it fails, the server isn't listening
or is crashing on startup. The most common cause is a missing or too-short
`JWT_SECRET`.

**I need to reset my admin password from outside the app.** Stop the
container, edit `data/.users.json` (it's a plain JSON file), delete the
admin's `passwordHash` field, bump their `tokenVersion` by 1, and start
the container. The admin will be routed back through the bootstrap flow
on their next visit.
