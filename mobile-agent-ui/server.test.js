import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('authenticates, lists projects, and creates a private repo on push when remote is missing', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-agent-ui-'));
  await fs.mkdir(path.join(workspace, 'sample-app'));

  await fs.mkdir(path.join(workspace, 'sample-app', 'node_modules'));
  await fs.writeFile(path.join(workspace, 'sample-app', 'package.json'), '{"scripts":{}}\n');
  await fs.writeFile(path.join(workspace, 'sample-app', 'README.md'), 'hello\n');
  await fs.writeFile(path.join(workspace, 'sample-app', 'node_modules', 'ignored.txt'), 'ignored\n');
  await execFileAsync('git', ['init'], { cwd: path.join(workspace, 'sample-app') });
  await fs.writeFile(path.join(workspace, 'sample-app', '.gitignore'), 'node_modules/\n.env\n');
  await execFileAsync('git', ['add', 'README.md', 'package.json', '.gitignore'], { cwd: path.join(workspace, 'sample-app') });
  await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Initial'], { cwd: path.join(workspace, 'sample-app') });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: path.join(workspace, 'sample-app') });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: path.join(workspace, 'sample-app') });

  process.env.MOBILE_AGENT_PASSWORD = 'test-password';
  process.env.WORKSPACE_ROOT = workspace;
  process.env.MOBILE_AGENT_FAKE_GITHUB_OWNER = 'test-user';

  const ollama = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/generate');
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const request = JSON.parse(body);
      assert.equal(request.model, 'qwen2.5-coder:7b');
      assert.match(request.prompt, /User request: Suggest a tiny safe improvement/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response: [
          'Suggested local-only improvement.',
          '',
          '```diff',
          '--- a/README.md',
          '+++ b/README.md',
          '@@ -1,6 +1,7 @@',
          '-hello',
          '+hello local copilot',
          '```'
        ].join('\n')
      }));
    });
  });
  await new Promise((resolve) => ollama.listen(0, resolve));
  t.after(() => ollama.close());
  process.env.OLLAMA_HOST = `http://127.0.0.1:${ollama.address().port}`;

  const { app } = await import('./server.js');
  const server = app.listen(0);
  t.after(() => server.close());
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.MOBILE_AGENT_FAKE_GITHUB_OWNER;
  });

  const base = `http://127.0.0.1:${server.address().port}`;

  const blocked = await fetch(`${base}/api/projects`);
  assert.equal(blocked.status, 401);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' })
  });
  assert.equal(login.status, 200);

  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /mobile_agent_session=/);

  const projects = await fetch(`${base}/api/projects`, {
    headers: { cookie }
  });
  assert.equal(projects.status, 200);
  const body = await projects.json();
  assert.deepEqual(body.projects, [
    { name: 'sample-app', git: true, packageJson: true }
  ]);

  const push = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ project: 'sample-app', action: 'push' })
  });
  assert.equal(push.status, 202);
  const pushBody = await push.json();
  assert.equal(pushBody.job.label, 'Git Push');

  let job;
  for (let i = 0; i < 60; i += 1) {
    const response = await fetch(`${base}/api/jobs/${pushBody.job.id}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    ({ job } = await response.json());
    if (job.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, 'complete', job.output);
  assert.match(job.output, /No Git remote is configured/);
  assert.match(job.output, /created private repo/);
  const remote = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: path.join(workspace, 'sample-app') });
  assert.match(remote.stdout, /github.com\/test-user\/sample-app/);

  const suggest = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      project: 'sample-app',
      action: 'local-suggest',
      prompt: 'Suggest a tiny safe improvement'
    })
  });
  assert.equal(suggest.status, 202);
  const suggestBody = await suggest.json();
  assert.match(suggestBody.job.label, /Local Suggest/);

  let suggestionJob;
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${base}/api/jobs/${suggestBody.job.id}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    ({ job: suggestionJob } = await response.json());
    if (suggestionJob.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(suggestionJob.status, 'complete');
  assert.match(suggestionJob.output, /No files will be changed/);
  assert.match(suggestionJob.output, /Suggested local-only improvement/);
  assert.match(suggestionJob.output, /Patch detected/);

  const apply = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ project: 'sample-app', action: 'apply-patch' })
  });
  assert.equal(apply.status, 202);
  const applyBody = await apply.json();
  assert.equal(applyBody.job.label, 'Apply Patch');

  let applyJob;
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${base}/api/jobs/${applyBody.job.id}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    ({ job: applyJob } = await response.json());
    if (applyJob.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(applyJob.status, 'complete');
  assert.match(applyJob.output, /Patch applied successfully/);
  const readme = await fs.readFile(path.join(workspace, 'sample-app', 'README.md'), 'utf8');
  assert.equal(readme.replace(/\r\n/g, '\n'), 'hello local copilot\n');

  const commit = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ project: 'sample-app', action: 'commit', message: 'Apply local patch' })
  });
  assert.equal(commit.status, 202);
  const commitBody = await commit.json();
  assert.equal(commitBody.job.label, 'Commit');

  let commitJob;
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${base}/api/jobs/${commitBody.job.id}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    ({ job: commitJob } = await response.json());
    if (commitJob.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(commitJob.status, 'complete', commitJob.output);
  assert.doesNotMatch(commitJob.output, /node_modules/);
  const trackedFiles = await execFileAsync('git', ['ls-files'], { cwd: path.join(workspace, 'sample-app') });
  assert.doesNotMatch(trackedFiles.stdout, /node_modules/);
});

test('applies plain unified diffs with unprefixed paths', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-agent-ui-plain-diff-'));
  const projectPath = path.join(workspace, 'sample-app');
  await fs.mkdir(projectPath);
  await fs.writeFile(path.join(projectPath, 'package.json'), '{"scripts":{}}\n');
  await fs.writeFile(path.join(projectPath, 'README.md'), 'hello\n');
  await execFileAsync('git', ['init'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
  await execFileAsync('git', ['add', 'README.md', 'package.json'], { cwd: projectPath });
  await execFileAsync('git', ['commit', '-m', 'Initial'], { cwd: projectPath });

  process.env.MOBILE_AGENT_PASSWORD = 'test-password';
  process.env.WORKSPACE_ROOT = workspace;

  const ollama = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      response: [
        '```diff',
        '--- README.md',
        '+++ README.md',
        '@@ -1 +1 @@',
        '-hello',
        '+hello from p0',
        '```'
      ].join('\n')
    }));
  });
  await new Promise((resolve) => ollama.listen(0, resolve));
  t.after(() => ollama.close());
  process.env.OLLAMA_HOST = `http://127.0.0.1:${ollama.address().port}`;

  const { app } = await import(`./server.js?plain-diff=${Date.now()}`);
  const server = app.listen(0);
  t.after(() => server.close());
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' })
  });
  const cookie = login.headers.get('set-cookie');

  const suggest = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ project: 'sample-app', action: 'local-suggest', prompt: 'change readme' })
  });
  const suggestBody = await suggest.json();
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${base}/api/jobs/${suggestBody.job.id}`, { headers: { cookie } });
    const { job } = await response.json();
    if (job.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const apply = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ project: 'sample-app', action: 'apply-patch' })
  });
  const applyBody = await apply.json();
  let applyJob;
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${base}/api/jobs/${applyBody.job.id}`, { headers: { cookie } });
    ({ job: applyJob } = await response.json());
    if (applyJob.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(applyJob.status, 'complete', applyJob.output);
  const readme = await fs.readFile(path.join(projectPath, 'README.md'), 'utf8');
  assert.equal(readme.replace(/\r\n/g, '\n'), 'hello from p0\n');
});

