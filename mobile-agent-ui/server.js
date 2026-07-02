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
const architectModel = process.env.ARCHITECT_MODEL || 'deepseek-r1:7b';
const ghCommand = process.env.GH_COMMAND || 'gh';
const cookieName = 'mobile_agent_session';
const jobs = new Map();
const suggestions = new Map();
let activeJobId = null;

// Knowledge base: error patterns → hints, loaded from agent-patterns.json
let agentErrorPatterns = [];
fs.readFile(new URL('./agent-patterns.json', import.meta.url).pathname, 'utf8')
  .then((text) => { agentErrorPatterns = JSON.parse(text).patterns || []; })
  .catch(() => {});

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

function cleanProjectName(name) {
  const cleaned = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned || cleaned.length > 80) {
    throw new Error('Project name must use 1-80 letters, numbers, dots, underscores, or dashes');
  }
  if (cleaned === '.' || cleaned === '..' || cleaned.includes('..')) {
    throw new Error('Invalid project name');
  }
  return cleaned;
}

async function trustProjectPath(cwd) {
  await runBuffered('git', ['config', '--global', '--add', 'safe.directory', cwd], cwd).catch(() => {});
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
      return {
        label: 'Git Status',
        command: 'git',
        args: ['status', '--short', '--branch', '--', '.', ':(exclude)node_modules/**']
      };
    case 'diff':
      return {
        label: 'Git Diff',
        type: 'git-diff',
        timeoutMs: 2 * 60 * 1000
      };
    case 'test':
      return { label: 'Tests', command: 'npm', args: ['test'], timeoutMs: 10 * 60 * 1000 };
    case 'commit': {
      const message = String(body.message || '').trim();
      if (!message) throw new Error('Commit message is required');
      return {
        label: 'Commit',
        type: 'git-commit',
        message
      };
    }
    case 'push':
      return {
        label: 'Git Push',
        type: 'git-push',
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
    case 'local-agent': {
      const prompt = String(body.prompt || '').trim();
      if (!prompt) throw new Error('Prompt is required');
      return {
        label: `Local Agent (${architectModel} -> ${ollamaModel})`,
        type: 'local-agent',
        prompt,
        history: Array.isArray(body.history) ? body.history.slice(-8) : [],
        timeoutMs: 20 * 60 * 1000
      };
    }
    case 'apply-patch':
      return {
        label: 'Apply Patch',
        type: 'apply-patch',
        timeoutMs: 2 * 60 * 1000
      };
    default:
      throw new Error('Unknown action');
  }
}

