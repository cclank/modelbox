#!/usr/bin/env python3
"""
ModelBox JSONL capture analyzer.

Parses `logs/modelbox.jsonl` (or any modelbox capture file) and reports
structure, token distribution, and tool schema usage of the captured
OpenAI-compatible requests. Useful for context debugging and prompt
cache optimization.

USAGE
  python tools/analyze.py <file.jsonl>                    # overview (default)
  python tools/analyze.py <file.jsonl> list               # list every record
  python tools/analyze.py <file.jsonl> chats              # chat/completions requests only
  python tools/analyze.py <file.jsonl> record <N>         # details of chat request #N
  python tools/analyze.py <file.jsonl> tokens <N>         # token distribution chart
  python tools/analyze.py <file.jsonl> tools <N>          # tools sorted by schema size
  python tools/analyze.py <file.jsonl> messages <N>       # preview each message
  python tools/analyze.py <file.jsonl> extract <N> [dir]  # dump system/messages/tools to disk
  python tools/analyze.py <file.jsonl> diff <A> <B>       # compare two chat requests

NOTES
- N is the 0-based index into chat/completions requests (not the raw file
  line). Use `list` to see raw line indices.
- Token counts use tiktoken (cl100k_base) if installed, otherwise fall
  back to `chars / 4`. Run `pip install tiktoken` for accurate counts.
"""
import json
import sys
from pathlib import Path
from collections import Counter


# ---- token 估算(4 chars ≈ 1 token 粗估,若有 tiktoken 则用它) ----
try:
    import tiktoken
    _ENC = tiktoken.get_encoding("cl100k_base")
    def count_tokens(text: str) -> int:
        return len(_ENC.encode(text))
    TOKEN_METHOD = "tiktoken/cl100k_base"
except ImportError:
    def count_tokens(text: str) -> int:
        return len(text) // 4
    TOKEN_METHOD = "chars/4 (粗估,装 tiktoken 更准)"


def load(path: str):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def record_kind(r: dict) -> str:
    """分类: chat-req / chat-resp / models / props / error / other"""
    if "error" in r:
        return "error"
    p = r.get("path", "")
    d = r.get("direction", "")
    if p == "/v1/chat/completions":
        return f"chat-{d}"
    if p.startswith("/v1/models"):
        return f"models-{d}"
    if p.startswith("/v1/props"):
        return f"props-{d}"
    return f"{p}-{d}"


# ------------------------- 命令实现 -------------------------

def cmd_summary(records):
    print(f"文件总 record 数: {len(records)}")
    print(f"Token 估算方法: {TOKEN_METHOD}\n")

    kinds = Counter(record_kind(r) for r in records)
    print("Record 类型分布:")
    for k, v in kinds.most_common():
        print(f"  {k:30s} {v}")

    # chat/completions 请求的规模
    chats = [(i, r) for i, r in enumerate(records)
             if r.get("path") == "/v1/chat/completions" and r.get("direction") == "request"]
    print(f"\nChat completions 请求数: {len(chats)}")
    if chats:
        print("\n  #  idx  ts                    msgs  tools  promptChars  model")
        for i, (idx, r) in enumerate(chats):
            s = r.get("summary", {})
            body = r.get("body", {}) or {}
            tools_n = len(body.get("tools") or [])
            model = s.get("model") or body.get("model", "?")
            print(f"  {i:3d} {idx:4d} {r.get('ts','')[:19]}  {s.get('messageCount',0):4d}  "
                  f"{tools_n:5d}  {s.get('promptChars',0):11d}  {model}")

    errors = [r for r in records if "error" in r]
    if errors:
        print(f"\n错误记录 ({len(errors)}):")
        for r in errors[:5]:
            print(f"  [{r.get('ts','')[:19]}] {r.get('path')} -> {r.get('error')}")


def cmd_list(records):
    for i, r in enumerate(records):
        s = r.get("summary", {})
        tag = record_kind(r)
        ts = r.get("ts", "")[:19]
        extra = ""
        if s.get("messageCount"):
            extra = f" msgs={s['messageCount']} tools={s.get('toolsCount',0)} chars={s.get('promptChars',0)}"
        elif "error" in r:
            extra = f" error={r['error']}"
        print(f"[{i:4d}] {ts}  {tag:25s}{extra}")


