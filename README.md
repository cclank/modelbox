# ModelBox

A standalone OpenAI-protocol proxy for debugging model context.

- Supports `POST /v1/responses`
- Supports `POST /v1/chat/completions`
- Supports `GET /v1/models`
- Modes: `passthrough` or `mock`
- Captures request/response JSONL logs with a stable `traceId`
- Runtime toggle via admin API (no restart)

## Run

```bash
cd tools/modelbox
MODELBOX_MODE=mock npm start
```

Default bind is `127.0.0.1:8787`.

## Environment

- `MODELBOX_BIND` default `127.0.0.1`
- `MODELBOX_PORT` default `8787`
- `MODELBOX_MODE` default `passthrough` (`passthrough` | `mock`)
- `MODELBOX_CAPTURE` default `true`
- `MODELBOX_LOG_FILE` default `./logs/modelbox.jsonl`
- `MODELBOX_MAX_CAPTURE_BYTES` default `2097152` (response body capture cap)
- `MODELBOX_UPSTREAM_BASE_URL` required in `passthrough` mode
- `MODELBOX_UPSTREAM_API_KEY` optional; if set, overrides outbound `Authorization`
- `MODELBOX_ADMIN_TOKEN` optional; protects `/admin/*`
- Backward compatibility: legacy `SIDECAR_*` env vars are still accepted.

## Admin API

### Get current state

```bash
curl -s http://127.0.0.1:8787/admin/state
```

### Update state dynamically

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

If `MODELBOX_ADMIN_TOKEN` is set, include:

```bash
-H 'Authorization: Bearer <token>'
```

## OpenClaw config example

Point a custom provider to ModelBox:

```json
{
  "models": {
    "providers": {
      "modelbox": {
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
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

Then use model `modelbox/debug-model`.

## OpenClaw integration (EN + 中文)

### EN

1. Start ModelBox:

```bash
cd tools/modelbox
MODELBOX_MODE=mock npm start
```

2. Configure OpenClaw provider:

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
      "contextWindow": 200000,
      "maxTokens": 8192
    }
  ]
}'
```

3. Set default model to ModelBox:

```bash
openclaw config set agents.defaults.model.primary "modelbox/debug-model"
```

4. If you use model allowlist (`agents.defaults.models`), include `modelbox/debug-model` there.

### 中文

1. 启动 ModelBox：

```bash
cd tools/modelbox
MODELBOX_MODE=mock npm start
```

2. 在 OpenClaw 里配置 provider：

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
      "contextWindow": 200000,
      "maxTokens": 8192
    }
  ]
}'
```

3. 把默认模型切到 ModelBox：

```bash
openclaw config set agents.defaults.model.primary "modelbox/debug-model"
```

4. 如果你启用了模型白名单（`agents.defaults.models`），要把 `modelbox/debug-model` 加进去。

## Generic integration for other agents (EN + 中文)

### EN

1. Point your client/provider base URL to:

```text
http://127.0.0.1:8787/v1
```

2. Use any API key value (ModelBox accepts and logs it; auth is controlled by your upstream and admin policy).
3. Use OpenAI-compatible endpoints:
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `GET /v1/models`
4. For transparent relay, set `MODELBOX_MODE=passthrough` and `MODELBOX_UPSTREAM_BASE_URL` (for example `https://api.openai.com`).
5. For context debugging without upstream calls, set `MODELBOX_MODE=mock`.

### 中文

1. 把你的客户端/provider 的 base URL 指向：

```text
http://127.0.0.1:8787/v1
```

2. API Key 可填任意值（ModelBox 会接收并记录；鉴权由上游和你的管理策略决定）。
3. 使用 OpenAI 兼容接口：
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `GET /v1/models`
4. 要透明转发到真实模型，使用 `MODELBOX_MODE=passthrough` 并配置 `MODELBOX_UPSTREAM_BASE_URL`（例如 `https://api.openai.com`）。
5. 只做上下文调试不调用上游，使用 `MODELBOX_MODE=mock`。

## Log format

Each JSONL line includes:

- `traceId`
- `direction` (`request` | `response`)
- `mode` (`mock` | `passthrough`)
- `path`, `method`, `status`
- `summary` (message count, roles, tools, images, prompt chars)
- request/response payload body and `sha256`

In `mock` mode the model output is a compact summary string:

```text
DEBUG_CONTEXT_SUMMARY {...}
```

Use `traceId` to correlate each request and response.
