"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebServer = void 0;
const http_1 = __importDefault(require("http"));
const LogBuffer_1 = require("../LogBuffer");
class WebServer {
    constructor(repository, controller, adapter, dispatch, port = 3000) {
        this.repository = repository;
        this.controller = controller;
        this.adapter = adapter;
        this.dispatch = dispatch;
        this.port = port;
        this.server = http_1.default.createServer((req, res) => {
            try {
                this.handle(req, res);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[WebServer] ${req.method} ${req.url} → 500: ${msg}`);
                if (err instanceof Error)
                    console.error(err.stack);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end(`Internal error: ${msg}`);
                }
            }
        });
    }
    start() {
        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`[WebServer] Port ${this.port} already in use — UI will not be available`);
            }
            else {
                console.error('[WebServer] Server error:', err.message);
            }
        });
        this.server.listen(this.port, '0.0.0.0', () => console.log(`[WebServer] Debug UI → http://localhost:${this.port}`));
    }
    // ─── Router ───────────────────────────────────────────────────────────────
    handle(req, res) {
        const url = req.url ?? '/';
        const method = req.method ?? 'GET';
        // CORS for local dev tools
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        if (method === 'GET' && url === '/api/status')
            return this.apiStatus(res);
        if (method === 'GET' && url?.startsWith('/api/log'))
            return this.apiLog(res, url);
        if (method === 'POST' && url === '/api/command')
            return this.apiCommand(req, res);
        if (method === 'GET' && (url === '/' || url === '/index.html'))
            return this.serveUI(res);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }
    // ─── Endpoints ────────────────────────────────────────────────────────────
    apiStatus(res) {
        const bots = this.repository.findAll().map(bot => ({
            id: bot.id,
            username: bot.username,
            state: String(bot.state),
            mode: this.adapter.getMode(bot),
            online: bot.isOnline(),
        }));
        const online = bots.filter(b => b.online).length;
        const intel = this.controller.intel.getAllSightings().map(s => ({
            target: s.targetUsername,
            spottedBy: s.spottedBy,
            x: Math.floor(s.position.x),
            y: Math.floor(s.position.y),
            z: Math.floor(s.position.z),
            secsAgo: Math.floor((Date.now() - s.timestamp) / 1000),
        }));
        const friends = this.controller.relations.getFriends();
        const enemies = this.controller.relations.getEnemies();
        const storages = this.controller.storage.list().map(s => ({
            label: s.label,
            x: s.pos.x,
            y: s.pos.y,
            z: s.pos.z,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ online, total: bots.length, bots, intel, friends, enemies, storages }, null, 2));
    }
    apiCommand(req, res) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { command } = JSON.parse(body);
                if (typeof command !== 'string' || !command.trim()) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '"command" string required' }));
                    return;
                }
                this.dispatch(command.trim());
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, command: command.trim() }));
            }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
        });
    }
    apiLog(res, url) {
        const n = parseInt(new URL(url, 'http://x').searchParams.get('n') ?? '150', 10);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify((0, LogBuffer_1.recent)(n)));
    }
    serveUI(res) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML_PAGE);
    }
}
exports.WebServer = WebServer;
// ─── Embedded HTML dashboard ──────────────────────────────────────────────
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swarm Debug</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0e1117; color: #c9d1d9; font: 14px/1.5 'Consolas', monospace; padding: 16px; }
  h1 { color: #58a6ff; margin-bottom: 12px; font-size: 18px; }
  h2 { color: #8b949e; font-size: 13px; text-transform: uppercase; letter-spacing: .05em;
       margin: 16px 0 6px; border-bottom: 1px solid #21262d; padding-bottom: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px; }
  .bot { padding: 8px 10px; border-radius: 6px; border: 1px solid #21262d; }
  .bot.online { border-color: #238636; background: #0d1117; }
  .bot.offline { border-color: #6e7681; opacity: .55; }
  .bot .name { font-weight: bold; }
  .bot .state { color: #8b949e; font-size: 11px; }
  .bot.online .state { color: #3fb950; }
  .bot .mode { color: #e3b341; font-size: 11px; margin-top: 2px; }
  .storage-row { padding: 4px 0; border-bottom: 1px solid #21262d; display: flex; gap: 12px; }
  .storage-row:last-child { border: 0; }
  .intel-row { padding: 4px 0; border-bottom: 1px solid #21262d; display: flex; gap: 12px; }
  .intel-row:last-child { border: 0; }
  .lbl { color: #8b949e; min-width: 80px; }
  #log-panel { background: #010409; border: 1px solid #21262d; border-radius: 6px;
               padding: 8px; height: 260px; overflow-y: auto; font-size: 12px; }
  .log-info  { color: #c9d1d9; }
  .log-warn  { color: #e3b341; }
  .log-error { color: #f85149; }
  .log-time  { color: #484f58; margin-right: 6px; user-select: none; }
  .log-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
  .log-toolbar label { color: #8b949e; font-size: 12px; display: flex; align-items: center; gap: 4px; }
  .btn-sm { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 3px 10px;
            border-radius: 4px; cursor: pointer; font: inherit; font-size: 12px; }
  .btn-sm:hover { background: #30363d; }
  .cmd-bar { display: flex; gap: 8px; margin-top: 8px; }
  input { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px;
          border-radius: 6px; flex: 1; font: inherit; }
  input:focus { outline: none; border-color: #58a6ff; }
  button { background: #238636; border: 0; color: #fff; padding: 6px 16px;
           border-radius: 6px; cursor: pointer; font: inherit; }
  button:hover { background: #2ea043; }
  #log { margin-top: 6px; color: #3fb950; font-size: 12px; min-height: 18px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: bold; }
  .badge.online { background: #238636; color: #fff; }
  .badge.offline { background: #6e7681; color: #fff; }
  #refresh { color: #8b949e; font-size: 11px; margin-left: 8px; }
</style>
</head>
<body>
<h1>Swarm Debug <span id="refresh"></span></h1>

<h2>Bots</h2>
<div id="bots" class="grid"></div>

<h2>Intel (last sightings)</h2>
<div id="intel"></div>

<h2>Storages</h2>
<div id="storages"></div>

<h2>Send Command</h2>
<div class="cmd-bar">
  <input id="cmd" type="text" placeholder="e.g. store deposit base | @builders defend 6" autocomplete="off" />
  <button onclick="sendCmd()">Send</button>
</div>
<div id="cmd-log"></div>

<h2>Log</h2>
<div class="log-toolbar">
  <label><input type="checkbox" id="autoscroll" checked> Auto-scroll</label>
  <label><input type="checkbox" id="filter-info" checked> info</label>
  <label><input type="checkbox" id="filter-warn" checked> warn</label>
  <label><input type="checkbox" id="filter-error" checked> error</label>
  <button class="btn-sm" onclick="downloadLog()">Download</button>
  <button class="btn-sm" onclick="clearLog()">Clear view</button>
</div>
<div id="log-panel"></div>

<script>
let logData = [];
let clearedBefore = 0;

function ts(ms) {
  return new Date(ms).toLocaleTimeString();
}

function renderLog() {
  const panel = document.getElementById('log-panel');
  const showInfo  = document.getElementById('filter-info').checked;
  const showWarn  = document.getElementById('filter-warn').checked;
  const showError = document.getElementById('filter-error').checked;
  const filtered = logData.filter(e =>
    e.time > clearedBefore &&
    ((e.level==='info' && showInfo) || (e.level==='warn' && showWarn) || (e.level==='error' && showError))
  );
  panel.innerHTML = filtered.map(e =>
    \`<div class="log-\${e.level}"><span class="log-time">\${ts(e.time)}</span>\${escHtml(e.text)}</div>\`
  ).join('');
  if (document.getElementById('autoscroll').checked) panel.scrollTop = panel.scrollHeight;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function clearLog() { clearedBefore = Date.now(); renderLog(); }

function downloadLog() {
  const text = logData.map(e => \`[\${ts(e.time)}] [\${e.level.toUpperCase()}] \${e.text}\`).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
  a.download = 'swarm-log-' + Date.now() + '.txt';
  a.click();
}

async function refreshLog() {
  try {
    const data = await fetch('/api/log?n=300').then(r => r.json());
    logData = data;
    renderLog();
  } catch { /* server starting */ }
}

async function refresh() {
  try {
    const data = await fetch('/api/status').then(r => r.json());
    document.getElementById('refresh').textContent =
      'Updated ' + new Date().toLocaleTimeString();

    // Bots
    const botsEl = document.getElementById('bots');
    botsEl.innerHTML = data.bots.map(b => \`
      <div class="bot \${b.online ? 'online' : 'offline'}">
        <div class="name">\${b.username}</div>
        <div class="state">\${b.state}</div>
        \${b.mode !== 'idle' ? \`<div class="mode">\${b.mode}</div>\` : ''}
      </div>\`).join('');

    // Intel
    const intelEl = document.getElementById('intel');
    if (data.intel.length === 0) {
      intelEl.innerHTML = '<span style="color:#6e7681">No recent sightings</span>';
    } else {
      intelEl.innerHTML = data.intel.map(s => \`
        <div class="intel-row">
          <span class="lbl">\${s.target}</span>
          <span>\${s.x}, \${s.y}, \${s.z}</span>
          <span style="color:#8b949e">\${s.secsAgo}s ago</span>
          <span style="color:#6e7681">by \${s.spottedBy}</span>
        </div>\`).join('');
    }

    // Storages
    const storagesEl = document.getElementById('storages');
    if (!data.storages || data.storages.length === 0) {
      storagesEl.innerHTML = '<span style="color:#6e7681">No storages registered</span>';
    } else {
      storagesEl.innerHTML = data.storages.map(s => \`
        <div class="storage-row">
          <span class="lbl" style="color:#e3b341">\${escHtml(s.label)}</span>
          <span>\${s.x}, \${s.y}, \${s.z}</span>
          <button class="btn-sm" onclick="sendQuick('store deposit \${escHtml(s.label)}')">deposit</button>
        </div>\`).join('');
    }
  } catch { /* server may be starting */ }
}

async function sendQuick(cmd) {
  document.getElementById('cmd').value = cmd;
  await sendCmd();
}

async function sendCmd() {
  const input = document.getElementById('cmd');
  const log = document.getElementById('cmd-log');
  const cmd = input.value.trim();
  if (!cmd) return;
  try {
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    });
    const data = await r.json();
    log.textContent = data.ok ? '> ' + cmd : 'Error: ' + data.error;
    if (data.ok) { input.value = ''; refresh(); }
  } catch(e) { log.textContent = 'Network error'; }
}

document.getElementById('cmd').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendCmd();
});

['filter-info','filter-warn','filter-error'].forEach(id =>
  document.getElementById(id).addEventListener('change', renderLog)
);

refresh();
refreshLog();
setInterval(refresh, 2000);
setInterval(refreshLog, 2000);
</script>
</body>
</html>`;
//# sourceMappingURL=WebServer.js.map