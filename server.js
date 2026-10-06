/**
 * =============================================================================
 *  GOOGLE FLOW ADMIN DASHBOARD + AUTOMATION ENGINE
 * =============================================================================
 *  Single-file backend (Express + Socket.io + Puppeteer-Extra/Stealth)
 *
 *  Fitur:
 *   1. Dual Login System (Auto Google Login via Puppeteer, & Manual Cookie Injection)
 *   2. CCTV Live Monitoring (Page.startScreencast via CDP -> Socket.io)
 *   3. Bulk Generate Engine (up to 100 prompts, smart concurrency queue)
 *   4. Ekstraksi & Ekspor JSON metadata + media (mp4/mp3)
 *   5. REST API + Account Rotation (kuota & kesehatan cookie)
 *
 *  Deploy target: Railway.app (lihat Dockerfile & DEPLOY.md)
 * =============================================================================
 */

'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Server: SocketIOServer } = require('socket.io');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const { parse: parseCsv } = require('csv-parse/sync');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, 'sessions');
const OUTPUT_DIR = path.join(SESSIONS_DIR, 'output');
const ACCOUNTS_FILE = path.join(SESSIONS_DIR, 'accounts.json');
const TASKS_INDEX_FILE = path.join(OUTPUT_DIR, 'tasks_index.json');

const FLOW_URL = process.env.FLOW_URL || 'https://labs.google/fx/tools/flow';
const GOOGLE_LOGIN_URL = 'https://accounts.google.com/ServiceLogin?service=accountsettings&continue=https://myaccount.google.com/';

const CONCURRENCY = Math.max(1, Math.min(10, parseInt(process.env.CONCURRENCY || '2', 10)));
const GENERATION_TIMEOUT_MS = parseInt(process.env.GENERATION_TIMEOUT_MS || '240000', 10);
const DEFAULT_QUOTA = parseInt(process.env.DEFAULT_ACCOUNT_QUOTA || '100', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const HEADLESS = process.env.PUPPETEER_HEADLESS !== 'false';
const EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  '/usr/bin/chromium-browser';

// Selector map for the Flow UI. Google can change its DOM at any time, so every
// selector has multiple fallbacks and everything is overridable via env vars
// without touching the code.
const SELECTORS = {
  promptBox: (process.env.FLOW_PROMPT_SELECTOR || '').split('|').filter(Boolean).concat([
    'textarea[placeholder*="prompt" i]',
    'textarea[aria-label*="prompt" i]',
    'div[contenteditable="true"]',
    'textarea',
  ]),
  generateButton: (process.env.FLOW_GENERATE_BUTTON_SELECTOR || '').split('|').filter(Boolean).concat([
    'button[aria-label*="generate" i]',
    'button[aria-label*="create" i]',
    'button:has(span)',
  ]),
};

// -----------------------------------------------------------------------------
// BOOTSTRAP DIRECTORIES
// -----------------------------------------------------------------------------
for (const dir of [SESSIONS_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// -----------------------------------------------------------------------------
// APP / SERVER / SOCKET.IO
// -----------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' }, maxHttpBufferSize: 5e6 });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Simple token-gate for the admin API (set ADMIN_TOKEN env var on Railway).
app.use('/api', (req, res, next) => {
  if (!ADMIN_TOKEN) return next(); // auth disabled if no token configured
  if (req.path === '/health') return next();
  const token = req.header('x-admin-token') || req.query.token;
  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized: invalid x-admin-token' });
});

// -----------------------------------------------------------------------------
// STATE: ACCOUNTS
// -----------------------------------------------------------------------------
/**
 * Account shape:
 * {
 *   id, label, email, method: 'auto'|'cookie',
 *   cookiePath, status: 'idle'|'logging_in'|'logged_in'|'needs_manual'|'error'|'busy',
 *   health: 'healthy'|'warning'|'dead',
 *   quota: number, quotaUsed: number,
 *   lastUsed, createdAt, lastError
 * }
 */
let accounts = [];

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[accounts] failed to load, starting fresh:', e.message);
    accounts = [];
  }
}

function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  io.emit('accounts:update', publicAccounts());
}

function publicAccounts() {
  return accounts.map((a) => ({ ...a }));
}

function getAccount(id) {
  return accounts.find((a) => a.id === id);
}

