# Architecture

This project runs a private AI coding workspace on a Windows homelab machine using Docker Desktop, Tailscale, code-server, Open WebUI, Ollama, and Codex CLI.

## Host

- Windows laptop/server
- Docker Desktop
- Tailscale
- Ollama running directly on Windows
- Project path: `C:\Users\mario\server\ai-coding-agent`

## Services

| Service | Container | Local URL | Purpose |
| --- | --- | --- | --- |
| code-server | `homelab_code_server` | `http://localhost:8081` | Browser-based coding workspace |
| Open WebUI | `homelab_open_webui` | `http://localhost:8082` | Browser chat UI for Ollama models |
| Ollama | Windows host process | `http://127.0.0.1:11434` | Local model runtime |
| OpenHands | `homelab_openhands` | `http://localhost:8083` | Optional dedicated coding-agent runtime |

Tailscale HTTPS access is handled outside this Compose stack. Use the machine's Tailscale HTTPS address from trusted devices.

## Workspace Boundary

Only this project folder is mounted into the coding container:

```text
./workspace:/home/coder/workspace
```

The full Windows drive is not mounted. Active project work should happen under `workspace/`, which is ignored by Git in this infrastructure repo.

Agent rules are mounted read-only:

```text
./config/agent-rules.md:/home/coder/agent-rules.md:ro
```

## Local Model Flow

Ollama runs on the Windows host. Docker containers reach it through:

```text
http://host.docker.internal:11434
```

The code-server container also starts a local forward:

```text
127.0.0.1:11434 -> host.docker.internal:11434
```

This lets Codex CLI use Ollama as a local provider from inside the container.

## Agent Flow

Inside code-server:

```bash
agent-doctor
```

```bash
cd /home/coder/workspace/<project-folder>
agent-local "Inspect this project and suggest one small improvement."
```

Alternate model:

```bash
agent-local --model llama3.1:8b "Inspect this project and suggest one small improvement."
```

The helper wraps:

```bash
codex exec --oss --local-provider ollama -m qwen2.5-coder:7b --sandbox workspace-write
```

Always review `git diff` before committing.

## OpenHands Flow

OpenHands runs only when the `openhands` Compose profile is enabled:

```cmd
docker build -f Dockerfile.openhands-agent -t homelab-openhands-agent-server:latest .
docker compose --profile openhands up -d openhands
```

The web app listens on host port `8083` because port `3000` is already used by another homelab service. It talks to the Windows-host Ollama server through the OpenAI-compatible endpoint:

```text
http://host.docker.internal:11434/v1
```

The sandbox callback URL is set to:

```text
WEB_HOST=host.docker.internal:8083
http://host.docker.internal:8083
```

This prevents OpenHands from sending sandbox webhooks to the unrelated host service already using port `3000`.

The OpenHands sandbox receives only the repo workspace folder:

```text
/run/desktop/mnt/host/c/Users/mario/server/ai-coding-agent/workspace:/workspace/project:rw
```

This keeps OpenHands focused on active projects under `workspace/` and avoids mounting the full Windows drive.

The sandbox uses a small local image built from `Dockerfile.openhands-agent`. It is based on the upstream OpenHands agent-server image, adds `/workspace/project` to git's system-level `safe.directory` list, and rewrites OpenHands' default sandbox webhook callback from host port `3000` to `8083` for this machine.

## Current Limitations

- `qwen2.5-coder:7b` is stable on this machine and good for coding discussion.
- Smaller local models may produce plans or tool-call-looking text instead of reliably applying edits.
- `qwen2.5-coder:14b` was removed after a CUDA crash on this machine.
- Open WebUI is useful for model switching and chat, but it does not replace code review.
- OpenHands may still require a stronger local agentic coding model for reliable tool use.
- OpenHands successfully starts against local Ollama, but `qwen2.5-coder:7b` and `llama3.1:8b` produced tool-call-looking text during a README creation smoke test instead of editing files.
