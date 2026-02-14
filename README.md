<p align="center">
  <h1 align="center">ModelBox</h1>
  <p align="center">OpenAI-protocol proxy for context debugging, traffic capture, and safe mocking.</p>
</p>

<p align="center">
  <a href="./README.md"><img alt="English" src="https://img.shields.io/badge/Language-English-111827?style=for-the-badge"></a>
  <a href="./README.zh-CN.md"><img alt="简体中文" src="https://img.shields.io/badge/语言-简体中文-2563EB?style=for-the-badge"></a>
</p>

<p align="center">
  <img alt="Node >=22" src="https://img.shields.io/badge/Node-%3E%3D22-339933?logo=node.js&logoColor=white">
  <img alt="OpenAI Compatible" src="https://img.shields.io/badge/OpenAI-Compatible-0EA5E9">
  <img alt="Modes" src="https://img.shields.io/badge/Modes-mock%20%7C%20passthrough-7C3AED">
</p>

## Why ModelBox

ModelBox sits between your agent and model provider so you can inspect what is actually sent to the model.

- Capture full request/response payloads as JSONL with `traceId`
- Switch between `mock` and `passthrough` without restarting
- Keep OpenAI-compatible clients unchanged (`/v1/responses`, `/v1/chat/completions`)
- Debug context safely without polluting upstream model behavior

## Features

| Capability | Description |
|---|---|
| OpenAI-compatible endpoints | `POST /v1/responses`, `POST /v1/chat/completions`, `GET /v1/models` |
| Runtime control | `GET/POST /admin/state` to switch mode, capture, upstream |
| Structured logs | JSONL records for request/response with digest and summary |
| Mock mode | Returns deterministic `DEBUG_CONTEXT_SUMMARY {...}` output |
| Passthrough mode | Relays traffic to your real upstream model provider |

## Architecture

```mermaid
flowchart LR
  A[Agent / App] -->|OpenAI API| B[ModelBox]
  B -->|passthrough| C[Upstream Provider]
  B -->|JSONL capture| D[(logs/modelbox.jsonl)]
  E[Admin API] -->|/admin/state| B
```

## Quick Start

### 1. Start in mock mode

```bash
cd tools/modelbox
MODELBOX_MODE=mock npm start
```

Default bind: `127.0.0.1:8787`.

### 2. Start in passthrough mode

```bash
cd tools/modelbox
MODELBOX_MODE=passthrough \
MODELBOX_UPSTREAM_BASE_URL=https://api.openai.com \
MODELBOX_UPSTREAM_API_KEY="$OPENAI_API_KEY" \
npm start
```

Note: `MODELBOX_UPSTREAM_BASE_URL` should be provider root URL (for OpenAI use `https://api.openai.com`, not `/v1`).

## OpenClaw Integration

### Configure provider

```bash
openclaw config set models.providers.modelbox --json '{
  "baseUrl": "http://127.0.0.1:8787/v1",
  "api": "openai-responses",
  "apiKey": "modelbox-local",
  "models": [
    {
      "id": "debug-model",
      "name": "debug-model",
      "reasoning": false,
      "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 1000000,
      "maxTokens": 131072
    }
  ]
}'
```

### Switch to ModelBox in current session

```bash
/model modelbox/debug-model
# or
/new modelbox/debug-model
```

If you use `agents.defaults.models` allowlist, include `modelbox/debug-model` there so `/model` and session overrides can use it.

## Generic Integration (Any Agent)

1. Set base URL to `http://127.0.0.1:8787/v1`
2. Keep your OpenAI-compatible SDK/client unchanged
3. Use `MODELBOX_MODE=mock` for local context debugging
4. Use `MODELBOX_MODE=passthrough` for transparent relay

## Admin API

### Read state

```bash
curl -s http://127.0.0.1:8787/admin/state
```

### Update state at runtime

```bash
curl -s -X POST http://127.0.0.1:8787/admin/state \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "passthrough",
    "capture": true,
    "upstreamBaseUrl": "https://api.openai.com",
    "maxCaptureBytes": 4194304
  }'
```

If `MODELBOX_ADMIN_TOKEN` is configured, pass:

```bash
-H 'Authorization: Bearer <token>'
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MODELBOX_BIND` | `127.0.0.1` | Bind address |
| `MODELBOX_PORT` | `8787` | Listen port |
| `MODELBOX_MODE` | `passthrough` | `mock` or `passthrough` |
| `MODELBOX_CAPTURE` | `true` | Enable JSONL capture |
| `MODELBOX_LOG_FILE` | `./logs/modelbox.jsonl` | Log output file |
| `MODELBOX_MAX_CAPTURE_BYTES` | `2097152` | Max captured response bytes |
| `MODELBOX_UPSTREAM_BASE_URL` | empty | Upstream base URL (required in passthrough) |
| `MODELBOX_UPSTREAM_API_KEY` | empty | Optional upstream API key override |
| `MODELBOX_ADMIN_TOKEN` | empty | Optional admin API token |

Backward compatibility: legacy `SIDECAR_*` variables are still accepted.

## Log Format

Each JSONL line includes key fields such as:

- `traceId`
- `direction` (`request` or `response`)
- `mode` (`mock` or `passthrough`)
- `path`, `method`, `status`
- `summary` (`messageCount`, `roles`, `toolsCount`, `imagesCount`, `promptChars`)
- `body` and `bodySha256`

Mock output text is intentionally compact:

```text
DEBUG_CONTEXT_SUMMARY {...}
```