function upsertAccount(acc) {
  const idx = accounts.findIndex((a) => a.id === acc.id);
  if (idx >= 0) accounts[idx] = { ...accounts[idx], ...acc };
  else accounts.push(acc);
  saveAccounts();
  return getAccount(acc.id);
}

/** Account rotation: pick healthiest account with the most remaining quota. */
function pickBestAccount(preferredId) {
  if (preferredId) {
    const acc = getAccount(preferredId);
    if (acc) return acc;
  }
  const candidates = accounts
    .filter((a) => a.status === 'logged_in' && a.health !== 'dead' && a.quota - a.quotaUsed > 0)
    .sort((a, b) => {
      const qa = a.quota - a.quotaUsed;
      const qb = b.quota - b.quotaUsed;
      if (qb !== qa) return qb - qa;
      return (a.lastUsed || 0) - (b.lastUsed || 0);
    });
  return candidates[0] || null;
}

loadAccounts();

// -----------------------------------------------------------------------------
// STATE: TASKS / BATCHES
// -----------------------------------------------------------------------------
const tasks = new Map(); // taskId -> task
const batches = new Map(); // batchId -> batch

function loadTasksIndex() {
  try {
    if (fs.existsSync(TASKS_INDEX_FILE)) {
      const data = JSON.parse(fs.readFileSync(TASKS_INDEX_FILE, 'utf-8'));
      (data.tasks || []).forEach((t) => tasks.set(t.id, t));
      (data.batches || []).forEach((b) => batches.set(b.id, b));
    }
  } catch (e) {
    console.error('[tasks] failed to load index:', e.message);
  }
}

let saveIndexTimer = null;
function saveTasksIndex() {
  clearTimeout(saveIndexTimer);
  saveIndexTimer = setTimeout(() => {
    const data = {
      tasks: Array.from(tasks.values()),
      batches: Array.from(batches.values()),
    };
    fs.writeFileSync(TASKS_INDEX_FILE, JSON.stringify(data, null, 2));
  }, 300);
}

loadTasksIndex();

function publicTask(t) {
  return t ? { ...t, metadata: undefined, _raw: undefined } : t;
}

function emitTaskUpdate(task) {
  io.emit('task:update', publicTask(task));
  if (task.batchId) {
    const batch = batches.get(task.batchId);
    if (batch) {
      const batchTasks = batch.taskIds.map((id) => tasks.get(id)).filter(Boolean);
      const completed = batchTasks.filter((t) => t.status === 'done' || t.status === 'error').length;
      const percent = Math.round((completed / batch.total) * 100);
      batch.completed = completed;
      batch.percent = percent;
      io.emit('bulk:progress', { batchId: batch.id, completed, total: batch.total, percent });
    }
  }
  saveTasksIndex();
}

// -----------------------------------------------------------------------------
// TASK QUEUE (concurrency-limited, prevents OOM on Railway free/hobby plans)
// -----------------------------------------------------------------------------
class TaskQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }
  push(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      this._next();
    });
  }
  _next() {
    if (this.running >= this.concurrency) return;
    const item = this.queue.shift();
    if (!item) return;
    this.running++;
    Promise.resolve()
      .then(() => item.taskFn())
      .then(item.resolve, item.reject)
      .finally(() => {
        this.running--;
        this._next();
      });
  }
  get stats() {
    return { running: this.running, waiting: this.queue.length, concurrency: this.concurrency };
  }
}
const queue = new TaskQueue(CONCURRENCY);
setInterval(() => io.emit('queue:stats', queue.stats), 2000);

// -----------------------------------------------------------------------------
// BROWSER MANAGER (single shared Chromium instance, multiple contexts)
// -----------------------------------------------------------------------------
let sharedBrowser = null;
const sessions = new Map(); // accountId -> { context, page, cdpSession, screencasting }

async function getBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  console.log('[browser] launching chromium:', EXECUTABLE_PATH);
  sharedBrowser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    executablePath: fs.existsSync(EXECUTABLE_PATH) ? EXECUTABLE_PATH : undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
    ],
    defaultViewport: { width: 1366, height: 768 },
  });
  sharedBrowser.on('disconnected', () => {
    console.warn('[browser] disconnected');
    sharedBrowser = null;
    sessions.clear();
  });
  return sharedBrowser;
}

async function getOrCreateSession(accountId) {
  let s = sessions.get(accountId);
  if (s && !s.page.isClosed()) return s;

  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  s = { context, page, cdpSession: null, screencasting: false, accountId };
  sessions.set(accountId, s);
  return s;
}

