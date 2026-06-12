# Operations

Run these commands from:

```cmd
C:\Users\mario\server\ai-coding-agent
```

## Start

```cmd
docker compose up -d
```

## Stop

```cmd
docker compose down
```

## Rebuild code-server

Use this after changing `Dockerfile.code-server` or scripts copied into the image.

```cmd
docker compose build code-server
docker compose up -d code-server
```

## Check containers

```cmd
docker ps --filter "name=homelab_"
```

## View logs

```cmd
docker logs homelab_code_server
docker logs homelab_open_webui
docker logs homelab_openhands
```

## Check Ollama on Windows

```cmd
ollama list
ollama ps
```

## Check Ollama from code-server

```cmd
docker exec homelab_code_server sh -lc "wget -qO- http://127.0.0.1:11434/api/tags"
```

## Use the local agent helper

Open code-server, then use its terminal:

```bash
agent-doctor
```

```bash
cd /home/coder/workspace/<project-folder>
agent-local "Inspect this project and suggest one small improvement."
```

Use a different local model:

```bash
agent-local --model llama3.1:8b "Inspect this project and suggest one small improvement."
```

## Start OpenHands

OpenHands is optional and uses host port `8083`.

```cmd
docker compose --profile openhands up -d openhands
```

Open:

```text
http://localhost:8083
```

Use these advanced LLM settings if prompted:

```text
Custom Model: openai/qwen2.5-coder:7b
Base URL: http://host.docker.internal:11434/v1
API Key: local-llm
```

Check OpenHands can reach Ollama:

```cmd
docker exec homelab_openhands curl -fsS http://host.docker.internal:11434/v1/models
```

Stop only OpenHands:

```cmd
docker compose --profile openhands stop openhands
```

Review changes:

```bash
git diff
git status
```

Commit reviewed changes:

```bash
git add <files>
git commit -m "Describe the change"
```

## Test Express Demo

```bash
cd /home/coder/workspace/express-health
node --check server.js
node server.js
```

From another terminal in code-server:

```bash
curl http://127.0.0.1:3100/health
curl http://127.0.0.1:3100/status
```

## Ports

| Port | Service |
| --- | --- |
| `8081` | code-server |
| `8082` | Open WebUI |
| `8083` | OpenHands |
| `11434` | Ollama on Windows host |
| `3100` | Express demo app |

Port `3000` is already used by another homelab dashboard on this machine.

## Safety Checklist

- Keep `.env` private.
- Do not mount the full Windows drive into agent containers.
- Review `git diff` before committing.
- Do not push workspace projects unless intentionally publishing them.
- Prefer small, reviewable agent tasks.
- Treat any password that was committed once as public and rotate it.
