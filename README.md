# AnImation

A web app with a **React + Vite + TypeScript** frontend and a **FastAPI (Python)** backend.

## Project layout

```
AnImation/
├── frontend/        # React + Vite + TypeScript (UI)
├── backend/         # FastAPI app managed with uv
├── docs/            # Documentation
├── agents/          # AI agent configs and related files
└── CLAUDE.md        # Agent / skill routing guidance
```

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ and npm
- [uv](https://docs.astral.sh/uv/) (Python package/runtime manager)

## Getting started

Run the backend and frontend in two separate terminals.

### Backend (FastAPI)

```bash
cd backend
uv run fastapi dev main.py
```

API runs at http://localhost:8000 — interactive docs at http://localhost:8000/docs.

### Frontend (Vite)

```bash
cd frontend
npm install
npm run dev
```

App runs at http://localhost:5173. Requests to `/api/*` are proxied to the
backend (configured in `frontend/vite.config.ts`), so no CORS setup is needed
in development.

## API endpoints

- `GET /api/health` — health check
- `GET /api/hello` — sample greeting consumed by the frontend
