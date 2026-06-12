# Homelab AI Coding Agent

A self-hosted AI coding agent workspace for managing local development projects from my homelab server.

## Goal

Build a private Codex-style coding environment that can run on my own laptop/server and be accessed from my devices through Tailscale.

## Planned Stack

- Docker
- code-server
- GitHub CLI
- Tailscale
- Local workspaces
- AI coding agent tools
- Optional local LLM support with Ollama

## Safety Model

- Active project workspaces are not uploaded to GitHub
- Secrets and environment files are ignored
- AI changes should be reviewed before commits
- Work should happen inside a dedicated workspace folder

## Status

Docker is working on Windows. The first safe workspace container is configured with Docker Compose.

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
