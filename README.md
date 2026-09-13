# Pi → Odysseus OpenAI bridge

A Pi extension that exposes the **live Pi agent session** as an OpenAI-compatible chat endpoint. Requests run through Pi's complete agent harness, including its system prompt, extensions, skills, coding tools, retries, and compaction.

## Routes

- `GET /health`, `/healthz`, `/v1/health`
- `GET /models`, `/v1/models`, `/v1/models/:id`
- `POST /chat/completions`, `/v1/chat/completions`
- `OPTIONS *` (CORS preflight)

Both streaming SSE and non-streaming chat completions are supported. OpenAI text content and base64 `data:` image URLs are accepted.

## Start

From any project you want Pi to operate on:

```bash
pi -e /Users/handlerone/Downloads/pi-odysseus-bridge
```

The default API base is:

```text
http://127.0.0.1:8787/v1
```

In Odysseus, add that URL as an OpenAI-compatible model endpoint. `/v1/models` exposes all models currently authenticated in Pi. Model IDs have the form `pi/<provider>/<model-id>` (for example `pi/claude-cli/claude-opus-5`). Selecting one routes the request through that Pi model. The `openai-codex` provider is exposed as `pi/chatgpt/...`, and any `codex` in an ID becomes `cdx`, because Odysseus treats IDs containing `codex` as non-chat models and hides them. Legacy `provider/model-id` and bare model IDs are still accepted in requests.

Quick checks:

```bash
curl http://127.0.0.1:8787/v1/models

curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"pi-agent","messages":[{"role":"user","content":"Say hello in one sentence"}]}'
```

Streaming:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"pi-agent","stream":true,"messages":[{"role":"user","content":"List the files here"}]}'
```

## Configuration

Set these before launching Pi:

| Variable | Default | Purpose |
|---|---:|---|
| `PI_BRIDGE_HOST` | `127.0.0.1` | Listen address. Use `0.0.0.0` only on a trusted network. |
| `PI_BRIDGE_PORT` | `8787` | Listen port. |
| `PI_BRIDGE_API_KEY` | unset | Optional bearer/API key. |
| `PI_BRIDGE_MAX_BODY_BYTES` | `10485760` | Maximum JSON request size. |
| `PI_BRIDGE_REQUEST_TIMEOUT_MS` | `1800000` | Agent request timeout. |

When a key is configured, either header works:

```text
Authorization: Bearer <key>
X-API-Key: <key>
```

## Behavior and limits

- The bridge intentionally returns only Pi's assistant text; internal Pi tool calls execute inside the harness rather than being delegated to Odysseus.
- System/developer messages are appended to Pi's system prompt for that request.
- The latest user message is sent to the persistent live Pi session, so Pi maintains conversation context. Use one Odysseus conversation per Pi process/session.
- HTTP requests are serialized. A request receives `409 pi_busy` if Pi is already processing a prompt started outside the bridge.
- The listener is a singleton across Pi processes. If the configured address already hosts a healthy `pi-odysseus-bridge`, another extension load reuses it instead of failing with `EADDRINUSE`. An unrelated service on the same address still produces an error.
- Keep the default loopback bind unless remote access is explicitly required. The extension has the same filesystem and shell permissions as Pi.

## Install persistently (optional)

```bash
pi install /Users/handlerone/Downloads/pi-odysseus-bridge
```

This starts the bridge whenever the package is enabled. For occasional testing, prefer `pi -e ...`.
