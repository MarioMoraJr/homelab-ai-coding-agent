# Homelab AI Coding Agent

A self-hosted AI coding agent workspace for managing local development projects from my homelab server.

## Goal

Build a private Codex-style coding environment that can run on my own laptop/server and be accessed from my devices through Tailscale.

## Planned Stack

- Docker
- code-server
- Open WebUI
- OpenHands
- GitHub CLI
- Tailscale
- Local workspaces
- AI coding agent tools
- Local LLM support with Ollama

## Safety Model

- Active project workspaces are not uploaded to GitHub
- Secrets and environment files are ignored
- AI changes should be reviewed before commits
- Work should happen inside a dedicated workspace folder

## Status

Docker is working on Windows. The first safe workspace container is configured with Docker Compose.

## Documentation

- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md)

## First Container

The starter stack runs code-server in Docker and mounts only the local workspace folder:

```text
./workspace:/home/coder/workspace
```

The agent rules are mounted read-only:

```text
./config/agent-rules.md:/home/coder/agent-rules.md:ro
```

Create a local `.env` file from the example before starting:

```cmd
copy .env.example .env
```

Edit `.env` and replace `change-this-password` with a private password. Then start the container:

```cmd
docker compose up -d
```

Open code-server:

```text
http://localhost:8081
```

Open the model chat UI:

```text
http://localhost:8082
```

## Remote Access

The code-server container is reachable over Tailscale from trusted devices using the machine's Tailscale HTTPS address:

```text
https://<tailscale-machine-name-or-address>
```

Use the password from the local `.env` file. Do not commit `.env` or share the password publicly.

## Ollama

Ollama is expected to run on the Windows host. Containers can reach it through Docker Desktop at:

```text
http://host.docker.internal:11434
```

The starter model is configured in `.env`:

```text
OLLAMA_MODEL=qwen2.5-coder:7b
```

The code-server container receives both `OLLAMA_HOST` and `OLLAMA_MODEL` as environment variables so agent tools can use the local model service.

Open WebUI runs on port `8082` and connects to the same host Ollama service. Use it to chat with installed models and switch between available Ollama models from the browser.

## OpenHands

OpenHands is included as an optional agent runtime for testing local model file-editing behavior. It is behind a Compose profile so the stable code-server and Open WebUI stack still starts with the normal command.

Start OpenHands:

```cmd
docker compose --profile openhands up -d openhands
```

Open it at:

```text
http://localhost:8083
```

The default local model settings are:

```text
Custom Model: openai/qwen2.5-coder:7b
Base URL: http://host.docker.internal:11434/v1
API Key: local-llm
```

If the UI prompts for setup, open the advanced LLM settings and use those values. The OpenHands sandbox mounts only this repo's `workspace/` folder at `/workspace`.

Stop OpenHands without stopping the stable base stack:

```cmd
docker compose --profile openhands stop openhands
```

## Coding Agent Tools

The code-server image is built locally from `Dockerfile.code-server`. It includes Git, Node.js/npm, Python, pip, venv support, Codex CLI, Bubblewrap sandbox support, `ripgrep`, `jq`, `tree`, build tools, and `socat` for local service forwarding.

Inside code-server, Codex CLI can use the host Ollama service through a localhost forward:

```bash
codex --oss --local-provider ollama -m qwen2.5-coder:7b
```

Use the helper command for local agent runs:

```bash
cd /home/coder/workspace/<project-folder>
agent-local "Inspect this project and suggest one small improvement."
```

Check the local agent toolchain:

```bash
agent-doctor
```

Use a different local model:

```bash
agent-local --model llama3.1:8b "Inspect this project and suggest one small improvement."
```

Review changes before committing:

```bash
git diff
git status
```

Commit only reviewed changes:

```bash
git add <files>
git commit -m "Describe the change"
```

Current local-model note: Ollama-backed Codex CLI is useful for chat, inspection, and planning. Some small local models may produce tool-call-looking text instead of reliably editing files, so always check `git diff` and expect to manually apply or adjust small changes.

Rebuild after changing the Dockerfile:

```cmd
docker compose build code-server
docker compose up -d
```
