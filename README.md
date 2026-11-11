# secret-chat

Terminal chat with up to **2 rooms**. Messages are **end-to-end encrypted** and **deleted after 24 hours**.
**Private mode** shows messages as harmless-looking code (JS, Python or Go) until you reveal them.

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`).

## Quick start (local)

```bash
npm install
npm run server          # terminal 1
npm run chat            # terminal 2+ (or: node src/cli.js --name alice)
```

## Web view

The backend also serves a web client at `/`. It's disguised as a reading site called **Margins**:

| What you see | What it is |
|---|---|
| Articles in the middle | Cover content (original, fictional) |
| **Search box** | Chat input while a collection is open. Otherwise it really searches the article |
| **Sponsored** ads on the right | Messages. "Promoted" are yours, "Sponsored" are from others |
| **Collections** in the left sidebar | Rooms. The "access code" is the room passphrase |
| **Sign in** | Username = your display name, password = `CHAT_TOKEN` |
| **AdChoices** link / **Esc** key | Private mode: every ad shows fake ad copy. **Click an ad** to reveal it for 8s |

It uses the same end-to-end encryption as the CLI (WebCrypto), so CLI and browser users can chat in the
same room. Browsers only allow WebCrypto on secure pages, so it works over `https://` or on
`http://localhost`, but not on plain `http://` to a remote host.
Your sign-in lasts for the browser tab. Access codes are kept only in memory, so you re-enter them after a reload.

Locally: `npm run server`, then open http://localhost:4545.

## Hosting the backend on your server

**With Claude Code:** clone the repo on the server, run `claude` in it and type `/setup-server`.
It follows [.claude/skills/setup-server/SKILL.md](.claude/skills/setup-server/SKILL.md): installs a hardened
systemd service, generates `CHAT_TOKEN`, configures Caddy or nginx with HTTPS, and checks the result.
Running `/setup-server` again later updates the deployment.

**Manually:**

1. Run the chat server on the server, bound to localhost, with an access token:

   ```bash
   CHAT_TOKEN='long-random-string' npm run server      # e.g. under systemd or pm2
   ```

2. Put a reverse proxy in front of it to handle HTTPS/TLS. With [Caddy](https://caddyserver.com),
   this gets a Let's Encrypt certificate automatically (WebSockets need no extra config):

   ```
   chat.example.com {
       reverse_proxy 127.0.0.1:4545
   }
   ```

   If you don't use a proxy, the server can handle TLS itself:
   `HOST=0.0.0.0 TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem npm run server`.

3. Connect from any machine:

   ```bash
   CHAT_SERVER=wss://chat.example.com CHAT_TOKEN='long-random-string' npm run chat
   ```

## Security model

| Layer | What it protects |
|---|---|
| **End-to-end encryption** (room passphrase) | Message text. Encrypted in the CLI with AES-256-GCM, using a key derived from the passphrase with PBKDF2-SHA256 (600k iterations, per-room salt). The server and database only store ciphertext. |
| **TLS** (`wss://`) | Everything on the wire, including names and room names, which are not end-to-end encrypted. |
| **`CHAT_TOKEN`** | Who can connect at all, so strangers can't create or delete rooms. |
| **Private mode** | People looking at your screen. Display-only camouflage. |

When you create a room, you choose its passphrase and share it with the other person **outside the app**.
The server never receives the passphrase or the key. If you lose the passphrase, the messages can't be recovered.

## Room list

| input        | action                        |
|--------------|-------------------------------|
| `1`, `2`     | join room (asks for passphrase once per session) |
| `n <name>`   | create room (max 2)           |
| `d <number>` | delete room and its messages  |
| `r` / `q`    | refresh / quit                |

## In a room

| command            | action                                                              |
|--------------------|---------------------------------------------------------------------|
| `/p`               | toggle private mode: redraws the screen with every message as code  |
| `/lang js\|py\|go` | language used for disguises                                         |
| `/r [n]`           | reveal message `#n` (default: the latest hidden message)            |
| `/c`               | redraw screen (re-hides anything revealed)                          |
| `/rooms`           | back to the room list                                               |
| `/delete`          | delete this room                                                    |
| `/q`               | quit                                                                |

Messages sent in private mode are marked 🔒 and show as code for everyone in the room.

## Config (env)

Server: `PORT` (4545) · `HOST` (127.0.0.1) · `CHAT_DB` (./data/chat.db) · `CHAT_TOKEN` · `TLS_CERT` / `TLS_KEY`
Client: `CHAT_SERVER` (ws://localhost:4545) · `CHAT_TOKEN` (or `--server`, `--token`, `--name`)

The CLI also reads these from a `.env` file in the current directory or the project root
(copy `.env.example`). Variables exported in the shell take priority. `.env` is git-ignored, so keep the token there.

## Layout

- `src/server.js`: HTTP(S) + WebSocket server; serves `web/` with a strict CSP; purges expired messages every minute
- `web/`: browser client (`app.js` UI, `crypto.js` WebCrypto twin of `src/crypto.js`, `articles.js` / `ads.js` cover content)
- `src/db.js`: SQLite schema and queries
- `src/crypto.js`: end-to-end encryption (WebCrypto-compatible format)
- `src/client.js`: protocol client (request/response + events)
- `src/cli.js`: terminal UI
- `src/disguise.js`: private-mode code generators
