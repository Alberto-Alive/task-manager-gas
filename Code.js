/***************
 * Mindjo AI-First Task Manager - GAS Web App API
 * - No auth (per assessment)
 * - Google Sheet is system of record
 * - Deterministic "next task" relevance scoring
 * - Idempotency + basic logging
 ***************/

const SHEET_TASKS = 'Tasks';
const SHEET_IDEMPOTENCY = 'Idempotency';
const SHEET_LOGS = 'Logs';

const TASK_HEADERS = [
  'id','title','notes','status','priority','due_at','scheduled_for','snoozed_until',
  'contexts','tags','created_at','updated_at','completed_at'
];

const IDEMPOTENCY_HEADERS = ['key','endpoint','request_hash','response_json','created_at'];
const LOG_HEADERS = ['ts','request_id','method','path','duration_ms','ok','error_code','request_json','response_json'];

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_TASKS, TASK_HEADERS);
  ensureSheet_(ss, SHEET_IDEMPOTENCY, IDEMPOTENCY_HEADERS);
  ensureSheet_(ss, SHEET_LOGS, LOG_HEADERS);
}

function doGet(e) { return handle_(e, 'GET'); }
function doPost(e) { return handle_(e, 'POST'); }

function handle_(e, method) {
  const started = Date.now();
  const requestId = Utilities.getUuid();

  // Always initialize req first
  let req = {};

  // Parse request body/query
  try {
    if (method === 'POST') {
      const raw = e && e.postData && e.postData.contents;
      req = parseJson_(raw) || {};
    } else {
      req = (e && e.parameter) ? e.parameter : {};
    }
  } catch (err) {
    return respondAndLog_(
      started, requestId, method, '',
      req,
      error_('BAD_JSON', 'Invalid JSON body', { message: String(err) }, requestId)
    );
  }

  // IMPORTANT: compute route/path AFTER req is initialized
  const route =
    (e && e.parameter && (e.parameter.route || e.parameter.r)) ||
    (req && (req.route || req.r)) ||
    '';

  const path = normalizePath_(route || (e && e.pathInfo));

  try {
    // Router
    if (method === 'GET' && (path === '' || path === 'health')) {
      return respondAndLog_(
        started, requestId, method, path, req,
        ok_({ status: 'ok', now: new Date().toISOString(), version: 'route-v2' }, requestId)
      );
    }

    if (method === 'GET' && path === 'tasks/get')  return respondAndLog_(started, requestId, method, path, req, getTask_(req, requestId));
    if (method === 'GET' && path === 'tasks/list') return respondAndLog_(started, requestId, method, path, req, listTasks_(req, requestId));

    if (method === 'POST' && path === 'tasks/create')   return respondAndLog_(started, requestId, method, path, req, withIdempotency_(req, 'tasks/create', requestId, () => createTask_(req, requestId)));
    if (method === 'POST' && path === 'tasks/update')   return respondAndLog_(started, requestId, method, path, req, withIdempotency_(req, 'tasks/update', requestId, () => updateTask_(req, requestId)));
    if (method === 'POST' && path === 'tasks/complete') return respondAndLog_(started, requestId, method, path, req, withIdempotency_(req, 'tasks/complete', requestId, () => completeTask_(req, requestId)));
    if (method === 'POST' && path === 'tasks/snooze')   return respondAndLog_(started, requestId, method, path, req, withIdempotency_(req, 'tasks/snooze', requestId, () => snoozeTask_(req, requestId)));
    if (method === 'POST' && path === 'tasks/next')     return respondAndLog_(started, requestId, method, path, req, nextTask_(req, requestId));

    return respondAndLog_(
      started, requestId, method, path, req,
      error_('NOT_FOUND', `No route for ${method} ${path}`, { path, method }, requestId)
    );
  } catch (err) {
    return respondAndLog_(
      started, requestId, method, path, req,
      error_('INTERNAL', 'Unhandled server error', { message: String(err), stack: String(err && err.stack) }, requestId)
    );
  }
}


