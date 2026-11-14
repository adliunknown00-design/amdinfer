'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3030);
const LLAMA_PORT = Number(process.env.LLAMA_PORT || 8080);
const SETTINGS_DIR = path.resolve(process.env.SETTINGS_DIR || path.join(os.homedir(), '.amdinfer'));
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
let MODEL_DIR = path.resolve(saved.modelDir || process.env.MODEL_DIR || path.join(__dirname, 'models'));
let LLAMA_SERVER = saved.llamaServer || process.env.LLAMA_SERVER || 'llama-server';
let GPU_LAYERS = String(saved.gpuLayers || process.env.GPU_LAYERS || '99');
let CONTEXT_SIZE = String(saved.contextSize || process.env.CONTEXT_SIZE || '8192');
const EXTRA_ARGS = (process.env.LLAMA_EXTRA_ARGS || '').match(/(?:[^\s"]+|"[^"]*")+/g)?.map(x => x.replace(/^"|"$/g, '')) || [];
let engine = null;
let selectedModel = '';
let engineLog = '';
fs.mkdirSync(MODEL_DIR, { recursive: true });
const engineUrl = `http://127.0.0.1:${LLAMA_PORT}`;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
function readBody(req, max = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > max) { reject(new Error('Request body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function models() {
  try {
    return fs.readdirSync(MODEL_DIR, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.gguf'))
      .map(e => ({ id: e.name, path: path.join(MODEL_DIR, e.name), size: fs.statSync(path.join(MODEL_DIR, e.name)).size }));
  } catch { return []; }
}
function saveSettings() {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  saved = { modelDir: MODEL_DIR, llamaServer: LLAMA_SERVER, gpuLayers: Number(GPU_LAYERS), contextSize: Number(CONTEXT_SIZE) };
  const temporary = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(saved, null, 2));
  fs.renameSync(temporary, SETTINGS_FILE);
}
function stopEngine() {
  if (engine && !engine.killed) engine.kill('SIGTERM');
  engine = null;
  selectedModel = '';
}
function startEngine(modelName) {
  const item = models().find(m => m.id === modelName);
  if (!item) throw new Error('Choose a GGUF model from the model folder.');
  stopEngine();
  selectedModel = item.id;
  engineLog = '';
  const args = ['--model', item.path, '--host', '127.0.0.1', '--port', String(LLAMA_PORT), '--n-gpu-layers', GPU_LAYERS, '--ctx-size', CONTEXT_SIZE, ...EXTRA_ARGS];
  const child = spawn(LLAMA_SERVER, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  engine = child;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { engineLog = (engineLog + data.toString()).slice(-12000); });
  child.on('error', err => { engineLog += `\n${err.message}`; if (engine === child) engine = null; });
  child.on('exit', () => { if (engine === child) { engine = null; selectedModel = ''; } });
}
async function proxy(req, res, pathname) {
  const body = await readBody(req, 8 * 1024 * 1024);
  if (!engine) return json(res, 409, { error: { message: 'Load a model before starting a chat.' } });
  try {
    const upstream = await fetch(`${engineUrl}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch { json(res, 503, { error: { message: 'The inference engine is not responding. Wait for it to finish loading, or review the engine log in Settings.' } }); }
}
function mime(file) {
  return { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
}
const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' }); return res.end(); }
    if (req.method === 'GET' && ['/', '/index.html', '/app.css', '/app.js'].includes(url.pathname)) {
      const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
      res.writeHead(200, { 'content-type': mime(file), 'access-control-allow-origin': '*' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && url.pathname === '/api/models') return json(res, 200, { models: models(), selected: selectedModel });
    if (req.method === 'GET' && url.pathname === '/api/huggingface/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      const hf = new URL('https://huggingface.co/api/models');
      hf.searchParams.set('search', q);
      hf.searchParams.set('filter', 'gguf');
      hf.searchParams.set('sort', 'downloads');
      hf.searchParams.set('direction', '-1');
      hf.searchParams.set('limit', '20');
      hf.searchParams.set('full', 'true');
      const response = await fetch(hf, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Hugging Face search failed (${response.status}).`);
      const found = await response.json();
      return json(res, 200, { results: found.map(m => ({ id: m.id, downloads: m.downloads || 0, files: (m.siblings || []).filter(f => !f.rfilename.includes('/') && f.rfilename.endsWith('.gguf')).map(f => f.rfilename) })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/huggingface/download') {
      const repo = url.searchParams.get('repo') || '', file = url.searchParams.get('file') || '';
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w .()+-]+\.gguf$/i.test(file) || file.startsWith('.')) return json(res, 400, { error: { message: 'Invalid repository or file name.' } });
      const destination = path.join(MODEL_DIR, file), temporary = destination + '.download';
      const response = await fetch(`https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (!response.ok || !response.body) { response.body?.cancel(); return json(res, response.status === 200 ? 502 : response.status, { error: { message: `Download failed (${response.status}). The model may be gated or unavailable.` } }); }
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'access-control-allow-origin': '*' });
      const total = Number(response.headers.get('content-length') || 0);
      let received = 0, lastSent = 0;
      try {
        const output = fs.createWriteStream(temporary, { flags: 'w' });
        for await (const chunk of response.body) {
          if (!output.write(chunk)) await new Promise(r => output.once('drain', r));
          received += chunk.length;
          if (Date.now() - lastSent > 500) { res.write(JSON.stringify({ type: 'progress', received, total }) + '\n'); lastSent = Date.now(); }
        }
        await new Promise((resolve, reject) => { output.on('error', reject); output.end(resolve); });
        fs.renameSync(temporary, destination);
        res.end(JSON.stringify({ type: 'done', model: file }) + '\n');
      } catch (error) { fs.rmSync(temporary, { force: true }); res.end(JSON.stringify({ type: 'error', message: error.message }) + '\n'); }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      let upstream = false;
      try { upstream = (await fetch(`${engineUrl}/health`, { signal: AbortSignal.timeout(700) })).ok; } catch {}
      return json(res, 200, { running: !!engine, healthy: upstream, model: selectedModel, log: engineLog.slice(-10000) });
    }
    if (req.method === 'POST' && url.pathname === '/api/load') { const body = await readBody(req); startEngine(String(body.model || '')); return json(res, 202, { ok: true, model: selectedModel }); }
    if (req.method === 'POST' && url.pathname === '/api/unload') { stopEngine(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/api/chat')) return proxy(req, res, '/v1/chat/completions');
    if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, { object: 'list', data: selectedModel ? [{ id: selectedModel, object: 'model', created: 0, owned_by: 'local' }] : [] });
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { modelDir: MODEL_DIR, llamaServer: LLAMA_SERVER, gpuLayers: GPU_LAYERS, contextSize: CONTEXT_SIZE, apiBase: `http://${HOST}:${PORT}/v1` });
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req), dir = String(body.modelDir || MODEL_DIR);
      if (!path.isAbsolute(dir)) return json(res, 400, { error: { message: 'Choose an absolute model folder path.' } });
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.statSync(dir).isDirectory()) return json(res, 400, { error: { message: 'The selected path is not a folder.' } });
      const gpu = Number(body.gpuLayers), context = Number(body.contextSize);
      if (!Number.isInteger(gpu) || gpu < 0 || !Number.isInteger(context) || context < 512 || context > 1048576) return json(res, 400, { error: { message: 'GPU layers must be 0 or higher; context must be between 512 and 1,048,576.' } });
      const server = String(body.llamaServer || LLAMA_SERVER).trim();
      if (!server) return json(res, 400, { error: { message: 'Choose a llama-server executable.' } });
      stopEngine();
      MODEL_DIR = path.resolve(dir); LLAMA_SERVER = server; GPU_LAYERS = String(gpu); CONTEXT_SIZE = String(context);
      saveSettings();
      return json(res, 200, { modelDir: MODEL_DIR, llamaServer: LLAMA_SERVER, gpuLayers: GPU_LAYERS, contextSize: CONTEXT_SIZE });
    }
    if (req.method === 'POST' && url.pathname === '/api/model-dir') return json(res, 400, { error: { message: 'Use the Save settings button in Settings.' } });
    json(res, 404, { error: 'Not found' });
  } catch (error) { json(res, 500, { error: { message: error.message } }); }
});
app.listen(PORT, HOST, () => console.log(`AmdInfer listening on http://${HOST}:${PORT} (models: ${MODEL_DIR})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopEngine(); app.close(() => process.exit(0)); });