function extractDiffBlock(text) {
  const fenced = text.match(/```(?:diff|patch)\s*\n([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/^(diff --git |--- (?:a\/|\S))/m);
  if (start === -1) return null;
  return candidate.slice(start).trimEnd() + '\n';
}

function extractFileMapBlock(text) {
  const fenced = text.match(/```json\s*\n([\s\S]*?)```/i);
  if (!fenced) return null;
  try {
    const parsed = JSON.parse(fenced[1]);
    const files = parsed.diff || parsed.files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
    const cleanFiles = {};
    for (const [file, content] of Object.entries(files)) {
      if (typeof content !== 'string') return null;
      cleanFiles[file] = content.endsWith('\n') ? content : `${content}\n`;
    }
    return cleanFiles;
  } catch {
    return null;
  }
}

async function collectProjectContext(cwd) {
  const [status, files, trackedFiles] = await Promise.all([
    runBuffered('git', ['status', '--short', '--branch', '--', '.', ':(exclude)node_modules/**'], cwd).catch((error) => error.message),
    runBuffered('find', ['.', '-path', './node_modules', '-prune', '-o', '-maxdepth', '2', '-type', 'f', '-print'], cwd).catch((error) => error.message),
    runBuffered('git', ['ls-files', '--', '.', ':(exclude)node_modules/**'], cwd).catch(() => '')
  ]);
  const snippets = await collectFileSnippets(cwd, trackedFiles);

  return [
    'Git status:',
    status.slice(0, 4000),
    '',
    'Files, depth 2:',
    files.split('\n').filter((line) => !line.includes('/.git/')).slice(0, 120).join('\n'),
    '',
    'Relevant file contents:',
    snippets || '(No small source files selected.)'
  ].join('\n');
}

async function collectFileSnippets(cwd, trackedFiles) {
  const candidates = trackedFiles
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => !file.includes('node_modules/'))
    .filter((file) => /(^|\/)(package\.json|server\.js|app\.js|index\.js|main\.js|server\.mjs|app\.mjs|index\.mjs|README\.md)$/i.test(file))
    .slice(0, 8);

  const snippets = [];
  for (const file of candidates) {
    const absolute = path.resolve(cwd, file);
    if (!absolute.startsWith(`${cwd}${path.sep}`) && absolute !== cwd) continue;
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size > 20000) continue;
    const content = await fs.readFile(absolute, 'utf8').catch(() => '');
    snippets.push(`--- ${file} ---\n${content.slice(0, 6000)}`);
  }
  return snippets.join('\n\n');
}

function runBuffered(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: jobEnv(cwd),
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
    child.on('close', (code) => {
      if (options.rejectOnFailure && code !== 0) {
        reject(new Error(output || `${command} exited with code ${code}`));
        return;
      }
      resolve(output);
    });
  });
}

function jobEnv(extraSafeDirectory) {
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: workspaceRoot
  };

  if (extraSafeDirectory && extraSafeDirectory !== workspaceRoot) {
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_1 = 'safe.directory';
    env.GIT_CONFIG_VALUE_1 = extraSafeDirectory;
  }

  return env;
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
    exitCode: null,
    cancel: null
  };
  jobs.set(id, job);
  activeJobId = id;

  trustProjectPath(cwd).catch(() => {});

  if (spec.type === 'local-suggest') {
    const controller = new AbortController();
    job.cancel = () => controller.abort();
    runLocalSuggest(job, cwd, { ...spec, signal: controller.signal }).finally(() => {
      activeJobId = null;
    });
    return job;
  }

  if (spec.type === 'local-agent') {
    const controller = new AbortController();
    job.cancel = () => controller.abort();
    runLocalAgent(job, cwd, { ...spec, signal: controller.signal }).finally(() => {
      activeJobId = null;
    });
    return job;
  }

  if (spec.type === 'git-diff') {
    runGitDiff(job, cwd).finally(() => {
      activeJobId = null;
    });
    return job;
  }

  if (spec.type === 'apply-patch') {
    runApplyPatch(job, cwd, project).finally(() => {
      activeJobId = null;
    });
    return job;
  }

  if (spec.type === 'git-push') {
    runGitPush(job, cwd).finally(() => {
      activeJobId = null;
    });
    return job;
  }

  if (spec.type === 'git-commit') {
    runGitCommit(job, cwd, spec.message).finally(() => {
      activeJobId = null;
    });
    return job;
  }

  const child = spawn(spec.command, spec.args, {
    cwd,
    env: jobEnv(cwd),
    shell: false
  });

  const timer = setTimeout(() => {
    append(job, '\nTimed out. Stopping process.\n');
    child.kill('SIGTERM');
  }, spec.timeoutMs || 2 * 60 * 1000);

  job.cancel = () => {
    clearTimeout(timer);
    append(job, '\nCancelled by user.\n');
    child.kill('SIGTERM');
  };

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
  const controller = spec.signal ? { signal: spec.signal, abort: () => {} } : new AbortController();
  const signal = spec.signal || controller.signal;
  const timer = setTimeout(() => controller.abort?.(), spec.timeoutMs || 5 * 60 * 1000);

  try {
    await trustProjectPath(cwd);
    append(job, `Using local model: ${ollamaModel}\n`);
    append(job, 'No files will be changed by this action.\n\n');
    const context = await collectProjectContext(cwd);
    const prompt = [
      'You are a local coding copilot. Do not claim to edit files or run commands.',
      'Return a concise proposal the user can review.',
      'If code changes are useful, include a valid unified diff in a fenced diff block.',
      'Base patches only on the file contents shown below.',
      'Avoid new runtime dependencies unless package.json already includes them.',
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
      signal
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const suggestion = data.response || 'Ollama returned no response.';
    append(job, suggestion);
    const patch = extractDiffBlock(suggestion);
    const files = patch ? null : extractFileMapBlock(suggestion);
    suggestions.set(job.project, {
      output: suggestion,
      patch,
      files,
      createdAt: new Date().toISOString()
    });
    if (patch) {
      append(job, '\n\nPatch detected. Review it, then use Apply Patch if it looks good.');
    } else if (files) {
      append(job, '\n\nFile changes detected. Review them, then use Apply Patch if they look good.');
    } else {
      append(job, '\n\nNo applicable diff block detected.');
    }
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

function matchAgentPatterns(output) {
  const hints = [];
  for (const pattern of agentErrorPatterns) {
    const match = output.match(new RegExp(pattern.match, 's'));
    if (match) {
      let hint = pattern.hint;
      for (let i = 1; i < match.length; i++) hint = hint.replaceAll(`$${i}`, match[i] || '');
      hints.push(hint);
    }
  }
  return hints;
}

function extractTestFailureKey(output) {
  const errorLine = output.match(/error:\s*\|-?\s*\n\s*(.+)/);
  if (errorLine) return errorLine[1].trim().slice(0, 120);
  const location = output.match(/location:\s*'([^']+)'/);
  if (location) return location[1];
  // Catch structural test failures that don't surface as TAP assertion errors
  if (/connect ECONNREFUSED/.test(output)) return 'ECONNREFUSED: test connecting to hardcoded port';
  return null;
}

function sameFailureHint(key, count) {
  return [
    `The same test failure has occurred ${count} times in a row ("${key.slice(0, 80)}").`,
    'The model is stuck. Most common causes:',
    '(1) Missing create: your assertion expects data but nothing POSTed it to the server first. You CANNOT push to the server\'s internal arrays directly — all data must come from actual API calls (fetch POST requests).',
    '(2) State order: a DELETE or clear-all ran before an assertion that needs data. Move the assertion before the DELETE.',
    '(3) Wrong shape: the API returns different fields than your assertion expects — read the server handler.',
    'Use write_file to rewrite server.test.js completely: single test() block, app.listen(0) for the port, all data created via POST before any assertions that need it, DELETE only at the end.',
  ].join(' ');
}

function localAgentSystemPrompt(cwd) {
  return [
    'You are a local coding agent and project documentation companion working on exactly one app.',
    `Workspace root: ${cwd}`,
    '',
    'Rules:',
    '- Work only inside the workspace root.',
    '- Inspect files before editing.',
    '- When the user asks about docs, first inspect README, docs folders, markdown files, package manifests, and nearby source files as needed.',
    '- If the user asks you to create an app, feature, test, or file and the project is sparse, create the requested files after inspecting what exists. Do not stop just because only README or .gitignore exists.',
    '- Answer questions conversationally, but still use tools to ground answers in the selected project.',
    '- Make small, reviewable changes.',
    '- Prefer focused edits over broad rewrites.',
    '- Run relevant tests or checks when possible.',
    '- Never expose secrets or credentials.',
    '- Do not commit, push, delete large folders, or run destructive commands.',
    '',
    'Common mistakes to avoid:',
    '- Express: never put query strings in a route path. Wrong: app.get(\'/search?q=\', ...). Right: app.get(\'/search\', (req, res) => { const q = req.query.q; ... })',
    '- Tests: write assertions that need existing data BEFORE any DELETE or clear operation in the same test.',
    '- Tests: every const must have a unique name — declaring the same name twice is a SyntaxError.',
    '- Tests: assert the exact shape the server returns, including null fields (e.g. { text: "x", author: null }).',
    '- Tests: NEVER use a hardcoded port like 127.0.0.1:3000. Always start the server on port 0: const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); }); then use `http://127.0.0.1:${server.address().port}` as the base URL.',
    '- Tests: NEVER create a tests/ subdirectory. The test file is always server.test.js at the project root. NEVER use Jest globals (describe, it, beforeAll, afterAll) — this project uses node:test only.',
    '- Tests: do NOT use helper functions like clearQuotes() that call the API outside a test() block. Put all assertions inside the test() callback.',
    '- If you must start a dev server on a fixed port, use a port in 49152-65535 (see /workspace/port-registry.json). Add the port to the reserved list when starting and remove it when done. Never use ports below 49152 — they conflict with other running services.',
    '',
    'Reply with one JSON object only. Do not use Markdown.',
    '',
    'Tool actions:',
    '{"tool":"plan","args":{"steps":["inspect project files","read relevant docs","answer from evidence"]}}',
    '{"tool":"list_files","args":{"path":"."}}',
    '{"tool":"read_file","args":{"path":"relative/path"}}',
    '{"tool":"write_file","args":{"path":"relative/path","content":"full file content"}}',
    '{"tool":"replace_text","args":{"path":"relative/path","old":"exact text","new":"replacement text"}}',
    '{"tool":"run_command","args":{"command":"npm test"}}',
    '{"tool":"final","args":{"summary":"what changed","checks":"what you ran or why not"}}'
  ].join('\n');
}

