import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('authenticates, lists projects, and starts a guarded push job', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-agent-ui-'));
  await fs.mkdir(path.join(workspace, 'sample-app'));
  await fs.writeFile(path.join(workspace, 'sample-app', 'package.json'), '{"scripts":{}}\n');
  await execFileAsync('git', ['init'], { cwd: path.join(workspace, 'sample-app') });

  process.env.MOBILE_AGENT_PASSWORD = 'test-password';
  process.env.WORKSPACE_ROOT = workspace;

  const { app } = await import('./server.js');
  const server = app.listen(0);
  t.after(() => server.close());
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

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
  for (let i = 0; i < 20; i += 1) {
    const response = await fetch(`${base}/api/jobs/${pushBody.job.id}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    ({ job } = await response.json());
    if (job.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, 'failed');
  assert.match(job.output, /No configured push destination|no upstream branch|fatal:/i);
});
