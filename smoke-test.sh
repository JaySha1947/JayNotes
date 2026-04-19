#!/usr/bin/env bash
# Runtime HTTP smoke test for server.ts.
# Starts the server once with setsid, runs every curl inline, then kills it.
# Must all live in a single bash invocation because backgrounded processes
# don't survive across bash_tool calls in this sandbox.

set -u  # do NOT set -e: we want to see all test outcomes
cd /home/claude

# ---------- setup ----------
rm -rf /tmp/vault && mkdir -p /tmp/vault
rm -f /tmp/server.log /tmp/server.pid
PORT=3100
BASE="http://127.0.0.1:${PORT}"

# Generate a 96-char hex JWT secret (48 bytes)
SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

# Per-test pass/fail tracking
PASS=0
FAIL=0
RESULTS=()

pass() { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); echo "  [PASS] $1"; }
fail() { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1  -- $2"); echo "  [FAIL] $1 :: $2"; }

# ---------- start server ----------
echo "== Starting server =="
JWT_SECRET="$SECRET" \
ALLOWED_ORIGIN="http://localhost:${PORT}" \
PORT="${PORT}" HOST=127.0.0.1 \
VAULT_PATH=/tmp/vault \
NODE_ENV=production \
setsid node_modules/.bin/tsx server.ts > /tmp/server.log 2>&1 < /dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > /tmp/server.pid
echo "server pid=$SERVER_PID"

# Wait up to 15s for the server to be ready
for i in $(seq 1 15); do
  sleep 1
  if curl -sf "${BASE}/api/auth/status" > /dev/null 2>&1; then
    echo "server ready after ${i}s"
    break
  fi
  if [ $i -eq 15 ]; then
    echo "SERVER FAILED TO START. Log:"
    cat /tmp/server.log
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
done

# Cleanup trap
cleanup() {
  echo
  echo "== Killing server =="
  # Kill the whole session (setsid created one) so tsx + child node both die
  kill -- -"$SERVER_PID" 2>/dev/null || true
  kill "$SERVER_PID" 2>/dev/null || true
  sleep 1
}
trap cleanup EXIT

echo
echo "==============================================="
echo "Test 1: GET /api/auth/status on fresh vault"
echo "==============================================="
BODY=$(curl -s "${BASE}/api/auth/status")
echo "response: $BODY"
if echo "$BODY" | grep -q '"needsBootstrap":true'; then
  pass "fresh vault reports needsBootstrap:true"
else
  fail "fresh vault reports needsBootstrap:true" "got: $BODY"
fi

echo
echo "==============================================="
echo "Test 2: Bootstrap with valid user"
echo "==============================================="
BODY=$(curl -s -X POST "${BASE}/api/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"correctpass123","email":"a@b.c"}')
echo "response: $BODY"
ADMIN_TOKEN=$(echo "$BODY" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch{console.log('')}})")
if [ -n "$ADMIN_TOKEN" ] && echo "$BODY" | grep -q '"role":"admin"'; then
  pass "bootstrap returns token + role=admin"
else
  fail "bootstrap returns token + role=admin" "got: $BODY"
fi

echo
echo "==============================================="
echo "Test 3: Repeat bootstrap should 403"
echo "==============================================="
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" -X POST "${BASE}/api/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin2","password":"correctpass123"}')
echo "http: $HTTP  body: $(cat /tmp/r.txt)"
if [ "$HTTP" = "403" ]; then
  pass "repeat bootstrap → 403"
else
  fail "repeat bootstrap → 403" "got HTTP $HTTP"
fi

echo
echo "==============================================="
echo "Test 4: Login wrong password → 401 (timing-safe)"
echo "==============================================="
# Both should take roughly the same time because both run bcrypt.
# We're not asserting exact timing — just that both paths return 401.
T1_START=$(date +%s%N)
HTTP1=$(curl -s -o /tmp/r.txt -w "%{http_code}" -X POST "${BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"WRONGpass!!"}')
T1_END=$(date +%s%N)
T1_MS=$(( (T1_END - T1_START) / 1000000 ))
echo "valid-user wrong-pw: HTTP=$HTTP1 time=${T1_MS}ms body=$(cat /tmp/r.txt)"

T2_START=$(date +%s%N)
HTTP2=$(curl -s -o /tmp/r.txt -w "%{http_code}" -X POST "${BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"nonexistent_ghost","password":"WRONGpass!!"}')
T2_END=$(date +%s%N)
T2_MS=$(( (T2_END - T2_START) / 1000000 ))
echo "bogus-user wrong-pw: HTTP=$HTTP2 time=${T2_MS}ms body=$(cat /tmp/r.txt)"

if [ "$HTTP1" = "401" ] && [ "$HTTP2" = "401" ]; then
  pass "both bad-login paths return 401"
else
  fail "both bad-login paths return 401" "HTTP1=$HTTP1 HTTP2=$HTTP2"
fi

# Both paths should be non-trivially slow (bcrypt work).
# With BCRYPT_ROUNDS=12, each bcrypt is O(100ms+) on most machines.
if [ "$T1_MS" -gt 30 ] && [ "$T2_MS" -gt 30 ]; then
  pass "both paths hit bcrypt (>30ms): valid=${T1_MS}ms bogus=${T2_MS}ms"
else
  fail "both paths hit bcrypt (>30ms)" "valid=${T1_MS}ms bogus=${T2_MS}ms"
fi

echo
echo "==============================================="
echo "Test 5: Login with correct password → token"
echo "==============================================="
BODY=$(curl -s -X POST "${BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"correctpass123"}')
echo "response: $BODY"
LOGIN_TOKEN=$(echo "$BODY" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch{console.log('')}})")
if [ -n "$LOGIN_TOKEN" ]; then
  pass "correct login returns token"
else
  fail "correct login returns token" "got: $BODY"
fi

echo
echo "==============================================="
echo "Test 6: GET /api/files unauth → 401; with token → 200"
echo "==============================================="
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" "${BASE}/api/files")
echo "unauth: HTTP=$HTTP body=$(cat /tmp/r.txt)"
if [ "$HTTP" = "401" ]; then
  pass "/api/files without auth → 401"
else
  fail "/api/files without auth → 401" "got HTTP $HTTP"
fi

HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE}/api/files")
echo "auth'd: HTTP=$HTTP body-first-200chars=$(head -c 200 /tmp/r.txt)"
if [ "$HTTP" = "200" ]; then
  pass "/api/files with token → 200"
else
  fail "/api/files with token → 200" "got HTTP $HTTP"
fi

echo
echo "==============================================="
echo "Test 7: Path traversal on /api/file → 400/403"
echo "==============================================="
# Try several traversal variants
for P in "../.users.json" "../../etc/passwd" "..%2F.users.json" "foo/../../.users.json"; do
  HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    --get --data-urlencode "path=$P" "${BASE}/api/file")
  echo "  path='$P' → HTTP=$HTTP body=$(cat /tmp/r.txt)"
  if [ "$HTTP" = "403" ] || [ "$HTTP" = "400" ] || [ "$HTTP" = "404" ]; then
    # 404 is also acceptable because safeJoin returns a vault-scoped path that
    # doesn't exist for sibling-user files — not a traversal escape.
    :
  else
    fail "path traversal blocked for '$P'" "got HTTP $HTTP"
    continue
  fi
done
pass "path traversal blocked on /api/file"

# Also try via admin storage route
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --get --data-urlencode "path=.users.json" "${BASE}/api/admin/storage/file")
echo "admin storage dotfile: HTTP=$HTTP body=$(cat /tmp/r.txt)"
if [ "$HTTP" = "403" ]; then
  pass "admin storage /api/admin/storage/file?path=.users.json → 403 (dotfile blocked)"