async function runArchitect(userPrompt, cwd, signal) {
  const context = await collectProjectContext(cwd);
  const systemPrompt = [
    'You are a senior software architect. Given a feature request and the current project source, write a precise implementation spec.',
    '',
    'Your spec must include:',
    '1. FILES TO MODIFY: exact file names and what to add or change in each',
    '2. LOGIC: step-by-step implementation — exact route paths, function signatures, response shapes',
    '3. EDGE CASES: what to return for invalid input, empty state, out-of-range values',
    '4. TESTS TO ADD: exact test cases with concrete seed data, expected response shapes, and status codes',
    '',
    'CRITICAL RULES:',
    '- NO CODE. Not even one line. No backtick blocks. No pseudo-code. Plain English descriptions only.',
    '- The builder will copy any code you write verbatim, including bugs. Describe logic in words.',
    '- Do not invent new files or modules that do not already exist in the project.',
    '- Base your spec only on the files shown in the project context below.',
    '- Be specific about exact values (route paths, field names, status codes, variable names).',
    '- BACKWARD COMPATIBILITY: if the request says "with no params return X as before", spell out the exact conditional: "if NEITHER page NOR limit is in req.query, return the plain array directly — otherwise return the pagination object". The builder must know EXACTLY when to branch.',
  ].join('\n');

  const response = await fetch(`${ollamaHost.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: architectModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Feature request: ${userPrompt}\n\nProject:\n${context}` }
      ],
      stream: false,
      options: { temperature: 0.3 }
    }),
    signal
  });

  if (!response.ok) throw new Error(`Architect model returned HTTP ${response.status}`);
  const data = await response.json();
  const raw = data.message?.content || '';
  // Strip chain-of-thought tags, then strip ALL fenced code blocks before passing to builder.
  // The builder copies code verbatim including bugs — English description only is safer.
  const spec = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '[code example removed — implement based on the plain-English description above]')
    .trim();
  return { raw, spec };
}

const INSPECTION_TOOLS = new Set(['list_files', 'read_file', 'run_command']);
const WRITE_TOOLS = new Set(['write_file', 'replace_text']);
const READ_ONLY_TOOLS = new Set(['plan', 'list_files', 'read_file']);
const CHANGE_REQUEST_PATTERN = /\b(add|build|create|change|update|edit|implement|fix|write|generate)\b/i;