async function closeSession(accountId) {
  const s = sessions.get(accountId);
  if (!s) return;
  try {
    await stopScreencast(accountId);
    await s.context.close();
  } catch (e) {
    /* noop */
  }
  sessions.delete(accountId);
}

// --- Cookie normalization (supports Puppeteer / EditThisCookie / Cookie-Editor formats)
function normalizeCookies(raw) {
  let list = raw;
  if (!Array.isArray(list)) {
    if (raw && Array.isArray(raw.cookies)) list = raw.cookies;
    else throw new Error('Cookie JSON harus berupa array atau { cookies: [...] }');
  }
  return list.map((c) => {
    const cookie = {
      name: c.name,
      value: c.value,
      domain: c.domain || '.google.com',
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: c.secure !== undefined ? !!c.secure : true,
    };
    if (c.expirationDate) cookie.expires = Math.floor(c.expirationDate);
    else if (c.expires && c.expires > 0) cookie.expires = Math.floor(c.expires);
    if (c.sameSite) {
      const s = String(c.sameSite).toLowerCase();
      if (s === 'no_restriction' || s === 'none') cookie.sameSite = 'None';
      else if (s === 'lax') cookie.sameSite = 'Lax';
      else if (s === 'strict') cookie.sameSite = 'Strict';
    }
    return cookie;
  });
}

// -----------------------------------------------------------------------------
// CCTV SCREENCAST (CDP Page.startScreencast -> Socket.io)
// -----------------------------------------------------------------------------
async function startScreencast(accountId) {
  const s = await getOrCreateSession(accountId);
  if (s.screencasting) return;
  const client = await s.page.target().createCDPSession();
  s.cdpSession = client;
  s.screencasting = true;

  client.on('Page.screencastFrame', async (frame) => {
    io.to(`cctv:${accountId}`).emit('cctv:frame', {
      accountId,
      data: frame.data,
      ts: Date.now(),
    });
    try {
      await client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
    } catch (e) {
      /* session might already be gone */
    }
  });

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 55,
    maxWidth: 1024,
    maxHeight: 640,
    everyNthFrame: 1,
  });
  console.log(`[cctv] screencast started for ${accountId}`);
}

async function stopScreencast(accountId) {
  const s = sessions.get(accountId);
  if (!s || !s.screencasting || !s.cdpSession) return;
  try {
    await s.cdpSession.send('Page.stopScreencast');
  } catch (e) {
    /* noop */
  }
  s.screencasting = false;
}

