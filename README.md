# FlowPro Phase 1

Railway-first internal AI document cockpit monorepo:

- `frontend`: Next.js workspace UI
- `api`: FastAPI API, auth, storage, run orchestration, SSE, health checks
- `worker`: Redis-backed workflow worker and PDF generation
- `postgres`: Railway Postgres
- `redis`: Railway Redis

## Railway deployment model

Use one Railway project with five services:

1. `frontend`
2. `api`
3. `worker`
4. `postgres`
5. `redis`

For the three code services, point each service at the repository root and set a service-specific `RAILWAY_DOCKERFILE_PATH`:

1. `frontend` -> `frontend/Dockerfile`
2. `api` -> `api/Dockerfile`
3. `worker` -> `worker/Dockerfile`

Recommended watch paths:

1. `frontend` -> `/frontend/**`
2. `api` -> `/api/**`
3. `worker` -> `/api/**` and `/worker/**`

Recommended health checks:

1. `frontend` -> `/health`
2. `api` -> `/health`
3. `worker` -> none

## Required Railway environment variables

Shared or service-scoped as appropriate:

- `DATABASE_URL`
- `REDIS_URL`
- `OPENROUTER_API_KEY`
- `MOCK_AI`
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_R2_BUCKET`
- `CLOUDFLARE_R2_ENDPOINT`
- `JWT_SECRET`
- `APP_BASE_URL`
- `FRONTEND_URL`
- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`

Frontend-only:

- `NEXT_PUBLIC_API_BASE_URL`

Recommended scoping:

1. `frontend`: `NEXT_PUBLIC_API_BASE_URL`
2. `api`: all backend variables above
3. `worker`: all backend variables above

## Bootstrap admin

On API startup, if the `users` table is empty and all three bootstrap variables are present, the API creates the first internal user once:

- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`

If users already exist, startup does nothing.

## Mock mode

Set `MOCK_AI=true` to test the full infrastructure path without OpenRouter. In mock mode, the workflow still produces:

- `working/intent.json`
- `working/requirements.json`
- `working/outline.md`
- `working/draft.md`
- `working/qa_report.json`
- `final/output.md`
- `final/output.pdf`

## Health endpoints

API:

- `GET /health`
- `GET /health/db`
- `GET /health/redis`
- `GET /health/r2`

Frontend:

- `GET /health`

## Railway test path

1. Deploy `postgres` and `redis`.
2. Deploy `api` with `MOCK_AI=true`.
3. Deploy `worker` with the same backend variables.
4. Deploy `frontend` with `NEXT_PUBLIC_API_BASE_URL` pointing to the Railway API URL.
5. Sign in with the bootstrap admin.
6. Create a project.
7. Upload a file and confirm it appears in Files.
8. Start a run and watch the Node Flow update live.
9. Confirm Data Inspector, Files, Output Viewer, and Logs update as artifacts are created.

## Local fallback

If you need a local smoke run while fixing code:

```bash
docker compose up --build
```
