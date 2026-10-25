# Self-hosting OpenGMB

This runs the community edition of OpenGMB (Postgres, web app, MCP server and worker) on one machine with Docker Compose. You use your own Google Cloud project, your own email domain and your own API keys. Everything lives in `deploy/selfhost/`.

One owner login manages as many clients and locations as you like. There is no sign-up page and no billing. You set the owner's email and password in the env file.

Out of the box the Google client runs in `mock` mode (no live Google calls). Going live needs Google's approval of Business Profile API access for your project (step 3), which you request yourself and which can take days.

## 1. Prerequisites

- A Linux server or workstation with Docker Engine 24+ and the Compose plugin (`docker compose version`).
- About 4 GB of RAM free during the image build and 2 GB of disk for the image.
- A public hostname with HTTPS for the web app and the worker (Google OAuth and Pub/Sub push need it). Put a reverse proxy (Caddy, nginx, Traefik) in front of the host ports below; the stack does not do TLS.
- A Google account that can create Google Cloud projects. Optional: a Resend account for email, an Anthropic key for AI features, and a DataForSEO account for rank tracking.

Default host ports are **8080** (web), **8081** (MCP) and **8082** (worker), so on the machine itself the web app is at <http://localhost:8080>. Change them in `.env` (`WEB_HOST_PORT`, `MCP_HOST_PORT`, `WORKER_HOST_PORT`) if they are taken. Postgres is not published to the host.

## 2. Configure

```sh
cd deploy/selfhost
cp .env.example .env
```

Generate the secrets and paste them into `.env`:

```sh
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY       (exactly 32 bytes, base64)
openssl rand -base64 32   # AUDIT_CHECKPOINT_KEY (different from ENCRYPTION_KEY)
```

Set `WEB_URL` to the public URL of the web app (no trailing slash) and `WORKER_PUBLIC_URL` to the public URL of the worker. Keep a copy of `ENCRYPTION_KEY` somewhere safe: it encrypts the stored Google refresh tokens and DataForSEO keys, and without it those become unreadable. `.env` is git-ignored; never commit it.

Set the owner login:

- `OWNER_EMAIL` and `OWNER_PASSWORD` (8 to 128 characters). On the first start, when the database has no organization, OpenGMB creates the organization and this owner. Change the password in the app after you sign in. From then on the password in the file is ignored.
- `OWNER_ORG_NAME` (optional) names the first organization. It starts as "My agency".

After you change `.env`, apply it with `docker compose up -d` (it recreates the containers whose settings changed). `docker compose restart` does not work for this: it restarts the old containers with the old environment.

Your own API keys go in the same file. Each feature stays off until its key is set, and the rest of the app keeps working:

- `ANTHROPIC_API_KEY` for AI drafts, review reply suggestions and report summaries.
- `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` for rank tracking.
- `PIXABAY_API_KEY` for stock photos on posts, and `OPENAI_API_KEY` for AI-generated post images.
- `RESEND_API_KEY` and `EMAIL_FROM` for email (step 4).

You pay each of these providers directly. OpenGMB adds no charge and has no credits.

## 3. Google Cloud project, OAuth client and Business Profile API

All of this is in your own Google Cloud project, so quota and approval belong to you.

