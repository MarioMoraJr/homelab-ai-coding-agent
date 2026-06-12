import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import express from 'express';

const app = express();
const port = Number(process.env.PORT || 8080);
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT || '/workspace');
const password = process.env.MOBILE_AGENT_PASSWORD || '';
const ollamaHost = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
const cookieName = 'mobile_agent_session';
const jobs = new Map();
let activeJobId = null;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(new URL('./public', import.meta.url).pathname));

function sign(value) {
  return crypto.createHmac('sha256', password).update(value).digest('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => {
      const [key, ...value] = part.trim().split('=');
      return [key, decodeURIComponent(value.join('='))];
    }).filter(([key]) => key)
  );
}

function authed(req) {
  if (!password) return false;
  const cookie = parseCookies(req.headers.cookie)[cookieName];
  if (!cookie) return false;
  const [value, mac] = cookie.split('.');
  if (!value || !mac) return false;
  const expected = sign(value);
  if (mac.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}

function requireAuth(req, res, next) {
  if (authed(req)) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

async function getProjectPath(project) {
  if (!project || typeof project !== 'string') {
    throw new Error('Project is required');
  }
  if (project.includes('..') || path.isAbsolute(project)) {
    throw new Error('Invalid project path');
  }
  const resolved = path.resolve(workspaceRoot, project);
  if (!resolved.startsWith(`${workspaceRoot}${path.sep}`) && resolved !== workspaceRoot) {
    throw new Error('Project is outside workspace');
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error('Project is not a directory');
  }
  return resolved;
}

function commandFor(action, body) {
  switch (action) {
    case 'agent': {
      const prompt = String(body.prompt || '').trim();
      if (!prompt) throw new Error('Prompt is required');
      const args = ['--prompt', prompt, '--approval-mode', 'yolo', '--skip-trust'];
      if (process.env.GEMINI_MODEL) {
        args.unshift('--model', process.env.GEMINI_MODEL);
      }
      return {
        label: 'Gemini Agent',
        command: 'gemini',
        args,
        timeoutMs: 15 * 60 * 1000
      };
    }
    case 'status':
      return { label: 'Git Status', command: 'git', args: ['status', '--short', '--branch'] };
    case 'diff':
      return { label: 'Git Diff', command: 'git', args: ['--no-pager', 'diff', '--stat', '--patch'] };
    case 'test':
      return { label: 'Tests', command: 'npm', args: ['test'], timeoutMs: 10 * 60 * 1000 };
    case 'commit': {
      const message = String(body.message || '').trim();
      if (!message) throw new Error('Commit message is required');
      return {
        label: 'Commit',
        command: 'sh',
        args: ['-lc', 'git add -A && git commit -m "$1"', 'commit', message]
      };
    }
    case 'push':
      return {
        label: 'Git Push',
        command: 'git',
        args: ['push'],
        timeoutMs: 5 * 60 * 1000
      };
    case 'local-suggest': {
      const prompt = String(body.prompt || '').trim();
      if (!prompt) throw new Error('Prompt is required');
      return {
        label: `Local Suggest (${ollamaModel})`,
        type: 'local-suggest',
        prompt,
        timeoutMs: 5 * 60 * 1000
      };
    }
    default:
      throw new Error('Unknown action');
  }
}

async function collectProjectContext(cwd) {
  const [status, files] = await Promise.all([
    runBuffered('git', ['status', '--short', '--branch'], cwd).catch((error) => error.message),
    runBuffered('find', ['.', '-maxdepth', '2', '-type', 'f'], cwd).catch((error) => error.message)
  ]);

  return [
    'Git status:',
    status.slice(0, 4000),
    '',
    'Files, depth 2:',
    files.split('\n').filter((line) => !line.includes('/.git/')).slice(0, 120).join('\n')
  ].join('\n');
}

function runBuffered(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: jobEnv(),
      shell: false
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => resolve(output));
  });
}

function jobEnv() {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: workspaceRoot
  };
}