// -----------------------------------------------------------------------------
// LOGIN ENGINE
// -----------------------------------------------------------------------------
async function autoLoginGoogle(accountId, email, password) {
  const acc = getAccount(accountId);
  upsertAccount({ ...acc, status: 'logging_in', lastError: null });
  const s = await getOrCreateSession(accountId);
  const page = s.page;
  await startScreencast(accountId);

  try {
    await page.goto(GOOGLE_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Email step
    const emailSel = 'input[type="email"]';
    await page.waitForSelector(emailSel, { timeout: 20000 });
    await page.type(emailSel, email, { delay: 40 });
    await Promise.all([
      page.keyboard.press('Enter'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    ]);
    await new Promise((r) => setTimeout(r, 1500));

    // Password step
    const passSel = 'input[type="password"]';
    await page.waitForSelector(passSel, { visible: true, timeout: 20000 });
    await page.type(passSel, password, { delay: 40 });
    await Promise.all([
      page.keyboard.press('Enter'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    ]);
    await new Promise((r) => setTimeout(r, 2500));

    const url = page.url();
    const blocked = /challenge|signin\/v2\/challenge|deniedsignin|captcha/i.test(url);
    if (blocked) {
      upsertAccount({
        ...getAccount(accountId),
        status: 'needs_manual',
        lastError: 'Terdeteksi 2FA/Captcha/Challenge. Selesaikan manual via CCTV remote-control.',
      });
      return { ok: false, needsManual: true, url };
    }

    // Verify login & extract cookies
    await page.goto('https://myaccount.google.com/', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    const cookies = await page.cookies();
    const cookiePath = path.join(SESSIONS_DIR, `acc_${accountId}.json`);
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));

    upsertAccount({
      ...getAccount(accountId),
      email,
      status: 'logged_in',
      health: 'healthy',
      cookiePath,
      lastUsed: Date.now(),
      lastError: null,
    });
    return { ok: true };
  } catch (err) {
    upsertAccount({ ...getAccount(accountId), status: 'error', health: 'warning', lastError: err.message });
    return { ok: false, error: err.message };
  }
}

async function manualCookieLogin(accountId, cookieJson) {
  const acc = getAccount(accountId);
  upsertAccount({ ...acc, status: 'logging_in', lastError: null });
  const s = await getOrCreateSession(accountId);
  const page = s.page;

  try {
    const cookies = normalizeCookies(cookieJson);
    await page.goto('https://google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.setCookie(...cookies);
    await page.goto(FLOW_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 1500));

    const title = await page.title().catch(() => '');
    const currentUrl = page.url();
    const loginRedirect = /accounts\.google\.com\/(ServiceLogin|signin)/i.test(currentUrl);

    const cookiePath = path.join(SESSIONS_DIR, `acc_${accountId}.json`);
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));

    if (loginRedirect) {
      upsertAccount({
        ...getAccount(accountId),
        status: 'error',
        health: 'dead',
        cookiePath,
        lastError: 'Cookie tidak valid / kedaluwarsa (redirect ke halaman login).',
      });
      return { ok: false, error: 'Cookie invalid/expired' };
    }

    upsertAccount({
      ...getAccount(accountId),
      status: 'logged_in',
      health: 'healthy',
      cookiePath,
      lastUsed: Date.now(),
      lastError: null,
    });
    return { ok: true, title };
  } catch (err) {
    upsertAccount({ ...getAccount(accountId), status: 'error', health: 'warning', lastError: err.message });
    return { ok: false, error: err.message };
  }
}

// -----------------------------------------------------------------------------
// FLOW GENERATION CORE (navigates UI, sniffs internal API responses, downloads media)
// -----------------------------------------------------------------------------
function extractMediaUrls(obj, out = new Set(), depth = 0) {
  if (!obj || depth > 6) return out;
  if (typeof obj === 'string') {
    if (/^https?:\/\/.*\.(mp4|mp3|wav|webm|m4a)(\?.*)?$/i.test(obj)) out.add(obj);
    else if (/googleusercontent\.com|googlevideo\.com/i.test(obj) && /^https?:\/\//i.test(obj)) out.add(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v) => extractMediaUrls(v, out, depth + 1));
    return out;
  }
  if (typeof obj === 'object') {
    Object.values(obj).forEach((v) => extractMediaUrls(v, out, depth + 1));
  }
  return out;
}

async function downloadMedia(page, url, destPath) {
  const cookies = await page.cookies(url).catch(() => []);
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const res = await fetch(url, { headers: { cookie: cookieHeader } });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buf);
  return destPath;
}

