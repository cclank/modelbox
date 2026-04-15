# ModelBox Tools

Utility scripts for analyzing ModelBox capture logs.

## `analyze.py`

Offline analyzer for `logs/modelbox.jsonl` (or any capture file in the
same format). Breaks down each `/v1/chat/completions` request into its
component sizes — **system prompt**, **conversation messages**, and
**tools schema** — so you can see where your input tokens actually go.

### Why you need this

ModelBox's built-in `summary.promptTokensApprox` only counts `messages`.
It does **not** include the `tools` field, which for modern agents often
rivals or exceeds the system prompt in size. This script measures every
part of the request, including tools.

### Quick start

```bash
# 1. Capture some traffic via ModelBox
MODELBOX_MODE=mock npm start
# ... run your agent ...

# 2. Analyze the capture
python3 tools/analyze.py logs/modelbox.jsonl            # overview
python3 tools/analyze.py logs/modelbox.jsonl tokens 0   # token breakdown of first chat request
python3 tools/analyze.py logs/modelbox.jsonl tools 0    # tools sorted by schema size
```

Optional: `pip install tiktoken` for accurate `cl100k_base` token counts
(without it the script falls back to `chars / 4`).

### Commands

| Command | Description |
|---|---|
| `summary` (default) | Record type distribution + chat request list + error summary |
| `list` | Every record on one line with raw line index |
| `chats` | All `/v1/chat/completions` requests with basic stats |
| `record <N>` | Full per-message + tools breakdown of chat request #N |
| `tokens <N>` | Token distribution chart (sorted bars) for chat request #N |
| `tools <N>` | All tools sorted by schema byte size, with % of total |
| `messages <N>` | Per-message content preview (truncated for long content) |
| `extract <N> [dir]` | Dump `system_prompt.md`, `messages.json`, `tools/*.json`, `meta.json` to a directory |
| `diff <A> <B>` | Compare two chat requests: sizes, tools diff, system prompt hash |

`N` is the **0-based index into chat/completions requests**, not the raw
file line number. Use `list` to see raw line indices.

### Example output

```
$ python3 tools/analyze.py logs/modelbox.jsonl tokens 1

=== Token distribution (chat request #1) ===

组件                               tokens      占比  图示
--------------------------------------------------------------------------------
tools_schema                       9712   51.3%  █████████████████████████
system_prompt                      9182   48.5%  ████████████████████████
msg[3].user                          36    0.2%
msg[2].assistant                     10    0.1%
msg[1].user                           3    0.0%
--------------------------------------------------------------------------------
TOTAL                             18943  100.0%
```

This shows the tools schema is actually slightly larger than the system
prompt — information ModelBox's own summary field misses.

### Typical workflows

**Find out why a request is big**
```bash
python3 tools/analyze.py logs/modelbox.jsonl tokens 0
python3 tools/analyze.py logs/modelbox.jsonl tools 0   # drill down into tools
```

**Check if prefix cache should be hitting**
```bash
python3 tools/analyze.py logs/modelbox.jsonl diff 0 1
# Look for: tools identical + system prompt hash identical = cache-friendly
```

**Save a system prompt for manual inspection**
```bash
python3 tools/analyze.py logs/modelbox.jsonl extract 0 ./debug/
cat ./debug/system_prompt.md
ls ./debug/tools/
```