async function runLocalAgent(job, cwd, spec) {
  const controller = spec.signal ? { signal: spec.signal, abort: () => {} } : new AbortController();
  const signal = spec.signal || controller.signal;
  const timer = setTimeout(() => controller.abort?.(), spec.timeoutMs || 20 * 60 * 1000);

  try {
    await trustProjectPath(cwd);
    append(job, `Using local model: ${ollamaModel}\n`);
    append(job, `Working directory: ${cwd}\n\n`);

    // === Architect phase ===
    append(job, `=== Architect (${architectModel}) ===\n`);
    let builderPrompt = spec.prompt;
    try {
      const { raw, spec: expandedSpec } = await runArchitect(spec.prompt, cwd, signal);
      append(job, `${raw}\n\n`);
      if (expandedSpec) builderPrompt = expandedSpec;
    } catch (archError) {
      append(job, `Architect phase skipped: ${archError.message}\n\n`);
    }
    append(job, `=== Builder (${ollamaModel}) ===\n`);

    const messages = [
      { role: 'system', content: localAgentSystemPrompt(cwd) },
      ...sanitizeChatHistory(spec.history),
      { role: 'user', content: builderPrompt }
    ];

    const packageJson = await fs.readFile(path.join(cwd, 'package.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    const hasTestScript = Boolean(packageJson.scripts?.test);

    let inspectedProject = false;
    const readPaths = new Set();
    let wroteProject = false;
    let testedAfterWrite = !hasTestScript;
    let lastTestPassed = !hasTestScript;
    let readOnlyLoopCount = 0;
    let consecutiveWriteCount = 0;
    let lastWrittenPath = null;
    let lastActionJson = null;
    let lastFailureKey = null;
    let failureKeyCount = 0;
    let replaceFailStreak = 0;
    let replaceFailPath = null;
    let lastWriteTool = null;
    let lastWritePath = null;

    for (let step = 1; step <= 30; step += 1) {
      append(job, `Step ${step}/30\n`);
      const raw = await ollamaJsonChat(messages, signal);
      const parsed = parseJsonAction(raw);
      const action = normalizeJsonAction(parsed);
      const tool = action.tool;
      const args = action.args || {};

      // Detect exact action repetition before doing anything else
      const actionJson = JSON.stringify(action);
      if (tool && tool !== 'final' && actionJson === lastActionJson) {
        append(job, 'Exact action repeated; breaking loop.\n\n');
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'You sent the exact same action twice in a row. Do not repeat it. If the task is complete use final, otherwise try a different tool or path.' });
        lastActionJson = null;
        continue;
      }
      lastActionJson = actionJson;

      if (!tool) {
        if (inspectedProject) {
          if (shouldBlockNoChangeFinal(spec.prompt, parsed.response ?? parsed, wroteProject)) {
            append(job, 'No-change answer blocked because the request asks for project changes.\n\n');
            messages.push({ role: 'assistant', content: raw });
            messages.push({ role: 'user', content: nextActionInstruction() });
            continue;
          }
          append(job, `\n${formatPlainResponse(parsed.response ?? parsed)}\n`);
          job.status = 'complete';
          job.exitCode = 0;
          return;
        }
        append(job, 'Model answered before inspecting enough project context; asking it to plan and use tools first.\n\n');
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'Your last JSON was missing a valid tool field. First reply with {"tool":"plan","args":{"steps":["inspect project files","read relevant docs","answer from evidence"]}}, then use list_files and read_file before final.' });
        continue;
      }

      append(job, `Tool: ${tool}\n`);

      if (tool === 'plan') {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        append(job, `Plan:\n${steps.map((item) => `- ${item}`).join('\n') || '- Inspect the selected project first.'}\n\n`);
        messages.push({ role: 'assistant', content: JSON.stringify(action) });
        messages.push({ role: 'user', content: inspectedProject ? nextActionInstruction() : 'Plan noted. Now inspect the selected project with list_files, read_file, or run_command before answering.' });
        if (inspectedProject) readOnlyLoopCount += 1;
        continue;
      }

      if (tool === 'final') {
        if (!inspectedProject) {
          append(job, 'Final answer blocked until the agent inspects the selected project.\n\n');
          messages.push({ role: 'assistant', content: JSON.stringify(action) });
          messages.push({ role: 'user', content: 'You must inspect the selected project before final. Use list_files and read_file first.' });
          continue;
        }
        if (wroteProject && !testedAfterWrite) {
          append(job, 'Final blocked: files were written but tests were not run.\n\n');
          messages.push({ role: 'assistant', content: JSON.stringify(action) });
          messages.push({ role: 'user', content: 'You wrote files but did not run tests. Run the test suite with run_command before calling final.' });
          continue;
        }
        if (testedAfterWrite && !lastTestPassed) {
          append(job, 'Final blocked: the last test run had failures.\n\n');
          messages.push({ role: 'assistant', content: JSON.stringify(action) });
          messages.push({ role: 'user', content: 'Tests are still failing. Fix the failing assertions, then run tests again before calling final.' });
          continue;
        }
        if (shouldBlockNoChangeFinal(spec.prompt, args.summary || '', wroteProject)) {
          append(job, 'No-change final answer blocked because the request asks for project changes.\n\n');
          messages.push({ role: 'assistant', content: JSON.stringify(action) });
          messages.push({ role: 'user', content: nextActionInstruction() });
          continue;
        }
        append(job, `\n${args.summary || 'Done.'}\n`);
        if (args.checks) append(job, `\nChecks: ${args.checks}\n`);
        job.status = 'complete';
        job.exitCode = 0;
        return;
      }

      // Block writes to files that haven't been read yet in this session
      if (WRITE_TOOLS.has(tool) && args.path && !readPaths.has(args.path)) {
        append(job, `Write to ${args.path} blocked: read it first.\n\n`);
        messages.push({ role: 'assistant', content: JSON.stringify(action) });
        messages.push({ role: 'user', content: `You must read ${args.path} with read_file before writing or replacing it. Read the file now so you can make targeted edits instead of rewriting from scratch.` });
        continue;
      }

      const result = await runLocalAgentTool(cwd, tool, args);
      if (tool === 'read_file' && args.path && !result.error) {
        readPaths.add(args.path);
      }
      if (INSPECTION_TOOLS.has(tool) && !result.error) {
        inspectedProject = true;
      }
      if (WRITE_TOOLS.has(tool) && !result.error) {
        wroteProject = true;
        if (hasTestScript) testedAfterWrite = false;
        readOnlyLoopCount = 0;
        lastWriteTool = tool;
        lastWritePath = args.path || null;
        const writtenPath = args.path || null;
        if (writtenPath && writtenPath === lastWrittenPath) {
          consecutiveWriteCount += 1;
        } else {
          consecutiveWriteCount = 1;
          lastWrittenPath = writtenPath;
        }
      } else {
        consecutiveWriteCount = 0;
        lastWrittenPath = null;
        if (tool === 'run_command' && /\btest\b|jest|mocha|vitest|tap|ava/i.test(args.command || '')) {
          testedAfterWrite = true;
          const out = result.output || '';
          lastTestPassed = /# fail\s+0\b/.test(out) || (/# pass\s+[1-9]/.test(out) && !/# fail\s+[1-9]/.test(out));
        }
        if (inspectedProject && READ_ONLY_TOOLS.has(tool)) {
          readOnlyLoopCount += 1;
        }
      }
      append(job, `${JSON.stringify(result, null, 2).slice(0, 5000)}\n\n`);
      messages.push({ role: 'assistant', content: JSON.stringify(action) });

      // Build tool result message, appending any pattern-matched hints
      let toolResultContent = `Tool result:\n${JSON.stringify(result)}`;
      if (tool === 'run_command') {
        const output = result.output || '';
        const patternHints = matchAgentPatterns(output);
        if (patternHints.length > 0) {
          toolResultContent += `\n\nHint: ${patternHints.join(' ')}`;
          append(job, `Pattern hint: ${patternHints[0].slice(0, 120)}\n\n`);
        }
        const failKey = extractTestFailureKey(output);
        if (failKey) {
          failureKeyCount = failKey === lastFailureKey ? failureKeyCount + 1 : 1;
          lastFailureKey = failKey;
        } else {
          lastFailureKey = null;
          failureKeyCount = 0;
        }
      }
      messages.push({ role: 'user', content: toolResultContent });

      if (failureKeyCount >= 3) {
        append(job, `Same failure repeated ${failureKeyCount}×; injecting diagnostic hint.\n\n`);
        messages.push({ role: 'user', content: sameFailureHint(lastFailureKey, failureKeyCount) });
        failureKeyCount = 0;
        lastFailureKey = null;
      }

      // replace_text failure streak: escalate to write_file
      if (tool === 'replace_text' && result.error === 'Old text was not found') {
        const p = args.path || null;
        replaceFailStreak = p === replaceFailPath ? replaceFailStreak + 1 : 1;
        replaceFailPath = p;
      } else {
        replaceFailStreak = 0;
        replaceFailPath = null;
      }
      if (replaceFailStreak >= 2) {
        append(job, `replace_text failed ${replaceFailStreak}× on ${replaceFailPath}; suggesting write_file.\n\n`);
        messages.push({ role: 'user', content: `replace_text cannot find the text to replace in ${replaceFailPath}. The old text you provided does not match the file exactly. Use write_file to rewrite the entire file with all changes applied correctly.` });
        replaceFailStreak = 0;
        replaceFailPath = null;
      }

      // Syntax error after replace_text: the replacement corrupted the file
      if (tool === 'run_command' && /SyntaxError/.test(result.output || '') && lastWriteTool === 'replace_text') {
        append(job, `SyntaxError after replace_text on ${lastWritePath}; suggesting write_file.\n\n`);
        messages.push({ role: 'user', content: `replace_text introduced a SyntaxError in ${lastWritePath}. Stop using replace_text on this file — it is corrupting it. Use write_file to rewrite the entire file correctly from scratch.` });
        lastWriteTool = null;
      }
      if (readOnlyLoopCount >= 4) {
        append(job, 'Read-only loop detected; forcing the next step to edit files or finish.\n\n');
        messages.push({ role: 'user', content: nextActionInstruction() });
        readOnlyLoopCount = 0;
      }
      if (consecutiveWriteCount >= 2) {
        append(job, 'Write-loop detected on same file; prompting to test or finish.\n\n');
        messages.push({ role: 'user', content: nextWriteLoopInstruction() });
        consecutiveWriteCount = 0;
        lastWrittenPath = null;
      }
    }

    append(job, 'Stopped after 30 steps. The model kept looping instead of finishing. Try a narrower request or review the current diff before continuing.\n');
    job.status = 'failed';
    job.exitCode = 1;
  } catch (error) {
    append(job, `\nLocal agent failed: ${error.message}\n`);
    job.status = 'failed';
    job.exitCode = 1;
  } finally {
    clearTimeout(timer);
    job.finishedAt = new Date().toISOString();
  }
}

