from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, EmailStr
from redis.asyncio import from_url as redis_from_url
from sqlalchemy import desc, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import AsyncSessionLocal, get_db, init_db
from app.dependencies import auth_service, get_current_user, get_project_for_user
from app.models import (
    Artifact,
    ChatMessage,
    NodeExecution,
    Project,
    Run,
    RunEvent,
    Template,
    User,
    generate_id,
    serialize_artifact,
    serialize_chat_message,
    serialize_node_execution,
    serialize_project,
    serialize_run,
    serialize_run_event,
    serialize_template,
    serialize_user,
    utcnow,
)
from app.services import StorageService, WorkflowService, validate_template_config
from app.templates_seed import SEED_TEMPLATES

app = FastAPI(title="FlowPro API", version="0.1.0")
storage_service = StorageService()
workflow_service = WorkflowService()


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    name: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ProjectCreateRequest(BaseModel):
    name: str
    description: str = ""
    template_id: str | None = None


class ProjectUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    template_id: str | None = None


class TemplateCreateRequest(BaseModel):
    name: str
    description: str = ""
    config_json: dict
    slug: str | None = None


class TemplateUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    config_json: dict | None = None


class MessageCreateRequest(BaseModel):
    role: Literal["user", "assistant", "system"] = "user"
    content: str


class RunCreateRequest(BaseModel):
    input_message: str


class UploadUrlRequest(BaseModel):
    relative_path: str
    mime_type: str


class ConfirmUploadRequest(BaseModel):
    relative_path: str
    filename: str
    mime_type: str
    size_bytes: int


@app.on_event("startup")
async def startup() -> None:
    await init_db()
    async with AsyncSessionLocal() as session:
        existing_user = await session.execute(select(User.id).limit(1))
        has_users = existing_user.scalar_one_or_none() is not None
        if (not has_users and settings.bootstrap_admin_email and settings.bootstrap_admin_password and settings.bootstrap_admin_name):
            session.add(
                User(
                    id=generate_id("usr"),
                    email=settings.bootstrap_admin_email.lower(),
                    password_hash=auth_service.hash_password(settings.bootstrap_admin_password),
                    name=settings.bootstrap_admin_name.strip(),
                )
            )
            await session.commit()

        # Seed default templates if not present (idempotent by slug).
        for seed in SEED_TEMPLATES:
            existing = await session.execute(select(Template).where(Template.slug == seed["slug"]))
            current = existing.scalar_one_or_none()
            if current is None:
                session.add(
                    Template(
                        id=generate_id("tpl"),
                        slug=seed["slug"],
                        name=seed["name"],
                        description=seed["description"],
                        config_json=seed["config_json"],
                        is_seeded=True,
                    )
                )
            else:
                # Refresh seeded templates' config so updates ship via deploy.
                if current.is_seeded:
                    current.name = seed["name"]
                    current.description = seed["description"]
                    current.config_json = seed["config_json"]
                    current.updated_at = utcnow()
        await session.commit()

        # Backfill template_id for projects that pre-date the templates table.
        # Runs after seeding so the document_generator template definitely exists.
        await session.execute(
            text(
                "UPDATE projects SET template_id = (SELECT id FROM templates WHERE slug = 'document_generator' LIMIT 1) "
                "WHERE template_id IS NULL AND EXISTS (SELECT 1 FROM templates WHERE slug = 'document_generator')"
            )
        )
        await session.commit()


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"ok": True, "service": "api"}


@app.get("/model-profiles")
async def list_model_profiles(current_user: User = Depends(get_current_user)) -> dict:
    """Returns the model_profile -> [primary, fallback] mapping so the builder UI
    can show real OpenRouter model names instead of abstract profile slugs."""
    return {
        "profiles": [
            {
                "slug": slug,
                "primary": models[0] if len(models) > 0 else None,
                "fallback": models[1] if len(models) > 1 else None,
            }
            for slug, models in settings.model_profiles.items()
        ]
    }