def cmd_chats(records):
    chats = [(i, r) for i, r in enumerate(records)
             if r.get("path") == "/v1/chat/completions" and r.get("direction") == "request"]
    print(f"{len(chats)} 条 chat/completions 请求\n")
    for i, (idx, r) in enumerate(chats):
        body = r.get("body", {}) or {}
        msgs = body.get("messages", [])
        tools = body.get("tools") or []
        s = r.get("summary", {})
        roles = Counter(m.get("role") for m in msgs)
        print(f"[#{i} idx={idx}] {r.get('ts','')[:19]}")
        print(f"  model: {body.get('model')}   stream: {body.get('stream', False)}")
        print(f"  body keys: {list(body.keys())}")
        print(f"  messages: {len(msgs)}   roles: {dict(roles)}")
        print(f"  tools: {len(tools)}")
        print(f"  summary.promptChars: {s.get('promptChars')} (~{s.get('promptTokensApprox')} tokens by modelbox)")
        print()


def _get_chat_record(records, n: int) -> dict:
    """取第 N 条 chat/completions 请求(按 chat 序号,不是文件行号)"""
    chats = [r for r in records
             if r.get("path") == "/v1/chat/completions" and r.get("direction") == "request"]
    if n >= len(chats):
        print(f"只有 {len(chats)} 条 chat 请求,索引 {n} 越界", file=sys.stderr)
        sys.exit(1)
    return chats[n]


def cmd_record(records, n: int):
    r = _get_chat_record(records, n)
    body = r.get("body", {}) or {}
    msgs = body.get("messages", [])
    tools = body.get("tools") or []
    s = r.get("summary", {})

    print(f"=== Chat request #{n} ===")
    print(f"ts: {r.get('ts')}")
    print(f"traceId: {r.get('traceId')}")
    print(f"model: {body.get('model')}")
    print(f"stream: {body.get('stream')}")
    print(f"body top-level keys: {list(body.keys())}")
    print()

    # messages
    print(f"--- messages ({len(msgs)}) ---")
    total_msg_chars = 0
    for i, m in enumerate(msgs):
        content = m.get("content", "")
        if isinstance(content, list):
            content_len = sum(len(str(x)) for x in content)
        else:
            content_len = len(content or "")
        total_msg_chars += content_len
        extra = [k for k in m.keys() if k not in ("role", "content")]
        extra_tag = f" +{extra}" if extra else ""
        print(f"  [{i}] role={m.get('role'):10s} chars={content_len:7d} ~{count_tokens(str(content)):6d}tok{extra_tag}")

    # tools
    tools_json = json.dumps(tools, ensure_ascii=False) if tools else ""
    tools_chars = len(tools_json)
    print(f"\n--- tools ({len(tools)}) ---")
    print(f"  total chars: {tools_chars}   ~{count_tokens(tools_json)} tokens")

    # 汇总
    sys_chars = len(msgs[0].get("content", "")) if msgs and msgs[0].get("role") == "system" else 0
    non_sys_chars = total_msg_chars - sys_chars
    print(f"\n--- 汇总 ---")
    print(f"  system prompt (messages[0]):  {sys_chars:7d} chars  ~{count_tokens(msgs[0].get('content','')) if sys_chars else 0:6d} tokens")
    print(f"  对话消息 (messages[1:]):       {non_sys_chars:7d} chars")
    print(f"  tools 字段:                    {tools_chars:7d} chars  ~{count_tokens(tools_json):6d} tokens")
    total_chars = sys_chars + non_sys_chars + tools_chars
    total_tokens = count_tokens(msgs[0].get("content","") if sys_chars else "") + count_tokens(tools_json) + sum(count_tokens(str(m.get("content",""))) for m in msgs[1:])
    print(f"  合计:                          {total_chars:7d} chars  ~{total_tokens:6d} tokens")
    print(f"  modelbox summary 报告:         promptChars={s.get('promptChars')} promptTokensApprox={s.get('promptTokensApprox')}")
    if tools:
        print(f"  ⚠ 注意: modelbox 的 promptTokensApprox 通常只统计 messages,不含 tools 字段")