/****************
 * Endpoints
 ****************/

function createTask_(req, requestId) {
  const title = string_(req.title);
  if (!title) return error_('VALIDATION', 'title is required', { field: 'title' }, requestId);

  const now = new Date();
  const task = {
    id: Utilities.getUuid(),
    title,
    notes: string_(req.notes),
    status: 'ACTIVE',
    priority: clampInt_(req.priority, 1, 5, 3),
    due_at: toIsoOrBlank_(req.due_at),
    scheduled_for: toIsoOrBlank_(req.scheduled_for),
    snoozed_until: toIsoOrBlank_(req.snoozed_until),
    contexts: csv_(req.contexts),
    tags: csv_(req.tags),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    completed_at: ''
  };

  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    const { sheet, idx } = getTable_(SHEET_TASKS, TASK_HEADERS);
    sheet.appendRow(TASK_HEADERS.map(h => task[h] || ''));
    return ok_({ task }, requestId);
  } finally {
    lock.releaseLock();
  }
}

function updateTask_(req, requestId) {
  const taskId = string_(req.id);
  if (!taskId) return error_('VALIDATION', 'id is required', { field: 'id' }, requestId);

  const patch = req.patch || {};
  if (typeof patch !== 'object') return error_('VALIDATION', 'patch must be an object', { field: 'patch' }, requestId);

  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    const table = readTasksTable_();
    const rowIndex = table.rows.findIndex(r => r.id === taskId);
    if (rowIndex < 0) return error_('NOT_FOUND', 'Task not found', { id: taskId }, requestId);

    const t = table.rows[rowIndex];

    // Allowed fields to patch
    const allowed = ['title','notes','priority','due_at','scheduled_for','snoozed_until','contexts','tags','status'];
    allowed.forEach(k => {
      if (patch[k] === undefined) return;
      if (k === 'priority') t.priority = clampInt_(patch.priority, 1, 5, t.priority || 3);
      else if (k === 'due_at' || k === 'scheduled_for' || k === 'snoozed_until') t[k] = toIsoOrBlank_(patch[k]);
      else if (k === 'contexts' || k === 'tags') t[k] = csv_(patch[k]);
      else t[k] = string_(patch[k]);
    });

    t.updated_at = new Date().toISOString();
    // If status changed to COMPLETED, set completed_at (unless already set)
    if (t.status === 'COMPLETED' && !t.completed_at) t.completed_at = new Date().toISOString();
    if (t.status !== 'COMPLETED') t.completed_at = '';

    writeTaskRowById_(taskId, t, table);
    return ok_({ task: t }, requestId);
  } finally {
    lock.releaseLock();
  }
}

function completeTask_(req, requestId) {
  const taskId = string_(req.id);
  if (!taskId) return error_('VALIDATION', 'id is required', { field: 'id' }, requestId);

  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    const table = readTasksTable_();
    const rowIndex = table.rows.findIndex(r => r.id === taskId);
    if (rowIndex < 0) return error_('NOT_FOUND', 'Task not found', { id: taskId }, requestId);

    const t = table.rows[rowIndex];
    t.status = 'COMPLETED';
    t.completed_at = new Date().toISOString();
    t.updated_at = new Date().toISOString();

    writeTaskRowById_(taskId, t, table);
    return ok_({ task: t }, requestId);
  } finally {
    lock.releaseLock();
  }
}

