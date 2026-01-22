# Privacy Policy — AI-First Task Manager Demo

Last updated: 2026-01-22

This project is a demo “AI-first” task manager. It provides an API that a Custom GPT can call to create, update, list, snooze, complete, and rank tasks. Tasks are stored in Google Sheets.

## What data we process
When you interact with the GPT, we may process:
- Task content you provide (e.g., title, notes, priority, due dates, tags, contexts).
- Requests needed to perform task operations (e.g., “create task”, “list tasks”).
- Basic metadata for reliability and debugging (e.g., timestamps, route called, success/failure).

## Where your data goes
To operate the system, data may be sent to:
- **OpenAI / ChatGPT** (the conversational interface you use).
- **Cloudflare Workers** (a lightweight proxy that forwards requests and normalizes responses).
- **Google Apps Script** (the backend logic/API).
- **Google Sheets** (the system of record where tasks are stored).

## What we store
- **Tasks** are stored as rows in a Google Sheet (title, notes, status, priority, timestamps, etc.).
- **Idempotency records** may be stored to prevent duplicate writes on retries.
- **Request logs** may be stored (e.g., timestamp, endpoint/route, duration, and minimal request/response info) to troubleshoot issues.

## Why we use a proxy
Cloudflare Workers is used as a transport/compatibility layer to provide stable API behavior for the GPT (e.g., following redirects and returning minimal headers). No task business logic is executed in the proxy.

## Data retention
- Tasks remain in the Google Sheet until removed by the owner of the sheet.
- Logs may be periodically cleared and are kept only as needed for debugging.

## Data sharing
We do not sell your data. Data is shared only with the service providers needed to run this demo (OpenAI, Cloudflare, Google).

## Security note
This is a demo system. Do not use it for sensitive personal data, secrets, financial information, or regulated data.

## Contact / deletion requests
If you want data removed from the Google Sheet used by this demo, contact:
- Name: Alberto Popescu
- Email: alberto-alive@outlook.com