test('runs the local Ollama agent with workspace tools', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-agent-ui-local-agent-'));
  const projectPath = path.join(workspace, 'sample-app');
  await fs.mkdir(projectPath);
  await fs.writeFile(path.join(projectPath, 'README.md'), 'hello\n');
  await execFileAsync('git', ['init'], { cwd: projectPath });

  process.env.MOBILE_AGENT_PASSWORD = 'test-password';
  process.env.WORKSPACE_ROOT = workspace;

  let chatCalls = 0;
  const ollama = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/chat');
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const request = JSON.parse(body);
      assert.equal(request.model, 'qwen2.5-coder:7b');
      chatCalls += 1;
      const content = chatCalls === 1
        ? JSON.stringify({ name: 'list_files', arguments: '{"path":"."}' })
        : JSON.stringify({ tool: 'final', args: { summary: 'Listed files.', checks: 'No changes.' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content } }));
    });
  });
  await new Promise((resolve) => ollama.listen(0, resolve));
  t.after(() => ollama.close());
  process.env.OLLAMA_HOST = `http://127.0.0.1:${ollama.address().port}`;

  const { app } = await import(`./server.js?local-agent=${Date.now()}`);
  const server = app.listen(0);
  t.after(() => server.close());
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' })
  });
  const cookie = login.headers.get('set-cookie');

  const started = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      project: 'sample-app',
      action: 'local-agent',
      prompt: 'List files',
      history: [
        { role: 'user', content: 'We are discussing README.md' },
        { role: 'assistant', content: 'I will inspect project docs.' }
      ]
    })
  });
  assert.equal(started.status, 202);
  const startedBody = await started.json();
  assert.match(startedBody.job.label, /Local Agent/);

  let agentJob;
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${base}/api/jobs/${startedBody.job.id}`, { headers: { cookie } });
    ({ job: agentJob } = await response.json());
    if (agentJob.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(agentJob.status, 'complete', agentJob.output);
  assert.match(agentJob.output, /Tool: list_files/);
  assert.match(agentJob.output, /README.md/);
  assert.match(agentJob.output, /Listed files/);
});

test('creates a new local project as a git repo', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-agent-ui-create-project-'));

  process.env.MOBILE_AGENT_PASSWORD = 'test-password';
  process.env.WORKSPACE_ROOT = workspace;

  const { app } = await import(`./server.js?create-project=${Date.now()}`);
  const server = app.listen(0);
  t.after(() => server.close());
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' })
  });
  const cookie = login.headers.get('set-cookie');

  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'My Private App', githubPrivate: false })
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.project, 'my-private-app');

  const readme = await fs.readFile(path.join(workspace, 'my-private-app', 'README.md'), 'utf8');
  assert.match(readme, /my-private-app/);
  const log = await execFileAsync('git', ['log', '--oneline', '-1'], { cwd: path.join(workspace, 'my-private-app') });
  assert.match(log.stdout, /Initial project/);

  const projects = await fetch(`${base}/api/projects`, { headers: { cookie } });
  const body = await projects.json();
  assert.deepEqual(body.projects.map((project) => ({
    name: project.name,
    git: project.git,
    packageJson: project.packageJson
  })), [
    { name: 'my-private-app', git: true, packageJson: false }
  ]);
});

test('blocks final answers until the local agent inspects the project', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-agent-ui-inspection-'));
  const projectPath = path.join(workspace, 'sample-app');
  await fs.mkdir(projectPath);
  await fs.writeFile(path.join(projectPath, 'README.md'), '# sample-app\n\nDocs first.\n');
  await execFileAsync('git', ['init'], { cwd: projectPath });

  process.env.MOBILE_AGENT_PASSWORD = 'test-password';
  process.env.WORKSPACE_ROOT = workspace;

  let chatCalls = 0;
  const ollama = http.createServer((_req, res) => {
    chatCalls += 1;
    const responses = [
      { tool: 'final', args: { summary: 'Too early.', checks: '' } },
      { tool: 'plan', args: { steps: ['inspect files', 'read docs', 'answer'] } },
      { tool: 'read_file', args: { path: 'README.md' } },
      { summary: 'Read README and found docs first.' }
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: JSON.stringify(responses[chatCalls - 1]) } }));
  });
  await new Promise((resolve) => ollama.listen(0, resolve));
  t.after(() => ollama.close());
  process.env.OLLAMA_HOST = `http://127.0.0.1:${ollama.address().port}`;

  const { app } = await import(`./server.js?inspection=${Date.now()}`);
  const server = app.listen(0);
  t.after(() => server.close());
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' })
  });
  const cookie = login.headers.get('set-cookie');

  const started = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ project: 'sample-app', action: 'local-agent', prompt: 'What do the docs say?' })
  });
  const startedBody = await started.json();

  let agentJob;
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${base}/api/jobs/${startedBody.job.id}`, { headers: { cookie } });
    ({ job: agentJob } = await response.json());
    if (agentJob.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(agentJob.status, 'complete', agentJob.output);
  assert.match(agentJob.output, /Final answer blocked/);
  assert.match(agentJob.output, /Tool: plan/);
  assert.match(agentJob.output, /Tool: read_file/);
  assert.match(agentJob.output, /Read README/);
});

test('blocks no-change final answers for creation requests after inspection', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-agent-ui-nochange-'));
  const projectPath = path.join(workspace, 'sample-app');
  await fs.mkdir(projectPath);
  await fs.writeFile(path.join(projectPath, 'README.md'), '# sample-app\n');
  await execFileAsync('git', ['init'], { cwd: projectPath });

  process.env.MOBILE_AGENT_PASSWORD = 'test-password';
  process.env.WORKSPACE_ROOT = workspace;

  let chatCalls = 0;
  const ollama = http.createServer((_req, res) => {
    chatCalls += 1;
    const responses = [
      { tool: 'list_files', args: { path: '.' } },
      { tool: 'final', args: { summary: 'No changes were made.', checks: 'none' } },
      { tool: 'write_file', args: { path: 'hello.txt', content: 'hello\n' } },
      { tool: 'final', args: { summary: 'Created hello.txt.', checks: 'not run' } }
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: JSON.stringify(responses[chatCalls - 1]) } }));
  });
  await new Promise((resolve) => ollama.listen(0, resolve));
  t.after(() => ollama.close());
  process.env.OLLAMA_HOST = `http://127.0.0.1:${ollama.address().port}`;

  const { app } = await import(`./server.js?nochange=${Date.now()}`);
  const server = app.listen(0);
  t.after(() => server.close());
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' })
  });
  const cookie = login.headers.get('set-cookie');

  const started = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ project: 'sample-app', action: 'local-agent', prompt: 'Create a hello file.' })
  });
  const startedBody = await started.json();

  let agentJob;
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${base}/api/jobs/${startedBody.job.id}`, { headers: { cookie } });
    ({ job: agentJob } = await response.json());
    if (agentJob.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(agentJob.status, 'complete', agentJob.output);
  assert.match(agentJob.output, /No-change final answer blocked/);
  assert.equal(await fs.readFile(path.join(projectPath, 'hello.txt'), 'utf8'), 'hello\n');
});