function snoozeTask_(req, requestId) {
  const taskId = string_(req.id);
  const until = toIsoOrBlank_(req.until);
  if (!taskId) return error_('VALIDATION', 'id is required', { field: 'id' }, requestId);
  if (!until) return error_('VALIDATION', 'until is required (ISO8601)', { field: 'until' }, requestId);

  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    const table = readTasksTable_();
    const rowIndex = table.rows.findIndex(r => r.id === taskId);
    if (rowIndex < 0) return error_('NOT_FOUND', 'Task not found', { id: taskId }, requestId);

    const t = table.rows[rowIndex];
    if (t.status === 'COMPLETED') return error_('INVALID_STATE', 'Cannot snooze a completed task', { id: taskId }, requestId);

    t.snoozed_until = until;
    if (req.note) t.notes = [t.notes || '', `SNOOZED: ${string_(req.note)}`].filter(Boolean).join('\n');
    t.updated_at = new Date().toISOString();

    writeTaskRowById_(taskId, t, table);
    return ok_({ task: t }, requestId);
  } finally {
    lock.releaseLock();
  }
}

function getTask_(req, requestId) {
  const taskId = string_(req.id);
  if (!taskId) return error_('VALIDATION', 'id is required', { field: 'id' }, requestId);

  const table = readTasksTable_();
  const t = table.rows.find(r => r.id === taskId);
  if (!t) return error_('NOT_FOUND', 'Task not found', { id: taskId }, requestId);

  const includeNotes = truthy_(req.include_notes);
  if (!includeNotes) t.notes = '';
  if (includeNotes && t.notes && t.notes.length > 500) t.notes = t.notes.slice(0, 500) + '…(truncated)';


  return ok_({ task: t }, requestId);
}

function listTasks_(req, requestId) {
  const status = String(req.status || '').trim(); // e.g. ACTIVE or COMPLETED

  // FIX: if user requests COMPLETED explicitly, we must include completed
  const includeCompleted = truthy_(req.include_completed) || status === 'COMPLETED';
  const includeSnoozed = truthy_(req.include_snoozed);

  const limit = clampInt_(req.limit, 1, 100, 25);
  const q = String(req.q || '').toLowerCase();

  const now = new Date();
  const table = readTasksTable_();
  let tasks = table.rows.slice();

  if (status) tasks = tasks.filter(t => t.status === status);

  // Only apply this filter when we truly want to exclude completed
  if (!includeCompleted) tasks = tasks.filter(t => t.status !== 'COMPLETED');
  if (!includeSnoozed) tasks = tasks.filter(t => !isSnoozed_(t, now));

  if (q) tasks = tasks.filter(t => (t.title || '').toLowerCase().includes(q));

  tasks = tasks.slice(0, limit).map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    due_at: t.due_at
  }));

  return ok_({ tasks, count: tasks.length, limit }, requestId);
}



/**
 * Deterministic relevance: returns the best "next task right now"
 * Input:
 *  - now: ISO8601 (optional, default server time)
 *  - timezone: IANA tz (optional, default script tz)
 *  - limit: number of candidates to return (optional, default 3)
 */
function nextTask_(req, requestId) {
  const tz = string_(req.timezone) || Session.getScriptTimeZone();
  const now = req.now ? new Date(req.now) : new Date();
  if (isNaN(now.getTime())) return error_('VALIDATION', 'now must be a valid ISO8601 datetime', { field: 'now' }, requestId);

  const ctxTokens = computeContextTokens_(now, tz); // e.g. ['weekday','morning','weekday_morning']
  const limit = clampInt_(req.limit, 1, 10, 3);

  const table = readTasksTable_();
  const candidates = table.rows
    .filter(t => t.status === 'ACTIVE')
    .filter(t => !isScheduledInFuture_(t, now))
    .filter(t => !isSnoozed_(t, now));

  const scored = candidates.map(t => {
    const explain = scoreTask_(t, now, ctxTokens);
    return { task: t, score: explain.total, explain };
  }).sort((a,b) => b.score - a.score);

  const top = scored.slice(0, limit);
  const best = top.length ? top[0] : null;

  return ok_({
    now: now.toISOString(),
    timezone: tz,
    context_tokens: ctxTokens,
    best: best ? { task: best.task, score: best.score, explain: best.explain } : null,
    candidates: top
  }, requestId);
}