1. Create a project at <https://console.cloud.google.com/>.
2. **Business Profile API access.** Request access for the project (the application form is linked from <https://developers.google.com/my-business/content/prereqs>). Until Google approves it the Business Profile APIs return quota errors, so keep `GOOGLE_BUSINESS_API_MODE=mock`. After approval enable the Business Profile APIs for the project (Account Management, Business Information, Performance, Notifications, and the legacy My Business API where the docs still require it) and set `GOOGLE_BUSINESS_API_MODE=live`.
3. **OAuth consent screen** (APIs & Services, OAuth consent screen). User type External. Add the scope `https://www.googleapis.com/auth/business.manage`. While the app is unverified it stays in Testing: add every Google account that will connect a profile under **Test users** (up to 100). Google expires refresh tokens of apps in Testing after 7 days, so reconnect weekly until you publish the app and pass verification.
4. **OAuth client** (Credentials, Create credentials, OAuth client ID, type Web application). Authorized redirect URIs: `<WEB_URL>/api/google/callback` and `<WEB_URL>/api/auth/callback/google` (for example `https://gmb.example.com/api/google/callback`). Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Pub/Sub push (new-review notifications)

Optional, and only useful once the Business Profile API is live. The web app must be reachable over HTTPS.

1. In the same project, enable the My Business Notifications API and the Pub/Sub API, then create a topic, for example `gbp-notifications`.
2. Give `mybusiness-api-pubsub@system.gserviceaccount.com` the **Pub/Sub Publisher** role on the topic.
3. Create a service account for push delivery. Its email is `PUBSUB_SERVICE_ACCOUNT_EMAIL`.
4. Create a **push** subscription on the topic. Endpoint: `<WEB_URL>/webhooks/google-pubsub`. Enable authentication with that service account and set the audience to the endpoint URL; the same string is `PUBSUB_AUDIENCE`.
5. Set `PUBSUB_TOPIC` (the full name, `projects/<project>/topics/<topic>`), `PUBSUB_AUDIENCE` and `PUBSUB_SERVICE_ACCOUNT_EMAIL` in `.env` and restart the stack. New Google connections are registered automatically.

With the three settings empty the webhook answers 503 and nothing else breaks.

## 4. Email (Resend)

1. In Resend, add and verify your sending domain (add the DNS records Resend shows: SPF, DKIM).
2. Create an API key and set `RESEND_API_KEY`.
3. Set `EMAIL_FROM` to an address on that domain, for example `"OpenGMB <notifications@your-domain.com>"`.

With `RESEND_API_KEY` empty the daily notification digest is skipped (logged, nothing sent).

## 5. DataForSEO and Google Maps (optional)

Rank tracking uses DataForSEO with your own account. Create one at <https://dataforseo.com/>, copy the **API login** and **API password** from the API Access page (the API password is generated for you and is not your account password), and set `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`. Runs are billed to you at DataForSEO's price.

The rank tracking run detail draws its grid over a Google Maps JavaScript API map. Without a key it shows a placeholder and the rank table instead; nothing else changes.

1. In your Google Cloud project enable **Maps JavaScript API** (billing must be on).
2. Create an API key. Application restriction: **Websites**, add `https://<your web domain>/*`. API restriction: **Maps JavaScript API** only.
3. Set `GOOGLE_MAPS_BROWSER_KEY` and restart web. The key is sent to browsers by design; the referrer restriction is what protects it.

## 6. First run

```sh
cd deploy/selfhost
docker compose up -d --build     # builds one image, runs migrations, starts web, mcp and worker
docker compose ps                # postgres, web, mcp and worker should be "healthy"; migrate "Exited (0)"
docker compose logs migrate      # should end with "migrations applied"
```

The first command builds the image once (a few minutes) and then starts everything; only the `migrate` service builds, and web, mcp and worker reuse its image.

1. Open `WEB_URL` (on the machine itself, <http://localhost:8080> with the default port) and **sign in** with `OWNER_EMAIL` and `OWNER_PASSWORD`. Change the password in the app.
2. **Two-factor sign-in is required.** On the first sign-in the app does not let you in until you enrol an authenticator app (scan the QR code or type the key, then enter a 6-digit code). It then shows your backup codes once. Save them before you continue: they are the only way in if you lose the authenticator. Every later sign-in asks for a code.
3. Connect Google under Settings, Google. With the OAuth client from step 3 the button is "Connect Google account". Without one, and while `GOOGLE_BUSINESS_API_MODE=mock`, press **Use the sample Google account** instead: it connects a built-in sample account, so you can import its sample locations and try every screen. The button is not offered in live mode.
4. Optional: the audit-chain checkpoint is created for you when the owner and organization are created on the first start, so there is nothing to do. The backfill command is only for a database that was created before checkpoints existed:

   ```sh
   docker compose run --rm --no-deps mcp pnpm audit:checkpoint-backfill
   ```

   It refuses to run, and exits with an error, on an empty database.
5. To use the MCP server (`POST <MCP url>/mcp`, health at `/healthz`), create an API token: in the web app at `/settings/tokens`, or `docker compose run --rm --no-deps mcp pnpm token:create you@example.com "my laptop"` (the `claude mcp add` line it prints uses the container port; replace it with your public MCP URL).

## 7. Backups

All state is in the Postgres volume (including the job queue).

```sh
cd deploy/selfhost
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > backup-$(date +%F).dump
```

Restore into a stopped stack's fresh database:

```sh
docker compose up -d postgres
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < backup-2026-01-01.dump
```

Back up `.env` separately, especially `ENCRYPTION_KEY` and `AUDIT_CHECKPOINT_KEY`: a database dump is not usable for stored secrets or audit-chain verification without them. Run the dump from cron and copy it off the machine.

## 8. Upgrading

```sh
cd deploy/selfhost
git pull
docker compose up -d --build     # rebuilds the image; the migrate service applies new migrations first
docker compose logs migrate
```

Take a backup first. Migrations run when the stack starts and only move forward; to roll back, restore the dump and check out the older version.

## Push alerts (optional)

Installed browsers can get an alert when a new review arrives or something waits for approval. Without the three variables below the feature is hidden and nothing errors.

1. Generate a VAPID key pair once: `npx web-push generate-vapid-keys --json`.
2. Put the values in `.env`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` set to `mailto:you@your-domain.com`.
3. Restart the stack. Open Settings, Notifications, and press "Turn on alerts on this device". On an iPhone, add OpenGMB to the Home Screen first (Share, Add to Home Screen) and open it from there.

Keep the key pair. Changing it later silently stops every device that subscribed with the old one.

## Troubleshooting

- The mcp and worker logs print `../../.env not found. Continuing without it.` at start. It is harmless: the apps read an optional `.env` file at the repository root, and the containers get their settings from the compose environment instead.
- `docker compose config` prints the resolved configuration; a missing required variable is reported by name.
- `docker compose logs -f web mcp worker` for application logs. The worker prints which Pub/Sub settings are missing.
- Sign-in redirects to the wrong host: `WEB_URL` must be the exact public URL, including `https://`.
- No account on first start: set `OWNER_EMAIL` and `OWNER_PASSWORD` and restart. The web log says when the owner was created.
- Google "redirect_uri_mismatch": the URI in the OAuth client must equal `<WEB_URL>/api/google/callback` or `<WEB_URL>/api/auth/callback/google` exactly.
