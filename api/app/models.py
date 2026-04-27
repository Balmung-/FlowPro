from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def generate_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    template_id: Mapped[str | None] = mapped_column(ForeignKey("templates.id", ondelete="SET NULL"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    r2_root_prefix: Mapped[str] = mapped_column(String(255), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Template(Base):
    __tablename__ = "templates"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    config_json: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    is_seeded: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id", ondelete="SET NULL"), nullable=True, index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    input_message: Mapped[str] = mapped_column(Text)
    state_json: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Set to a node_id to instruct the worker to pause AFTER that node completes.
    # Cleared by the continue endpoint, which re-queues the run to resume from
    # the first non-completed node.
    stop_after_node_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class NodeExecution(Base):
    __tablename__ = "node_executions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    node_id: Mapped[str] = mapped_column(String(64), index=True)
    node_name: Mapped[str] = mapped_column(String(255))
    node_type: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="waiting")
    model_profile: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model_used: Mapped[str | None] = mapped_column(String(255), nullable=True)
    input_json: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    output_json: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    token_input: Mapped[int | None] = mapped_column(nullable=True)
    token_output: Mapped[int | None] = mapped_column(nullable=True)
    cost_estimate: Mapped[float | None] = mapped_column(Numeric(12, 6), nullable=True)


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id", ondelete="SET NULL"), nullable=True, index=True)
    node_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    path: Mapped[str] = mapped_column(String(1024), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(255))
    size_bytes: Mapped[int] = mapped_column()
    created_by: Mapped[str] = mapped_column(String(16))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RunEvent(Base):
    __tablename__ = "run_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    event_json: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class VaultItem(Base):
    """Permanent per-user file storage. Survives project deletion.

    R2 layout: ``vault/{user_id}/{vault_item_id}`` — keyed by opaque id so
    rename/move is a pure DB update, no R2 copy.
    """

    __tablename__ = "vault_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(512))
    folder: Mapped[str] = mapped_column(String(512), default="/")
    storage_key: Mapped[str] = mapped_column(String(1024), unique=True)
    mime_type: Mapped[str] = mapped_column(String(255))
    size_bytes: Mapped[int] = mapped_column()
    source_project_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_artifact_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


def serialize_user(user: User) -> dict[str, Any]:
    return {"id": user.id, "email": user.email, "name": user.name, "created_at": iso(user.created_at)}


def serialize_project(project: Project) -> dict[str, Any]:
    return {
        "id": project.id,
        "user_id": project.user_id,
        "template_id": project.template_id,
        "name": project.name,
        "description": project.description,
        "r2_root_prefix": project.r2_root_prefix,
        "created_at": iso(project.created_at),
        "updated_at": iso(project.updated_at),
    }


def serialize_template(template: Template) -> dict[str, Any]:
    return {
        "id": template.id,
        "slug": template.slug,
        "name": template.name,
        "description": template.description,
        "config_json": template.config_json or {},
        "is_seeded": template.is_seeded,
        "created_at": iso(template.created_at),
        "updated_at": iso(template.updated_at),
    }


def serialize_chat_message(message: ChatMessage) -> dict[str, Any]:
    return {
        "id": message.id,
        "project_id": message.project_id,
        "run_id": message.run_id,
        "role": message.role,
        "content": message.content,
        "created_at": iso(message.created_at),
    }


def serialize_run(run: Run) -> dict[str, Any]:
    return {
        "id": run.id,
        "project_id": run.project_id,
        "status": run.status,
        "input_message": run.input_message,
        "state_json": run.state_json or {},
        "created_at": iso(run.created_at),
        "updated_at": iso(run.updated_at),
        "completed_at": iso(run.completed_at),
        "error_message": run.error_message,
        "stop_after_node_id": run.stop_after_node_id,
    }


def serialize_node_execution(node: NodeExecution) -> dict[str, Any]:
    return {
        "id": node.id,
        "run_id": node.run_id,
        "node_id": node.node_id,
        "node_name": node.node_name,
        "node_type": node.node_type,
        "status": node.status,
        "model_profile": node.model_profile,
        "model_used": node.model_used,
        "input_json": node.input_json or {},
        "output_json": node.output_json or {},
        "error_message": node.error_message,
        "started_at": iso(node.started_at),
        "completed_at": iso(node.completed_at),
        "token_input": node.token_input,
        "token_output": node.token_output,
        "cost_estimate": float(node.cost_estimate) if node.cost_estimate is not None else None,
    }


def serialize_artifact(artifact: Artifact) -> dict[str, Any]:
    return {
        "id": artifact.id,
        "project_id": artifact.project_id,
        "run_id": artifact.run_id,
        "node_id": artifact.node_id,
        "path": artifact.path,
        "filename": artifact.filename,
        "mime_type": artifact.mime_type,
        "size_bytes": artifact.size_bytes,
        "created_by": artifact.created_by,
        "deleted_at": iso(artifact.deleted_at),
        "created_at": iso(artifact.created_at),
    }


def serialize_run_event(event: RunEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "run_id": event.run_id,
        "type": event.event_type,
        "event_json": event.event_json or {},
        "created_at": iso(event.created_at),
    }


def serialize_vault_item(item: VaultItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "user_id": item.user_id,
        "name": item.name,
        "folder": item.folder,
        "storage_key": item.storage_key,
        "mime_type": item.mime_type,
        "size_bytes": item.size_bytes,
        "source_project_id": item.source_project_id,
        "source_run_id": item.source_run_id,
        "source_artifact_id": item.source_artifact_id,
        "notes": item.notes,
        "created_at": iso(item.created_at),
        "updated_at": iso(item.updated_at),
    }