function sanitizeChatHistory(history) {
  return history
    .filter((entry) => ['user', 'assistant'].includes(entry?.role) && typeof entry.content === 'string')
    .map((entry) => ({
      role: entry.role,
      content: entry.content.slice(0, 4000)
    }));
}

function nextActionInstruction() {
  return [
    'You have inspected the project. Do not call plan, list_files, or read_file again unless you need a new specific file.',
    'If the user asked you to create or change code, use write_file or replace_text now, even if the project only has README or .gitignore.',
    'If the requested work is complete, use final now.',
    'Reply with exactly one JSON tool action.'
  ].join(' ');
}

function nextWriteLoopInstruction() {
  return [
    'You have modified the same file multiple times in a row. Do not append more content to it.',
    'If you need to verify your changes, run tests with run_command.',
    'If the task is complete, use final now.',
    'Reply with exactly one JSON tool action.'
  ].join(' ');
}

function shouldBlockNoChangeFinal(prompt, response, wroteProject) {
  if (wroteProject) return false;
  // If the task asks for code changes and nothing was written, always block final.
  // The model must use write_file or replace_text before it can call final.
  return CHANGE_REQUEST_PATTERN.test(prompt || '');
}

async function ollamaJsonChat(messages, signal) {
  const response = await fetch(`${ollamaHost.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      messages,
      stream: false,
      format: 'json',
      options: { temperature: 0 }
    }),
    signal
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const data = await response.json();
  return data.message?.content || '';
}

function parseJsonAction(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Model did not return JSON: ${raw.slice(0, 500)}`);
    return JSON.parse(match[0]);
  }
}

function normalizeJsonAction(action) {
  if (!action || typeof action !== 'object') return {};
  if (action.tool) return { tool: normalizeToolName(action.tool), args: normalizeArgs(action.args || action.arguments || action.parameters) };
  if (action.tool_name) return { tool: normalizeToolName(action.tool_name), args: normalizeArgs(action.arguments || action.args || action.parameters) };
  if (action.name) return { tool: normalizeToolName(action.name), args: normalizeArgs(action.arguments || action.args || action.parameters) };
  if (action.action) return { tool: normalizeToolName(action.action), args: normalizeArgs(action.arguments || action.args || action.parameters) };
  if (action.function?.name) {
    return {
      tool: normalizeToolName(action.function.name),
      args: normalizeArgs(action.function.arguments || action.arguments || action.args || action.parameters)
    };
  }
  if (action.tool_call?.name) {
    return {
      tool: normalizeToolName(action.tool_call.name),
      args: normalizeArgs(action.tool_call.arguments || action.arguments || action.args || action.parameters)
    };
  }
  return action;
}

function normalizeToolName(name) {
  const normalized = String(name || '').trim();
  const aliases = {
    create_file: 'write_file',
    edit_file: 'replace_text',
    update_file: 'replace_text',
    shell: 'run_command',
    command: 'run_command',
    finish: 'final',
    answer: 'final'
  };
  return aliases[normalized] || normalized;
}

function normalizeArgs(args) {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args;
}

function formatPlainResponse(response) {
  if (typeof response === 'string') return response;
  if (response?.summary) return String(response.summary);
  if (response?.content) return String(response.content);
  if (response?.message) return String(response.message);
  return JSON.stringify(response, null, 2);
}

function resolveAgentPath(cwd, requested = '.') {
  const resolved = path.resolve(cwd, requested);
  if (!resolved.startsWith(`${cwd}${path.sep}`) && resolved !== cwd) {
    throw new Error(`Path escapes project: ${requested}`);
  }
  return resolved;
}

async function runLocalAgentTool(cwd, tool, args) {
  switch (tool) {
    case 'list_files':
      return listAgentFiles(cwd, args.path || '.');
    case 'read_file':
      return readAgentFile(cwd, args.path);
    case 'write_file':
      return writeAgentFile(cwd, args.path, args.content);
    case 'replace_text':
      return replaceAgentText(cwd, args.path, args.old, args.new);
    case 'run_command':
      return runAgentCommand(cwd, args.command);
    default:
      return { error: `Unknown tool: ${tool}` };
  }
}

