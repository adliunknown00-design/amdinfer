const $ = selector => document.querySelector(selector);
const API = location.protocol.startsWith('http') ? location.origin : 'http://127.0.0.1:3030';
const history = [];
let busy = false;
let status = { running: false, healthy: false, model: '', log: '' };
let localModels = [];
let currentConfig = null;
let selectedModel = '';

async function api(path, options = {}) {
  const response = await fetch(API + path, options);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error?.message || data.error || `Request failed (${response.status})`);
  return data;
}
function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function markdown(value) {
  return esc(value).replace(/```([\s\S]*?)```/g, '<pre>$1</pre>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4200);
}
function navigate(view) {
  for (const name of ['chat', 'models', 'settings']) {
    $(`#${name}View`).classList.toggle('hidden', name !== view);
    $(`#${name}Nav`).classList.toggle('active', name === view);
  }
  $('.breadcrumb').innerHTML = `Workspace <span>/</span> <strong>${view === 'chat' ? 'New chat' : view === 'models' ? 'Models' : 'Settings'}</strong>`;
  $('.sidebar').classList.remove('open');
  if (view === 'models') refreshModels();
  if (view === 'settings') openSettings();
}
function renderLibrary() {
  $('#folderDisplay').textContent = currentConfig?.modelDir || 'Loading folder…';
  $('#modelCount').textContent = localModels.length;
  $('#localModels').innerHTML = localModels.length ? localModels.map(model => `<div class="local-model"><div class="file-icon">GGUF</div><div class="local-details"><div class="local-name">${esc(model.id)}</div><div class="local-size">${(model.size / 1073741824).toFixed(2)} GB</div></div><button class="secondary" data-load="${esc(model.id)}">Load model</button></div>`).join('') : '<div class="empty">No single-file GGUF models in this folder yet.<br><button class="primary" id="emptyDiscover">Discover models</button></div>';
  $('#localModels').querySelectorAll('[data-load]').forEach(button => button.onclick = () => loadModel(button.dataset.load));
  $('#emptyDiscover')?.addEventListener('click', () => showModelsTab('discover'));
  if (!localModels.some(model => model.id === selectedModel)) selectedModel = status.model || localModels[0]?.id || '';
  $('#selectedModel').textContent = selectedModel || 'Nothing selected';
  $('#loadBtn').disabled = !selectedModel || (status.running && !status.healthy);
}
async function refreshModels() {
  try {
    const data = await api('/api/models');
    localModels = data.models;
    if (data.selected) selectedModel = data.selected;
    renderLibrary();
  } catch (error) { $('#localModels').innerHTML = `<div class="empty error">${esc(error.message)}</div>`; }
}
async function refreshStatus() {
  try {
    status = await api('/api/status');
    if (status.model) selectedModel = status.model;
    $('#dot').classList.toggle('on', status.healthy);
    $('#engineState').textContent = status.healthy ? 'Model ready' : status.running ? 'Starting model…' : 'No model loaded';
    $('#selectedModel').textContent = selectedModel || 'Nothing selected';
    $('#loadBtn').textContent = status.healthy ? 'Unload model' : status.running ? 'Starting…' : 'Load model';
    $('#loadBtn').disabled = !selectedModel || (status.running && !status.healthy);
    $('#diagStatus').textContent = status.healthy ? 'Running' : 'Not loaded';
    $('#engineLog').textContent = status.log || 'No engine output yet.';
    $('#serviceError').classList.add('hidden');
  } catch {
    $('#engineState').textContent = 'Service unavailable';
    $('#serviceError').classList.remove('hidden');
  }
}
async function openSettings() {
  try {
    currentConfig = await api('/api/config');
    $('#modelDirSetting').value = currentConfig.modelDir;
    $('#llamaServerSetting').value = currentConfig.llamaServer;
    $('#gpuSetting').value = currentConfig.gpuLayers;
    $('#ctxSetting').value = currentConfig.contextSize;
    $('#settingsMessage').textContent = '';
  } catch (error) { toast(error.message); }
}
async function chooseFolder(target) {
  try {
    if (!window.__TAURI__) return toast('Use the desktop app for the folder picker, or enter a full path.');
    const folder = await window.__TAURI__.core.invoke('choose_folder');
    if (folder) $(target).value = folder;
  } catch (error) { toast(`Could not open the picker: ${error}`); }
}
function showModelsTab(tab) {
  const library = tab === 'library';
  $('#libraryTab').classList.toggle('active', library);
  $('#discoverTab').classList.toggle('active', !library);
  $('#libraryPanel').classList.toggle('hidden', !library);
  $('#discoverPanel').classList.toggle('hidden', library);
  if (!library) $('#hfQuery').focus();
}
async function loadModel(model) {
  if (status.healthy) {
    await api('/api/unload', { method: 'POST' });
    selectedModel = '';
    await refreshModels();
    await refreshStatus();
    return;
  }
  if (!model) return toast('Choose a model from your library first.');
  try {
    await api('/api/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
    selectedModel = model;
    await refreshStatus();
    navigate('chat');
    toast('Model is starting. This can take a moment for large models.');
  } catch (error) { toast(error.message); }
}
function addMessage(role, text) {
  $('#welcome').classList.add('hidden');
  const row = document.createElement('div');
  row.className = `msg ${role}`;
  row.innerHTML = `<div class="avatar">${role === 'user' ? 'Y' : '◈'}</div><div class="msg-body">${markdown(text)}</div>`;
  $('#messages').appendChild(row);
  $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
  return row.querySelector('.msg-body');
}
async function send() {
  const text = $('#prompt').value.trim();
  if (!text || busy) return;
  if (!status.healthy) { toast('Load a model and wait for it to be ready before chatting.'); navigate('models'); return; }
  $('#prompt').value = '';
  busy = true;
  $('#sendBtn').disabled = true;
  addMessage('user', text);
  history.push({ role: 'user', content: text });
  const target = addMessage('assistant', '');
  let answer = '';
  try {
    const response = await fetch(API + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: status.model, messages: history, stream: true }) });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error?.message || `Request failed (${response.status})`); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const part = JSON.parse(data).choices?.[0]?.delta?.content || '';
          answer += part;
          target.innerHTML = markdown(answer);
          $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
        } catch {}
      }
    }
    history.push({ role: 'assistant', content: answer });
  } catch (error) {
    target.innerHTML = `<span class="error">${esc(error.message)}</span>`;
    if (history.at(-1)?.role === 'user') history.pop();
  } finally {
    busy = false;
    $('#sendBtn').disabled = false;
    $('#prompt').focus();
  }
}
async function searchModels() {
  const button = $('#hfSearch');
  button.disabled = true;
  $('#hfResults').innerHTML = '<div class="empty">Searching Hugging Face…</div>';
  try {
    const data = await api('/api/huggingface/search?q=' + encodeURIComponent($('#hfQuery').value.trim()));
    $('#hfResults').innerHTML = '';
    for (const repo of data.results) {
      const item = document.createElement('div');
      item.className = 'repo-item';
      const id = crypto.randomUUID();
      item.innerHTML = `<div class="repo-top"><div class="repo-name">${esc(repo.id)}</div><div class="repo-meta">${(repo.downloads / 1000).toFixed(1)}k downloads</div></div><div class="repo-controls"><select id="file-${id}">${repo.files.length ? repo.files.map(file => `<option value="${esc(file)}">${esc(file)}</option>`).join('') : '<option value="">No single-file GGUF found</option>'}</select><button class="secondary" ${repo.files.length ? '' : 'disabled'}>Download</button></div><div class="download-progress"></div>`;
      item.querySelector('button').onclick = () => downloadModel(repo.id, id, item.querySelector('button'), item.querySelector('.download-progress'));
      $('#hfResults').appendChild(item);
    }
    if (!data.results.length) $('#hfResults').innerHTML = '<div class="empty">No models found. Try another search.</div>';
  } catch (error) { $('#hfResults').innerHTML = `<div class="empty error">${esc(error.message)}</div>`; }
  finally { button.disabled = false; }
}
async function downloadModel(repo, id, button, progress) {
  const file = $(`#file-${id}`).value;
  button.disabled = true;
  progress.textContent = 'Connecting…';
  try {
    const response = await fetch(`${API}/api/huggingface/download?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(file)}`);
    if (!response.ok) { const data = await response.json(); throw new Error(data.error?.message || data.error); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type === 'progress') {
          const gb = bytes => (bytes / 1073741824).toFixed(2);
          progress.textContent = `Downloaded ${gb(event.received)} GB${event.total ? ` of ${gb(event.total)} GB` : ''} · Keep AmdInfer open`;
        } else if (event.type === 'done') {
          progress.textContent = 'Download complete. Find it in your local library.';
          refreshModels();
        } else if (event.type === 'error') throw new Error(event.message);
      }
    }
  } catch (error) { progress.innerHTML = `<span class="error">${esc(error.message)}</span>`; }
  finally { button.disabled = false; }
}