else
  fail "admin storage dotfile blocked" "got HTTP $HTTP"
fi

echo
echo "==============================================="
echo "Test 8: SSRF loopback blocked"
echo "==============================================="
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --get --data-urlencode "url=http://127.0.0.1:${PORT}/api/auth/status" \
  "${BASE}/api/proxy/iframe")
echo "loopback: HTTP=$HTTP body-first-200=$(head -c 200 /tmp/r.txt)"
if [ "$HTTP" = "400" ]; then
  pass "SSRF loopback (127.0.0.1) blocked"
else
  fail "SSRF loopback blocked" "got HTTP $HTTP, body: $(head -c 200 /tmp/r.txt)"
fi

# Also try localhost (DNS-resolves to 127.0.0.1)
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --get --data-urlencode "url=http://localhost:${PORT}/" \
  "${BASE}/api/proxy/iframe")
echo "localhost: HTTP=$HTTP"
if [ "$HTTP" = "400" ]; then
  pass "SSRF localhost blocked"
else
  fail "SSRF localhost blocked" "got HTTP $HTTP"
fi

echo
echo "==============================================="
echo "Test 9: SSRF cloud metadata blocked"
echo "==============================================="
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --get --data-urlencode "url=http://169.254.169.254/latest/meta-data/" \
  "${BASE}/api/proxy/iframe")
echo "metadata: HTTP=$HTTP body-first-200=$(head -c 200 /tmp/r.txt)"
if [ "$HTTP" = "400" ]; then
  pass "SSRF cloud metadata (169.254.169.254) blocked"
