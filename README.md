# Loopcast FFmpeg Render Service

Replaces Shotstack. Runs FFmpeg on a Render web service, uploads finished
videos to Cloudflare R2, and exposes the same async poll API that the Base44
app already expects (`POST /render` → job ID, `GET /render/:id` → status).

## Deploy to Render

1. **Create a new Web Service** on Render, connected to this folder (push
   it to a GitHub repo first). Choose **Docker** as the environment —
   the Dockerfile installs FFmpeg automatically.

2. **Set environment variables:**

   | Variable | Description |
   |---|---|
   | `FFMPEG_SERVICE_KEY` | A random auth key (e.g. `openssl rand -hex 32`). Must match the `FFMPEG_SERVICE_KEY` secret in Base44. |
   | `R2_ACCOUNT_ID` | Your Cloudflare account ID |
   | `R2_ACCESS_KEY_ID` | R2 API token (create under R2 → Manage R2 API Tokens) |
   | `R2_SECRET_ACCESS_KEY` | R2 API secret |
   | `R2_BUCKET_NAME` | R2 bucket name (e.g. `loopcast-renders`) |
   | `R2_PUBLIC_URL` | Public URL for the bucket (e.g. `https://renders.yourdomain.com` or the `r2.dev` subdomain) |

3. Render assigns a URL like `https://loopcast-render.onrender.com`.
   Copy it — you'll set it as `FFMPEG_SERVICE_URL` in Base44.

## Cloudflare R2 setup

1. Create an R2 bucket (e.g. `loopcast-renders`).
2. Enable public access: Settings → Public Access → enable the `r2.dev`
   subdomain (or connect a custom domain).
3. Create an API token: R2 → Manage R2 API Tokens → Create API Token with
   Object Read & Write permissions for the bucket.
4. The account ID, access key, secret, and bucket name go into Render's
   environment variables.

## Base44 secrets

In Base44 → Settings → Secrets, set:
- `FFMPEG_SERVICE_URL` → your Render service URL (e.g. `https://loopcast-render.onrender.com`)
- `FFMPEG_SERVICE_KEY` → the same key you set on Render

## API

### POST /render
```json
{
  "segments": ["https://.../clip1.mp4", "https://.../clip2.mp4"],
  "audio_url": "https://.../narration.mp3",
  "targetSeconds": 48,
  "captions": [{ "text": "...", "start": 0, "length": 4 }],
  "captionStyle": "bold_white",
  "clipDuration": 8,
  "assetType": "video"
}
```
Returns: `{ "id": "uuid" }`

### GET /render/:id
Returns: `{ "status": "pending" | "done" | "failed", "url": "https://..." }`

### GET /health
Returns: `{ "ok": true }` (no auth required)