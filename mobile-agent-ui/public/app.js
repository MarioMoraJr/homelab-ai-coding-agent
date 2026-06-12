const loginView = document.querySelector('#login-view');
const appView = document.querySelector('#app-view');
const loginForm = document.querySelector('#login-form');
const loginError = document.querySelector('#login-error');
const projectSelect = document.querySelector('#project');
const promptInput = document.querySelector('#prompt');
const output = document.querySelector('#output');
const jobTitle = document.querySelector('#job-title');
const jobStatus = document.querySelector('#job-status');
const commitMessage = document.querySelector('#commit-message');
const logoutButton = document.querySelector('#logout');
let pollTimer = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function showAuthed(authed) {
  loginView.hidden = authed;
  appView.hidden = !authed;
}

async function loadProjects() {
  const { projects } = await api('/api/projects');
  projectSelect.innerHTML = '';
  for (const project of projects) {
    const option = document.createElement('option');
    const flags = [project.git ? 'git' : null, project.packageJson ? 'node' : null].filter(Boolean).join(', ');
    option.value = project.name;
    option.textContent = flags ? `${project.name} (${flags})` : project.name;
    projectSelect.append(option);
  }
}

function setBusy(busy) {
  document.querySelectorAll('button, input, select, textarea').forEach((element) => {
    if (element.id !== 'logout') element.disabled = busy;
  });
}

function renderJob(job) {
  jobTitle.textContent = `${job.label} - ${job.project}`;
  jobStatus.textContent = job.status;
  output.textContent = job.output || 'Waiting for output...';
  output.scrollTop = output.scrollHeight;
  setBusy(job.status === 'running');
}

async function pollJob(id) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const { job } = await api(`/api/jobs/${id}`);
      renderJob(job);
      if (job.status !== 'running') {
        clearInterval(pollTimer);
        setBusy(false);
      }
    } catch (error) {
      clearInterval(pollTimer);
      jobStatus.textContent = 'error';
      output.textContent += `\n${error.message}`;
      setBusy(false);
    }
  }, 1200);
}

async function runAction(action) {
  if (action === 'push') {
    const ok = window.confirm(`Push commits from ${projectSelect.value} to its configured Git remote?`);
    if (!ok) return;
  }

  const body = { action, project: projectSelect.value };
  if (action === 'agent' || action === 'local-suggest') body.prompt = promptInput.value;
  if (action === 'commit') body.message = commitMessage.value;
  const { job } = await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  renderJob(job);
  await pollJob(job.id);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: document.querySelector('#password').value })
    });
    showAuthed(true);
    await loadProjects();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

logoutButton.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' });
  showAuthed(false);
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await runAction(button.dataset.action);
    } catch (error) {
      jobStatus.textContent = 'error';
      output.textContent = error.message;
      setBusy(false);
    }
  });
});

const session = await api('/api/session').catch(() => ({ authenticated: false }));
showAuthed(session.authenticated);
if (session.authenticated) {
  await loadProjects();
}