# In-process cache for the OpenRouter models list. The list rarely changes; one
# hour is fine. Refreshed lazily on next request after expiry.
_OPENROUTER_MODELS_CACHE: dict[str, object] = {"data": None, "expires_at": 0.0}
_OPENROUTER_MODELS_TTL = 3600.0


@app.get("/openrouter-models")
async def list_openrouter_models(current_user: User = Depends(get_current_user)) -> dict:
    """Proxy + cache OpenRouter's public models list so the builder can show a
    searchable picker. Returns the OpenRouter response shape with `data`: list
    of {id, name, context_length, pricing, ...}."""
    now = time.monotonic()
    cached = _OPENROUTER_MODELS_CACHE.get("data")
    expires_at = float(_OPENROUTER_MODELS_CACHE.get("expires_at", 0.0))
    if cached is not None and now < expires_at:
        return {"data": cached, "cached": True}

    headers = {
        "Accept": "application/json",
        "User-Agent": "FlowPro/1.0 (+https://github.com/Balmung-/FlowPro)",
    }
    if settings.openrouter_api_key:
        # The /models endpoint is public, but sending a key never hurts and may
        # avoid rate-limit surprises.
        headers["Authorization"] = f"Bearer {settings.openrouter_api_key}"

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(
                "https://openrouter.ai/api/v1/models",
                headers=headers,
            )
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:
        # On error, fall back to whatever we cached previously (even if stale).
        detail = f"OpenRouter models fetch failed: {type(exc).__name__}: {exc}"
        if cached is not None:
            return {"data": cached, "cached": True, "stale": True, "error": detail}
        raise HTTPException(status_code=502, detail=detail) from exc

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        data = []

    _OPENROUTER_MODELS_CACHE["data"] = data
    _OPENROUTER_MODELS_CACHE["expires_at"] = now + _OPENROUTER_MODELS_TTL
    return {"data": data, "cached": False}


@app.get("/health/db")
async def health_db(db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    try:
        await db.execute(text("SELECT 1"))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database unavailable: {exc}") from exc
    return {"ok": True, "database": "connected"}


@app.get("/health/redis")
async def health_redis() -> dict[str, str]:
    redis = redis_from_url(settings.redis_url, decode_responses=True)
    try:
        try:
            await redis.ping()
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Redis unavailable: {exc}") from exc
    finally:
        await redis.close()
    return {"ok": True, "redis": "connected"}


@app.get("/health/r2")
async def health_r2() -> dict[str, str]:
    try:
        await storage_service.check_bucket_access()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"R2 unavailable: {exc}") from exc
    return {"ok": True, "r2": "connected", "bucket": settings.cloudflare_r2_bucket}


@app.post("/auth/register")
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)) -> dict:
    result = await db.execute(select(User).where(User.email == payload.email.lower()))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered.")

    user = User(
        id=generate_id("usr"),
        email=payload.email.lower(),
        password_hash=auth_service.hash_password(payload.password),
        name=payload.name.strip(),
    )
    db.add(user)
    await db.commit()
    return {"token": auth_service.issue_jwt(user.id), "user": serialize_user(user)}


@app.post("/auth/login")
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> dict:
    result = await db.execute(select(User).where(User.email == payload.email.lower()))
    user = result.scalar_one_or_none()
    if not user or not auth_service.verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials.")
    return {"token": auth_service.issue_jwt(user.id), "user": serialize_user(user)}


@app.get("/auth/me")
async def me(current_user: User = Depends(get_current_user)) -> dict:
    return serialize_user(current_user)


