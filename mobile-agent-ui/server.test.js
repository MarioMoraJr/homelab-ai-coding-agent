import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('authenticates and lists workspace projects', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-agent-ui-'));
  await fs.mkdir(path.join(workspace, 'sample-app'));
  await fs.writeFile(path.join(workspace, 'sample-app', 'package.json'), '{"scripts":{}}\n');

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
    { name: 'sample-app', git: false, packageJson: true }
  ]);
});
