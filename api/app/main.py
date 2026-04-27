from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
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
    VaultItem,
    generate_id,
    serialize_artifact,
    serialize_chat_message,
    serialize_node_execution,
    serialize_project,
    serialize_run,
    serialize_run_event,
    serialize_template,
    serialize_user,
    serialize_vault_item,
    utcnow,
)
from app.services import StorageService, WorkflowService, validate_template_config
from app.templates_seed import SEED_TEMPLATES

logger = logging.getLogger("flowpro.api")

app = FastAPI(title="FlowPro API", version="0.1.0")
storage_service = StorageService()
workflow_service = WorkflowService()


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Log full traceback for any unhandled exception and return a JSON envelope
    with the exception type + message so the frontend can surface something
    actionable instead of a bare 'Internal Server Error'."""
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "detail": f"{type(exc).__name__}: {exc}",
            "path": request.url.path,
            "method": request.method,
        },
    )


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


class VaultUploadUrlRequest(BaseModel):
    name: str
    mime_type: str
    folder: str = "/"


class VaultConfirmUploadRequest(BaseModel):
    item_id: str
    name: str
    mime_type: str
    size_bytes: int
    folder: str = "/"
    notes: str = ""


class VaultFromArtifactRequest(BaseModel):
    artifact_id: str
    name: str | None = None
    folder: str = "/"
    notes: str = ""


class VaultUpdateRequest(BaseModel):
    name: str | None = None
    folder: str | None = None
    notes: str | None = None


class MessageCreateRequest(BaseModel):
    role: Literal["user", "assistant", "system"] = "user"
    content: str


class RunCreateRequest(BaseModel):
    input_message: str


class RunUpdateRequest(BaseModel):
    stop_after_node_id: str | None = None


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
async def health() -> dict[str, Any]:
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
async def health_db(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    try:
        await db.execute(text("SELECT 1"))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database unavailable: {exc}") from exc
    return {"ok": True, "database": "connected"}


@app.get("/health/redis")
async def health_redis() -> dict[str, Any]:
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
async def health_r2() -> dict[str, Any]:
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
    return {
        **serialize_user(current_user),
        "mock_ai_enabled": bool(settings.mock_ai),
        "openrouter_configured": bool(settings.openrouter_api_key),
    }


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
    cascade_vault: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delete a project, all its R2 objects, and optionally any Vault items
    copied from this project.

    - cascade_vault=false (default): Vault items survive, but their
      `source_project_id` will dangle (refers to a deleted project).
    - cascade_vault=true: Vault items where source_project_id matches this
      project get their R2 objects + DB rows removed too. Other Vault items
      are untouched.

    Crucially the cascade only touches items the caller owns AND whose
    source_project_id matches — no other vault rows are affected.
    """
    project = await get_project_for_user(db, project_id, current_user.id)

    deleted_vault_items = 0
    vault_storage_warnings: list[str] = []
    if cascade_vault:
        result = await db.execute(
            select(VaultItem).where(
                VaultItem.user_id == current_user.id,
                VaultItem.source_project_id == project_id,
            )
        )
        items = list(result.scalars().all())
        for item in items:
            try:
                await storage_service.delete_vault_object(item.storage_key)
            except Exception as exc:
                vault_storage_warnings.append(f"{item.id}: {exc}")
            await db.delete(item)
            deleted_vault_items += 1
        if items:
            await db.flush()

    # Wipe the R2 tree first so we don't leak storage. The DB rows (runs,
    # node_executions, run_events, chat_messages, artifacts) cascade via FKs
    # when the project row is deleted.
    deleted_objects = 0
    storage_warning: str | None = None
    try:
        deleted_objects = await storage_service.delete_project_tree(project)
    except Exception as exc:
        storage_warning = f"Project storage cleanup partial: {exc}"

    await db.delete(project)
    await db.commit()

    response: dict = {
        "deleted": True,
        "project_id": project_id,
        "deleted_objects": deleted_objects,
        "deleted_vault_items": deleted_vault_items,
    }
    if storage_warning:
        response["storage_warning"] = storage_warning
    if vault_storage_warnings:
        response["vault_storage_warnings"] = vault_storage_warnings
    return response


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
    run_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Return chat messages for the project. Pass `run_id` to scope the
    thread to a single run (the user's request + that run's system/assistant
    messages) — the workspace uses this so the chat reflects the selected run
    instead of mixing every run's history into one stream."""
    await get_project_for_user(db, project_id, current_user.id)
    statement = select(ChatMessage).where(ChatMessage.project_id == project_id)
    if run_id:
        statement = statement.where(ChatMessage.run_id == run_id)
    statement = statement.order_by(ChatMessage.created_at)
    result = await db.execute(statement)
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
    execution_result = await db.execute(select(NodeExecution).where(NodeExecution.run_id == run.id).order_by(NodeExecution.order_index, NodeExecution.node_id))

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
    result = await db.execute(select(NodeExecution).where(NodeExecution.run_id == run.id).order_by(NodeExecution.order_index, NodeExecution.node_id))
    return [serialize_node_execution(item) for item in result.scalars().all()]