async function listAgentFiles(cwd, requested) {
  const root = resolveAgentPath(cwd, requested);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat) return { error: `Path does not exist: ${requested}` };
  if (stat.isFile()) return { files: [path.relative(cwd, root)] };
  const files = [];
  await walkAgentFiles(cwd, root, files, 0);
  return { files };
}

async function walkAgentFiles(cwd, directory, files, depth) {
  if (depth > 3 || files.length >= 200) return;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (files.length >= 200) return;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(cwd, absolute).replaceAll(path.sep, '/');
    files.push(entry.isDirectory() ? `${relative}/` : relative);
    if (entry.isDirectory()) {
      await walkAgentFiles(cwd, absolute, files, depth + 1);
    }
  }
}

async function readAgentFile(cwd, requested) {
  const file = resolveAgentPath(cwd, requested);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return { error: `Not a file: ${requested}` };
  const content = await fs.readFile(file, 'utf8');
  return { content: content.slice(0, 20000), truncated: content.length > 20000 };
}

async function writeAgentFile(cwd, requested, content) {
  const file = resolveAgentPath(cwd, requested);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, String(content ?? ''), 'utf8');
  return { ok: true, path: path.relative(cwd, file) };
}

async function replaceAgentText(cwd, requested, oldText, newText) {
  const file = resolveAgentPath(cwd, requested);
  const content = await fs.readFile(file, 'utf8');
  if (!content.includes(oldText)) return { error: 'Old text was not found' };
  await fs.writeFile(file, content.replace(oldText, newText), 'utf8');
  return { ok: true, path: path.relative(cwd, file) };
}

async function runAgentCommand(cwd, command) {
  const blocked = /\b(rm\s+-rf|rmdir|del|format|shutdown|git\s+push|git\s+reset|git\s+checkout\s+--|sudo|chmod\s+-r|chown\s+-r)\b/i;
  if (blocked.test(command)) return { error: `Blocked command: ${command}` };
  const TIMEOUT_MS = 60_000;
  const output = await new Promise((resolve) => {
    const child = spawn('sh', ['-lc', command], { cwd, env: jobEnv(cwd), shell: false });
    let buf = '';
    child.stdout.on('data', (c) => { buf += c; });
    child.stderr.on('data', (c) => { buf += c; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(`${buf}\nERROR: command timed out after ${TIMEOUT_MS / 1000}s and was killed.`);
    }, TIMEOUT_MS);
    child.on('close', () => { clearTimeout(timer); resolve(buf); });
    child.on('error', (err) => { clearTimeout(timer); resolve(`ERROR: ${err.message}`); });
  });
  return { output: output.slice(-12000) };
}

async function runApplyPatch(job, cwd, project) {
  const suggestion = suggestions.get(project);
  if (!suggestion?.patch && !suggestion?.files) {
    append(job, 'No applicable patch or file changes found for this project. Run Local Suggest and ask for a unified diff first.\n');
    job.status = 'failed';
    job.exitCode = 1;
    job.finishedAt = new Date().toISOString();
    return;
  }

  const patchPath = path.join(cwd, `.mobile-agent-${job.id}.patch`);
  try {
    await trustProjectPath(cwd);
    await ensureCleanProject(cwd);
    if (suggestion.patch) {
      await fs.writeFile(patchPath, suggestion.patch, 'utf8');
      await applyPatchFile(job, cwd, patchPath);
    } else {
      await applySuggestedFiles(job, cwd, suggestion.files);
    }
    await validateProjectAfterPatch(job, cwd);
    append(job, 'Patch applied successfully.\nRun Tests and Diff next before committing.\n');
    suggestions.delete(project);
    job.status = 'complete';
    job.exitCode = 0;
  } catch (error) {
    await restoreFailedPatch(job, cwd);
    suggestions.delete(project);
    append(job, `Patch was not applied.\n${error.message}\n\nRun Local Suggest again so the next patch is based on the current files.\n`);
    job.status = 'failed';
    job.exitCode = 1;
  } finally {
    await fs.rm(patchPath, { force: true }).catch(() => {});
    job.finishedAt = new Date().toISOString();
  }
}

async function ensureCleanProject(cwd) {
  const status = await runBuffered('git', ['status', '--porcelain', '--', '.', ':(exclude)node_modules/**'], cwd, { rejectOnFailure: true });
  if (status.trim()) {
    throw new Error(`Project has existing changes. Run Diff, then commit or revert them before applying a new patch.\n${status}`);
  }
}

async function restoreFailedPatch(job, cwd) {
  await runBuffered('git', ['restore', '--staged', '--worktree', '--', '.'], cwd).catch(() => {});
  await runBuffered('git', ['clean', '-fd', '--', '.', ':(exclude)node_modules/**'], cwd).catch(() => {});
}

async function applyPatchFile(job, cwd, patchPath) {
  try {
    const check = await runBuffered('git', ['apply', '--check', '--recount', patchPath], cwd, { rejectOnFailure: true });
    if (check.trim()) append(job, check);
    await runBuffered('git', ['apply', '--recount', patchPath], cwd, { rejectOnFailure: true });
    return;
  } catch (gitError) {
    append(job, `Strict git apply failed; trying fuzzy patch fallback.\n${gitError.message}\n`);
  }

  const fallback = await findPatchFallback(cwd, patchPath);
  if (fallback.dryRun.trim()) append(job, `${fallback.dryRun.trimEnd()}\n`);
  const output = await runBuffered('patch', ['--batch', '--forward', '--fuzz=3', fallback.strip, '-i', patchPath], cwd, { rejectOnFailure: true });
  if (output.trim()) append(job, `${output.trimEnd()}\n`);
  await runBuffered('find', ['.', '-name', '*.orig', '-delete'], cwd).catch(() => {});
}

async function applySuggestedFiles(job, cwd, files) {
  for (const [file, content] of Object.entries(files)) {
    const destination = path.resolve(cwd, file);
    if (!destination.startsWith(`${cwd}${path.sep}`) && destination !== cwd) {
      throw new Error(`Suggested file escapes project: ${file}`);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, 'utf8');
    append(job, `Wrote ${file}\n`);
  }
}