@app.get("/projects")
async def list_projects(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> list[dict]:
    result = await db.execute(select(Project).where(Project.user_id == current_user.id).order_by(desc(Project.updated_at)))
    return [serialize_project(project) for project in result.scalars().all()]


@app.post("/projects")
async def create_project(
    payload: ProjectCreateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    template_id = payload.template_id
    if template_id is None:
        # Default to seeded document_generator if available.
        result = await db.execute(select(Template).where(Template.slug == "document_generator"))
        seeded = result.scalar_one_or_none()
        template_id = seeded.id if seeded else None
    elif template_id:
        template = await db.get(Template, template_id)
        if template is None:
            raise HTTPException(status_code=400, detail="Template not found.")

    project_id = generate_id("proj")
    project = Project(
        id=project_id,
        user_id=current_user.id,
        template_id=template_id,
        name=payload.name.strip(),
        description=payload.description.strip(),
        r2_root_prefix=f"projects/{project_id}/",
    )
    db.add(project)
    await db.commit()
    return serialize_project(project)


@app.get("/projects/{project_id}")
async def get_project(
    project_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    project = await get_project_for_user(db, project_id, current_user.id)
    return serialize_project(project)


@app.patch("/projects/{project_id}")
async def update_project(
    project_id: str,
    payload: ProjectUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    project = await get_project_for_user(db, project_id, current_user.id)
    if payload.name is not None:
        project.name = payload.name.strip()
    if payload.description is not None:
        project.description = payload.description.strip()
    if payload.template_id is not None:
        if payload.template_id == "":
            project.template_id = None
        else:
            template = await db.get(Template, payload.template_id)
            if template is None:
                raise HTTPException(status_code=400, detail="Template not found.")
            project.template_id = payload.template_id
    project.updated_at = utcnow()
    await db.commit()
    return serialize_project(project)


@app.delete("/projects/{project_id}")
async def delete_project(
    project_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    project = await get_project_for_user(db, project_id, current_user.id)
    await db.delete(project)
    await db.commit()
    return {"deleted": True, "project_id": project_id}


# ---------------------------------------------------------------------------
# Templates
# Templates are global (visible to all authenticated users). Seeded templates
# are read-only at runtime — a fresh deploy refreshes their config from
# templates_seed.py. To customize a seeded template, clone it.
# ---------------------------------------------------------------------------


def _slugify(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "_" for ch in value).strip("_")
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    return cleaned or "template"


async def _ensure_unique_template_slug(db: AsyncSession, base: str) -> str:
    candidate = base
    suffix = 1
    while True:
        result = await db.execute(select(Template).where(Template.slug == candidate))
        if result.scalar_one_or_none() is None:
            return candidate
        suffix += 1
        candidate = f"{base}_{suffix}"


@app.get("/templates")
async def list_templates(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    result = await db.execute(select(Template).order_by(desc(Template.is_seeded), Template.name))
    return [serialize_template(template) for template in result.scalars().all()]


@app.post("/templates")
async def create_template(
    payload: TemplateCreateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Template name is required.")

    config = payload.config_json or {}
    # Ensure the persisted name matches the request name even if the user forgot to set it inside config_json.
    config.setdefault("name", name)
    validate_template_config(config)

    slug_base = _slugify(payload.slug or name)
    slug = await _ensure_unique_template_slug(db, slug_base)

    template = Template(
        id=generate_id("tpl"),
        slug=slug,
        name=name,
        description=payload.description.strip(),
        config_json=config,
        is_seeded=False,
    )
    db.add(template)
    await db.commit()
    return serialize_template(template)


@app.get("/templates/{template_id}")
async def get_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    template = await db.get(Template, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found.")
    return serialize_template(template)


@app.patch("/templates/{template_id}")
async def update_template(
    template_id: str,
    payload: TemplateUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    template = await db.get(Template, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found.")
    if template.is_seeded:
        raise HTTPException(
            status_code=400,
            detail="Seeded templates are read-only. Clone this template to customize it.",
        )

    if payload.name is not None:
        template.name = payload.name.strip()
    if payload.description is not None:
        template.description = payload.description.strip()
    if payload.config_json is not None:
        config = dict(payload.config_json)
        config.setdefault("name", template.name)
        validate_template_config(config)
        template.config_json = config
    template.updated_at = utcnow()
    await db.commit()
    return serialize_template(template)


@app.delete("/templates/{template_id}")
async def delete_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    template = await db.get(Template, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found.")
    if template.is_seeded:
        raise HTTPException(status_code=400, detail="Seeded templates cannot be deleted.")
    await db.delete(template)
    await db.commit()
    return {"deleted": True, "template_id": template_id}


@app.post("/templates/{template_id}/clone")
async def clone_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    source = await db.get(Template, template_id)
    if not source:
        raise HTTPException(status_code=404, detail="Template not found.")

    new_name = f"{source.name} (Copy)"
    config = dict(source.config_json or {})
    config["name"] = new_name

    slug = await _ensure_unique_template_slug(db, _slugify(new_name))

    clone = Template(
        id=generate_id("tpl"),
        slug=slug,
        name=new_name,
        description=source.description,
        config_json=config,
        is_seeded=False,
    )
    db.add(clone)
    await db.commit()
    return serialize_template(clone)


@app.get("/projects/{project_id}/messages")
async def list_messages(
    project_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await get_project_for_user(db, project_id, current_user.id)
    result = await db.execute(select(ChatMessage).where(ChatMessage.project_id == project_id).order_by(ChatMessage.created_at))
    return [serialize_chat_message(item) for item in result.scalars().all()]


@app.post("/projects/{project_id}/messages")
async def create_message(
    project_id: str,
    payload: MessageCreateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await get_project_for_user(db, project_id, current_user.id)
    message = ChatMessage(
        id=generate_id("msg"),
        project_id=project_id,
        role=payload.role,
        content=payload.content,
    )
    db.add(message)
    await db.commit()
    return serialize_chat_message(message)


@app.post("/projects/{project_id}/runs")
async def create_run(
    project_id: str,
    payload: RunCreateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    project = await get_project_for_user(db, project_id, current_user.id)
    run = await workflow_service.create_run(db, project, payload.input_message)
    await db.commit()
    await workflow_service.queue_run(run.id)
    return serialize_run(run)


@app.get("/projects/{project_id}/runs")
async def list_runs(
    project_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await get_project_for_user(db, project_id, current_user.id)
    result = await db.execute(select(Run).where(Run.project_id == project_id).order_by(desc(Run.created_at)))
    return [serialize_run(run) for run in result.scalars().all()]


@app.get("/runs/{run_id}")
async def get_run(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    run = await db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found.")
    await get_project_for_user(db, run.project_id, current_user.id)

    artifact_result = await db.execute(select(Artifact).where(Artifact.run_id == run.id, Artifact.deleted_at.is_(None)).order_by(Artifact.created_at))
    event_result = await db.execute(select(RunEvent).where(RunEvent.run_id == run.id).order_by(RunEvent.created_at))
    execution_result = await db.execute(select(NodeExecution).where(NodeExecution.run_id == run.id).order_by(NodeExecution.node_id))

    return {
        **serialize_run(run),
        "artifacts": [serialize_artifact(item) for item in artifact_result.scalars().all()],
        "events": [serialize_run_event(item) for item in event_result.scalars().all()],
        "node_executions": [serialize_node_execution(item) for item in execution_result.scalars().all()],
    }


@app.get("/runs/{run_id}/state")
async def get_run_state(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    run = await db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found.")
    await get_project_for_user(db, run.project_id, current_user.id)
    return {"run_id": run.id, "state_json": run.state_json or {}}


@app.get("/runs/{run_id}/node-executions")
async def get_node_executions(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    run = await db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found.")
    await get_project_for_user(db, run.project_id, current_user.id)
    result = await db.execute(select(NodeExecution).where(NodeExecution.run_id == run.id).order_by(NodeExecution.node_id))
    return [serialize_node_execution(item) for item in result.scalars().all()]


@app.get("/runs/{run_id}/events")
async def stream_run_events(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    run = await db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found.")
    await get_project_for_user(db, run.project_id, current_user.id)

    async def stream() -> AsyncIterator[str]:
        seen_event_ids: set[str] = set()
        keepalive_counter = 0
        yield "retry: 3000\n\n"
        while True:
            async with AsyncSessionLocal() as session:
                live_run = await session.get(Run, run_id)
                statement = select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.created_at)
                result = await session.execute(statement)
                events = result.scalars().all()
                emitted = False
                for event in events:
                    if event.id in seen_event_ids:
                        continue
                    seen_event_ids.add(event.id)
                    emitted = True
                    payload = json.dumps(serialize_run_event(event))
                    yield f"id: {event.id}\nevent: {event.event_type}\ndata: {payload}\n\n"
                if not emitted:
                    keepalive_counter += 1
                    if keepalive_counter >= 5:
                        keepalive_counter = 0
                        yield ": keepalive\n\n"
                else:
                    keepalive_counter = 0
                if live_run and live_run.status in {"completed", "failed", "cancelled"}:
                    break
            await asyncio.sleep(2)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/projects/{project_id}/files")
async def list_files(
    project_id: str,
    prefix: str = Query(default=""),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await get_project_for_user(db, project_id, current_user.id)
    artifacts = await storage_service.list_files(db, project_id, prefix)
    return [serialize_artifact(artifact) for artifact in artifacts]


@app.post("/projects/{project_id}/files/upload-url")
async def get_upload_url(
    project_id: str,
    payload: UploadUrlRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    project = await get_project_for_user(db, project_id, current_user.id)
    return {
        "upload_url": await storage_service.get_signed_upload_url(project, payload.relative_path, payload.mime_type),
        "relative_path": storage_service.validate_relative_path(payload.relative_path),
    }


@app.post("/projects/{project_id}/files/confirm-upload")
async def confirm_upload(
    project_id: str,
    payload: ConfirmUploadRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    project = await get_project_for_user(db, project_id, current_user.id)
    try:
        metadata = await storage_service.get_object_metadata(project, payload.relative_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Uploaded object not found in R2: {exc}") from exc
    artifact = await storage_service.create_artifact_record(
        db,
        project_id,
        payload.relative_path,
        payload.filename,
        payload.mime_type,
        int(metadata.get("ContentLength", payload.size_bytes)),
        "user",
    )
    await db.commit()
    return serialize_artifact(artifact)


@app.get("/projects/{project_id}/files/download-url")
async def get_download_url(
    project_id: str,
    path: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    project = await get_project_for_user(db, project_id, current_user.id)
    return {"download_url": await storage_service.get_signed_download_url(project, path)}


@app.delete("/projects/{project_id}/files")
async def delete_file(
    project_id: str,
    path: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    project = await get_project_for_user(db, project_id, current_user.id)
    artifact = await storage_service.delete_file(db, project, path)
    await db.commit()
    return {"deleted": True, "artifact": serialize_artifact(artifact)}


@app.get("/artifacts/{artifact_id}")
async def get_artifact(
    artifact_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    artifact = await db.get(Artifact, artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Artifact not found.")
    await get_project_for_user(db, artifact.project_id, current_user.id)
    return serialize_artifact(artifact)


@app.get("/artifacts/{artifact_id}/download-url")
async def get_artifact_download_url(
    artifact_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    artifact = await db.get(Artifact, artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Artifact not found.")
    project = await get_project_for_user(db, artifact.project_id, current_user.id)
    return {"download_url": await storage_service.get_signed_download_url(project, artifact.path)}


@app.get("/artifacts/{artifact_id}/content")
async def get_artifact_content(
    artifact_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    artifact = await db.get(Artifact, artifact_id)
    if not artifact or artifact.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Artifact not found.")
    project = await get_project_for_user(db, artifact.project_id, current_user.id)
    content = await storage_service.read_file(project, artifact.path)
    return Response(
        content=content,
        media_type=artifact.mime_type,
        headers={"Content-Disposition": f'inline; filename="{artifact.filename}"'},
    )


@app.delete("/artifacts/{artifact_id}")
async def delete_artifact(
    artifact_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    artifact = await db.get(Artifact, artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Artifact not found.")
    project = await get_project_for_user(db, artifact.project_id, current_user.id)
    deleted = await storage_service.delete_file(db, project, artifact.path)
    await db.commit()
    return {"deleted": True, "artifact": serialize_artifact(deleted)}