async function runGenerationTask(task) {
  task.status = 'running';
  task.startedAt = Date.now();
  task.progress = 5;
  emitTaskUpdate(task);

  const account = pickBestAccount(task.accountId);
  if (!account) {
    task.status = 'error';
    task.error = 'Tidak ada akun yang berstatus logged_in & memiliki kuota tersisa.';
    task.progress = 100;
    emitTaskUpdate(task);
    return task;
  }
  task.accountId = account.id;
  upsertAccount({ ...account, status: 'busy', lastUsed: Date.now() });

  const capturedResponses = [];
  const mediaUrls = new Set();
  let listener = null;

  try {
    const s = await getOrCreateSession(account.id);
    const page = s.page;
    if (!s.screencasting) await startScreencast(account.id);

    listener = async (response) => {
      try {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('application/json') && /flow|veo|labs\.google|generate|media/i.test(url)) {
          const json = await response.json().catch(() => null);
          if (json) {
            capturedResponses.push({ url, capturedAt: Date.now(), status: response.status(), data: json });
            extractMediaUrls(json).forEach((u) => mediaUrls.add(u));
          }
        }
      } catch (e) {
        /* ignore parse errors on non-json/streamed responses */
      }
    };
    page.on('response', listener);

    task.progress = 15;
    emitTaskUpdate(task);
    await page.goto(FLOW_URL, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    task.progress = 30;
    emitTaskUpdate(task);

    // Locate the prompt box using the fallback selector chain.
    let promptHandle = null;
    for (const sel of SELECTORS.promptBox) {
      promptHandle = await page.$(sel).catch(() => null);
      if (promptHandle) break;
    }
    if (!promptHandle) throw new Error('Prompt input tidak ditemukan di halaman Flow (DOM mungkin berubah).');

    await promptHandle.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.type(task.prompt, { delay: 15 });
    task.progress = 45;
    emitTaskUpdate(task);

    let genButton = null;
    for (const sel of SELECTORS.generateButton) {
      genButton = await page.$(sel).catch(() => null);
      if (genButton) break;
    }
    if (genButton) await genButton.click().catch(() => {});
    else await page.keyboard.press('Enter').catch(() => {});

    task.progress = 55;
    emitTaskUpdate(task);

    // Poll until a media URL is captured from network traffic, or timeout.
    const start = Date.now();
    while (Date.now() - start < GENERATION_TIMEOUT_MS) {
      if (mediaUrls.size > 0) break;
      await new Promise((r) => setTimeout(r, 3000));
      task.progress = Math.min(90, 55 + Math.round(((Date.now() - start) / GENERATION_TIMEOUT_MS) * 35));
      emitTaskUpdate(task);
    }

    page.off('response', listener);

    task.metadata = capturedResponses;
    task.mediaUrls = Array.from(mediaUrls);

    if (task.mediaUrls.length === 0) {
      task.status = 'error';
      task.error = 'Timeout / tidak ada media terdeteksi dari respons API Flow. Cek CCTV untuk debug.';
    } else {
      const files = [];
      for (let i = 0; i < task.mediaUrls.length; i++) {
        const u = task.mediaUrls[i];
        const ext = (u.match(/\.(mp4|mp3|wav|webm|m4a)(\?|$)/i) || [, 'mp4'])[1];
        const destName = `${task.id}_${i}.${ext}`;
        const dest = path.join(OUTPUT_DIR, destName);
        try {
          await downloadMedia(page, u, dest);
          files.push({ url: u, file: destName });
        } catch (e) {
          files.push({ url: u, error: e.message });
        }
      }
      task.mediaFiles = files;
      task.status = 'done';
    }

    // Persist metadata JSON for this task.
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${task.id}.json`),
      JSON.stringify(
        { id: task.id, prompt: task.prompt, accountId: task.accountId, metadata: task.metadata, mediaFiles: task.mediaFiles },
        null,
        2
      )
    );

    task.progress = 100;
    task.finishedAt = Date.now();
    upsertAccount({ ...getAccount(account.id), status: 'logged_in', quotaUsed: (getAccount(account.id).quotaUsed || 0) + 1 });
    emitTaskUpdate(task);
    return task;
  } catch (err) {
    if (listener) {
      try {
        (await getOrCreateSession(account.id)).page.off('response', listener);
      } catch (e) {}
    }
    task.status = 'error';
    task.error = err.message;
    task.progress = 100;
    task.finishedAt = Date.now();
    upsertAccount({ ...getAccount(account.id), status: 'logged_in' });
    emitTaskUpdate(task);
    return task;
  }
}

function createTask({ prompt, accountId, options, batchId }) {
  const task = {
    id: uuidv4(),
    batchId: batchId || null,
    prompt,
    options: options || {},
    accountId: accountId || null,
    status: 'queued',
    progress: 0,
    metadata: [],
    mediaUrls: [],
    mediaFiles: [],
    error: null,
    createdAt: Date.now(),
  };
  tasks.set(task.id, task);
  emitTaskUpdate(task);
  queue.push(() => runGenerationTask(task));
  return task;
}

// -----------------------------------------------------------------------------
// ROUTES: HEALTH
// -----------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), queue: queue.stats, accounts: accounts.length, tasks: tasks.size });
});

// -----------------------------------------------------------------------------
// ROUTES: ACCOUNTS
// -----------------------------------------------------------------------------
app.get('/api/v1/accounts', (req, res) => res.json({ ok: true, accounts: publicAccounts() }));

app.post('/api/v1/accounts', (req, res) => {
  const { label, email } = req.body;
  const acc = {
    id: uuidv4(),
    label: label || email || `account-${accounts.length + 1}`,
    email: email || '',
    method: null,
    cookiePath: null,
    status: 'idle',
    health: 'healthy',
    quota: DEFAULT_QUOTA,
    quotaUsed: 0,
    lastUsed: null,
    createdAt: Date.now(),
    lastError: null,
  };
  upsertAccount(acc);
  res.json({ ok: true, account: acc });
});

app.delete('/api/v1/accounts/:id', async (req, res) => {
  await closeSession(req.params.id);
  accounts = accounts.filter((a) => a.id !== req.params.id);
  saveAccounts();
  res.json({ ok: true });
});

// a) Auto Google login
app.post('/api/v1/accounts/:id/login/auto', async (req, res) => {
  let acc = getAccount(req.params.id);
  if (!acc) {
    acc = upsertAccount({
      id: req.params.id,
      label: req.body.email,
      email: req.body.email,
      method: 'auto',
      status: 'idle',
      health: 'healthy',
      quota: DEFAULT_QUOTA,
      quotaUsed: 0,
      createdAt: Date.now(),
    });
  }
  upsertAccount({ ...acc, method: 'auto' });
  const result = await autoLoginGoogle(req.params.id, req.body.email, req.body.password);
  res.json({ ok: result.ok, ...result });
});

// b) Manual cookie injection (JSON body or uploaded file)
app.post('/api/v1/accounts/:id/login/cookie', upload.single('cookieFile'), async (req, res) => {
  let acc = getAccount(req.params.id);
  if (!acc) {
    acc = upsertAccount({
      id: req.params.id,
      label: req.body.label || `cookie-account-${accounts.length + 1}`,
      email: req.body.email || '',
      method: 'cookie',
      status: 'idle',
      health: 'healthy',
      quota: DEFAULT_QUOTA,
      quotaUsed: 0,
      createdAt: Date.now(),
    });
  }
  upsertAccount({ ...acc, method: 'cookie' });

  try {
    let cookieJson;
    if (req.file) cookieJson = JSON.parse(req.file.buffer.toString('utf-8'));
    else if (req.body.cookies) cookieJson = typeof req.body.cookies === 'string' ? JSON.parse(req.body.cookies) : req.body.cookies;
    else return res.status(400).json({ ok: false, error: 'cookies (JSON) atau cookieFile wajib diisi' });

    const result = await manualCookieLogin(req.params.id, cookieJson);
    res.json({ ok: result.ok, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'JSON cookie tidak valid: ' + err.message });
  }
});

// Export cookie/session JSON directly from the dashboard table
app.get('/api/v1/accounts/:id/export-cookie', (req, res) => {
  const acc = getAccount(req.params.id);
  if (!acc || !acc.cookiePath || !fs.existsSync(acc.cookiePath)) {
    return res.status(404).json({ ok: false, error: 'Belum ada cookie/session tersimpan untuk akun ini.' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="acc_${acc.id}.json"`);
  res.setHeader('Content-Type', 'application/json');
  fs.createReadStream(acc.cookiePath).pipe(res);
});