def cmd_tokens(records, n: int):
    """token 分布饼图(文本版)"""
    r = _get_chat_record(records, n)
    body = r.get("body", {}) or {}
    msgs = body.get("messages", [])
    tools = body.get("tools") or []

    parts = []
    if msgs and msgs[0].get("role") == "system":
        parts.append(("system_prompt", count_tokens(msgs[0].get("content", ""))))
    for i, m in enumerate(msgs[1:], 1):
        parts.append((f"msg[{i}].{m.get('role')}", count_tokens(str(m.get("content", "")))))
    if tools:
        parts.append(("tools_schema", count_tokens(json.dumps(tools, ensure_ascii=False))))

    total = sum(p[1] for p in parts) or 1
    print(f"=== Token 分布 (chat request #{n}) ===\n")
    print(f"{'组件':30s} {'tokens':>8s}  {'占比':>6s}  图示")
    print("-" * 80)
    for name, toks in sorted(parts, key=lambda x: -x[1]):
        pct = toks / total * 100
        bar = "█" * int(pct / 2)
        print(f"{name:30s} {toks:8d}  {pct:5.1f}%  {bar}")
    print("-" * 80)
    print(f"{'TOTAL':30s} {total:8d}  100.0%")


def cmd_tools(records, n: int):
    r = _get_chat_record(records, n)
    tools = (r.get("body") or {}).get("tools") or []
    if not tools:
        print("该 record 没有 tools")
        return

    rows = []
    for t in tools:
        fn = t.get("function", {})
        name = fn.get("name", "?")
        desc = fn.get("description", "")
        chars = len(json.dumps(t, ensure_ascii=False))
        rows.append((chars, name, len(desc), desc[:80]))
    rows.sort(reverse=True)

    total = sum(r[0] for r in rows)
    print(f"=== Tools ({len(tools)}) 按 schema 大小降序 ===\n")
    print(f"{'#':>3s} {'chars':>6s} {'pct':>5s} {'desc_len':>8s}  {'name':30s}  description")
    print("-" * 110)
    for i, (chars, name, dlen, dsnip) in enumerate(rows):
        pct = chars / total * 100
        print(f"{i+1:3d} {chars:6d} {pct:4.1f}% {dlen:8d}  {name:30s}  {dsnip}")
    print("-" * 110)
    print(f"{'合计':>3s} {total:6d}  ~{count_tokens(json.dumps(tools, ensure_ascii=False))} tokens")


def cmd_messages(records, n: int):
    r = _get_chat_record(records, n)
    msgs = (r.get("body") or {}).get("messages") or []
    for i, m in enumerate(msgs):
        content = m.get("content", "")
        if isinstance(content, list):
            content_str = json.dumps(content, ensure_ascii=False)
        else:
            content_str = str(content or "")
        print(f"===== messages[{i}]  role={m.get('role')}  chars={len(content_str)} =====")
        extra = {k: v for k, v in m.items() if k not in ("role", "content")}
        if extra:
            print(f"  (extra fields: {list(extra.keys())})")
        preview = content_str if len(content_str) <= 2000 else content_str[:1000] + f"\n...[省略 {len(content_str)-2000} 字符]...\n" + content_str[-1000:]
        print(preview)
        print()


