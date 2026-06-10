# Agent Rules

These are the operating rules for my self-hosted homelab coding agent.

## Workspace Rules

- Only work inside the mounted workspace folder.
- Never edit files outside the approved project workspace.
- Inspect files before changing them.
- Explain the plan before multi-file changes.
- Make small, reviewable changes.
- Show a diff after changes.
- Run tests when possible.

## Safety Rules

- Never reveal secrets, tokens, passwords, SSH keys, .env values, or cloud credentials.
- Never modify .env files unless directly approved.
- Never run destructive commands without approval.
- Do not delete large folders or wipe directories.
- Prefer project-local installs over global installs.

## Git Rules

- Check git status before changes.
- Do not commit unless approved.
- Do not push unless approved.