/****************
 * Relevance scoring (deterministic + explainable)
 ****************/

function scoreTask_(t, now, ctxTokens) {
  const priority = parseInt(t.priority, 10);
  const p = isNaN(priority) ? 3 : priority;

  // Priority weight
  const priorityScore = p * 10;

  // Due score
  let dueScore = 0;
  let dueMeta = null;
  if (t.due_at) {
    const due = new Date(t.due_at);
    if (!isNaN(due.getTime())) {
      const hours = (due.getTime() - now.getTime()) / 3600000;
      dueMeta = { hours_until_due: Number(hours.toFixed(2)) };
      if (hours < 0) dueScore = 120 + Math.min(80, Math.abs(hours));     // overdue => big boost
      else if (hours <= 24) dueScore = 60;
      else if (hours <= 72) dueScore = 25;
      else dueScore = 5;
    }
  }

  // Context score
  const taskCtx = parseCsv_(t.contexts);
  let ctxScore = 0;
  let ctxMeta = { task_contexts: taskCtx, matched: [] };

  if (taskCtx.length === 0 || taskCtx.includes('anytime')) {
    ctxScore = 5;
  } else {
    const matched = taskCtx.filter(x => ctxTokens.includes(x));
    ctxMeta.matched = matched;
    if (matched.length > 0) ctxScore = 25;
    else ctxScore = -10;
  }

  // Light tie-breakers: recently updated or created
  const recencyScore = recency_(t, now);

  const total = priorityScore + dueScore + ctxScore + recencyScore;

  return {
    total,
    components: {
      priorityScore,
      dueScore,
      contextScore: ctxScore,
      recencyScore
    },
    meta: {
      due: dueMeta,
      context: ctxMeta
    }
  };
}

function recency_(t, now) {
  const iso = t.updated_at || t.created_at;
  if (!iso) return 0;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  const hoursAgo = (now.getTime() - d.getTime()) / 3600000;
  if (hoursAgo <= 2) return 6;
  if (hoursAgo <= 24) return 3;
  return 0;
}

function computeContextTokens_(now, tz) {
  // Convert "now" into script-local tokens using formatting (weekday/weekend + part of day)
  const dayName = Utilities.formatDate(now, tz, 'u'); // 1=Mon .. 7=Sun
  const hourStr = Utilities.formatDate(now, tz, 'H'); // 0..23
  const day = parseInt(dayName, 10);
  const hour = parseInt(hourStr, 10);

  const weekday = (day >= 1 && day <= 5);
  const part =
    (hour >= 5 && hour < 12) ? 'morning' :
    (hour >= 12 && hour < 17) ? 'afternoon' :
    (hour >= 17 && hour < 22) ? 'evening' :
    'night';

  const tokens = [];
  tokens.push(weekday ? 'weekday' : 'weekend');
  tokens.push(part);
  tokens.push((weekday ? 'weekday' : 'weekend') + '_' + part);
  return tokens;
}

function isScheduledInFuture_(t, now) {
  if (!t.scheduled_for) return false;
  const d = new Date(t.scheduled_for);
  if (isNaN(d.getTime())) return false;
  return d.getTime() > now.getTime();
}

function isSnoozed_(t, now) {
  if (!t.snoozed_until) return false;
  const d = new Date(t.snoozed_until);
  if (isNaN(d.getTime())) return false;
  return d.getTime() > now.getTime();
}

/****************
 * Idempotency
 ****************/

function withIdempotency_(req, endpoint, requestId, fn) {
  const key = string_(req.idempotency_key);
  if (!key) return fn(); // optional

  const requestHash = hash_(JSON.stringify(req));

  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    const { sheet } = getTable_(SHEET_IDEMPOTENCY, IDEMPOTENCY_HEADERS);
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (String(row[0]) === key && String(row[1]) === endpoint && String(row[2]) === requestHash) {
        const cached = parseJson_(row[3]);
        if (cached) return cached;
      }
    }
    const resp = fn();
    // Cache only success + known validation errors (to avoid replay mutating twice)
    sheet.appendRow([key, endpoint, requestHash, JSON.stringify(resp), new Date().toISOString()]);
    return resp;
  } finally {
    lock.releaseLock();
  }
}