async function findPatchFallback(cwd, patchPath) {
  const errors = [];
  for (const strip of ['-p1', '-p0']) {
    try {
      const dryRun = await runBuffered('patch', ['--dry-run', '--batch', '--forward', '--fuzz=3', strip, '-i', patchPath], cwd, { rejectOnFailure: true });
      return { strip, dryRun };
    } catch (error) {
      errors.push(`${strip}: ${error.message}`);
    }
  }
  throw new Error(errors.join('\n'));
}

async function validateProjectAfterPatch(job, cwd) {
  const packageJson = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8').catch(() => '{}'));
  if (!packageJson.scripts?.test) return;
  append(job, '\nValidating patch with npm test...\n');
  const output = await runBuffered('npm', ['test'], cwd, { rejectOnFailure: true });
  if (output.trim()) append(job, `${output.trimEnd()}\n`);
}

async function runGitDiff(job, cwd) {
  try {
    await trustProjectPath(cwd);
    const staged = await runBuffered('git', ['--no-pager', 'diff', '--cached', '--stat', '--patch', '--', '.', ':(exclude)node_modules/**'], cwd);
    const diff = await runBuffered('git', ['--no-pager', 'diff', '--stat', '--patch', '--', '.', ':(exclude)node_modules/**'], cwd);
    const untracked = await runBuffered('git', ['ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude)node_modules/**'], cwd);
    const parts = [];

    if (staged.trim()) {
      parts.push(`Staged changes:\n${staged.trimEnd()}`);
    }
    if (diff.trim()) {
      parts.push(`Unstaged changes:\n${diff.trimEnd()}`);
    }
    if (untracked.trim()) {
      parts.push(`Untracked files:\n${untracked.trimEnd()}`);
    }
    if (parts.length === 0) {
      parts.push('No tracked or untracked changes in this project.');
    }

    append(job, `${parts.join('\n\n')}\n`);
    job.status = 'complete';
    job.exitCode = 0;
  } catch (error) {
    append(job, `Git diff failed: ${error.message}\n`);
    job.status = 'failed';
    job.exitCode = 1;
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

async function runGitPush(job, cwd) {
  try {
    await trustProjectPath(cwd);
    await ensureGitIdentity(cwd, (chunk) => append(job, `${chunk}\n`));
    const remotes = await runBuffered('git', ['remote'], cwd, { rejectOnFailure: true });
    if (!remotes.trim()) {
      const projectName = path.basename(cwd);
      append(job, `No Git remote is configured. Creating private GitHub repo: ${projectName}\n`);
      await ensureInitialCommit(job, cwd);
      if (process.env.MOBILE_AGENT_FAKE_GITHUB_OWNER) {
        const repoUrl = `https://github.com/${process.env.MOBILE_AGENT_FAKE_GITHUB_OWNER}/${projectName}.git`;
        await runBuffered('git', ['remote', 'add', 'origin', repoUrl], cwd, { rejectOnFailure: true });
        append(job, `created private repo: ${repoUrl}\n`);
        job.status = 'complete';
        job.exitCode = 0;
        return;
      }
      await runBuffered(ghCommand, ['auth', 'status'], cwd, { rejectOnFailure: true }).catch((error) => {
        throw new Error(`GitHub CLI is not authenticated. Run gh auth login in code-server first.\n${error.message}`);
      });
      const createOutput = await runBuffered(
        ghCommand,
        ['repo', 'create', projectName, '--private', '--source', '.', '--remote', 'origin', '--push'],
        cwd,
        { rejectOnFailure: true }
      ).catch(async (error) => {
        if (!/Name already exists|already exists/i.test(error.message)) throw error;
        append(job, 'A GitHub repo with this name already exists. Attaching it as origin and pushing.\n');
        const login = await githubLogin(cwd);
        const repoUrl = `https://github.com/${login}/${projectName}.git`;
        await runBuffered('git', ['remote', 'add', 'origin', repoUrl], cwd, { rejectOnFailure: true }).catch(async (remoteError) => {
          if (!/remote origin already exists/i.test(remoteError.message)) throw remoteError;
          await runBuffered('git', ['remote', 'set-url', 'origin', repoUrl], cwd, { rejectOnFailure: true });
        });
        const pushOutput = await runBuffered('git', ['push', '-u', 'origin', 'main'], cwd, { rejectOnFailure: true });
        return pushOutput || `Pushed to existing private GitHub repo: ${repoUrl}\n`;
      });
      append(job, createOutput || 'Private GitHub repository created and pushed.\n');
      job.status = 'complete';
      job.exitCode = 0;
      return;
    }

    await ensureInitialCommit(job, cwd);
    await runBuffered(ghCommand, ['auth', 'setup-git'], cwd).catch(() => {});
    const output = await runBuffered('git', ['push', '-u', 'origin', 'main'], cwd, { rejectOnFailure: true });
    append(job, output || 'Push completed.\n');
    job.status = 'complete';
    job.exitCode = 0;
  } catch (error) {
    append(job, `Git push failed.\n${error.message}\n`);
    job.status = 'failed';
    job.exitCode = 1;
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

async function ensureInitialCommit(job, cwd) {
  const headExists = await runBuffered('git', ['rev-parse', '--verify', 'HEAD'], cwd, { rejectOnFailure: true })
    .then(() => true)
    .catch(() => false);
  const status = await runBuffered('git', ['status', '--porcelain', '--', '.', ':(exclude)node_modules/**'], cwd, { rejectOnFailure: true });
  if (!status.trim() && headExists) return;

  await runBuffered('git', ['add', '-A', '--', '.'], cwd, { rejectOnFailure: true });
  const commitMessage = headExists ? 'Save mobile agent changes' : 'Initial project';
  const commitOutput = await runBuffered('git', ['commit', '-m', commitMessage], cwd, { rejectOnFailure: true });
  append(job, commitOutput || `Committed changes: ${commitMessage}\n`);
}

async function githubLogin(cwd) {
  const login = await runBuffered(ghCommand, ['api', 'user', '--jq', '.login'], cwd, { rejectOnFailure: true });
  return login.trim();
}

async function runGitCommit(job, cwd, message) {
  try {
    await trustProjectPath(cwd);
    await ensureGitIdentity(cwd, (chunk) => append(job, `${chunk}\n`));
    const addOutput = await runBuffered(
      'git',
      ['add', '-A', '--', '.'],
      cwd,
      { rejectOnFailure: true }
    );
    if (addOutput.trim()) append(job, addOutput);

    const output = await runBuffered('git', ['commit', '-m', message], cwd, { rejectOnFailure: true });
    append(job, output || 'Commit completed.\n');
    job.status = 'complete';
    job.exitCode = 0;
  } catch (error) {
    append(job, `Commit failed.\n${error.message}\n`);
    job.status = 'failed';
    job.exitCode = 1;
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

async function getProjectInfo(entry) {
  const projectPath = path.join(workspaceRoot, entry.name);
  const [git, packageJson, remote] = await Promise.all([
    fs.stat(path.join(projectPath, '.git')).then(() => true).catch(() => false),
    fs.stat(path.join(projectPath, 'package.json')).then(() => true).catch(() => false),
    runBuffered('git', ['remote', 'get-url', 'origin'], projectPath, { rejectOnFailure: true }).then((value) => value.trim()).catch(() => '')
  ]);
  return { name: entry.name, git, packageJson, ...(remote ? { remote } : {}) };
}

async function createProject({ name, githubPrivate }) {
  const projectName = cleanProjectName(name);
  const projectPath = path.join(workspaceRoot, projectName);
  await fs.mkdir(workspaceRoot, { recursive: true });

  const existing = await fs.stat(projectPath).catch(() => null);
  if (existing) throw new Error(`Project already exists: ${projectName}`);

  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${projectName}\n\nProject notes and agent context live here.\n`, 'utf8');
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n.env\n*.log\n', 'utf8');

  const output = [];
  const run = async (command, args, options = {}) => {
    const text = await runBuffered(command, args, projectPath, options);
    if (text.trim()) output.push(text.trim());
    return text;
  };

  await run('git', ['init', '-b', 'main']).catch(async () => {
    await run('git', ['init'], { rejectOnFailure: true });
    await run('git', ['branch', '-M', 'main']).catch(() => {});
  });
  await trustProjectPath(projectPath);
  await ensureGitIdentity(projectPath, output);
  await run('git', ['add', 'README.md', '.gitignore'], { rejectOnFailure: true });
  await run('git', ['commit', '-m', 'Initial project']).catch((error) => {
    output.push(`Initial commit skipped: ${error.message}`);
  });

  if (githubPrivate) {
      await runBuffered(ghCommand, ['auth', 'status'], projectPath, { rejectOnFailure: true }).catch((error) => {
        throw new Error(`GitHub CLI is not authenticated. Run gh auth login in code-server first.\n${error.message}`);
      });
    await run(ghCommand, ['repo', 'create', projectName, '--private', '--source', '.', '--remote', 'origin', '--push'], { rejectOnFailure: true });
  }

  return {
    project: projectName,
    output: output.join('\n') || 'Project created.'
  };
}

async function ensureGitIdentity(cwd, output) {
  const [name, email] = await Promise.all([
    runBuffered('git', ['config', 'user.name'], cwd, { rejectOnFailure: true }).then((value) => value.trim()).catch(() => ''),
    runBuffered('git', ['config', 'user.email'], cwd, { rejectOnFailure: true }).then((value) => value.trim()).catch(() => '')
  ]);
  if (name && email) return;

  const login = await runBuffered(ghCommand, ['api', 'user', '--jq', '.login'], cwd, { rejectOnFailure: true }).then((value) => value.trim()).catch(() => '');
  const ghEmail = await runBuffered(ghCommand, ['api', 'user', '--jq', '.email'], cwd, { rejectOnFailure: true }).then((value) => value.trim()).catch(() => '');
  const fallbackName = login || 'Mobile Agent';
  const fallbackEmail = ghEmail && ghEmail !== 'null' ? ghEmail : `${fallbackName}@users.noreply.github.com`;

  if (!name) {
    await runBuffered('git', ['config', 'user.name', fallbackName], cwd, { rejectOnFailure: true });
  }
  if (!email) {
    await runBuffered('git', ['config', 'user.email', fallbackEmail], cwd, { rejectOnFailure: true });
  }
  note(output, `Configured local Git author as ${fallbackName} <${fallbackEmail}>.`);
}

function note(output, message) {
  if (!output) return;
  if (Array.isArray(output)) {
    output.push(message);
    return;
  }
  if (typeof output === 'function') {
    output(message);
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
    projects.push(await getProjectInfo(entry));
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ projects });
});

app.post('/api/projects', requireAuth, async (req, res) => {
  try {
    const created = await createProject({
      name: req.body?.name,
      githubPrivate: Boolean(req.body?.githubPrivate)
    });
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
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

app.get('/api/jobs/:id/stream', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sentLength = 0;

  function flush() {
    const chunk = job.output.slice(sentLength);
    if (chunk) {
      sentLength += chunk.length;
      res.write(`data: ${JSON.stringify({ chunk, status: job.status })}\n\n`);
    }
    if (job.status !== 'running') {
      res.write(`data: ${JSON.stringify({ done: true, status: job.status })}\n\n`);
      clearInterval(ticker);
      res.end();
    }
  }

  const ticker = setInterval(flush, 250);
  flush();

  req.on('close', () => clearInterval(ticker));
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { cancel: _cancel, ...jobData } = job;
  res.json({ job: jobData });
});

app.delete('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'running') return res.status(400).json({ error: 'Job is not running' });
  if (job.cancel) job.cancel();
  job.status = 'cancelled';
  job.exitCode = -1;
  job.finishedAt = new Date().toISOString();
  activeJobId = null;
  const { cancel: _cancel, ...jobData } = job;
  res.json({ job: jobData });
});

app.get('/api/jobs', requireAuth, (_req, res) => {
  const list = Array.from(jobs.values()).slice(-20).reverse().map(({ cancel: _c, ...j }) => j);
  res.json({ jobs: list });
});

export { app };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(port, () => {
    console.log(`mobile-agent-ui listening on ${port}`);
  });
}
