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
docker logs homelab_litellm
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

## Start LiteLLM

LiteLLM is optional and uses host port `8084`.

```cmd
docker compose --profile litellm up -d litellm
```

Check LiteLLM can list configured models:

```cmd
curl http://localhost:8084/v1/models -H "Authorization: Bearer sk-local"
```

Use these OpenHands advanced LLM settings to test through LiteLLM:

```text
Custom Model: openai/qwen25-coder-7b-ollama-chat
Base URL: http://host.docker.internal:8084/v1
API Key: sk-local
```

Alternate model:

```text
Custom Model: openai/llama31-8b-ollama-chat
Base URL: http://host.docker.internal:8084/v1
API Key: sk-local
```

Current LiteLLM result:

```text
LiteLLM /v1/models works.
LiteLLM /v1/chat/completions works for simple chat.
OpenHands can select openai/qwen25-coder-7b-ollama-chat.
OpenHands still does not create the smoke-test README.md because qwen2.5-coder:7b returns tool-call-looking JSON as assistant content instead of structured tool_calls.
```

Temporary llama.cpp test used the existing Ollama GGUF blob for `qwen2.5-coder:7b` and proved that llama.cpp can serve the model on this RTX 4050, but it did not fix OpenHands tool execution:

```cmd
docker run -d --name homelab_llamacpp_test --gpus all -p 8085:8080 -v C:\Users\mario\.ollama\models\blobs\<qwen-blob>:/models/qwen2.5-coder-7b.gguf:ro ghcr.io/ggml-org/llama.cpp:server-cuda -m /models/qwen2.5-coder-7b.gguf --host 0.0.0.0 --port 8080 --jinja -ngl 99 -c 8192
```

Result:

```text
llama.cpp /v1/models works.
llama.cpp /v1/chat/completions works.
Tool-call probes returned JSON inside message.content, not message.tool_calls.
Do not treat llama.cpp plus the current qwen2.5-coder:7b GGUF as an OpenHands fix.
```

## Start OpenHands

OpenHands is optional and uses host port `8083`.

```cmd
docker build -f Dockerfile.openhands-agent -t homelab-openhands-agent-server:latest .
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

OpenHands sees this repo's `workspace/` folder at:

```text
/workspace/project
```

The sandbox callback host is `host.docker.internal:8083`; keep this aligned with the host port mapping.

Check OpenHands can reach Ollama:

```cmd
docker exec homelab_openhands curl -fsS http://host.docker.internal:11434/v1/models
```

Stop only OpenHands:

```cmd
docker compose --profile openhands stop openhands
```

Current smoke-test result:

```text
qwen2.5-coder:7b: connected, but emitted JSON-looking create_file text instead of editing.
llama3.1:8b: connected, but emitted pseudo-command text instead of editing.
qwen2.5-coder:7b through LiteLLM ollama_chat: connected, but emitted JSON-looking invoke_skill text instead of editing.
qwen2.5-coder:7b through llama.cpp server-cuda: served successfully, but did not emit structured tool_calls in direct probes.
```

Next model/server test should focus on a pair with known structured tool-call support, not another generic OpenAI-compatible proxy. The current blocker is the missing `tool_calls` array in model responses.

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
| `8084` | LiteLLM |
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
