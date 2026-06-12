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

## LiteLLM

LiteLLM is included as an optional proxy for testing Ollama through LiteLLM's `ollama_chat` adapter instead of Ollama's raw OpenAI-compatible endpoint.

Start LiteLLM:

```cmd
docker compose --profile litellm up -d litellm
```

OpenAI-compatible URL:

```text
http://localhost:8084/v1
```

Available proxy model names:

```text
qwen25-coder-7b-ollama-chat
llama31-8b-ollama-chat
```

The proxy API key is:

```text
sk-local
```

## OpenHands

OpenHands is included as an optional agent runtime for testing local model file-editing behavior. It is behind a Compose profile so the stable code-server and Open WebUI stack still starts with the normal command.

Start OpenHands:

```cmd
docker build -f Dockerfile.openhands-agent -t homelab-openhands-agent-server:latest .
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

If the UI prompts for setup, open the advanced LLM settings and use those values. The OpenHands sandbox mounts only this repo's `workspace/` folder at `/workspace/project`.

Stop OpenHands without stopping the stable base stack:

```cmd
docker compose --profile openhands stop openhands
```

## Coding Agent Tools

The code-server image is built locally from `Dockerfile.code-server`. It includes Git, Node.js/npm, Python, pip, venv support, Codex CLI, Gemini CLI, Bubblewrap sandbox support, `ripgrep`, `jq`, `tree`, build tools, and `socat` for local service forwarding.

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

Hybrid low-cost path:

```bash
cd /home/coder/workspace/<project-folder>
agent-gemini --interactive
```

Gemini CLI runs locally in the same terminal and can read files, write files, and run shell commands from the mounted workspace. The model is remote, but execution stays inside the code-server container. Run `gemini` once to authenticate with a Google account or configure the API key mode supported by Gemini CLI, then use:

```bash
agent-gemini "Inspect this project, run its tests, and make one small safe fix."
```

The `gemini-cli-data` Docker volume persists `/home/coder/.gemini` across container recreates. For headless/API-key mode, set `GEMINI_API_KEY` in the host `.env` file and recreate `code-server`.

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

Hybrid-agent note: for reliable command execution with little to no usage cost, Gemini CLI is the current best optional path to test. It uses a remote Gemini model but executes file and shell actions locally in the workspace container.

OpenHands smoke-test note: `qwen2.5-coder:7b` and `llama3.1:8b` both connected through Ollama and completed conversations, but neither created the requested test file. They produced tool-call-looking or pseudo-command text instead of executing OpenHands tools.

LiteLLM smoke-test note: LiteLLM successfully proxies Ollama through `ollama_chat`, and OpenHands can use the `openai/qwen25-coder-7b-ollama-chat` profile. The same README creation smoke test still failed because the model returned JSON text like `{"name": "invoke_skill", ...}` in message content instead of a structured OpenAI `tool_calls` array.

llama.cpp smoke-test note: the existing Ollama GGUF blob for `qwen2.5-coder:7b` can be served by `ghcr.io/ggml-org/llama.cpp:server-cuda` on this 6 GB RTX 4050, but tool-call probes also returned JSON-in-content instead of structured `tool_calls`. This makes llama.cpp a working inference server for chat/completions here, but not a fix for OpenHands tool execution with this model.

Known next path: test a local model/server pair that is documented to emit real OpenAI-compatible tool calls, preferably a newer Qwen coder/instruct model with a matching vLLM or SGLang tool parser. The current blocker is not basic connectivity; it is structured tool-call compatibility.

Rebuild after changing the Dockerfile:

```cmd
docker compose build code-server
docker compose up -d
```