function append(job, chunk) {
  job.output += chunk.toString();
  if (job.output.length > 120000) {
    job.output = job.output.slice(-120000);
  }
}

function startJob({ project, cwd, action, spec }) {
  if (activeJobId) {
    throw new Error('Another job is already running');
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    project,
    action,
    label: spec.label,
    status: 'running',
    output: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null
  };
  jobs.set(id, job);
  activeJobId = id;

  if (spec.type === 'local-suggest') {
    runLocalSuggest(job, cwd, spec).finally(() => {
      activeJobId = null;
    });
    return job;
  }

  const child = spawn(spec.command, spec.args, {
    cwd,
    env: jobEnv(),
    shell: false
  });

  const timer = setTimeout(() => {
    append(job, '\nTimed out. Stopping process.\n');
    child.kill('SIGTERM');
  }, spec.timeoutMs || 2 * 60 * 1000);

  child.stdout.on('data', (chunk) => append(job, chunk));
  child.stderr.on('data', (chunk) => append(job, chunk));
  child.on('error', (error) => {
    append(job, `\nFailed to start command: ${error.message}\n`);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    job.status = code === 0 ? 'complete' : 'failed';
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    activeJobId = null;
  });

  return job;
}

async function runLocalSuggest(job, cwd, spec) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs || 5 * 60 * 1000);

  try {
    append(job, `Using local model: ${ollamaModel}\n`);
    append(job, 'No files will be changed by this action.\n\n');
    const context = await collectProjectContext(cwd);
    const prompt = [
      'You are a local coding copilot. Do not claim to edit files or run commands.',
      'Return a concise proposal the user can review.',
      'If code changes are useful, include a unified diff in a fenced diff block.',
      'If commands are useful, include them in a fenced shell block.',
      'Do not invent files that are not present in the context unless you explicitly label them as new files.',
      '',
      `User request: ${spec.prompt}`,
      '',
      context
    ].join('\n');

    const response = await fetch(`${ollamaHost.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        options: {
          temperature: 0.2
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const data = await response.json();
    append(job, data.response || 'Ollama returned no response.');
    job.status = 'complete';
    job.exitCode = 0;
  } catch (error) {
    append(job, `\nLocal suggestion failed: ${error.message}\n`);
    job.status = 'failed';
    job.exitCode = 1;
  } finally {
    clearTimeout(timer);
    job.finishedAt = new Date().toISOString();
  }
}

app.get('/api/session', (req, res) => {
  res.json({ authenticated: authed(req) });
});

app.post('/api/login', (req, res) => {
  if (!password) {
    return res.status(500).json({ error: 'MOBILE_AGENT_PASSWORD is not configured' });
  }
  if (req.body?.password !== password) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const value = crypto.randomBytes(24).toString('hex');
  res.cookie(cookieName, `${value}.${sign(value)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 14
  });
  res.json({ ok: true });
});

app.post('/api/logout', requireAuth, (_req, res) => {
  res.clearCookie(cookieName);
  res.json({ ok: true });
});

app.get('/api/projects', requireAuth, async (_req, res) => {
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const projectPath = path.join(workspaceRoot, entry.name);
    const [git, packageJson] = await Promise.all([
      fs.stat(path.join(projectPath, '.git')).then(() => true).catch(() => false),
      fs.stat(path.join(projectPath, 'package.json')).then(() => true).catch(() => false)
    ]);
    projects.push({ name: entry.name, git, packageJson });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ projects });
});

app.post('/api/jobs', requireAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || '');
    const project = String(req.body?.project || '');
    const cwd = await getProjectPath(project);
    const spec = commandFor(action, req.body || {});
    const job = startJob({ project, cwd, action, spec });
    res.status(202).json({ job });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job });
});

app.get('/api/jobs', requireAuth, (_req, res) => {
  res.json({ jobs: Array.from(jobs.values()).slice(-20).reverse() });
});

export { app };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(port, () => {
    console.log(`mobile-agent-ui listening on ${port}`);
  });
}
