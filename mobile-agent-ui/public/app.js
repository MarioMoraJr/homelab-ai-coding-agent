const loginView = document.querySelector('#login-view');
const appView = document.querySelector('#app-view');
const loginForm = document.querySelector('#login-form');
const loginError = document.querySelector('#login-error');
const projectSelect = document.querySelector('#project');
const newProjectForm = document.querySelector('#new-project-form');
const newProjectName = document.querySelector('#new-project-name');
const githubPrivate = document.querySelector('#github-private');
const promptInput = document.querySelector('#prompt');
const chatForm = document.querySelector('#chat-form');
const chatLog = document.querySelector('#chat-log');
const output = document.querySelector('#output');
const jobTitle = document.querySelector('#job-title');
const jobStatus = document.querySelector('#job-status');
const commitMessage = document.querySelector('#commit-message');
const logoutButton = document.querySelector('#logout');
const busyOverlay = document.querySelector('#busy-overlay');
const busyLabel = document.querySelector('#busy-label');
let pollTimer = null;
const chatHistoryByProject = new Map();

function addChatMessage(role, text) {
  const message = document.createElement('article');
  message.className = `chat-message ${role}`;
  const label = document.createElement('div');
  label.className = 'chat-role';
  label.textContent = role === 'user' ? 'You' : 'Local Agent';
  const body = document.createElement('pre');
  body.textContent = text;
  message.append(label, body);
  chatLog.append(message);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function rememberChat(role, text) {
  const project = projectSelect.value;
  if (!project) return;
  const history = chatHistoryByProject.get(project) || [];
  history.push({ role, content: text });
  chatHistoryByProject.set(project, history.slice(-8));
}

function resetChatForProject() {
  chatLog.innerHTML = '';
  const project = projectSelect.value;
  const history = chatHistoryByProject.get(project) || [];
  for (const entry of history) {
    addChatMessage(entry.role, entry.content);
  }
}

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
  const selected = projectSelect.value;
  projectSelect.innerHTML = '';
  for (const project of projects) {
    const option = document.createElement('option');
    const flags = [project.git ? 'git' : null, project.packageJson ? 'node' : null, project.remote ? 'github' : null].filter(Boolean).join(', ');
    option.value = project.name;
    option.textContent = flags ? `${project.name} (${flags})` : project.name;
    projectSelect.append(option);
  }
  if (selected && Array.from(projectSelect.options).some((option) => option.value === selected)) {
    projectSelect.value = selected;
  }
  resetChatForProject();
}

function setBusy(busy) {
  document.querySelectorAll('button, input, select, textarea').forEach((element) => {
    if (element.id !== 'logout') element.disabled = busy;
  });
  busyOverlay.hidden = !busy;
}

function renderJob(job) {
  jobTitle.textContent = `${job.label} - ${job.project}`;
  jobStatus.textContent = job.status;
  busyLabel.textContent = job.status === 'running' ? `${job.label} is running...` : 'Waiting for output...';
  output.textContent = job.output || (job.status === 'running' ? 'Waiting for output...' : 'No output.');
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
        if (job.action === 'local-agent') {
          const text = job.output || 'Done.';
          addChatMessage('assistant', text);
          rememberChat('assistant', text);
        }
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
  const prompt = promptInput.value.trim();
  if ((action === 'agent' || action === 'local-suggest' || action === 'local-agent') && !prompt) {
    throw new Error('Message is required');
  }
  if (action === 'apply-patch') {
    const ok = window.confirm(`Apply the latest Local Suggest patch to ${projectSelect.value}?`);
    if (!ok) return;
  }

  if (action === 'push') {
    const ok = window.confirm(`Push commits from ${projectSelect.value} to its configured Git remote?`);
    if (!ok) return;
  }

  const body = { action, project: projectSelect.value };
  if (action === 'agent' || action === 'local-suggest' || action === 'local-agent') body.prompt = prompt;
  if (action === 'local-agent') body.history = chatHistoryByProject.get(projectSelect.value) || [];
  if (action === 'commit') body.message = commitMessage.value;
  if (action === 'local-agent') {
    addChatMessage('user', prompt);
    rememberChat('user', prompt);
  }
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

newProjectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const created = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: newProjectName.value,
        githubPrivate: githubPrivate.checked
      })
    });
    newProjectName.value = '';
    await loadProjects();
    projectSelect.value = created.project;
    resetChatForProject();
    jobTitle.textContent = `Project Created - ${created.project}`;
    jobStatus.textContent = 'complete';
    output.textContent = created.output || 'Project created.';
  } catch (error) {
    jobStatus.textContent = 'error';
    output.textContent = error.message;
    busyLabel.textContent = 'Waiting for output...';
    setBusy(false);
  }
});

projectSelect.addEventListener('change', resetChatForProject);

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await runAction('local-agent');
  } catch (error) {
    jobStatus.textContent = 'error';
    output.textContent = error.message;
    busyLabel.textContent = 'Waiting for output...';
    addChatMessage('assistant', error.message);
    setBusy(false);
  }
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await runAction(button.dataset.action);
    } catch (error) {
      jobStatus.textContent = 'error';
      output.textContent = error.message;
      busyLabel.textContent = 'Waiting for output...';
      setBusy(false);
    }
  });
});

const session = await api('/api/session').catch(() => ({ authenticated: false }));
showAuthed(session.authenticated);
if (session.authenticated) {
  await loadProjects();
}

