# Task Manager Application
Ai-First Task Manager: Custom GPT + Google Sheets + Apps Script (+ Cloudflare proxy)



### Background
The app is an AI-first task manager where:
- the UI is a Custom GPT (frontend)
- tasks live in Google Sheets (db)
- Apps Script provides the API (backend)
- cloudflare worker to normalizes GAS HTTP responses (proxy)

### Architecture
User → Custom GPT (Actions) → Cloudflare Worker (proxy) → GAS Web App → Google Sheets

## Requirements mapping
- **Minimal Sheet model:**
The task asks for one spreadsheet with three tabs:
* Tasks: The following set of fields meet the required behaviours the assessment asks for, including identity&content (id, title, notes), state (status, priority), time gating (scheduled_for, snoozed_until), urgency (due_at), and timestamps (created_at, updated_at, completed_at).
* Idempotency: basic fields (key - UI, endpoint -what was called, created_at - when was called); request_hash - prevents a key collision when the same idempotency key is used but the request differs (deterministically computed from payload); response_json - to returns the actual response (success response json or the error response : both currently stored)
- **Sane endpoint set + contracts:**
Based on the **Task Requirements** I separated the API into three categories:
* Read: to get the task state from the Sheet (list, get)
* Write: operation that mutates tasks and persists it (create, update, complete, snooze)
* Compute: this reads and applies rules (derived from task state plus time/locale context) server side to return deterministic explainable recommendations 
- **Deterministic relevance (“best task right now”):**
For “what should be my next task right now?” I added a compute endpoint (POST /tasks/next). It first filters out anything not eligible right now: only ACTIVE tasks, not snoozed into the future, and not scheduled in the future. Then it ranks what’s left in a deterministic, explainable way (urgency/overdue + due date, then priority, plus simple context matching), so given the same sheet state + time it will always pick the same result. I also return the top candidates with score/explain fields so it’s easy to see why a task was chosen.
- **Time/locale + validation + idempotency + observability:** 
Time/locale is handled with ISO datetimes plus an optional IANA timezone. The backend derives simple tokens like weekday/weekend and morning/afternoon/evening, and uses those for context matching in /tasks/next. All endpoints do server-side validation (required fields, datetime parsing, priority 1–5) and return structured errors when something is wrong. Write ops accept an idempotency_key so retries don’t create duplicates or apply updates twice (cached response is returned for the same key+endpoint+request_hash). Every call (success or error) is logged to the Logs tab with request_id, duration, ok/error_code, and compact request/response JSON so debugging and the screen-recording demo are straightforward.

### Encountered issues
Issue 1: When the Apps script was called with extra path segments (e.g. /exec/tasks/list) from an anonymous/incognito client, Google would redirect to the login page. One "solution" was allowing backend to support routing via a route parameter (/exec?route=tasks/list for GET and { "route": "tasks/create" } for POST).
Issue 2: Actions “ResponseTooLarge” despite small body → added Worker proxy to normalize headers/redirects.
Decision: The Cloudflare proxy exposes clean REST paths; GAS keeps logic + Sheets persistence.

### Data model (Google Sheets)
One Google Spreadsheet with 3 tabs:
- **Tasks** (system of record): one row per task  
  Key columns: `id`, `title`, `notes`, `status` (ACTIVE/COMPLETED), `priority`, `due_at`, `scheduled_for`, `snoozed_until`, `tags`, `contexts`, `created_at`, `updated_at`, `completed_at`.
- **Idempotency** (dedupe retries): stores previously-seen write requests so client retries don’t create duplicates  
  Key columns: `key` (idempotency_key), `endpoint`, `request_hash`, `response_json`, `created_at`.
- **Logs** (observability): one row per API request for debugging and demo/audit  
  Key columns: `ts`, `request_id`, `method`, `path`, `duration_ms`, `ok`, `error_code`, `request_json`, `response_json`.


### API Reference (used by Custom GPT Actions)

## Base URL: PROXY_URL (see Submission links / set in openapi.yaml servers.url)
# Health
GET /health
Returns service status.

# List tasks
GET /tasks/list
Query parameters:
- **limit** (int, optional, default 25, max 100) — max number of tasks returned
- *status* (string, optional: ACTIVE | COMPLETED) — filter by status
- **include_completed** (bool, optional, default false) — must be true when requesting completed tasks
- **q** (string, optional) — search string (filters by title; notes only if you implement include_notes behavior)

```bash
curl -s "PROXY_URL/tasks/list?limit=10&status=ACTIVE"
```

# Get task details
GET /tasks/get
Query parameters:
- **id** (string, required) — task id
- **include_notes** (bool, optional, default false) — include notes if supported

```bash
curl -s "PROXY_URL/tasks/get?id=<TASK_ID>"
```

# Create task
POST /tasks/create
JSON body:
- **title** (string, required)
- **priority** (int 1–5, optional)
- **notes** (string, optional)
- **due_at**, **scheduled_for**, snoozed_until (ISO8601 string, optional)
-**tags**, **contexts** (string or string[], optional)
- **idempotency_key** (string - optional)

ex: 
```bash curl -s -X POST "PROXY_URL/tasks/create" \
  -H "Content-Type: application/json" \
  --data-binary '{"title":"Example task","priority":3}'
```


# Update task
POST /tasks/update
JSON body:
**id** (string, required)
**patch** (object, required) — fields to update
**idempotency_key** (string, optional)

```bash
curl -s -X POST "PROXY_URL/tasks/update" \
  -H "Content-Type: application/json" \
  --data-binary '{"id":"<TASK_ID>","patch":{"priority":5}}'
```