def cmd_extract(records, n: int, out_dir: str = None):
    r = _get_chat_record(records, n)
    body = r.get("body") or {}
    msgs = body.get("messages") or []
    tools = body.get("tools") or []

    out = Path(out_dir or f"./chat_{n}_extracted")
    out.mkdir(parents=True, exist_ok=True)

    # system prompt
    if msgs and msgs[0].get("role") == "system":
        (out / "system_prompt.md").write_text(msgs[0].get("content", ""), encoding="utf-8")

    # 其他消息
    (out / "messages.json").write_text(
        json.dumps(msgs, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # tools
    if tools:
        (out / "tools.json").write_text(
            json.dumps(tools, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        # 每个 tool 一个文件
        tools_dir = out / "tools"
        tools_dir.mkdir(exist_ok=True)
        for t in tools:
            name = t.get("function", {}).get("name", "unknown")
            (tools_dir / f"{name}.json").write_text(
                json.dumps(t, ensure_ascii=False, indent=2), encoding="utf-8"
            )

    # 元信息
    meta = {
        "ts": r.get("ts"),
        "traceId": r.get("traceId"),
        "model": body.get("model"),
        "stream": body.get("stream"),
        "body_keys": list(body.keys()),
        "message_count": len(msgs),
        "tools_count": len(tools),
        "summary": r.get("summary"),
    }
    (out / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"已拆出到 {out.resolve()}")
    for f in sorted(out.rglob("*")):
        if f.is_file():
            print(f"  {f.relative_to(out)}  ({f.stat().st_size} bytes)")


def cmd_diff(records, a: int, b: int):
    """比较两条 chat 请求的差异"""
    ra = _get_chat_record(records, a)
    rb = _get_chat_record(records, b)
    ba = ra.get("body") or {}
    bb = rb.get("body") or {}

    def stats(body):
        msgs = body.get("messages") or []
        tools = body.get("tools") or []
        sys_c = len(msgs[0].get("content", "")) if msgs and msgs[0].get("role") == "system" else 0
        tools_c = len(json.dumps(tools, ensure_ascii=False)) if tools else 0
        return {
            "msgs": len(msgs),
            "roles": dict(Counter(m.get("role") for m in msgs)),
            "sys_chars": sys_c,
            "non_sys_chars": sum(len(str(m.get("content",""))) for m in msgs[1:]),
            "tools_count": len(tools),
            "tools_chars": tools_c,
            "tool_names": sorted(t.get("function",{}).get("name","?") for t in tools),
        }

    sa, sb = stats(ba), stats(bb)
    print(f"=== Diff #{a} vs #{b} ===\n")
    keys = ["msgs", "roles", "sys_chars", "non_sys_chars", "tools_count", "tools_chars"]
    for k in keys:
        mark = " " if sa[k] == sb[k] else "*"
        print(f"  {mark} {k:15s}  A={sa[k]!s:20s}  B={sb[k]!s:20s}")

    only_a = set(sa["tool_names"]) - set(sb["tool_names"])
    only_b = set(sb["tool_names"]) - set(sa["tool_names"])
    if only_a or only_b:
        print("\n  tools 差异:")
        if only_a:
            print(f"    仅 A 有: {sorted(only_a)}")
        if only_b:
            print(f"    仅 B 有: {sorted(only_b)}")
    else:
        print("\n  tools 完全一致 ✓")

    # 系统提示词 hash 对比
    import hashlib
    def sys_hash(body):
        msgs = body.get("messages") or []
        if msgs and msgs[0].get("role") == "system":
            return hashlib.sha256(msgs[0]["content"].encode()).hexdigest()[:12]
        return None
    ha, hb = sys_hash(ba), sys_hash(bb)
    print(f"\n  system prompt hash:  A={ha}  B={hb}  {'✓ 一致' if ha==hb else '✗ 不同'}")


# ------------------------- 入口 -------------------------

COMMANDS = {
    "summary": lambda recs, args: cmd_summary(recs),
    "list":    lambda recs, args: cmd_list(recs),
    "chats":   lambda recs, args: cmd_chats(recs),
    "record":  lambda recs, args: cmd_record(recs, int(args[0])),
    "tokens":  lambda recs, args: cmd_tokens(recs, int(args[0])),
    "tools":   lambda recs, args: cmd_tools(recs, int(args[0])),
    "messages":lambda recs, args: cmd_messages(recs, int(args[0])),
    "extract": lambda recs, args: cmd_extract(recs, int(args[0]), args[1] if len(args)>1 else None),
    "diff":    lambda recs, args: cmd_diff(recs, int(args[0]), int(args[1])),
}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    file_path = sys.argv[1]
    cmd = sys.argv[2] if len(sys.argv) > 2 else "summary"
    args = sys.argv[3:]

    if cmd not in COMMANDS:
        print(f"未知命令: {cmd}\n可用命令: {', '.join(COMMANDS)}")
        sys.exit(1)

    records = load(file_path)
    COMMANDS[cmd](records, args)


if __name__ == "__main__":
    main()
