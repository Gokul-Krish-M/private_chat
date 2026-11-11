---
name: setup-server
description: Deploy or update the secret-chat backend on this Linux server (systemd service, CHAT_TOKEN, HTTPS reverse proxy, verification). Use when the user asks to set up, deploy, install, update or troubleshoot the backend on a server.
disable-model-invocation: true
---

# Set up the secret-chat backend on this server

You are running on the server that will host the backend. The goal is to get this state:

```
internet ──443/TLS──▶ Caddy or nginx ──▶ 127.0.0.1:4545  node src/server.js  (systemd: secret-chat)
                                                          └─ /var/lib/secret-chat/chat.db
```

Read `README.md` (sections "Hosting the backend" and "Security model") and the files in `deploy/`
before starting. The configs in `deploy/` are the source of truth. Copy them and fill in the placeholders
rather than writing new ones.

## Ground rules

- Ask the user before installing system packages, opening firewall ports, or changing **any existing**
  web-server config. Creating new files that belong only to this app doesn't need confirmation.
- Port 4545 must never be reachable from the internet. The server binds to `127.0.0.1`. Do not change
  `HOST`, and do not open 4545 in the firewall.
- `CHAT_TOKEN` is a secret. Write it only to `/etc/secret-chat/env` (root:root, mode 600). Don't echo it
  into commands that end up in shell history or logs. Show it to the user exactly once, in the final report.
- Use `sudo` for system changes. If sudo needs a password you can't provide, stop and tell the user which
  commands to run.
- If this is an **update** (`secret-chat.service` already exists), skip to "Updating".

## 1. Gather inputs

Ask the user, in a single question, for:
- **Domain** for the chat backend, such as `chat.example.com`. Its DNS A/AAAA record must already point to
  this server. Check with `dig +short <domain>` against `curl -s https://api.ipify.org`, and warn if they
  don't match, because the certificate request will fail.
- **Reverse proxy**: detect first (`systemctl is-active caddy nginx`, `command -v caddy nginx`). If one is
  already running, recommend using it. If neither is installed, recommend Caddy (automatic HTTPS, the
  simplest config).

## 2. Prerequisites

- **Node.js ≥ 22.13**, required for the built-in `node:sqlite`. Check `node --version`. If it's missing or
  too old, propose installing Node 24 LTS system-wide (NodeSource apt repo on Debian/Ubuntu, or the
  distro's package if it's new enough). Node from nvm under a home directory won't work, because the unit
  sets `ProtectHome=true`.
- Use `command -v node` to get the absolute node path for `__NODE_BIN__`.

## 3. Install the app

1. App directory: `/opt/secret-chat`. If the repo is cloned somewhere else (for example under `/home`),
   ask whether to move or re-clone it to `/opt/secret-chat`. The service can't read from `/home`.
2. Create the system user: `sudo useradd --system --no-create-home --shell /usr/sbin/nologin secretchat`
   (skip this if the user already exists).
3. `cd /opt/secret-chat && sudo npm ci --omit=dev`
4. The code should be root-owned and read-only to the service:
   `sudo chown -R root:root /opt/secret-chat && sudo chmod -R a+rX /opt/secret-chat`

## 4. Secret token

```bash
sudo install -d -m 700 /etc/secret-chat
sudo sh -c 'umask 077; printf "CHAT_TOKEN=%s\n" "$(openssl rand -base64 32 | tr -d "=+/\n")" > /etc/secret-chat/env'
```

If `/etc/secret-chat/env` already exists, keep it. Don't rotate the token unless the user asks, because
that disconnects every client.

## 5. systemd service

```bash
sed -e "s|__APP_DIR__|/opt/secret-chat|g" -e "s|__NODE_BIN__|$(command -v node)|g" \
  deploy/secret-chat.service | sudo tee /etc/systemd/system/secret-chat.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now secret-chat
```

Check: `systemctl is-active secret-chat` returns `active`, and
`sudo journalctl -u secret-chat -n 20 --no-pager` shows `listening on ws://127.0.0.1:4545` with **no**
"CHAT_TOKEN is not set" warning.

## 6. Reverse proxy and HTTPS

**Caddy:** put the contents of `deploy/Caddyfile.example` (with `__DOMAIN__` replaced) in
`/etc/caddy/Caddyfile`. If that file already has other sites, add this one as a new block rather than
replacing the file, and confirm with the user first. Then run `sudo caddy validate --config /etc/caddy/Caddyfile`
and `sudo systemctl reload caddy`.

**nginx:** copy `deploy/nginx.conf.example` with `__DOMAIN__` replaced to
`/etc/nginx/sites-available/secret-chat` and symlink it into `sites-enabled`. On RHEL-style systems, use
`/etc/nginx/conf.d/secret-chat.conf` instead. If `grep -r connection_upgrade /etc/nginx` finds an
existing `map`, remove the map block from the new file. Run `sudo nginx -t && sudo systemctl reload nginx`,
then `sudo certbot --nginx -d <domain>`, installing certbot if needed and asking first.

**Firewall:** if `ufw` or `firewalld` is active, make sure 80 and 443 are open (ask first). Never open 4545.

## 7. Verify

Run all of these and report the results:

```bash
curl -fsS http://127.0.0.1:4545/ | grep -o "<title>[^<]*"   # local: "<title>Margins · Reading library"
curl -fsSI https://<domain>/ | grep -i content-security   # through the proxy: valid cert + CSP header
sudo sh -c 'set -a; . /etc/secret-chat/env; CHAT_SERVER=wss://<domain> node /opt/secret-chat/deploy/check.mjs'
```

`check.mjs` must print `OK wss://<domain>: ...`. Also confirm the token is enforced: run the same check
with `CHAT_TOKEN=wrong`, which must print `FAIL ... Invalid access token`. Confirm the port is closed from
outside: `ss -ltnp | grep 4545` must show only `127.0.0.1:4545`.

If something fails, check `journalctl -u secret-chat` and the proxy's logs, fix the cause, and run all the
checks again.

## 8. Final report to the user

Keep it short:
- Status of each check above.
- The client command, including the token (the only place it's shown):
  ```bash
  CHAT_SERVER=wss://<domain> CHAT_TOKEN='<token>' npm run chat
  ```
- The web view is at `https://<domain>/`. It looks like a reading site called "Margins". Sign in with any
  username, and use the token as the password. The web view must be served over HTTPS, because browsers only
  allow its encryption on secure pages.
- Remind them that the token goes to the other chat participant through a private channel, and so does each
  room's passphrase. The server never sees passphrases.
- Useful commands: `sudo systemctl restart secret-chat`, `sudo journalctl -u secret-chat -f`.

## Updating

```bash
cd /opt/secret-chat
sudo git pull --ff-only
sudo npm ci --omit=dev
sudo systemctl restart secret-chat
```

Then run the checks in step 7 again. If `deploy/secret-chat.service` changed in the pull, reinstall it as in
step 5 (including `daemon-reload`) before restarting.