@app.patch("/runs/{run_id}")
async def update_run(
    run_id: str,
    payload: RunUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Set or clear the stop point. Set stop_after_node_id to a node_id to
    pause the run after that node completes. Pass null/empty to clear."""
    run = await db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found.")
    await get_project_for_user(db, run.project_id, current_user.id)
    run.stop_after_node_id = payload.stop_after_node_id or None
    run.updated_at = utcnow()
    await db.commit()
    return serialize_run(run)


@app.post("/runs/{run_id}/continue")
async def continue_run(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Clear the stop point on a paused run and re-queue it. The worker's
    execute_run is resumable — it skips already-completed nodes and picks up
    where the stop happened."""
    run = await db.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found.")
    await get_project_for_user(db, run.project_id, current_user.id)
    if run.status not in {"paused", "queued"}:
        raise HTTPException(
            status_code=400,
            detail=f"Run is in status '{run.status}'. Only paused/queued runs can be continued.",
        )
    run.stop_after_node_id = None
    run.status = "queued"
    run.updated_at = utcnow()
    await db.commit()
    await workflow_service.queue_run(run.id)
    return serialize_run(run)


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


# ---------------------------------------------------------------------------
# Vault — per-user permanent storage that survives project deletion.
# Files live at vault/{user_id}/{vault_item_id} in R2; rename/move is a pure
# DB update because the storage key is opaque.
# ---------------------------------------------------------------------------


@app.get("/vault")
async def list_vault_items(
    folder: str | None = Query(default=None),
    search: str | None = Query(default=None),
    source_project_id: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    statement = select(VaultItem).where(VaultItem.user_id == current_user.id)
    if folder:
        normalized = storage_service.normalize_vault_folder(folder)
        statement = statement.where(VaultItem.folder == normalized)
    if search:
        like = f"%{search.strip()}%"
        statement = statement.where(VaultItem.name.ilike(like))
    if source_project_id:
        # Used by the delete-project modal to enumerate vault items copied
        # from a specific project so the user can opt-in to cascading delete.
        statement = statement.where(VaultItem.source_project_id == source_project_id)
    statement = statement.order_by(desc(VaultItem.created_at))
    result = await db.execute(statement)
    return [serialize_vault_item(item) for item in result.scalars().all()]


@app.get("/vault/folders")
async def list_vault_folders(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Returns the set of distinct virtual folders this user has used so the
    UI can render a folder tree."""
    result = await db.execute(
        select(VaultItem.folder).where(VaultItem.user_id == current_user.id).distinct()
    )
    folders = sorted({row[0] or "/" for row in result.all()})
    if "/" not in folders:
        folders.insert(0, "/")
    return {"folders": folders}


@app.post("/vault/upload-url")
async def vault_upload_url(
    payload: VaultUploadUrlRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Reserve a vault item id, return a presigned PUT URL keyed by that id."""
    item_id = generate_id("vlt")
    storage_key = storage_service.vault_storage_key(current_user.id, item_id)
    upload_url = await storage_service.get_vault_signed_upload_url(storage_key, payload.mime_type)
    return {
        "upload_url": upload_url,
        "item_id": item_id,
        "storage_key": storage_key,
    }


@app.post("/vault/confirm-upload")
async def vault_confirm_upload(
    payload: VaultConfirmUploadRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    storage_key = storage_service.vault_storage_key(current_user.id, payload.item_id)
    try:
        metadata = await storage_service.get_vault_object_metadata(storage_key)
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Uploaded vault object not found in R2: {exc}"
        ) from exc

    folder = storage_service.normalize_vault_folder(payload.folder)
    item = VaultItem(
        id=payload.item_id,
        user_id=current_user.id,
        name=payload.name.strip() or "untitled",
        folder=folder,
        storage_key=storage_key,
        mime_type=payload.mime_type,
        size_bytes=int(metadata.get("ContentLength", payload.size_bytes)),
        notes=payload.notes,
    )
    db.add(item)
    await db.commit()
    return serialize_vault_item(item)


@app.post("/vault/from-artifact")
async def vault_from_artifact(
    payload: VaultFromArtifactRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Server-side copy a project artifact into the user's vault."""
    artifact = await db.get(Artifact, payload.artifact_id)
    if not artifact or artifact.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Artifact not found.")
    project = await get_project_for_user(db, artifact.project_id, current_user.id)

    item_id = generate_id("vlt")
    storage_key = storage_service.vault_storage_key(current_user.id, item_id)
    size = await storage_service.copy_artifact_to_vault(project, artifact, storage_key)

    item = VaultItem(
        id=item_id,
        user_id=current_user.id,
        name=(payload.name or artifact.filename).strip() or artifact.filename,
        folder=storage_service.normalize_vault_folder(payload.folder),
        storage_key=storage_key,
        mime_type=artifact.mime_type,
        size_bytes=size,
        source_project_id=artifact.project_id,
        source_run_id=artifact.run_id,
        source_artifact_id=artifact.id,
        notes=payload.notes,
    )
    db.add(item)
    await db.commit()
    return serialize_vault_item(item)


@app.get("/vault/{item_id}")
async def get_vault_item(
    item_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.get(VaultItem, item_id)
    if not item or item.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Vault item not found.")
    return serialize_vault_item(item)


@app.get("/vault/{item_id}/download-url")
async def vault_download_url(
    item_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.get(VaultItem, item_id)
    if not item or item.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Vault item not found.")
    url = await storage_service.get_vault_signed_download_url(item.storage_key)
    return {"download_url": url}


@app.get("/vault/{item_id}/content")
async def vault_content(
    item_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    item = await db.get(VaultItem, item_id)
    if not item or item.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Vault item not found.")
    content = await storage_service.read_vault_object(item.storage_key)
    return Response(
        content=content,
        media_type=item.mime_type,
        headers={"Content-Disposition": f'inline; filename="{item.name}"'},
    )


@app.patch("/vault/{item_id}")
async def update_vault_item(
    item_id: str,
    payload: VaultUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.get(VaultItem, item_id)
    if not item or item.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Vault item not found.")
    if payload.name is not None:
        cleaned = payload.name.strip()
        if not cleaned:
            raise HTTPException(status_code=400, detail="Name cannot be empty.")
        item.name = cleaned
    if payload.folder is not None:
        item.folder = storage_service.normalize_vault_folder(payload.folder)
    if payload.notes is not None:
        item.notes = payload.notes
    item.updated_at = utcnow()
    await db.commit()
    return serialize_vault_item(item)


@app.delete("/vault/{item_id}")
async def delete_vault_item(
    item_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.get(VaultItem, item_id)
    if not item or item.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Vault item not found.")
    try:
        await storage_service.delete_vault_object(item.storage_key)
    except Exception as exc:
        # Don't block DB cleanup if R2 delete fails (object may already be gone).
        await db.delete(item)
        await db.commit()
        return {"deleted": True, "item_id": item_id, "storage_warning": str(exc)}
    await db.delete(item)
    await db.commit()
    return {"deleted": True, "item_id": item_id}
