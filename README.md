# whatsapp-container

A sandboxed way for AI agents to use WhatsApp — either their own dedicated line or their human's account.

Each WhatsApp line runs as an isolated Docker container with a REST API the agent can call to send messages, read conversations, search history, and receive live updates. The human retains full control: they hold the admin password, pair the device, and issue the API token the agent uses. The agent never touches the WhatsApp session directly.

Designed for:
- **Agent lines** — a dedicated burner number the agent owns and operates autonomously
- **Human lines** — the human's personal WhatsApp, with the agent acting as a controlled assistant that drafts messages for human approval before sending

**One script gets you from zero to running:**

```bash
git clone https://github.com/dennis-pbotty/whatsapp-container
cd whatsapp-container
./setup.sh
```

That's it. `setup.sh` installs Docker if missing, asks you to name your account(s), builds and starts the containers, and walks you through scanning the WhatsApp QR code.

---

## Requirements

- Linux or macOS
- Internet access (Docker and wacli are fetched during first build)
- A WhatsApp account to link (or a burner number for automated agents)

No other dependencies — Docker is installed automatically on Linux if it isn't present.

---

## What you get

| URL | What's there |
|-----|-------------|
| `http://<host>:<port>/` | Dashboard: connection status, token management, message queue, drafts |
| `http://<host>:<port>/chat` | Chat viewer and search |
| `http://<host>:<port>/api/health` | `{"ok":true}` |
| `http://<host>:<port>/api/status` | `{"connected":true/false,...}` |

Each account gets its own port (default starts at `8792`).

---

## Setup walkthrough

### 1. First run

```bash
./setup.sh
```

The script will:

1. Check (and install) Docker
2. Ask for an **admin password** — you'll use this in the dashboard to create API tokens
3. Ask you to name your first WhatsApp account (e.g. `"My Bot"` or `"Personal"`)
4. Ask for a port (default is `8792`; press Enter to accept)
5. Build and start the container
6. Walk you through QR-code pairing:
   - Option 1: scan directly in the terminal
   - Option 2: open the dashboard in a browser and scan there

Repeat for as many accounts as you need.

### 2. Re-running setup

Safe to run at any time:

```bash
./setup.sh
```

It will show your existing accounts (data untouched) and offer to add more.

---

## API tokens

> **Security model — read this first:**
>
> There are two levels of access:
>
> | Credential | Who holds it | What it can do |
> |------------|-------------|----------------|
> | Admin password (set during `./setup.sh`) | **Human only** | Create/revoke tokens, change settings — full control |
> | Bearer token (created by the human) | Agent / app | Send, read, draft — scoped to what the token allows |
>
> **Never give an agent the admin password.** An agent only needs a Bearer token.
> The human creates the token, then hands only that token to the agent.

### Creating a token (human step)

In the dashboard (`/` → Tokens → Create), or via the terminal on the host:

```bash
curl -X POST http://localhost:8792/api/tokens \
  -H "x-admin-secret: <your-admin-password>" \
  -H "Content-Type: application/json" \
  -d '{"label":"my-agent","readonly":false}'
# → {"token":"<bearer-token>",...}
```

Copy the returned token and give it to your agent.

### Using a token (agent step)

Include the token in every API request:

```
Authorization: Bearer <token>
```

Tokens can be **read-only** (`"readonly":true` — search/read only) or **read-write** (can send messages).

---

## Sending a message

```bash
curl -X POST http://localhost:8792/api/send \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"to":"972501234567","body":"Hello!"}'
```

Phone numbers must be in E.164 format — digits only, no `+` or spaces:

| Country | Local | E.164 |
|---------|-------|-------|
| Israel | `050-123-4567` | `972501234567` |
| USA | `(415) 555-0123` | `14155550123` |
| UK | `07911 123456` | `447911123456` |

### Draft/confirm flow (recommended for agents)

Send a draft for human review before it goes out:

```bash
# 1. Create draft
curl -X POST http://localhost:8792/api/draft \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"to":"972501234567","body":"Hello!"}'
# → {"id":"abc123",...}

# 2. Approve it
curl -X POST http://localhost:8792/api/confirm/abc123 \
  -H "Authorization: Bearer <token>"

# Or cancel it
curl -X DELETE http://localhost:8792/api/drafts/abc123 \
  -H "Authorization: Bearer <token>"
```

---

## Reading messages

```bash
# Recent messages in a chat
curl "http://localhost:8792/api/db/messages?limit=20" \
  -H "Authorization: Bearer <token>"

# Search
curl "http://localhost:8792/api/db/messages?q=invoice&limit=10" \
  -H "Authorization: Bearer <token>"

# List chats
curl "http://localhost:8792/api/db/chats" \
  -H "Authorization: Bearer <token>"
```

---

## Live updates (SSE)

```bash
curl -N http://localhost:8792/api/events \
  -H "Authorization: Bearer <token>"
```

Emits `status` events on connection changes and `message` events on incoming messages.

---

## Common commands

```bash
# View running containers
docker compose ps

# Logs (all accounts)
docker compose logs -f

# Logs (one account — slug is label lowercased, e.g. "My Bot" → wa-my-bot)
docker compose logs -f wa-my-bot

# Stop everything
docker compose down

# Start again (no rebuild)
docker compose up -d

# Rebuild after code changes
docker compose up -d --build
```

---

## Adding accounts later

```bash
./setup.sh
```

Pick "Add another account" when prompted.

---

## File layout

```
whatsapp-container/
├── setup.sh              ← run this
├── wa-agents-service/    ← the service image (all accounts use this)
│   ├── Dockerfile
│   ├── server.js
│   └── ...
├── data/                 ← generated; one folder per account (gitignored)
│   ├── mybot/
│   └── personal/
├── .accounts             ← generated account registry (gitignored)
├── .env                  ← admin password (gitignored)
├── docker-compose.yml    ← generated by setup.sh (gitignored)
```

---

## Security notes

- Keep services on a LAN, VPN (e.g. Tailscale), or behind a reverse proxy. Do **not** expose ports directly to the internet.
- WhatsApp Web automation is unofficial. Using a burner number for agent automation reduces risk of banning your personal account.
- `.env`, `data/`, `.accounts`, and `docker-compose.yml` are gitignored — never commit them.
- Each account must have its own data directory. Never share a `data/wacli/` folder between two running containers.
- **The admin password lives in `.env` on the host. Only the human operator should ever know it.** Agents receive Bearer tokens only — a compromised token can be revoked; a compromised admin password cannot be.

---

## Troubleshooting

**Container won't start / exits immediately**
```bash
docker compose logs wa-<accountname>
```

**QR code not showing in terminal**
Open the dashboard in a browser instead: `http://<host>:<port>/`

**Session disconnected after restart**
The session is saved in `data/<account>/wacli/session.db`. If WhatsApp invalidates it (e.g. you logged out on your phone), re-run `./setup.sh` and re-scan the QR code.

**Port conflict**
Edit `.accounts` — change the port number for the affected account — then re-run `./setup.sh`.
