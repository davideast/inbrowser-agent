# Resumable Hono YouTube Briefcast

Paste a YouTube URL and get a narrated briefing. The app fetches the
YouTube transcript, streams transcript segments, writes a detailed Gemini
briefing, and uses Gemini TTS to generate WAV audio segments.

The example demonstrates `@inbrowser/resumable` as a durable progress log for a
multi-step AI media workflow. The sidebar and current briefcast can refresh or
reconnect from `?from=N` while the server continues writing events to RTDB.

## What You See

- A left sidebar with previous briefcasts and status badges.
- A new briefcast form for a YouTube URL.
- An audio player that appears as soon as the first TTS segment is ready, then
  switches to one combined WAV when narration is complete.
- Generated briefcast text below the player, updated as Gemini streams.
- Skeleton loaders while transcript, write-up, or audio are still pending.
- A collapsed transcript section that fills progressively.

## Setup

The UI can boot without secrets. By default, `.env.example` uses
`BRIEFCAST_STORE=memory`, which keeps the sidebar and job log in process for
local development. Real briefcast generation still needs Gemini.

```sh
bun install
cp examples/resumable-hono-youtube-briefcast/.env.example \
  examples/resumable-hono-youtube-briefcast/.env
```

For real YouTube-to-audio runs, fill in:

- `GEMINI_API_KEY`

For durable RTDB-backed jobs, set `BRIEFCAST_STORE=rtdb` and fill in:

- `RTDB_URL`
- `SERVICE_ACCOUNT_FILE`

On startup the server probes `RTDB_URL`. When `BRIEFCAST_STORE=rtdb` is set,
RTDB setup failures stop the server by default so you do not accidentally run
non-durable jobs. Set `BRIEFCAST_RTDB_FALLBACK=memory` only when you want a demo
to keep running with in-memory storage after RTDB fails.

If `GEMINI_API_KEY` is missing, the app still starts and the sidebar list
loads, but starting a briefcast creates an error job that tells you to add the
key.

The app remembers the selected briefcast id in browser local storage. If you
switch between `memory` and `rtdb`, click **Clear** in the sidebar to drop that
saved selection. Memory jobs cannot be ported after the server restarts because
their event log only existed in that process; the local WAV files may remain in
`.data/audio`, but the job timeline is gone.

When the server is using memory storage, the sidebar shows a warning because
briefcasts will disappear on restart. Persistent briefcasts require
`BRIEFCAST_STORE=rtdb` and a successful RTDB startup probe.

The default text model is `gemini-3.1-flash-lite`. The default TTS model is
`gemini-3.1-flash-tts-preview` to match this example's 3.1 briefcast theme.
If your Gemini project currently exposes the documented 2.5 TTS preview family
instead, set `GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts`.

## Run

Use two terminals:

```sh
bun --env-file=examples/resumable-hono-youtube-briefcast/.env \
  run --cwd examples/resumable-hono-youtube-briefcast dev:server
```

```sh
bun run --cwd examples/resumable-hono-youtube-briefcast vite --host 0.0.0.0 --port 5174
```

Open `http://localhost:5174`.

## RTDB Rules Index

For efficient cleanup on the resumable job log, add an index:

```json
{
  "rules": {
    "briefcast_jobs": {
      ".indexOn": ["expiresAt"]
    }
  }
}
```

`briefcast_index` stores sidebar metadata. This demo uses the server's service
account, so browser clients never talk to RTDB directly.

## Production Notes

Generated WAV files are stored under `.data/audio` and served by the Hono
server. The example writes segment files as `{index}.wav` plus a final
`combined.wav` once all segments are ready. A production app should write audio
to object storage and emit signed or public URLs in the audio-ready events.

The `youtube-transcript` package uses unofficial YouTube APIs, so transcript
fetching can break if YouTube changes its internals.