$('#chatNav').onclick = () => navigate('chat');
$('#modelsNav').onclick = () => navigate('models');
$('#settingsNav').onclick = () => navigate('settings');
$('#startBtn').onclick = () => navigate('models');
$('#libraryTab').onclick = () => showModelsTab('library');
$('#discoverTab').onclick = () => showModelsTab('discover');
$('#changeFolderBtn').onclick = () => navigate('settings');
$('#browseModelDir').onclick = () => chooseFolder('#modelDirSetting');
$('#browseServer').onclick = () => chooseFolder('#llamaServerSetting');
$('#showLog').onclick = () => { $('#engineLog').classList.toggle('hidden'); refreshStatus(); };
$('#loadBtn').onclick = () => loadModel(selectedModel);
$('#sendBtn').onclick = send;
$('#mobileMenu').onclick = () => $('.sidebar').classList.toggle('open');
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } });
document.querySelectorAll('.suggestion').forEach(button => button.onclick = () => { $('#prompt').value = button.dataset.prompt; $('#prompt').focus(); });
$('#newChat').onclick = () => { history.length = 0; $('#messages').innerHTML = ''; $('#welcome').classList.remove('hidden'); navigate('chat'); $('#prompt').focus(); };
$('#hfSearch').onclick = searchModels;
$('#hfQuery').addEventListener('keydown', event => { if (event.key === 'Enter') searchModels(); });
$('#settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#saveSettings');
  button.disabled = true;
  try {
    const data = await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelDir: $('#modelDirSetting').value.trim(), llamaServer: $('#llamaServerSetting').value.trim(), gpuLayers: Number($('#gpuSetting').value), contextSize: Number($('#ctxSetting').value) }) });
    currentConfig = { ...currentConfig, ...data };
    $('#settingsMessage').textContent = 'Settings saved.';
    toast('Settings saved. Any loaded model was unloaded.');
    await refreshModels();
    await refreshStatus();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

refreshStatus();
refreshModels();
openSettings();
setInterval(refreshStatus, 4000);
