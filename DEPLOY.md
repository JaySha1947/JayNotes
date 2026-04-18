# Deploying JayNotes on a VPS

End-to-end guide for putting JayNotes behind Nginx + HTTPS on a small Linux
VPS. Aimed at a $5–$10/mo droplet or equivalent. Read `README.md` first for
what the app does and what the env vars mean — this document assumes you
already know that and just want the commands to get it running in
production.

## Prerequisites

- A VPS running **Ubuntu 22.04 LTS or 24.04 LTS**. Other distros work but
  the commands here are apt-specific.
- **1 GB RAM minimum**, 2 GB recommended. Build peaks well under 1 GB;
  runtime is tiny.
- A **domain name** with an A record pointing at the VPS's public IP.
  Wait for DNS to propagate before running certbot — it will fail otherwise.
- **SSH access** as root or a user with sudo.

## 1. Initial server hardening

Do this once per VPS, before installing anything else.

### Create a non-root user

```bash
# As root:
adduser jay
usermod -aG sudo jay

# Copy your SSH key from root to the new user
rsync --archive --chown=jay:jay ~/.ssh /home/jay
```

Log out and SSH back in as `jay`. All subsequent commands run as this user
with `sudo` where needed.

### Disable root SSH and password auth

Edit `/etc/ssh/sshd_config`:

```
PermitRootLogin no
PasswordAuthentication no
```

Then `sudo systemctl restart ssh`. **Test from a second terminal before
closing your current session** so you can't lock yourself out.

### Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (for certbot challenges + redirect to HTTPS)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
sudo ufw status
```

### Automatic security updates

```bash
sudo apt update
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Pick "Yes" when prompted. This installs only security updates by default,
which is what you want on a small note-taking server.

## 2. Install Docker + the Compose plugin

Follow Docker's official apt install steps (abbreviated here for Ubuntu):

```bash
# Remove any older Docker packages
sudo apt remove -y docker docker-engine docker.io containerd runc 2>/dev/null || true

# Install prerequisites
sudo apt update
sudo apt install -y ca-certificates curl gnupg

# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repo
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Let the jay user run docker without sudo
sudo usermod -aG docker jay
```

Log out and back in so the new group membership takes effect. Verify:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

## 3. Deploy the app

### Clone the repo

```bash
cd ~
git clone <your-fork-url> jaynotes
cd jaynotes
```

### Generate a JWT secret and write `.env`

```bash
cat > .env <<EOF
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" 2>/dev/null || docker run --rm node:20-alpine node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
ALLOWED_ORIGIN=https://notes.example.com
EOF

chmod 600 .env
```

Replace `notes.example.com` with your actual domain. The `chmod 600` matters
— anything that can read this file can forge session tokens for every user.

If you don't have Node installed on the host (and you probably don't —
that's what Docker is for), the `docker run` fallback will do the same
thing inside a throwaway container.

### Bring up the stack

```bash
docker compose up -d
docker compose logs -f jaynotes
```

You should see startup lines like `[startup] Server listening on
http://0.0.0.0:3000`. Ctrl-C out of the logs (the container keeps running).

Verify the port is bound locally only:

```bash
sudo ss -tlnp | grep 3000
# Should show 127.0.0.1:3000 — NOT 0.0.0.0:3000
```

If it shows `0.0.0.0:3000`, check the `ports:` stanza in
`docker-compose.yml` — it should be `"127.0.0.1:3000:3000"`.

## 4. Nginx reverse proxy

### Install Nginx

```bash
sudo apt install -y nginx
```

### Write the site config

Create `/etc/nginx/sites-available/jaynotes`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name notes.example.com;

    # certbot --nginx will add the 301-to-HTTPS block automatically.
    # Until then, this server also serves the ACME challenge.

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # File uploads can be large; bump this if you raised MAX_UPLOAD_SIZE.
        client_max_body_size 50M;

        # WebSocket / long-polling headroom (not used today but cheap to set)
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
```

Replace `notes.example.com` with your domain.

```bash
sudo ln -s /etc/nginx/sites-available/jaynotes /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Verify HTTP works end-to-end before moving to TLS:

```bash
curl -I http://notes.example.com/api/auth/status
# Should be HTTP/1.1 200 OK with JSON body
```

## 5. TLS with Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d notes.example.com
```

Answer the prompts (use a real email, agree to the TOS, pick option 2 to
redirect HTTP to HTTPS). Certbot edits your Nginx config in place, adds
the `listen 443 ssl` block with the cert paths, and installs a systemd
timer to auto-renew.

Verify:

```bash
curl -I https://notes.example.com/api/auth/status
# Should be HTTP/2 200
curl -I http://notes.example.com/
# Should be HTTP/1.1 301 with Location: https://...
```

## 6. Bootstrap the first admin user

Open `https://notes.example.com` in your browser. You'll see the bootstrap
screen — create the first admin account here. This is a one-shot endpoint;
once used, `/api/auth/bootstrap` returns 403 for everyone.

If for some reason the screen doesn't appear, check that the vault is
empty:

```bash
ls -la ~/jaynotes/data/
# Should be empty or only contain a fresh .users.json with {} inside
```

## 7. Ongoing operations

### Logs

```bash
# App logs (streaming)
docker compose logs -f jaynotes

# Last 200 lines
docker compose logs --tail=200 jaynotes

# Nginx
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

### Backups

The entire state of the deployment is in `~/jaynotes/data/`. Back it up
whenever you want a snapshot:

```bash
cd ~/jaynotes
docker compose stop jaynotes
tar czf ~/jaynotes-backup-$(date +%F).tar.gz data/
docker compose start jaynotes
```

For offsite backups, rsync or `scp` the tarball somewhere else. A daily
cron job works fine for most personal deployments:

```cron
# crontab -e
30 3 * * * cd /home/jay/jaynotes && docker compose stop jaynotes && tar czf /home/jay/backups/jaynotes-$(date +\%F).tar.gz data/ && docker compose start jaynotes
```

Keep at least a week of backups. The vault is plain files, so old backups
are trivially useful — just extract into a fresh `data/` directory.

### Upgrading

```bash
cd ~/jaynotes
git pull
docker compose build
docker compose up -d
```

Every user gets logged out on upgrade (token version bump). No data
migration is needed — the vault format is forward-compatible.

### Rotating `JWT_SECRET`

If you suspect the secret has leaked (or just want to force everyone
off):

```bash
cd ~/jaynotes
# Generate a new secret and overwrite the line in .env
NEW=$(docker run --rm node:20-alpine node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$NEW/" .env
docker compose up -d
```

All existing tokens become invalid immediately. Every user has to log in
again on their next request.

### Health checks

```bash
# Container health
docker compose ps

# Manual health probe (same endpoint the container healthcheck uses)
curl -sf https://notes.example.com/api/auth/status && echo OK
```

If the container ever reports `unhealthy`, `docker compose logs jaynotes`
will tell you why. The three most common failures are a missing
`JWT_SECRET`, a read-only vault (wrong permissions on `./data`), or Node
crashing on an upgrade that needs a rebuild — `docker compose build &&
docker compose up -d` fixes the third.

## GitHub-side tasks

Once the VPS deployment is confirmed working and you're ready to cut
a release from the hardened branch:

```bash
# Tag the release
git tag -a v2.0.0-hardened -m "Security hardening release — see CHANGES.md"
git push origin v2.0.0-hardened
```

Then open the GitHub releases UI, draft a new release against the tag, and
paste a short note pointing readers at `CHANGES.md` for the full diff from
v1. Something like:

> **v2.0.0-hardened** — security hardening release. JWT secret enforcement,
> path-traversal / SSRF / zip-slip defenses, rate limiting, token versioning
> on password change, CORS lockdown, atomic writes, and a Docker Compose
> deployment path. See `CHANGES.md` for the full list of fixes and
> `DEPLOY.md` for VPS setup.
>
> **Upgrade path:** `git pull && docker compose build && docker compose
> up -d`. All users must log in again after upgrade (token format change).

That line about the upgrade path is worth pinning to the release notes
because people will expect to migrate from v1.
