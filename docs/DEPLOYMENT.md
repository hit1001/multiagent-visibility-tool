# Deployment

The dashboard is one Node.js process with a SQLite file. Run it locally with `agentscope`, or on a
server with Docker as described here.

## Docker

```bash
docker build -t agent-visibility .
docker run -d -p 4242:4242 -v mavt-data:/data \
  -e VISIBILITY_PASSWORD='choose-a-password' agent-visibility
```

Or with Compose:

```bash
cp .env.example .env      # set VISIBILITY_PASSWORD
docker compose up -d
```

The container listens on all interfaces, so it **will not start without `VISIBILITY_PASSWORD`**.
Runs, alert settings and `pricing.json` live in the `/data` volume. The image has a health check on
`GET /healthz`.

Agents then need an API key: sign in, open **API keys**, create one, and give it to the adapter or SDK
(`VISIBILITY_API_KEY`) together with the dashboard URL.

The MCP bridge only accepts connections from the same machine, so it is not started in the
container. Run `agentscope --mcp` next to your agent, or report over HTTP.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `VISIBILITY_PASSWORD` | none | Dashboard password. Required when `VISIBILITY_HOST` is not local. |
| `VISIBILITY_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Listen address |
| `VISIBILITY_PORT` | `4242` | Listen port |
| `VISIBILITY_DATA_DIR` | `~/.agentscope` (`/data` in the image) | Where `runs.db`, `alerts.json` and `pricing.json` are kept |
| `VISIBILITY_ENCRYPTION_KEY` | none | 64 hex characters. Encrypts stored event data (see below). |
| `VISIBILITY_SESSION_TTL_HOURS` | `12` | How long a login lasts |
| `VISIBILITY_COOKIE_SECURE` | off | Set to `1` when users reach the dashboard over HTTPS |
| `VISIBILITY_CORS_ORIGIN` | none | One browser origin allowed to call the API |
| `VISIBILITY_LICENCE` | none | Commercial licence key |

## HTTPS

The server speaks plain HTTP. On a network you don't fully control, put it behind a reverse proxy
that terminates TLS (Caddy, nginx, a cloud load balancer) and set `VISIBILITY_COOKIE_SECURE=1`.
Without TLS the password and every trace cross the network unencrypted.

Behind a proxy, all logins appear to come from the proxy's address, so the failed-login lockout
(10 failures in 15 minutes) applies to everyone at once.

## Encryption at rest

Traces contain prompts and model outputs. To encrypt them in the database:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # generate a key
export VISIBILITY_ENCRYPTION_KEY=<the 64 hex characters>
```

- Event payloads (prompts, responses, tool inputs and outputs, memory values) are encrypted with
  AES-256-GCM before they are written.
- Run goals, agent ids, API key hashes and the audit log are **not** encrypted, so that run search
  keeps working.
- Only events written while the key is set are encrypted; earlier runs stay as they were.
- **Keep a copy of the key.** Without it, encrypted runs cannot be replayed, exported or analysed.
  The server reports an error for those runs rather than starting without the key silently.
- The server refuses to start if the key is malformed.

## Cloud platforms

Any platform that runs a container works. Give it the image, a persistent volume mounted at
`/data`, and `VISIBILITY_PASSWORD` as a secret.

| Platform | Notes |
|---|---|
| AWS (ECS/Fargate, App Runner) | Mount EFS at `/data` for persistence. Health check path `/healthz`. |
| Google Cloud Run | Set `VISIBILITY_PORT` to the port Cloud Run provides (8080). Use one instance: live state is in memory, and SQLite on a network volume does not support several writers. |
| Azure Container Apps | Mount an Azure Files share at `/data`. One replica. |
| Hugging Face Spaces (Docker) | Set `VISIBILITY_PORT=7860` and add `VISIBILITY_PASSWORD` as a Space secret. |

Run a **single instance**. The live run is held in memory, so a second replica would show a
different view.

## Backups

Stop the container, or use `sqlite3 runs.db ".backup backup.db"`, and copy `runs.db` from the data
directory. Back up the encryption key separately.
