#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


MODEL = os.environ.get("AGENT_ONE_MODEL") or os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:7b")
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
MAX_STEPS = int(os.environ.get("AGENT_ONE_MAX_STEPS", "20"))
ROOT = Path.cwd().resolve()


SYSTEM_PROMPT = f"""
You are agent-one, a local coding agent working on exactly one app.

Workspace root:
{ROOT}

Rules:
- Work only inside the workspace root.
- Inspect files before editing.
- Make small, reviewable changes.
- Prefer focused edits over broad rewrites.
- Run relevant tests or checks when possible.
- Never expose secrets or credentials.
- Do not commit, push, delete large folders, or run destructive commands.

You can use tools by replying with one JSON object only. Do not use Markdown.

Tool actions:
{{"tool":"list_files","args":{{"path":"."}}}}
{{"tool":"read_file","args":{{"path":"relative/path"}}}}
{{"tool":"write_file","args":{{"path":"relative/path","content":"full file content"}}}}
{{"tool":"replace_text","args":{{"path":"relative/path","old":"exact text","new":"replacement text"}}}}
{{"tool":"run_command","args":{{"command":"npm test"}}}}
{{"tool":"final","args":{{"summary":"what changed","checks":"what you ran or why not"}}}}

Important:
- Paths must be relative to the workspace root.
- Use final only when the task is complete or blocked.
- If a tool result shows an error, choose a different small next step.
- When writing test files, ALWAYS write the complete file — never use placeholder comments like "// Existing tests..." or "// ... rest of file". Include every test, every line.
- Tests: NEVER use a hardcoded port. Always start the server on port 0: const server = await new Promise(resolve => {{ const s = app.listen(0, () => resolve(s)); }}); then use http://127.0.0.1:${{server.address().port}} as the base URL.
- Tests: always export the app with module.exports = app; and start the server conditionally: if (require.main === module) {{ app.listen(port, cb); }}
""".strip()


def fail(message, code=1):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(code)