// Remote-control input forwarded to the live Puppeteer page (for resolving 2FA/Cloudflare manually while watching CCTV)
app.post('/api/v1/cctv/:accountId/input', async (req, res) => {
  try {
    const s = await getOrCreateSession(req.params.accountId);
    const { type, x, y, text, key } = req.body;
    if (type === 'click') await s.page.mouse.click(x, y);
    else if (type === 'move') await s.page.mouse.move(x, y);
    else if (type === 'type') await s.page.keyboard.type(text, { delay: 20 });
    else if (type === 'key') await s.page.keyboard.press(key);
    else if (type === 'goto') await s.page.goto(text, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
    else return res.status(400).json({ ok: false, error: 'type tidak dikenal' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/v1/cctv/:accountId/start', async (req, res) => {
  try {
    await startScreencast(req.params.accountId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/v1/cctv/:accountId/stop', async (req, res) => {
  try {
    await stopScreencast(req.params.accountId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// ROUTES: FLOW GENERATE (single + bulk)
// -----------------------------------------------------------------------------
app.post('/api/v1/flow/generate', (req, res) => {
  const { prompt, accountId, options } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ ok: false, error: 'prompt wajib diisi' });
  const task = createTask({ prompt: prompt.trim(), accountId, options });
  res.json({ ok: true, taskId: task.id, task: publicTask(task) });
});

function parsePromptsFromUpload(file) {
  const content = file.buffer.toString('utf-8');
  if (file.originalname.endsWith('.json')) {
    const data = JSON.parse(content);
    if (Array.isArray(data)) return data.map((d) => (typeof d === 'string' ? d : d.prompt)).filter(Boolean);
    throw new Error('JSON harus berupa array string atau array {prompt}');
  }
  if (file.originalname.endsWith('.csv')) {
    const records = parseCsv(content, { columns: false, skip_empty_lines: true });
    return records.map((r) => r[0]).filter(Boolean);
  }
  // fallback: treat as plain text, one prompt per line
  return content.split('\n').map((l) => l.trim()).filter(Boolean);
}

app.post('/api/v1/flow/bulk-generate', upload.single('file'), (req, res) => {
  try {
    let prompts = [];
    if (req.file) {
      prompts = parsePromptsFromUpload(req.file);
    } else if (Array.isArray(req.body.prompts)) {
      prompts = req.body.prompts;
    } else if (typeof req.body.prompts === 'string') {
      prompts = req.body.prompts.split('\n');
    }
    prompts = prompts.map((p) => (p || '').trim()).filter(Boolean).slice(0, 100);

    if (prompts.length === 0) return res.status(400).json({ ok: false, error: 'Tidak ada prompt valid (maks 100).' });

    const accountId = req.body.accountId || null;
    const batchId = uuidv4();
    const taskIds = prompts.map((prompt) => createTask({ prompt, accountId, batchId }).id);

    batches.set(batchId, { id: batchId, taskIds, total: taskIds.length, completed: 0, percent: 0, createdAt: Date.now() });
    saveTasksIndex();

    res.json({ ok: true, batchId, total: taskIds.length, taskIds });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/v1/task/status/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ ok: false, error: 'task tidak ditemukan' });
  res.json({ ok: true, task });
});

app.get('/api/v1/task/list', (req, res) => {
  res.json({ ok: true, tasks: Array.from(tasks.values()), batches: Array.from(batches.values()) });
});

app.get('/api/v1/batch/:batchId', (req, res) => {
  const batch = batches.get(req.params.batchId);
  if (!batch) return res.status(404).json({ ok: false, error: 'batch tidak ditemukan' });
  const batchTasks = batch.taskIds.map((id) => tasks.get(id)).filter(Boolean);
  res.json({ ok: true, batch, tasks: batchTasks });
});

// -----------------------------------------------------------------------------
// ROUTES: EXPORT (metadata JSON & media zip)
// -----------------------------------------------------------------------------
app.get('/api/v1/task/export/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ ok: false, error: 'task tidak ditemukan' });
  res.setHeader('Content-Disposition', `attachment; filename="task_${task.id}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(task, null, 2));
});

app.get('/api/v1/task/export-all/json', (req, res) => {
  const all = Array.from(tasks.values());
  res.setHeader('Content-Disposition', 'attachment; filename="all_metadata.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(all, null, 2));
});

app.get('/api/v1/task/export-all/media', async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="all_media.zip"');
  res.setHeader('Content-Type', 'application/zip');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).end(String(err)));
  archive.pipe(res);

  for (const task of tasks.values()) {
    for (const f of task.mediaFiles || []) {
      const full = path.join(OUTPUT_DIR, f.file || '');
      if (f.file && fs.existsSync(full)) archive.file(full, { name: f.file });
    }
  }
  await archive.finalize();
});

// -----------------------------------------------------------------------------
// SOCKET.IO
// -----------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.emit('accounts:update', publicAccounts());
  socket.emit('queue:stats', queue.stats);

  socket.on('subscribe:cctv', async (accountId) => {
    socket.join(`cctv:${accountId}`);
    try {
      await startScreencast(accountId);
    } catch (e) {
      socket.emit('cctv:error', { accountId, error: e.message });
    }
  });

  socket.on('unsubscribe:cctv', (accountId) => {
    socket.leave(`cctv:${accountId}`);
  });
});

// -----------------------------------------------------------------------------
// GRACEFUL SHUTDOWN
// -----------------------------------------------------------------------------
async function shutdown() {
  console.log('Shutting down...');
  try {
    if (sharedBrowser) await sharedBrowser.close();
  } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// -----------------------------------------------------------------------------
// START
// -----------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(` Google Flow Admin Dashboard running on :${PORT}`);
  console.log(` Concurrency: ${CONCURRENCY} | Headless: ${HEADLESS}`);
  console.log(` Sessions dir: ${SESSIONS_DIR}`);
  console.log(`=================================================`);
});