else
  fail "SSRF cloud metadata blocked" "got HTTP $HTTP"
fi

# Also RFC1918 ranges
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --get --data-urlencode "url=http://10.0.0.1/" \
  "${BASE}/api/proxy/iframe")
if [ "$HTTP" = "400" ]; then
  pass "SSRF RFC1918 10.0.0.1 blocked"
else
  fail "SSRF RFC1918 10.0.0.1 blocked" "got HTTP $HTTP"
fi

echo
echo "==============================================="
echo "Test 10: Username validation on bootstrap"
echo "==============================================="
# Reset vault so bootstrap is available again
rm -rf /tmp/vault2 && mkdir -p /tmp/vault2
# Actually we can't easily swap VAULT_PATH mid-server — but bootstrap is already
# gone, so instead use /api/admin/users (same validator) to test bad usernames.
for BAD in "../evil" "bad/slash" "bad name" "ab" "$(printf 'a%.0s' {1..40})" "has.dot"; do
  BODY_JSON=$(node -e "console.log(JSON.stringify({username:process.argv[1],password:'somepass123'}))" "$BAD")
  HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -X POST --data "$BODY_JSON" "${BASE}/api/admin/users")
  echo "  username='$BAD' → HTTP=$HTTP body=$(cat /tmp/r.txt)"
  if [ "$HTTP" != "400" ]; then
    fail "username validation rejects '$BAD'" "got HTTP $HTTP"
    BAD_FAILED=1
  fi
done
if [ -z "${BAD_FAILED:-}" ]; then
  pass "username validator rejects traversal / slashes / spaces / dots / too-short / too-long"
fi

# Also confirm the bootstrap validator rejects ../evil — we need a fresh vault
# for that. Kill this server and restart with a fresh vault path.
echo
echo "  (testing bootstrap with ../evil on a fresh vault)"
kill -- -"$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true
sleep 2
rm -rf /tmp/vault_fresh && mkdir -p /tmp/vault_fresh

JWT_SECRET="$SECRET" \
ALLOWED_ORIGIN="http://localhost:${PORT}" \
PORT="${PORT}" HOST=127.0.0.1 \
VAULT_PATH=/tmp/vault_fresh \
NODE_ENV=production \
setsid node_modules/.bin/tsx server.ts > /tmp/server2.log 2>&1 < /dev/null &
SERVER_PID=$!
for i in $(seq 1 15); do
  sleep 1
  curl -sf "${BASE}/api/auth/status" > /dev/null 2>&1 && break
  if [ $i -eq 15 ]; then echo "server2 did not start"; cat /tmp/server2.log; exit 1; fi
done

HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" -X POST "${BASE}/api/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{"username":"../evil","password":"goodpass123"}')
echo "  bootstrap '../evil': HTTP=$HTTP body=$(cat /tmp/r.txt)"
if [ "$HTTP" = "400" ]; then
  pass "bootstrap rejects '../evil' username → 400"
else
  fail "bootstrap rejects '../evil'" "got HTTP $HTTP"
fi

# Bootstrap for real on this fresh vault so subsequent tests have a valid user
BODY=$(curl -s -X POST "${BASE}/api/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"correctpass123"}')
ADMIN_TOKEN=$(echo "$BODY" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch{console.log('')}})")
echo "  re-bootstrapped, token-len=${#ADMIN_TOKEN}"

echo
echo "==============================================="
echo "Test 11: Rate limit on /api/auth/login"
echo "==============================================="
# authLimiter is 20 requests / 15min. After 20, the 21st should get 429.
LAST_HTTP=""
RATE_LIMITED_AT=""
for i in $(seq 1 22); do
  HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" -X POST "${BASE}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"WRONGpass!!"}')
  echo "  attempt $i → HTTP=$HTTP"
  LAST_HTTP="$HTTP"
  if [ "$HTTP" = "429" ] && [ -z "$RATE_LIMITED_AT" ]; then
    RATE_LIMITED_AT=$i
    break
  fi
done
if [ -n "$RATE_LIMITED_AT" ]; then
  pass "rate limiter kicks in at attempt #$RATE_LIMITED_AT (expected ~21)"
else
  fail "rate limiter kicks in within 22 attempts" "last HTTP=$LAST_HTTP"
fi

echo
echo "==============================================="
echo "Test 12: Change password requires current password"
echo "==============================================="
# Can't use the rate-limit-exhausted token's login, but change-password uses
# authHeaderOnly, not authLimiter, so it's fine to proceed with ADMIN_TOKEN.

# Wrong current password → 401
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" -X POST "${BASE}/api/auth/change-password" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"WRONG_CURRENT","newPassword":"newpass4567"}')
echo "wrong current: HTTP=$HTTP body=$(cat /tmp/r.txt)"
if [ "$HTTP" = "401" ]; then
  pass "change-password with wrong current → 401"