# Complete task
POST /tasks/complete
JSON:
**id** (string, required)
**idempotency_key** (string - optional)


# Snooze task
POST /tasks/snooze
JSON body:
*id* (string, required)
**until** (ISO8601 string, required)
**idempotency_key** (string, optional but recommended)


# Next task (deterministic recommendation)
POST /tasks/next
JSON body (optional):
**now** (ISO8601 string, optional)
**timezone** (IANA timezone string - optional)
**limit** (int - optional, default 3, max 5) — number of candidates returned

Example:

```bash
curl -s -X POST "PROXY_URL/tasks/next" \
  -H "Content-Type: application/json" \
  --data-binary '{"timezone":"Europe/Bucharest","limit":3}'
```
### “Next task” logic (deterministic rule)
*Determinism*: Next task selection is deterministic. We first filter tasks to only those eligible “right now” (status != COMPLETED, not snoozed until the future, and not scheduled in the future). We then rank remaining tasks by urgency: overdue tasks first, then earliest due date, then higher priority, with a stable tie-breaker (created_at/id) to ensure consistent results.

### Idempotency behavior
*Idempotency*: Write operations accept an idempotency_key. The backend stores (idempotency_key, endpoint, response_json) in the Idempotency sheet. If the same key is received again for the same endpoint, the server returns the previously stored response instead of executing the operation again, preventing duplicate tasks when clients retry requests.

### Logs 
*Observability* The backend writes one row per API request to the Logs sheet, including timestamp, request_id, route, duration_ms, success flag, and error_code. This makes it easy to debug Action calls and verify end-to-end behavior during the demo.

### Setup & Run
## Prerequisites
- Google account (Sheets + Apps Script)
- Cloudflare account (Workers)
- ChatGPT account with Custom GPT Actions enabled
- curl installed

## Step 1
# Create the Google Sheet (database)
1. Create a new Google Sheet.

2. Create 3 tabs named exactly:
- Tasks
- Idempotency
- Logs

3. Add headers in Row 1:
Tasks (A1):
```bash
id	title	notes	status	priority	due_at	scheduled_for	snoozed_until	contexts	tags	created_at	updated_at	completed_at
```

Idempotency (A1):
```bash
key	endpoint	request_hash	response_json	created_at
```

Logs (A1):
```bash
ts	request_id	method	path	duration_ms	ok	error_code	request_json	response_json
```

## Step 2 
# Apps Script backend (GAS)
1. In the Sheet: Extensions → Apps Script
2. Open Code.gs and paste the backend code.
3. Click Save.
4. Run the setup() function once:
    - Select function setup → click Run
    - Accept permissions

## Step 3
# Deploy GAS Web App
1. Apps Script: Deploy → New deployment
2. Select type: Web app
3. Set:
    - Execute as: Me
    - Who has access: Anyone
4. Click Deploy
5. Copy the Web App URL (ends with /exec), referred to as:

```bash
GAS_URL = https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec
```
## Step 4
# Cloudflare Worker proxy (public API for Actions)
1. Cloudflare dashboard: Workers & Pages → Create Worker
2. In Worker Settings → Variables and Secrets, add variable:
    - Name: GAS_URL
    - Value: the GAS /exec URL from step 3
3. Paste the Worker proxy code (path routing) and Deploy.
4. Copy the Worker base URL (e.g.):

```bash
PROXY_URL = https://<worker-name>.<subdomain>.workers.dev
```

## Step 5
# Configure Custom GPT Actions
1. Open GPT Builder → Configure → Actions
2. Paste the OpenAPI schema
3. Set:

```yaml
servers:
  - url: PROXY_URL
```
4. Save this GPT

## Step 6
# Testing

1. Health
```bash
curl -s "PROXY_URL/health"
```
2. Create a task
```bash
curl -s -X POST "PROXY_URL/tasks/create" \
  -H "Content-Type: application/json" \
  --data-binary '{"title":"Hello from curl","priority":3}'
```
3. List tasks
```bash
curl -s "PROXY_URL/tasks/list?limit=10"
```
### Demo

# ToDo Video:
[x] Create 2–3 tasks via GPT (one with due_at, one with scheduled_for, one normal)
[x] “List my active tasks” (GPT → endpoints → Sheet updates visible)
[x] “What should I do next right now?” (shows /tasks/next result)
[x] Start handling: set a task scheduled_for in the future; ask “what’s next?” and show it’s excluded
[x] Due handling: create one overdue task (due_at in past) and show it’s prioritized in “next”
[x] Snooze the current best task; ask “what’s next?” and show it disappears from results
[x] Complete a task; show it moves to completed and is excluded from “next”
[x] “Show my completed tasks” (or “List completed tasks”) and show it works
[x] Show Logs tab entries updating for each request
[x] Ambiguous: “Snooze the meeting task until tomorrow morning” when there are 2 “meeting” tasks → narrate: “I’ll list matches, ask which one, then apply snooze.”
[x] Ambiguous: “Set it to next week” (unclear date) → narrate: “I’ll ask for a specific day/time and timezone.”

### Limitations & Security
**Security** note (demo vs prod): Demo uses public endpoints (no auth) and only non-sensitive test data, as required by the assessment. In production I’d put auth at the edge (Cloudflare Worker enforcing an API key or OAuth/JWT), add rate limiting, and lock down the sheet (least-privilege sharing / service account access). I’d also avoid logging full payloads (redact/trim) to prevent leaking sensitive data.
**Ops** note: Apps Script has quotas/limits so for real usage I’d move the API to a proper backend (Cloud Run or Functions) and keep the worker as transport-only (routing/normalization) and the sheet as the source of truth or reporting layer.

We'll check for sensitive data.. Thank you!