function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/****************
 * Table IO helpers
 ****************/

function readTasksTable_() {
  const { sheet } = getTable_(SHEET_TASKS, TASK_HEADERS);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { sheet, rows: [], headerMap: headerMap_(TASK_HEADERS) };

  const header = values[0].map(String);
  const map = headerMap_(header);

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const obj = {};
    header.forEach((h, c) => obj[h] = values[r][c] === null ? '' : String(values[r][c]));
    // Normalize a few fields
    obj.priority = obj.priority || '3';
    obj.status = obj.status || 'ACTIVE';
    rows.push(obj);
  }
  return { sheet, rows, headerMap: map, header };
}

function writeTaskRowById_(taskId, updatedTask, table) {
  const { sheet, header } = table;
  const values = sheet.getDataRange().getValues();
  const headerRow = values[0].map(String);
  const idCol = headerRow.indexOf('id');
  if (idCol < 0) throw new Error('Tasks sheet missing id column');

  let targetRow = -1;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === taskId) { targetRow = r + 1; break; } // 1-based rows
  }
  if (targetRow < 0) throw new Error('Task row not found (race?)');

  const rowVals = headerRow.map(h => updatedTask[h] || '');
  sheet.getRange(targetRow, 1, 1, rowVals.length).setValues([rowVals]);
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
  } else {
    const existing = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    // If headers mismatch, do not auto-destruct; just ensure at least the expected headers exist
    if (existing.join('\t') !== headers.join('\t')) {
      // Best-effort: overwrite row1 with expected headers (safe for assessment)
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }
  return sh;
}

function getTable_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, name, headers);
  const idx = headerMap_(headers);
  return { sheet, idx };
}

function headerMap_(headers) {
  const m = {};
  headers.forEach((h, i) => m[h] = i);
  return m;
}

/****************
 * Response + logging
 ****************/

function ok_(data, requestId) {
  return { ok: true, request_id: requestId, data };
}

function error_(code, message, details, requestId) {
  return { ok: false, request_id: requestId, error: { code, message, details: details || null } };
}

function respondAndLog_(started, requestId, method, path, req, resp) {
  const duration = Date.now() - started;
  log_(requestId, method, path, duration, resp && resp.ok, resp && resp.error && resp.error.code, req, resp);
  return ContentService
    .createTextOutput(JSON.stringify(resp))
    .setMimeType(ContentService.MimeType.JSON);
}

function log_(requestId, method, path, duration, ok, errorCode, req, resp) {
  try {
    const { sheet } = getTable_(SHEET_LOGS, LOG_HEADERS);
    sheet.appendRow([
      new Date().toISOString(),
      requestId,
      method,
      path,
      String(duration),
      ok ? 'true' : 'false',
      errorCode || '',
      JSON.stringify(req || {}),
      JSON.stringify(resp || {})
    ]);
  } catch (e) {
    // swallow logging errors
  }
}

/****************
 * Parsing + normalization helpers
 ****************/

function normalizePath_(pathInfo) {
  const p = (pathInfo || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return p;
}

function parseJson_(s) {
  if (!s) return null;
  return JSON.parse(s);
}

function string_(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function clampInt_(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function truthy_(v) {
  const s = String(v || '').toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function toIsoOrBlank_(v) {
  const s = string_(v);
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

function csv_(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean).join(',');
  return String(v).split(',').map(x => x.trim()).filter(Boolean).join(',');
}

function parseCsv_(s) {
  const v = string_(s);
  if (!v) return [];
  return v.split(',').map(x => x.trim()).filter(Boolean);
}
