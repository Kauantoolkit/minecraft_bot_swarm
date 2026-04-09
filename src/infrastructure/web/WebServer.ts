import http from 'http';
import { IBotRepository } from '../../domain/repositories/IBotRepository';
import { SwarmController } from '../../application/SwarmController';
import { IBotAdapter } from '../mineflayer/IBotAdapter';
import { recent as recentLogs } from '../LogBuffer';
import type { Orchestrator } from '../../orchestrator/Orchestrator';
import type { ColonyPhase } from '../../orchestrator/GlobalState';

export class WebServer {
  private readonly server: http.Server;

  constructor(
    private readonly repository: IBotRepository,
    private readonly controller: SwarmController,
    private readonly adapter: IBotAdapter,
    private readonly dispatch: (cmd: string) => void,
    private readonly port: number = 3000,
    private readonly orchestrator?: Orchestrator,
  ) {
    this.server = http.createServer((req, res) => {
      try { this.handle(req, res); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WebServer] ${req.method} ${req.url} → 500: ${msg}`);
        if (err instanceof Error) console.error(err.stack);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Internal error: ${msg}`);
        }
      }
    });
  }

  start(): void {
    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[WebServer] Port ${this.port} already in use — UI will not be available`);
      } else {
        console.error('[WebServer] Server error:', err.message);
      }
    });
    this.server.listen(this.port, '0.0.0.0', () =>
      console.log(`[WebServer] Debug UI → http://localhost:${this.port}`),
    );
  }

  // ─── Router ───────────────────────────────────────────────────────────────

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (method === 'GET'  && url === '/api/status')           return this.apiStatus(res);
    if (method === 'GET'  && url?.startsWith('/api/log'))     return this.apiLog(res, url);
    if (method === 'POST' && url === '/api/command')          return this.apiCommand(req, res);
    if (method === 'GET'  && url === '/api/orch')             return this.apiOrchGet(res);
    if (method === 'POST' && url === '/api/orch')             return this.apiOrchPost(req, res);
    if (method === 'GET'  && (url === '/' || url === '/index.html')) return this.serveUI(res);

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  // ─── Endpoints ────────────────────────────────────────────────────────────

  private apiStatus(res: http.ServerResponse): void {
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

  private apiOrchGet(res: http.ServerResponse): void {
    if (!this.orchestrator) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: false }));
      return;
    }

    const state = this.orchestrator.getState();
    const pausedIds = this.orchestrator.pausedBotIds();

    const bots = Array.from(state.bots.entries()).map(([id, rec]) => ({
      id,
      username: rec.username,
      role: rec.role,
      taskStatus: rec.taskStatus,
      currentTaskId: rec.currentTaskId,
      failCount: rec.failCount,
      paused: pausedIds.includes(id),
      health: rec.health,
      food: rec.food,
      position: rec.position,
      inventory: rec.inventory,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      available: true,
      autonomous: (this.orchestrator as unknown as { autonomousMode: boolean }).autonomousMode,
      phase: state.phase,
      storagePos: state.storagePos,
      bots,
      pausedIds,
    }));
  }

  private apiOrchPost(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!this.orchestrator) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Orchestrator not available' }));
        return;
      }
      try {
        const payload = JSON.parse(body) as {
          action: string;
          botId?: string;
          phase?: ColonyPhase;
          durationMs?: number;
        };

        switch (payload.action) {
          case 'pause_all':
            this.orchestrator.disableAutonomous();
            break;
          case 'resume_all':
            this.orchestrator.enableAutonomous();
            break;
          case 'pause_bot':
            if (payload.botId)
              this.orchestrator.pauseBot(payload.botId, payload.durationMs ?? 300_000);
            break;
          case 'resume_bot':
            if (payload.botId) this.orchestrator.resumeBot(payload.botId);
            break;
          case 'set_phase':
            if (payload.phase) this.orchestrator.setPhase(payload.phase);
            break;
          case 'clear_storage_pos':
            this.orchestrator.clearStoragePos();
            break;
          default:
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown action: ${payload.action}` }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
  }

  private apiCommand(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { command } = JSON.parse(body) as { command?: unknown };
        if (typeof command !== 'string' || !command.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '"command" string required' }));
          return;
        }
        this.dispatch(command.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, command: command.trim() }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
  }

  private apiLog(res: http.ServerResponse, url: string): void {
    const n = parseInt(new URL(url, 'http://x').searchParams.get('n') ?? '150', 10);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(recentLogs(n)));
  }

  private serveUI(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
  }
}

// ─── Embedded HTML dashboard ──────────────────────────────────────────────

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swarm Control</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0e1117;color:#c9d1d9;font:13px/1.5 'Consolas',monospace;padding:12px 16px}
  h2{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.06em;
     margin:14px 0 6px;border-bottom:1px solid #21262d;padding-bottom:3px}

  /* Colony bar */
  #colony-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;
    background:#161b22;border:1px solid #21262d;border-radius:8px;margin-bottom:12px;flex-wrap:wrap}
  #colony-bar .title{color:#58a6ff;font-size:15px;font-weight:bold;margin-right:4px}
  .pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:12px;
    font-size:11px;font-weight:bold;border:1px solid transparent}
  .pill.online{background:#0d2318;border-color:#238636;color:#3fb950}
  .pill.phase{background:#1c1a0d;border-color:#9e6a03;color:#e3b341}
  .pill.auto-on{background:#0d2318;border-color:#238636;color:#3fb950}
  .pill.auto-off{background:#2d1117;border-color:#da3633;color:#f85149}
  select{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:3px 6px;
    border-radius:4px;font:inherit;font-size:12px}
  select:focus{outline:none;border-color:#58a6ff}
  .spacer{flex:1}

  /* Bot grid */
  #bots{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
  .bot-card{padding:10px 12px;border-radius:8px;border:2px solid #21262d;
    background:#0d1117;cursor:pointer;transition:border-color .15s}
  .bot-card.online{border-color:#21262d}
  .bot-card.offline{opacity:.45;cursor:default}
  .bot-card.selected{border-color:#58a6ff !important}
  .bot-card:hover.online{border-color:#30363d}
  .bot-card .top-row{display:flex;align-items:center;gap:6px;margin-bottom:4px}
  .bot-name{font-weight:bold;font-size:13px;color:#e6edf3;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .role-badge{font-size:10px;padding:1px 6px;border-radius:8px;font-weight:bold;white-space:nowrap}
  .role-miner   {background:#0d2233;color:#58a6ff;border:1px solid #1f6feb}
  .role-builder {background:#1c1a0d;color:#e3b341;border:1px solid #9e6a03}
  .role-farmer  {background:#0d2318;color:#3fb950;border:1px solid #238636}
  .role-soldier {background:#2d1117;color:#f85149;border:1px solid #da3633}
  .role-hauler  {background:#1a0d2e;color:#a371f7;border:1px solid #6e40c9}
  .role-unassigned{background:#161b22;color:#6e7681;border:1px solid #30363d}
  .paused-badge{font-size:10px;padding:1px 6px;border-radius:8px;
    background:#1c1a0d;color:#e3b341;border:1px solid #9e6a03}
  .bot-status{font-size:11px;color:#8b949e;margin-bottom:3px;height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bot-status .task-running{color:#58a6ff}
  .bot-status .task-idle{color:#6e7681}
  .bot-status .task-failed{color:#f85149}
  .bars{display:flex;gap:4px;margin-bottom:6px}
  .bar-wrap{flex:1}
  .bar-lbl{font-size:9px;color:#484f58;margin-bottom:1px}
  .bar-bg{background:#21262d;border-radius:2px;height:5px;overflow:hidden}
  .bar-fill{height:100%;border-radius:2px;transition:width .3s}
  .bar-hp{background:#3fb950}
  .bar-food{background:#e3b341}
  .bot-pos{font-size:10px;color:#484f58;margin-bottom:5px}
  .quick-btns{display:flex;gap:4px;flex-wrap:wrap}
  .qbtn{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:2px 7px;
    border-radius:4px;cursor:pointer;font:11px 'Consolas',monospace;white-space:nowrap}
  .qbtn:hover{background:#30363d}
  .qbtn.red{border-color:#da3633;color:#f85149}
  .qbtn.red:hover{background:#2d1117}
  .qbtn.blue{border-color:#1f6feb;color:#58a6ff}
  .qbtn.blue:hover{background:#0d2233}

  /* Task panel */
  #task-panel{background:#161b22;border:1px solid #21262d;border-radius:8px;
    padding:12px;margin-top:10px;display:none}
  #task-panel.visible{display:block}
  #task-panel h3{color:#58a6ff;font-size:13px;margin-bottom:10px}
  .task-form{display:flex;flex-direction:column;gap:8px}
  .form-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .form-row label{color:#8b949e;font-size:11px;min-width:60px}
  .form-row input{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;
    padding:4px 8px;border-radius:4px;font:inherit;font-size:12px;width:100px}
  .form-row input:focus{outline:none;border-color:#58a6ff}
  .action-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;margin-top:4px}
  .action-btn{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:6px 10px;
    border-radius:6px;cursor:pointer;font:12px 'Consolas',monospace;text-align:left}
  .action-btn:hover{background:#30363d}
  .action-btn .ab-title{font-weight:bold;color:#e6edf3}
  .action-btn .ab-sub{font-size:10px;color:#8b949e;margin-top:1px}
  .action-btn.danger{border-color:#da3633}
  .action-btn.danger:hover{background:#2d1117}
  .action-btn.primary{border-color:#1f6feb}
  .action-btn.primary:hover{background:#0d2233}

  /* Command bar */
  .cmd-bar{display:flex;gap:8px;margin-top:6px}
  .cmd-bar input{background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:6px 10px;
    border-radius:6px;flex:1;font:inherit}
  .cmd-bar input:focus{outline:none;border-color:#58a6ff}
  .cmd-bar button{background:#238636;border:0;color:#fff;padding:6px 14px;
    border-radius:6px;cursor:pointer;font:inherit}
  .cmd-bar button:hover{background:#2ea043}
  #cmd-log{font-size:11px;color:#3fb950;margin-top:4px;min-height:16px}

  /* Log */
  .log-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap}
  .log-toolbar label{color:#8b949e;font-size:11px;display:flex;align-items:center;gap:3px}
  #log-panel{background:#010409;border:1px solid #21262d;border-radius:6px;
    padding:8px;height:220px;overflow-y:auto;font-size:11px}
  .log-info{color:#c9d1d9}
  .log-warn{color:#e3b341}
  .log-error{color:#f85149}
  .log-time{color:#484f58;margin-right:6px;user-select:none}
  .btn-sm{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:2px 8px;
    border-radius:4px;cursor:pointer;font:inherit;font-size:11px}
  .btn-sm:hover{background:#30363d}

  /* Storages */
  .storage-row{display:flex;align-items:center;gap:10px;padding:4px 0;
    border-bottom:1px solid #21262d}
  .storage-row:last-child{border:0}
  .lbl{color:#8b949e;min-width:80px}

  /* Intel */
  .intel-row{display:flex;gap:10px;padding:4px 0;border-bottom:1px solid #21262d;font-size:12px}
  .intel-row:last-child{border:0}

  #refresh-ts{color:#484f58;font-size:10px}
</style>
</head>
<body>

<!-- Colony control bar -->
<div id="colony-bar">
  <span class="title">Swarm Control</span>
  <span id="pill-online" class="pill online">0/0 online</span>
  <span>Phase:</span>
  <select id="phase-select" onchange="setPhase(this.value)">
    <option value="bootstrap">bootstrap</option>
    <option value="resource_gathering">resource_gathering</option>
    <option value="base_building">base_building</option>
    <option value="expansion">expansion</option>
    <option value="combat">combat</option>
  </select>
  <span id="pill-auto" class="pill auto-on">AUTO ON</span>
  <button class="btn-sm" id="btn-toggle-auto" onclick="toggleAuto()">Pause all</button>
  <div class="spacer"></div>
  <span id="storage-pos-display" style="color:#8b949e;font-size:11px"></span>
  <button class="btn-sm" id="btn-clear-storage" onclick="clearStoragePos()" style="display:none">Clear storagePos</button>
  <span id="refresh-ts"></span>
</div>

<h2>Bots</h2>
<div id="bots"></div>

<!-- Per-bot task panel -->
<div id="task-panel">
  <h3>Assign task to <span id="panel-bot-name">—</span>
    <span id="panel-paused-badge" class="paused-badge" style="display:none;margin-left:8px">PAUSED</span>
  </h3>

  <!-- Param inputs -->
  <div class="task-form">
    <div class="form-row">
      <label>Block</label>
      <input id="p-block" type="text" value="stone" placeholder="e.g. stone" />
      <label style="margin-left:8px">Count</label>
      <input id="p-count" type="number" value="64" min="1" max="512" style="width:64px" />
      <label style="margin-left:8px">Storage</label>
      <input id="p-store" type="text" value="nearest" placeholder="label or nearest" style="width:90px" />
    </div>
    <div class="form-row">
      <label>X</label><input id="p-x" type="number" value="0" style="width:64px" />
      <label>Y</label><input id="p-y" type="number" value="64" style="width:64px" />
      <label>Z</label><input id="p-z" type="number" value="0" style="width:64px" />
      <label style="margin-left:8px">Radius</label><input id="p-radius" type="number" value="8" style="width:56px" />
    </div>
  </div>

  <div class="action-grid" id="action-grid">
    <!-- filled by renderPanel() -->
  </div>
</div>

<h2>Storage</h2>
<div id="storages"></div>

<h2>Intel</h2>
<div id="intel"></div>

<h2>Command (raw)</h2>
<div class="cmd-bar">
  <input id="cmd" type="text" placeholder='e.g. @all stop  |  store register base 0 64 0' autocomplete="off" />
  <button onclick="sendCmd()">Send</button>
</div>
<div id="cmd-log"></div>

<h2>Log</h2>
<div class="log-toolbar">
  <label><input type="checkbox" id="autoscroll" checked> scroll</label>
  <label><input type="checkbox" id="filter-info" checked> info</label>
  <label><input type="checkbox" id="filter-warn" checked> warn</label>
  <label><input type="checkbox" id="filter-error" checked> error</label>
  <button class="btn-sm" onclick="downloadLog()">Download</button>
  <button class="btn-sm" onclick="clearLog()">Clear</button>
</div>
<div id="log-panel"></div>

<script>
// ── State ──────────────────────────────────────────────────────────────────
let orchData   = { available: false, autonomous: true, phase: 'bootstrap', bots: [], pausedIds: [] };
let statusData = { bots: [], storages: [], intel: [] };
let logData    = [];
let clearedBefore = 0;
let selectedBotId = null;
let autoOn = true;

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function ts(ms) { return new Date(ms).toLocaleTimeString(); }

// ── Orchestrator API ───────────────────────────────────────────────────────
async function orchPost(body) {
  const r = await fetch('/api/orch', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  return r.json();
}

async function toggleAuto() {
  if (autoOn) {
    await orchPost({ action: 'pause_all' });
    autoOn = false;
  } else {
    await orchPost({ action: 'resume_all' });
    autoOn = true;
  }
  renderColonyBar();
}

async function setPhase(phase) {
  await orchPost({ action: 'set_phase', phase });
}

async function clearStoragePos() {
  await orchPost({ action: 'clear_storage_pos' });
  await refreshOrch();
  renderColonyBar();
}

async function pauseBot(botId) {
  await orchPost({ action: 'pause_bot', botId, durationMs: 300_000 });
  await refreshOrch();
  renderPanel();
}

async function resumeBot(botId) {
  await orchPost({ action: 'resume_bot', botId });
  await refreshOrch();
  renderPanel();
}

// ── Command API ────────────────────────────────────────────────────────────
async function sendRaw(cmd) {
  const log = document.getElementById('cmd-log');
  try {
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ command: cmd }),
    });
    const data = await r.json();
    log.textContent = data.ok ? '> ' + cmd : 'Error: ' + data.error;
  } catch(e) { log.textContent = 'Network error'; }
}

async function sendCmd() {
  const input = document.getElementById('cmd');
  const cmd = input.value.trim();
  if (!cmd) return;
  await sendRaw(cmd);
  input.value = '';
}

// ── Per-bot command builders ───────────────────────────────────────────────
function targetPrefix(username) {
  return '@' + username + ' ';
}

function botAction(username, cmd) {
  return sendRaw(targetPrefix(username) + cmd);
}

// ── Colony bar render ──────────────────────────────────────────────────────
function renderColonyBar() {
  const online = statusData.bots.filter(b => b.online).length;
  const total  = statusData.bots.length;
  document.getElementById('pill-online').textContent = online + '/' + total + ' online';

  const phaseEl = document.getElementById('phase-select');
  if (orchData.available && phaseEl.value !== orchData.phase) {
    phaseEl.value = orchData.phase;
  }

  const storePosEl = document.getElementById('storage-pos-display');
  const clearBtn   = document.getElementById('btn-clear-storage');
  if (orchData.storagePos) {
    const p = orchData.storagePos;
    storePosEl.textContent = 'storagePos: ' + Math.floor(p.x) + ', ' + Math.floor(p.y) + ', ' + Math.floor(p.z);
    clearBtn.style.display = 'inline-block';
  } else {
    storePosEl.textContent = '';
    clearBtn.style.display = 'none';
  }

  autoOn = orchData.available ? orchData.autonomous : true;
  const pillAuto = document.getElementById('pill-auto');
  const btnAuto  = document.getElementById('btn-toggle-auto');
  if (autoOn) {
    pillAuto.className = 'pill auto-on';
    pillAuto.textContent = 'AUTO ON';
    btnAuto.textContent = 'Pause all';
  } else {
    pillAuto.className = 'pill auto-off';
    pillAuto.textContent = 'AUTO OFF';
    btnAuto.textContent = 'Resume all';
  }
}

// ── Bot cards ──────────────────────────────────────────────────────────────
function orchBotById(id) {
  return orchData.bots.find(b => b.id === id) ?? null;
}

function roleBadge(role) {
  return '<span class="role-badge role-' + esc(role) + '">' + esc(role) + '</span>';
}

function taskStatusText(b) {
  if (!b || b.taskStatus === 'idle' || !b.taskStatus) return '<span class="task-idle">idle</span>';
  if (b.taskStatus === 'running') return '<span class="task-running">running: ' + esc(b.currentTaskId ?? '?') + '</span>';
  if (b.taskStatus === 'failed') return '<span class="task-failed">failed</span>';
  return '<span>' + esc(b.taskStatus) + '</span>';
}

function renderBots() {
  const el = document.getElementById('bots');
  const cards = statusData.bots.map(bot => {
    const ob = orchBotById(bot.id);
    const paused = ob && orchData.pausedIds.includes(bot.id);
    const sel    = bot.id === selectedBotId;

    const hpPct   = ob ? Math.round((ob.health / 20) * 100) : 0;
    const foodPct = ob ? Math.round((ob.food   / 20) * 100) : 0;
    const pos = ob?.position
      ? Math.floor(ob.position.x) + ', ' + Math.floor(ob.position.y) + ', ' + Math.floor(ob.position.z)
      : '—';

    return \`<div class="bot-card \${bot.online ? 'online' : 'offline'}\${sel ? ' selected' : ''}"
        onclick="\${bot.online ? 'selectBot(\\'' + bot.id + '\\',\\'' + esc(bot.username) + '\\')' : ''}">
      <div class="top-row">
        <span class="bot-name">\${esc(bot.username)}</span>
        \${ob ? roleBadge(ob.role) : ''}
        \${paused ? '<span class="paused-badge">PAUSED</span>' : ''}
      </div>
      <div class="bot-status">\${ob ? taskStatusText(ob) : '<span class="task-idle">' + esc(bot.state) + '</span>'}</div>
      \${bot.online && ob ? \`
      <div class="bars">
        <div class="bar-wrap"><div class="bar-lbl">HP</div><div class="bar-bg"><div class="bar-fill bar-hp" style="width:\${hpPct}%"></div></div></div>
        <div class="bar-wrap"><div class="bar-lbl">Food</div><div class="bar-bg"><div class="bar-fill bar-food" style="width:\${foodPct}%"></div></div></div>
      </div>
      <div class="bot-pos">\${pos}</div>\` : ''}
      \${bot.online ? \`
      <div class="quick-btns">
        <button class="qbtn red" onclick="event.stopPropagation();botAction('\${esc(bot.username)}','stop')">stop</button>
        \${paused
          ? '<button class="qbtn blue" onclick="event.stopPropagation();resumeBot(\\'' + bot.id + '\\')">resume auto</button>'
          : '<button class="qbtn" onclick="event.stopPropagation();pauseBot(\\'' + bot.id + '\\')">pause auto</button>'
        }
        <button class="qbtn" onclick="event.stopPropagation();botAction('\${esc(bot.username)}','defend 8')">defend</button>
      </div>\` : ''}
    </div>\`;
  });
  el.innerHTML = cards.join('');
}

// ── Task panel ─────────────────────────────────────────────────────────────
function selectBot(id, username) {
  selectedBotId = selectedBotId === id ? null : id;
  renderBots();
  renderPanel();
}

function renderPanel() {
  const panel = document.getElementById('task-panel');
  if (!selectedBotId) { panel.className = 'task-panel'; return; }

  const bot = statusData.bots.find(b => b.id === selectedBotId);
  if (!bot || !bot.online) { panel.className = 'task-panel'; return; }

  const ob    = orchBotById(selectedBotId);
  const paused = ob && orchData.pausedIds.includes(selectedBotId);
  const uname = bot.username;

  panel.className = 'task-panel visible';
  document.getElementById('panel-bot-name').textContent = uname;
  const pb = document.getElementById('panel-paused-badge');
  pb.style.display = paused ? 'inline-flex' : 'none';

  const actions = [
    { title: 'Stop',        sub: 'clear all tasks',        cls: 'danger',
      fn: \`botAction('\${uname}','stop')\` },
    { title: 'Pause auto',  sub: '5 min no orchestrator',  cls: paused ? '' : 'primary',
      fn: paused ? \`resumeBot('\${selectedBotId}')\` : \`pauseBot('\${selectedBotId}')\`,
      label: paused ? 'Resume auto' : 'Pause auto' },
    { title: 'Mine block',  sub: 'block + count + store',  cls: 'primary',
      fn: \`assignMine('\${uname}')\` },
    { title: 'Collect wood',sub: 'count + store',          cls: 'primary',
      fn: \`assignWood('\${uname}')\` },
    { title: 'Deposit',     sub: 'store label',            cls: '',
      fn: \`assignDeposit('\${uname}')\` },
    { title: 'Defend self', sub: 'radius from field',      cls: '',
      fn: \`botAction('\${uname}','defend ' + document.getElementById('p-radius').value)\` },
    { title: 'Guard pos',   sub: 'X Y Z radius',           cls: '',
      fn: \`assignGuard('\${uname}')\` },
    { title: 'Farm',        sub: 'X Z radius',             cls: '',
      fn: \`assignFarm('\${uname}')\` },
    { title: 'Explore',     sub: 'auto direction',         cls: '',
      fn: \`botAction('\${uname}','explore auto')\` },
    { title: 'Eat',         sub: 'eat best food',          cls: '',
      fn: \`botAction('\${uname}','eat')\` },
    { title: 'Craft item',  sub: 'block field as item',    cls: '',
      fn: \`assignCraft('\${uname}')\` },
  ];

  document.getElementById('action-grid').innerHTML = actions.map(a => \`
    <button class="action-btn \${a.cls ?? ''}" onclick="\${a.fn}">
      <div class="ab-title">\${a.label ?? a.title}</div>
      <div class="ab-sub">\${a.sub}</div>
    </button>\`).join('');
}

// ── Action helpers (read form fields) ─────────────────────────────────────
function fBlock()  { return document.getElementById('p-block').value.trim() || 'stone'; }
function fCount()  { return parseInt(document.getElementById('p-count').value) || 64; }
function fStore()  { return document.getElementById('p-store').value.trim() || 'nearest'; }
function fX()      { return parseInt(document.getElementById('p-x').value) || 0; }
function fY()      { return parseInt(document.getElementById('p-y').value) || 64; }
function fZ()      { return parseInt(document.getElementById('p-z').value) || 0; }
function fRadius() { return parseInt(document.getElementById('p-radius').value) || 8; }

function assignMine(uname) {
  sendRaw('@' + uname + ' collect ' + fBlock() + ' ' + fCount() + ' --store ' + fStore());
}
function assignWood(uname) {
  sendRaw('@' + uname + ' collect oak_log ' + fCount() + ' --store ' + fStore());
}
function assignDeposit(uname) {
  sendRaw('@' + uname + ' store deposit ' + fStore());
}
function assignGuard(uname) {
  sendRaw('@' + uname + ' guard ' + fX() + ' ' + fY() + ' ' + fZ() + ' ' + fRadius());
}
function assignFarm(uname) {
  sendRaw('@' + uname + ' farm ' + fX() + ' ' + fZ() + ' ' + fRadius());
}
function assignCraft(uname) {
  sendRaw('@' + uname + ' craft ' + fBlock() + ' ' + fCount());
}

// ── Storage & Intel ────────────────────────────────────────────────────────
function renderStorages() {
  const el = document.getElementById('storages');
  if (!statusData.storages || statusData.storages.length === 0) {
    el.innerHTML = '<span style="color:#6e7681">No storages registered</span>';
    return;
  }
  el.innerHTML = statusData.storages.map(s => \`
    <div class="storage-row">
      <span class="lbl" style="color:#e3b341">\${esc(s.label)}</span>
      <span>\${s.x}, \${s.y}, \${s.z}</span>
      <button class="btn-sm" onclick="sendRaw('store deposit \${esc(s.label)}')">deposit all</button>
      <button class="btn-sm" onclick="sendRaw('@all store deposit \${esc(s.label)}')">all bots</button>
    </div>\`).join('');
}

function renderIntel() {
  const el = document.getElementById('intel');
  if (!statusData.intel || statusData.intel.length === 0) {
    el.innerHTML = '<span style="color:#6e7681">No recent sightings</span>';
    return;
  }
  el.innerHTML = statusData.intel.map(s => \`
    <div class="intel-row">
      <span style="color:#f85149">\${esc(s.target)}</span>
      <span>\${s.x}, \${s.y}, \${s.z}</span>
      <span style="color:#8b949e">\${s.secsAgo}s ago</span>
      <span style="color:#484f58">by \${esc(s.spottedBy)}</span>
    </div>\`).join('');
}

// ── Log ────────────────────────────────────────────────────────────────────
function renderLog() {
  const panel = document.getElementById('log-panel');
  const showInfo  = document.getElementById('filter-info').checked;
  const showWarn  = document.getElementById('filter-warn').checked;
  const showError = document.getElementById('filter-error').checked;
  const filtered = logData.filter(e =>
    e.time > clearedBefore &&
    ((e.level==='info'&&showInfo)||(e.level==='warn'&&showWarn)||(e.level==='error'&&showError))
  );
  panel.innerHTML = filtered.map(e =>
    \`<div class="log-\${e.level}"><span class="log-time">\${ts(e.time)}</span>\${esc(e.text)}</div>\`
  ).join('');
  if (document.getElementById('autoscroll').checked) panel.scrollTop = panel.scrollHeight;
}

function clearLog() { clearedBefore = Date.now(); renderLog(); }

function downloadLog() {
  const text = logData.map(e => '['+ts(e.time)+']['+e.level.toUpperCase()+'] '+e.text).join('\\n');
  const a = document.createElement('a');
  a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
  a.download = 'swarm-log-' + Date.now() + '.txt';
  a.click();
}

// ── Refresh loops ──────────────────────────────────────────────────────────
async function refreshOrch() {
  try { orchData = await fetch('/api/orch').then(r => r.json()); } catch {}
}

async function refreshStatus() {
  try { statusData = await fetch('/api/status').then(r => r.json()); } catch {}
}

async function refreshLog() {
  try { logData = await fetch('/api/log?n=300').then(r => r.json()); } catch {}
}

async function tick() {
  await Promise.all([refreshOrch(), refreshStatus(), refreshLog()]);
  renderColonyBar();
  renderBots();
  renderPanel();
  renderStorages();
  renderIntel();
  renderLog();
  document.getElementById('refresh-ts').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

// ── Init ───────────────────────────────────────────────────────────────────
document.getElementById('cmd').addEventListener('keydown', e => { if (e.key==='Enter') sendCmd(); });
['filter-info','filter-warn','filter-error'].forEach(id =>
  document.getElementById(id).addEventListener('change', renderLog));

tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