def ollama_chat(messages):
    body = {
        "model": MODEL,
        "messages": messages,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
    }
    request = urllib.request.Request(
        f"{OLLAMA_HOST}/api/chat",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        fail(f"Ollama is not reachable at {OLLAMA_HOST}: {exc}")
    return payload["message"]["content"]


def parse_action(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


def resolve_path(raw_path):
    raw_path = raw_path or "."
    path = (ROOT / raw_path).resolve()
    try:
        path.relative_to(ROOT)
    except ValueError:
        raise ValueError(f"path escapes workspace: {raw_path}")
    return path


def list_files(args):
    path = resolve_path(args.get("path", "."))
    if not path.exists():
        return {"error": f"path does not exist: {args.get('path', '.')}"}
    if path.is_file():
        return {"files": [str(path.relative_to(ROOT))]}
    ignored_dirs = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
    files = []
    for child in sorted(path.rglob("*")):
        rel = child.relative_to(ROOT)
        if any(part in ignored_dirs for part in rel.parts):
            continue
        suffix = "/" if child.is_dir() else ""
        files.append(f"{rel.as_posix()}{suffix}")
        if len(files) >= 200:
            files.append("... truncated at 200 entries")
            break
    return {"files": files}


def read_file(args):
    path = resolve_path(args["path"])
    if not path.is_file():
        return {"error": f"not a file: {args['path']}"}
    text = path.read_text(encoding="utf-8", errors="replace")
    if len(text) > 20000:
        return {"content": text[:20000], "truncated": True}
    return {"content": text}


def write_file(args):
    path = resolve_path(args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(args["content"], encoding="utf-8")
    return {"ok": True, "path": str(path.relative_to(ROOT))}


def replace_text(args):
    path = resolve_path(args["path"])
    if not path.is_file():
        return {"error": f"not a file: {args['path']}"}
    text = path.read_text(encoding="utf-8", errors="replace")
    old = args["old"]
    if old not in text:
        return {"error": "old text was not found"}
    updated = text.replace(old, args["new"], 1)
    path.write_text(updated, encoding="utf-8")
    return {"ok": True, "path": str(path.relative_to(ROOT))}


def command_is_blocked(command):
    lowered = command.lower()
    blocked_patterns = [
        r"\brm\s+-rf\b",
        r"\brmdir\b",
        r"\bdel\b",
        r"\bformat\b",
        r"\bshutdown\b",
        r"\bgit\s+push\b",
        r"\bgit\s+reset\b",
        r"\bgit\s+checkout\s+--\b",
        r"\bsudo\b",
        r"\bchmod\s+-r\b",
        r"\bchown\s+-r\b",
    ]
    return any(re.search(pattern, lowered) for pattern in blocked_patterns)


def run_command(args):
    command = args["command"]
    if command_is_blocked(command):
        return {"error": f"blocked command: {command}"}
    completed = subprocess.run(
        command,
        cwd=ROOT,
        shell=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=90,
    )
    output = completed.stdout
    if len(output) > 12000:
        output = output[-12000:]
    return {"exit_code": completed.returncode, "output": output}


TOOLS = {
    "list_files": list_files,
    "read_file": read_file,
    "write_file": write_file,
    "replace_text": replace_text,
    "run_command": run_command,
}


def git_snapshot(label):
    if not (ROOT / ".git").exists():
        return
    print()
    print(f"git status {label}:")
    subprocess.run(
        ["git", "config", "--global", "--add", "safe.directory", str(ROOT)],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    completed = subprocess.run(
        "git status --short",
        cwd=ROOT,
        shell=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    lines = [line for line in completed.stdout.splitlines() if "/node_modules/" not in line.replace("\\", "/")]
    if len(lines) > 80:
        lines = lines[:80] + ["... truncated git status output"]
    if lines:
        print("\n".join(lines))
    else:
        print("clean")


def main():
    task = " ".join(sys.argv[1:]).strip()
    if not task:
        fail("missing task", 2)

    print("agent-one")
    print(f"model: {MODEL}")
    print(f"ollama: {OLLAMA_HOST}")
    print(f"workdir: {ROOT}")
    git_snapshot("before run")

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": task},
    ]

    replace_fail_streak = 0
    replace_fail_path = None

    for step in range(1, MAX_STEPS + 1):
        print()
        print(f"step {step}/{MAX_STEPS}")
        raw = ollama_chat(messages)
        try:
            action = parse_action(raw)
        except Exception as exc:
            messages.append({"role": "assistant", "content": raw})
            messages.append({"role": "user", "content": f"Your last response was not valid JSON: {exc}. Reply with one valid JSON tool action."})
            print("model returned invalid JSON; asking it to repair")
            continue

        tool = action.get("tool")
        args = action.get("args") or {}
        print(f"tool: {tool}")

        if tool == "final":
            print()
            print(args.get("summary", "Done."))
            checks = args.get("checks")
            if checks:
                print()
                print(f"checks: {checks}")
            git_snapshot("after run")
            return

        if tool not in TOOLS:
            result = {"error": f"unknown tool: {tool}"}
        else:
            try:
                result = TOOLS[tool](args)
            except subprocess.TimeoutExpired:
                result = {"error": "command timed out"}
            except Exception as exc:
                result = {"error": str(exc)}

        # replace_text failure streak guard
        if tool == "replace_text" and result.get("error") == "old text was not found":
            p = args.get("path")
            replace_fail_streak = replace_fail_streak + 1 if p == replace_fail_path else 1
            replace_fail_path = p
        else:
            replace_fail_streak = 0
            replace_fail_path = None

        if replace_fail_streak >= 2:
            print(f"replace_text failed {replace_fail_streak}x on {replace_fail_path}; injecting write_file hint")
            messages.append({"role": "assistant", "content": json.dumps(action)})
            messages.append({"role": "user", "content": (
                f"Tool result:\n{json.dumps(result)}\n\n"
                f"replace_text has failed {replace_fail_streak} times on {replace_fail_path} because the old text does not match exactly. "
                f"Stop using replace_text on this file. Use read_file to read the current content, then use write_file to rewrite the entire file correctly with all changes applied."
            )})
            replace_fail_streak = 0
            replace_fail_path = None
            continue

        print(json.dumps(result, indent=2)[:4000])
        messages.append({"role": "assistant", "content": json.dumps(action)})
        messages.append({"role": "user", "content": "Tool result:\n" + json.dumps(result)})

    print()
    print("Stopped because AGENT_ONE_MAX_STEPS was reached.")
    git_snapshot("after run")
    raise SystemExit(1)


if __name__ == "__main__":
    main()