else
  fail "change-password with wrong current → 401" "got HTTP $HTTP"
fi

# Right current → 200 and new token
BODY=$(curl -s -X POST "${BASE}/api/auth/change-password" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"correctpass123","newPassword":"newpass4567"}')
echo "right current: $BODY"
NEW_TOKEN=$(echo "$BODY" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch{console.log('')}})")
if [ -n "$NEW_TOKEN" ] && [ "$NEW_TOKEN" != "$ADMIN_TOKEN" ]; then
  pass "change-password with right current → new token issued"
else
  fail "change-password issues new token" "new_token='${NEW_TOKEN:0:20}...' old_token='${ADMIN_TOKEN:0:20}...'"
fi

# Old token should no longer work on /api/files (tokenVersion bumped → 401)
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" "${BASE}/api/files")
echo "old token on /api/files: HTTP=$HTTP"
if [ "$HTTP" = "401" ]; then
  pass "old token rejected after password change (tokenVersion bump)"
else
  fail "old token rejected after password change" "got HTTP $HTTP"
fi

# New token should work
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" \
  -H "Authorization: Bearer $NEW_TOKEN" "${BASE}/api/files")
echo "new token on /api/files: HTTP=$HTTP"
if [ "$HTTP" = "200" ]; then
  pass "new token works on /api/files"
else
  fail "new token works on /api/files" "got HTTP $HTTP"
fi
ADMIN_TOKEN="$NEW_TOKEN"

echo
echo "==============================================="
echo "Test 13: Zip-slip defense"
echo "==============================================="
# Build a malicious zip containing ../evil.md using Node so we don't shell out
# to a specific zip tool.
#
# Important: adm-zip normalizes entry names on write — calling
# addFile('../evil.md', ...) strips the leading '../' before the bytes land
# on disk, so the archive isn't actually malicious. We work around this by
# adding the entry with a safe name, then mutating entryName AFTER addFile
# but BEFORE writeZip. The resulting zip has a real '../evil.md' entry.
# Use a temp ESM script (package.json has "type":"module" so require() is unavailable)
cat > /tmp/make-malicious-zip.mjs << 'MJSEOF'
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve adm-zip relative to the project so we use the installed version
const require = createRequire(import.meta.url);
// Find adm-zip in the project node_modules
const admZipPath = path.resolve(process.cwd(), 'node_modules/adm-zip/adm-zip.js');
const { default: AdmZip } = await import(admZipPath);
const zip = new AdmZip();
zip.addFile('normal.md', Buffer.from('hello'));
zip.addFile('evil.md', Buffer.from('PWNED'));
for (const e of zip.getEntries()) {
  if (e.entryName === 'evil.md') e.entryName = '../evil.md';
}
zip.writeZip('/tmp/malicious.zip');
const verify = new AdmZip('/tmp/malicious.zip');
const names = verify.getEntries().map(x => x.entryName);
console.log('wrote /tmp/malicious.zip with entries:', JSON.stringify(names));
if (!names.includes('../evil.md')) {
  console.error('ERROR: archive does not contain ../evil.md entry');
  process.exit(1);
}
MJSEOF
node /tmp/make-malicious-zip.mjs

# Upload to admin storage root
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@/tmp/malicious.zip" \
  "${BASE}/api/admin/storage/upload" > /tmp/r.txt
echo "upload resp: $(cat /tmp/r.txt)"

# Now call unzip on the uploaded archive
HTTP=$(curl -s -o /tmp/r.txt -w "%{http_code}" -X POST "${BASE}/api/admin/storage/unzip" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"malicious.zip"}')
echo "unzip: HTTP=$HTTP body=$(cat /tmp/r.txt)"
if [ "$HTTP" = "400" ]; then
  pass "zip-slip: malicious archive rejected → 400"
else
  fail "zip-slip: malicious archive rejected" "got HTTP $HTTP"
fi

# Confirm no ../evil.md escaped out of the vault
if [ -f /tmp/evil.md ]; then
  fail "zip-slip: /tmp/evil.md should NOT exist" "but it does — archive extracted outside vault!"
  rm -f /tmp/evil.md
else
  pass "zip-slip: no file escaped the vault"
fi

echo
echo "==============================================="
echo "SUMMARY"
echo "==============================================="
printf '%s\n' "${RESULTS[@]}"
echo
echo "Total: $((PASS+FAIL))  Passed: $PASS  Failed: $FAIL"
echo
echo "---- last 30 lines of server log ----"
tail -30 /tmp/server.log 2>/dev/null || tail -30 /tmp/server2.log

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
