from __future__ import annotations

import asyncio
import json
import logging
import string
from pathlib import PurePosixPath
from typing import Any

import boto3
import httpx
import jwt
from botocore.client import Config
from fastapi import HTTPException
from markdown import markdown
from passlib.context import CryptContext
from playwright.async_api import async_playwright
from redis.asyncio import from_url as redis_from_url
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import ALLOWED_PROJECT_PREFIXES, MODEL_PRICING_PER_MILLION, settings
from app.database import AsyncSessionLocal
from app.models import Artifact, ChatMessage, NodeExecution, Project, Run, RunEvent, Template, generate_id, utcnow

logger = logging.getLogger("flowpro")

SUPPORTED_NODE_TYPES = {"ai", "plan", "pdf_generator"}
SUPPORTED_OUTPUT_FORMATS = {"json", "markdown", "pdf"}
SUPPORTED_VIEWERS = {"markdown", "pdf", "json", "raw"}


def validate_template_config(config: dict[str, Any]) -> None:
    """Validate a template config_json blob. Raises HTTPException with 400 on failure."""
    if not isinstance(config, dict):
        raise HTTPException(status_code=400, detail="Template config must be an object.")

    name = config.get("name")
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail="Template config.name is required.")

    nodes = config.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise HTTPException(status_code=400, detail="Template config.nodes must be a non-empty list.")

    allowed_viewers = config.get("allowed_viewers", [])
    if not isinstance(allowed_viewers, list):
        raise HTTPException(status_code=400, detail="allowed_viewers must be a list of viewer names.")
    for viewer in allowed_viewers:
        if viewer not in SUPPORTED_VIEWERS:
            raise HTTPException(status_code=400, detail=f"Unsupported viewer: {viewer}")

    default_viewer = config.get("default_viewer")
    if default_viewer is not None and default_viewer not in SUPPORTED_VIEWERS:
        raise HTTPException(status_code=400, detail=f"Unsupported default_viewer: {default_viewer}")

    seen_ids: set[str] = set()
    produced: set[str] = set()  # "section.key" tokens produced so far
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise HTTPException(status_code=400, detail=f"Node #{index} must be an object.")

        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id.strip():
            raise HTTPException(status_code=400, detail=f"Node #{index} is missing id.")
        if node_id in seen_ids:
            raise HTTPException(status_code=400, detail=f"Duplicate node id: {node_id}")
        seen_ids.add(node_id)

        node_name = node.get("name")
        if not isinstance(node_name, str) or not node_name.strip():
            raise HTTPException(status_code=400, detail=f"Node {node_id} is missing name.")

        node_type = node.get("type")
        if node_type not in SUPPORTED_NODE_TYPES:
            raise HTTPException(status_code=400, detail=f"Node {node_id} has unsupported type: {node_type}")

        if node_type in ("ai", "plan"):
            # Either a direct OpenRouter model id (preferred) OR a legacy model_profile slug.
            model = node.get("model")
            model_profile = node.get("model_profile")
            if model:
                if not isinstance(model, str) or not model.strip():
                    raise HTTPException(
                        status_code=400, detail=f"Node {node_id} model must be a non-empty string."
                    )
            elif model_profile:
                if model_profile not in settings.model_profiles:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Node {node_id} has unknown model_profile: {model_profile}",
                    )
            else:
                raise HTTPException(
                    status_code=400,
                    detail=f"Node {node_id} must specify either 'model' (OpenRouter id) or 'model_profile'.",
                )
            # The node's task: either a plain `instruction` string (preferred) or a
            # legacy `user_prompt_template` with ${var} placeholders. At least one is required.
            instruction = node.get("instruction")
            user_prompt_template = node.get("user_prompt_template")
            if not (
                (isinstance(instruction, str) and instruction.strip())
                or (isinstance(user_prompt_template, str) and user_prompt_template.strip())
            ):
                raise HTTPException(
                    status_code=400,
                    detail=f"Node {node_id} must specify an `instruction` describing what it should do.",
                )

        output = node.get("output")
        if not isinstance(output, dict):
            raise HTTPException(status_code=400, detail=f"Node {node_id} is missing output.")
        out_format = output.get("format")
        if out_format not in SUPPORTED_OUTPUT_FORMATS:
            raise HTTPException(status_code=400, detail=f"Node {node_id} output.format invalid: {out_format}")
        out_path = output.get("path")
        if not isinstance(out_path, str) or not out_path:
            raise HTTPException(status_code=400, detail=f"Node {node_id} output.path is required.")
        first_segment = out_path.split("/", 1)[0]
        if first_segment not in ALLOWED_PROJECT_PREFIXES:
            raise HTTPException(
                status_code=400,
                detail=f"Node {node_id} output.path must start with one of {sorted(ALLOWED_PROJECT_PREFIXES)}",
            )
        section = output.get("state_section")
        key = output.get("state_key")
        if not isinstance(section, str) or not section or not isinstance(key, str) or not key:
            raise HTTPException(status_code=400, detail=f"Node {node_id} output.state_section and state_key are required.")

        reads = node.get("reads", [])
        if not isinstance(reads, list):
            raise HTTPException(status_code=400, detail=f"Node {node_id} reads must be a list.")
        for ref in reads:
            if not isinstance(ref, str) or "." not in ref:
                raise HTTPException(status_code=400, detail=f"Node {node_id} read '{ref}' must be in 'section.key' form.")
            if ref not in produced:
                raise HTTPException(
                    status_code=400,
                    detail=f"Node {node_id} reads '{ref}' but no upstream node has produced it.",
                )

        produced.add(f"{section}.{key}")

        if node_type == "pdf_generator":
            # PDF generator must have at least one read for its markdown source
            if not reads:
                raise HTTPException(
                    status_code=400,
                    detail=f"Node {node_id} (pdf_generator) must declare at least one read pointing to a markdown source.",
                )


class AuthService:
    def __init__(self) -> None:
        self.password_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto")

    def hash_password(self, password: str) -> str:
        return self.password_context.hash(password)

    def verify_password(self, password: str, password_hash: str) -> bool:
        return self.password_context.verify(password, password_hash)

    def issue_jwt(self, user_id: str) -> str:
        payload = {"sub": user_id, "iat": int(utcnow().timestamp())}
        return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")

    def verify_jwt(self, token: str) -> str | None:
        try:
            payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        except jwt.PyJWTError:
            return None
        return payload.get("sub")


class StorageService:
    def __init__(self) -> None:
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.cloudflare_r2_endpoint,
            aws_access_key_id=settings.cloudflare_r2_access_key_id,
            aws_secret_access_key=settings.cloudflare_r2_secret_access_key,
            config=Config(signature_version="s3v4"),
            region_name="auto",
        )

    def validate_relative_path(self, relative_path: str) -> str:
        normalized = relative_path.replace("\\", "/").strip("/")
        if not normalized:
            raise HTTPException(status_code=400, detail="Path is required.")
        path = PurePosixPath(normalized)
        if path.is_absolute() or ".." in path.parts:
            raise HTTPException(status_code=400, detail="Path escapes project root.")
        if normalized.startswith("projects/"):
            raise HTTPException(status_code=400, detail="Path must be project-relative.")
        if path.parts[0] not in ALLOWED_PROJECT_PREFIXES:
            raise HTTPException(status_code=400, detail="Path must start with an allowed project folder.")
        return normalized

    def build_object_key(self, project: Project, relative_path: str) -> str:
        safe_path = self.validate_relative_path(relative_path)
        return f"{project.r2_root_prefix.rstrip('/')}/{safe_path}"

    async def _run_s3(self, operation: str, **kwargs: Any) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, lambda: getattr(self.client, operation)(**kwargs))

    async def write_file(
        self,
        db: AsyncSession,
        project: Project,
        relative_path: str,
        content: bytes | str,
        mime_type: str,
        created_by: str,
        run_id: str | None = None,
        node_id: str | None = None,
    ) -> Artifact:
        safe_path = self.validate_relative_path(relative_path)
        object_key = self.build_object_key(project, safe_path)
        payload = content if isinstance(content, bytes) else content.encode("utf-8")
        attempts = 0
        while True:
            try:
                await self._run_s3(
                    "put_object",
                    Bucket=settings.cloudflare_r2_bucket,
                    Key=object_key,
                    Body=payload,
                    ContentType=mime_type,
                )
                break
            except Exception:
                attempts += 1
                if attempts >= 2:
                    raise

        artifact = Artifact(
            id=generate_id("art"),
            project_id=project.id,
            run_id=run_id,
            node_id=node_id,
            path=safe_path,
            filename=PurePosixPath(safe_path).name,
            mime_type=mime_type,
            size_bytes=len(payload),
            created_by=created_by,
        )
        db.add(artifact)
        await db.flush()
        return artifact

    async def read_file(self, project: Project, relative_path: str) -> bytes:
        object_key = self.build_object_key(project, relative_path)
        response = await self._run_s3("get_object", Bucket=settings.cloudflare_r2_bucket, Key=object_key)
        return response["Body"].read()

    async def list_files(self, db: AsyncSession, project_id: str, prefix: str = "") -> list[Artifact]:
        project = await db.get(Project, project_id)
        if not project:
            return []

        safe_prefix = self.validate_relative_path(prefix) if prefix else ""
        root_prefix = f"{project.r2_root_prefix.rstrip('/')}/"
        list_prefix = root_prefix
        if safe_prefix:
            list_prefix = f"{root_prefix}{safe_prefix.rstrip('/')}"
            if not list_prefix.endswith("/"):
                list_prefix = f"{list_prefix}/"

        objects: list[dict[str, Any]] = []
        continuation_token: str | None = None
        while True:
            params: dict[str, Any] = {
                "Bucket": settings.cloudflare_r2_bucket,
                "Prefix": list_prefix,
                "MaxKeys": 1000,
            }
            if continuation_token:
                params["ContinuationToken"] = continuation_token
            response = await self._run_s3("list_objects_v2", **params)
            objects.extend(response.get("Contents", []))
            if not response.get("IsTruncated"):
                break
            continuation_token = response.get("NextContinuationToken")

        artifact_result = await db.execute(
            select(Artifact).where(Artifact.project_id == project_id).order_by(desc(Artifact.created_at))
        )
        latest_by_path: dict[str, Artifact] = {}
        for artifact in artifact_result.scalars().all():
            if artifact.path not in latest_by_path:
                latest_by_path[artifact.path] = artifact

        files: list[Artifact] = []
        for item in objects:
            key = item.get("Key", "")
            if not key or key.endswith("/"):
                continue
            relative_path = key[len(root_prefix):] if key.startswith(root_prefix) else key
            artifact = latest_by_path.get(relative_path)
            if artifact:
                artifact.size_bytes = int(item.get("Size", artifact.size_bytes))
                files.append(artifact)
                continue

            files.append(
                Artifact(
                    id=generate_id("art"),
                    project_id=project_id,
                    run_id=None,
                    node_id=None,
                    path=relative_path,
                    filename=PurePosixPath(relative_path).name,
                    mime_type="application/octet-stream",
                    size_bytes=int(item.get("Size", 0)),
                    created_by="system",
                    created_at=utcnow(),
                )
            )

        files.sort(key=lambda artifact: artifact.created_at, reverse=True)
        return files

    async def delete_file(self, db: AsyncSession, project: Project, relative_path: str) -> Artifact:
        safe_path = self.validate_relative_path(relative_path)
        result = await db.execute(
            select(Artifact).where(
                Artifact.project_id == project.id,
                Artifact.path == safe_path,
            ).order_by(desc(Artifact.created_at))
        )
        artifacts = list(result.scalars().all())
        artifact = artifacts[0] if artifacts else None
        if artifact is None:
            raise HTTPException(status_code=404, detail="Artifact not found.")

        await self._run_s3(
            "delete_object",
            Bucket=settings.cloudflare_r2_bucket,
            Key=self.build_object_key(project, safe_path),
        )
        deleted_at = utcnow()
        for candidate in artifacts:
            candidate.deleted_at = deleted_at
        logger.info("Deleted project file %s for project %s", safe_path, project.id)
        await db.flush()
        return artifact

    async def get_signed_upload_url(self, project: Project, relative_path: str, mime_type: str) -> str:
        safe_path = self.validate_relative_path(relative_path)
        object_key = self.build_object_key(project, safe_path)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: self.client.generate_presigned_url(
                "put_object",
                Params={
                    "Bucket": settings.cloudflare_r2_bucket,
                    "Key": object_key,
                    "ContentType": mime_type,
                },
                ExpiresIn=3600,
            ),
        )

    async def get_signed_download_url(self, project: Project, relative_path: str) -> str:
        safe_path = self.validate_relative_path(relative_path)
        object_key = self.build_object_key(project, safe_path)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: self.client.generate_presigned_url(
                "get_object",
                Params={"Bucket": settings.cloudflare_r2_bucket, "Key": object_key},
                ExpiresIn=3600,
            ),
        )

    async def get_object_metadata(self, project: Project, relative_path: str) -> dict[str, Any]:
        safe_path = self.validate_relative_path(relative_path)
        return await self._run_s3(
            "head_object",
            Bucket=settings.cloudflare_r2_bucket,
            Key=self.build_object_key(project, safe_path),
        )

    async def check_bucket_access(self) -> dict[str, Any]:
        return await self._run_s3(
            "list_objects_v2",
            Bucket=settings.cloudflare_r2_bucket,
            MaxKeys=1,
        )

    async def create_artifact_record(
        self,
        db: AsyncSession,
        project_id: str,
        path: str,
        filename: str,
        mime_type: str,
        size_bytes: int,
        created_by: str,
        run_id: str | None = None,
        node_id: str | None = None,
    ) -> Artifact:
        artifact = Artifact(
            id=generate_id("art"),
            project_id=project_id,
            run_id=run_id,
            node_id=node_id,
            path=self.validate_relative_path(path),
            filename=filename,
            mime_type=mime_type,
            size_bytes=size_bytes,
            created_by=created_by,
        )
        db.add(artifact)
        await db.flush()
        return artifact


class OpenRouterService:
    async def _request(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not settings.openrouter_api_key:
            raise RuntimeError("OPENROUTER_API_KEY is required when MOCK_AI is false.")
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {settings.openrouter_api_key}",
                    "HTTP-Referer": settings.frontend_url or settings.app_base_url,
                    "X-Title": "FlowPro",
                },
                json=payload,
            )
            response.raise_for_status()
            return response.json()

    def _extract_content(self, message: Any) -> str:
        content = message.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    parts.append(item.get("text", ""))
            return "\n".join(parts)
        return str(content)

    def _estimate_cost(self, model: str, prompt_tokens: int, completion_tokens: int) -> float | None:
        pricing = MODEL_PRICING_PER_MILLION.get(model)
        if not pricing:
            return None
        return round(
            (prompt_tokens / 1_000_000 * pricing["input"])
            + (completion_tokens / 1_000_000 * pricing["output"]),
            6,
        )

    def _parse_json(self, content: str) -> dict[str, Any]:
        stripped = content.strip()
        if stripped.startswith("```"):
            stripped = stripped.split("```", 2)[1]
            if stripped.lstrip().startswith("json"):
                stripped = stripped.lstrip()[4:]
        return json.loads(stripped.strip())

    def _resolve_models(self, *, model: str | None, model_profile: str | None) -> list[str]:
        """Resolve the ordered list of model IDs to try.

        - If `model` is set, use [model] directly (no automatic fallback).
        - Else use settings.model_profiles[model_profile] (primary, fallback).
        """
        if model:
            return [model]
        if model_profile and model_profile in settings.model_profiles:
            return list(settings.model_profiles[model_profile])
        raise RuntimeError("Neither model nor a valid model_profile was provided.")

    async def _run_completion(
        self,
        *,
        model: str | None,
        model_profile: str | None,
        system_prompt: str,
        user_prompt: str,
        expect_json: bool,
    ) -> dict[str, Any]:
        last_error: Exception | None = None
        for model_name in self._resolve_models(model=model, model_profile=model_profile):
            payload: dict[str, Any] = {
                "model": model_name,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            }
            if expect_json:
                payload["response_format"] = {"type": "json_object"}
            try:
                data = await self._request(payload)
                message = data["choices"][0]["message"]
                text = self._extract_content(message)
                usage = data.get("usage", {})
                prompt_tokens = usage.get("prompt_tokens") or 0
                completion_tokens = usage.get("completion_tokens") or 0
                model_used = data.get("model", model_name)
                return {
                    "content": text,
                    "parsed": self._parse_json(text) if expect_json else None,
                    "model_used": model_used,
                    "token_input": prompt_tokens,
                    "token_output": completion_tokens,
                    "cost_estimate": self._estimate_cost(model_used, prompt_tokens, completion_tokens),
                }
            except Exception as exc:
                last_error = exc
        target = model or model_profile or "(unknown)"
        raise RuntimeError(f"OpenRouter completion failed for {target}: {last_error}")

    async def run_chat_completion(
        self,
        *,
        model: str | None = None,
        model_profile: str | None = None,
        system_prompt: str,
        user_prompt: str,
    ) -> dict[str, Any]:
        return await self._run_completion(
            model=model,
            model_profile=model_profile,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            expect_json=False,
        )

    async def run_json_completion(
        self,
        *,
        model: str | None = None,
        model_profile: str | None = None,
        system_prompt: str,
        user_prompt: str,
    ) -> dict[str, Any]:
        return await self._run_completion(
            model=model,
            model_profile=model_profile,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            expect_json=True,
        )


class PdfService:
    def markdown_to_html(self, markdown_text: str) -> str:
        body = markdown(markdown_text, extensions=["extra", "tables", "fenced_code"])
        return f"""
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {{
        font-family: "Georgia", serif;
        color: #172033;
        margin: 40px;
        line-height: 1.6;
      }}
      h1, h2, h3, h4 {{
        color: #0f172a;
        margin-top: 1.5em;
      }}
      pre {{
        background: #f4f4f5;
        padding: 16px;
        border-radius: 8px;
        overflow-x: auto;
      }}
      blockquote {{
        border-left: 4px solid #94a3b8;
        margin: 1rem 0;
        padding-left: 1rem;
      }}
      table {{
        width: 100%;
        border-collapse: collapse;
      }}
      th, td {{
        border: 1px solid #cbd5e1;
        padding: 8px 10px;
      }}
    </style>
  </head>
  <body>{body}</body>
</html>
"""

    async def html_to_pdf(self, html: str) -> bytes:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(args=["--no-sandbox"])
            page = await browser.new_page()
            await page.set_content(html, wait_until="networkidle")
            pdf = await page.pdf(
                format="A4",
                print_background=True,
                margin={"top": "20mm", "right": "16mm", "bottom": "20mm", "left": "16mm"},
            )
            await browser.close()
            return pdf


class WorkflowService:
    def __init__(self) -> None:
        self.storage = StorageService()
        self.openrouter = OpenRouterService()
        self.pdf_service = PdfService()

    async def queue_run(self, run_id: str) -> None:
        redis = redis_from_url(settings.redis_url, decode_responses=True)
        await redis.rpush("flowpro:runs", run_id)
        await redis.close()

    async def resolve_template_for_project(self, db: AsyncSession, project: Project) -> Template | None:
        if project.template_id:
            template = await db.get(Template, project.template_id)
            if template:
                return template
        # Fall back to the seeded document_generator template by slug.
        result = await db.execute(select(Template).where(Template.slug == "document_generator"))
        return result.scalar_one_or_none()

    async def create_run(self, db: AsyncSession, project: Project, message: str) -> Run:
        template = await self.resolve_template_for_project(db, project)
        if not template:
            raise HTTPException(
                status_code=400,
                detail="No template available for this project. Seed templates and assign one to the project.",
            )
        nodes_config = (template.config_json or {}).get("nodes", [])
        if not isinstance(nodes_config, list) or not nodes_config:
            raise HTTPException(status_code=400, detail="Template has no nodes.")

        uploaded_files = await self.storage.list_files(db, project.id, "input")
        run = Run(
            id=generate_id("run"),
            project_id=project.id,
            status="queued",
            input_message=message,
            state_json={
                "input": {
                    "message": message,
                    "uploaded_files": [
                        {"artifact_id": item.id, "path": item.path, "filename": item.filename}
                        for item in uploaded_files
                    ],
                    "template_id": template.id,
                    "template_slug": template.slug,
                    "template_name": template.name,
                },
                "working": {},
                "final": {},
            },
        )
        db.add(run)
        db.add(
            ChatMessage(
                id=generate_id("msg"),
                project_id=project.id,
                run_id=run.id,
                role="user",
                content=message,
            )
        )
        for node in nodes_config:
            db.add(
                NodeExecution(
                    id=generate_id("nex"),
                    run_id=run.id,
                    node_id=node["id"],
                    node_name=node["name"],
                    node_type=node["type"],
                    status="waiting",
                    # Direct model id takes precedence; falls back to profile slug for legacy configs.
                    model_profile=node.get("model") or node.get("model_profile"),
                    input_json={},
                    output_json={},
                )
            )
        await db.flush()
        return run

    async def emit_event(self, db: AsyncSession, run_id: str, event_type: str, payload: dict[str, Any]) -> None:
        db.add(RunEvent(id=generate_id("evt"), run_id=run_id, event_type=event_type, event_json=payload))
        await db.flush()

    async def _load_node(self, db: AsyncSession, run_id: str, node_id: str) -> NodeExecution:
        result = await db.execute(select(NodeExecution).where(NodeExecution.run_id == run_id, NodeExecution.node_id == node_id))
        return result.scalar_one()

    async def _mark_failure(self, db: AsyncSession, run: Run, node: NodeExecution, error: Exception) -> None:
        error_text = str(error)
        node.status = "failed"
        node.error_message = error_text
        node.completed_at = utcnow()
        run.status = "failed"
        run.error_message = error_text
        run.updated_at = utcnow()
        run.completed_at = utcnow()
        await self.emit_event(db, run.id, "node.failed", {"run_id": run.id, "node_id": node.node_id, "error": error_text})
        await self.emit_event(db, run.id, "run.failed", {"run_id": run.id, "error": error_text})
        db.add(
            ChatMessage(
                id=generate_id("msg"),
                project_id=run.project_id,
                run_id=run.id,
                role="system",
                content=f"Run failed at {node.node_name}: {error_text}",
            )
        )
        await db.commit()

    async def _artifact_event(self, db: AsyncSession, run_id: str, node_id: str, artifact: Artifact) -> None:
        await self.emit_event(
            db,
            run_id,
            "artifact.created",
            {"run_id": run_id, "node_id": node_id, "artifact_id": artifact.id, "path": artifact.path},
        )

    def _build_substitution_context(
        self,
        message: str,
        uploaded_files: list[Artifact],
        run_context: dict[str, str],
    ) -> dict[str, str]:
        ctx: dict[str, str] = {
            "message": message,
            "message_short": message[:160],
            "message_no_period": message.rstrip("."),
            "uploaded_files": json.dumps(
                [{"path": item.path, "filename": item.filename} for item in uploaded_files],
                indent=2,
            ),
        }
        for ref, rendered in run_context.items():
            # "working.intent" -> "working_intent" so it can be used as ${working_intent}
            ctx[ref.replace(".", "_")] = rendered
        return ctx

    def _apply_substitutions(self, value: Any, context: dict[str, str]) -> Any:
        if isinstance(value, str):
            return string.Template(value).safe_substitute(context)
        if isinstance(value, dict):
            return {key: self._apply_substitutions(item, context) for key, item in value.items()}
        if isinstance(value, list):
            return [self._apply_substitutions(item, context) for item in value]
        return value

    def _mock_node_result(
        self,
        node_config: dict[str, Any],
        sub_context: dict[str, str],
    ) -> dict[str, Any]:
        output_format = node_config["output"]["format"]
        mock = node_config.get("mock_content")
        if mock is None:
            if output_format == "json":
                content: Any = {
                    "node_id": node_config["id"],
                    "summary": f"Mock output for {node_config['name']}.",
                    "input_message_preview": sub_context.get("message_short", ""),
                }
            else:
                content = (
                    f"# {node_config['name']}\n\n"
                    "This is a deterministic mock output generated because MOCK_AI=true.\n\n"
                    f"Request preview: {sub_context.get('message_short', '')}"
                )
        else:
            content = self._apply_substitutions(mock, sub_context)
        return {
            "content": content if isinstance(content, str) else json.dumps(content, indent=2),
            "parsed": content if isinstance(content, (dict, list)) else None,
            "model_used": f"mock/{node_config['id']}",
            "token_input": 0,
            "token_output": 0,
            "cost_estimate": 0.0,
        }

    def _build_structured_user_prompt(
        self,
        node_config: dict[str, Any],
        message: str,
        uploaded_files: list[Artifact],
        run_context: dict[str, str],
    ) -> str:
        """Assemble the user prompt from the node's structured `instruction` field
        plus toggled context blocks (message, uploaded files, declared reads).

        This is the preferred path for new nodes — users describe what the node
        should do in plain English and tick which context to include. The runner
        does the formatting so users never need to write ${var} placeholders.
        """
        sections: list[str] = []
        include_message = node_config.get("include_message", True)
        include_uploaded_files = node_config.get("include_uploaded_files", False)

        if include_message and message:
            sections.append(f"USER REQUEST:\n{message}")

        if include_uploaded_files:
            files_text = json.dumps(
                [{"path": item.path, "filename": item.filename} for item in uploaded_files],
                indent=2,
            )
            sections.append(f"UPLOADED FILES:\n{files_text}")

        for ref in node_config.get("reads", []):
            value = run_context.get(ref)
            if not value:
                continue
            sections.append(f"{ref.upper()} (from upstream node):\n{value}")

        instruction = (node_config.get("instruction") or "").strip()
        if instruction:
            sections.append(f"YOUR TASK:\n{instruction}")

        return "\n\n".join(sections)

    async def _run_ai_node(
        self,
        db: AsyncSession,
        project: Project,
        run: Run,
        node_config: dict[str, Any],
        message: str,
        uploaded_files: list[Artifact],
        state: dict[str, Any],
        run_context: dict[str, str],
    ) -> None:
        node_row = await self._load_node(db, run.id, node_config["id"])
        node_row.status = "running"
        node_row.started_at = utcnow()

        sub_context = self._build_substitution_context(message, uploaded_files, run_context)
        system_prompt = node_config.get("system_prompt", "") or ""
        # Prefer the structured `instruction` field. Fall back to the legacy
        # `user_prompt_template` with ${var} substitutions for older configs.
        instruction = (node_config.get("instruction") or "").strip()
        if instruction:
            user_prompt = self._build_structured_user_prompt(
                node_config, message, uploaded_files, run_context
            )
        else:
            user_prompt_template = node_config.get("user_prompt_template", "") or ""
            user_prompt = string.Template(user_prompt_template).safe_substitute(sub_context)

        output_format = node_config["output"]["format"]
        expect_json = output_format == "json"

        node_model = node_config.get("model")
        node_profile = node_config.get("model_profile")
        node_row.input_json = {
            "message": message,
            "reads": node_config.get("reads", []),
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "model": node_model,
            "model_profile": node_profile,
        }
        await self.emit_event(db, run.id, "node.started", {"run_id": run.id, "node_id": node_config["id"]})
        await db.commit()

        try:
            if settings.mock_ai:
                result = self._mock_node_result(node_config, sub_context)
            elif expect_json:
                result = await self.openrouter.run_json_completion(
                    model=node_model,
                    model_profile=node_profile,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )
            else:
                result = await self.openrouter.run_chat_completion(
                    model=node_model,
                    model_profile=node_profile,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )

            if expect_json:
                parsed = result.get("parsed")
                if parsed is None:
                    parsed = json.loads(result["content"])
                content: Any = parsed
                payload_text = json.dumps(content, indent=2)
                mime_type = "application/json"
            else:
                content = result["content"]
                payload_text = content
                mime_type = "text/markdown"

            artifact = await self.storage.write_file(
                db,
                project,
                node_config["output"]["path"],
                payload_text,
                mime_type,
                "node",
                run.id,
                node_config["id"],
            )

            section = node_config["output"]["state_section"]
            key = node_config["output"]["state_key"]
            state.setdefault(section, {})
            state[section][key] = artifact.id
            run.state_json = state
            run.updated_at = utcnow()

            run_context[f"{section}.{key}"] = payload_text

            node_row.status = "completed"
            node_row.model_used = result["model_used"]
            node_row.token_input = result["token_input"]
            node_row.token_output = result["token_output"]
            node_row.cost_estimate = result["cost_estimate"]
            node_row.output_json = {
                "artifact_id": artifact.id,
                "path": artifact.path,
                "data": content,
            }
            node_row.completed_at = utcnow()
            await self._artifact_event(db, run.id, node_config["id"], artifact)
            await self.emit_event(
                db,
                run.id,
                "node.completed",
                {"run_id": run.id, "node_id": node_config["id"], "artifact_id": artifact.id},
            )
            await db.commit()
        except Exception as error:
            await self._mark_failure(db, run, node_row, error)
            raise

    async def _resolve_markdown_for_pdf(
        self,
        db: AsyncSession,
        project: Project,
        node_config: dict[str, Any],
        state: dict[str, Any],
        run_context: dict[str, str],
    ) -> tuple[str, str | None]:
        for ref in node_config.get("reads", []):
            text = run_context.get(ref)
            if text:
                return text, ref
        # Fallback: try to read the artifact directly from R2 using state references.
        for ref in node_config.get("reads", []):
            try:
                section, key = ref.split(".", 1)
            except ValueError:
                continue
            artifact_id = state.get(section, {}).get(key)
            if not artifact_id:
                continue
            artifact = await db.get(Artifact, artifact_id)
            if not artifact:
                continue
            raw = await self.storage.read_file(project, artifact.path)
            return raw.decode("utf-8"), ref
        return "", None

    async def _run_pdf_node(
        self,
        db: AsyncSession,
        project: Project,
        run: Run,
        node_config: dict[str, Any],
        state: dict[str, Any],
        run_context: dict[str, str],
    ) -> None:
        node_row = await self._load_node(db, run.id, node_config["id"])
        node_row.status = "running"
        node_row.started_at = utcnow()

        markdown_text, source_ref = await self._resolve_markdown_for_pdf(db, project, node_config, state, run_context)
        node_row.input_json = {
            "source": source_ref or "(none)",
            "markdown_length": len(markdown_text),
        }
        await self.emit_event(db, run.id, "node.started", {"run_id": run.id, "node_id": node_config["id"]})
        await db.commit()

        try:
            if not markdown_text:
                raise RuntimeError(
                    "PDF generator has no markdown source. Ensure a markdown-producing node runs before this node and that this node declares it in 'reads'."
                )
            html = self.pdf_service.markdown_to_html(markdown_text)
            pdf_bytes = await self.pdf_service.html_to_pdf(html)
            artifact = await self.storage.write_file(
                db,
                project,
                node_config["output"]["path"],
                pdf_bytes,
                "application/pdf",
                "node",
                run.id,
                node_config["id"],
            )

            section = node_config["output"]["state_section"]
            key = node_config["output"]["state_key"]
            state.setdefault(section, {})
            state[section][key] = artifact.id
            run.state_json = state
            run.updated_at = utcnow()

            node_row.status = "completed"
            node_row.output_json = {
                "artifact_id": artifact.id,
                "path": artifact.path,
                "html_length": len(html),
            }
            node_row.completed_at = utcnow()
            await self._artifact_event(db, run.id, node_config["id"], artifact)
            await self.emit_event(
                db,
                run.id,
                "node.completed",
                {"run_id": run.id, "node_id": node_config["id"], "artifact_id": artifact.id},
            )
            await db.commit()
        except Exception as error:
            await self._mark_failure(db, run, node_row, error)
            raise

    async def execute_run(self, run_id: str) -> None:
        async with AsyncSessionLocal() as db:
            run = await db.get(Run, run_id)
            if not run:
                return
            project = await db.get(Project, run.project_id)
            if not project:
                return

            template = await self.resolve_template_for_project(db, project)
            if not template:
                run.status = "failed"
                run.error_message = "No template available for project."
                run.updated_at = utcnow()
                run.completed_at = utcnow()
                await self.emit_event(db, run.id, "run.failed", {"run_id": run.id, "error": run.error_message})
                await db.commit()
                return

            nodes_config = (template.config_json or {}).get("nodes", [])
            if not isinstance(nodes_config, list) or not nodes_config:
                run.status = "failed"
                run.error_message = "Template has no nodes."
                run.updated_at = utcnow()
                run.completed_at = utcnow()
                await self.emit_event(db, run.id, "run.failed", {"run_id": run.id, "error": run.error_message})
                await db.commit()
                return

            run.status = "running"
            run.updated_at = utcnow()
            await self.emit_event(
                db,
                run.id,
                "run.started",
                {"run_id": run.id, "template_id": template.id, "template_slug": template.slug},
            )
            await db.commit()

            uploaded_files = await self.storage.list_files(db, project.id, "input")
            state: dict[str, Any] = run.state_json or {"input": {}, "working": {}, "final": {}}
            for section in ("input", "working", "final", "logs", "archive"):
                state.setdefault(section, {})
            run_context: dict[str, str] = {}

            try:
                for node_config in nodes_config:
                    node_type = node_config.get("type", "ai")
                    if node_type in ("ai", "plan"):
                        await self._run_ai_node(
                            db,
                            project,
                            run,
                            node_config,
                            run.input_message,
                            uploaded_files,
                            state,
                            run_context,
                        )
                    elif node_type == "pdf_generator":
                        await self._run_pdf_node(db, project, run, node_config, state, run_context)
                    else:
                        raise RuntimeError(f"Unsupported node type: {node_type}")

                run.status = "completed"
                run.completed_at = utcnow()
                run.updated_at = utcnow()
                await self.emit_event(db, run.id, "run.completed", {"run_id": run.id})
                produced_pdf = any(node.get("type") == "pdf_generator" for node in nodes_config)
                produced_markdown = any(
                    node.get("output", {}).get("format") == "markdown" for node in nodes_config
                )
                if produced_pdf and produced_markdown:
                    completion_msg = "Document generated. Markdown and PDF are ready."
                elif produced_pdf:
                    completion_msg = "PDF output is ready."
                elif produced_markdown:
                    completion_msg = "Markdown output is ready."
                else:
                    completion_msg = "Run complete. Outputs available in the Files tab."
                db.add(
                    ChatMessage(
                        id=generate_id("msg"),
                        project_id=project.id,
                        run_id=run.id,
                        role="assistant",
                        content=completion_msg,
                    )
                )
                await db.commit()
            except Exception:
                # _mark_failure already handled status/events/commit
                return


async def run_worker_loop() -> None:
    workflow_service = WorkflowService()
    redis = redis_from_url(settings.redis_url, decode_responses=True)
    while True:
        _, run_id = await redis.blpop("flowpro:runs")
        try:
            await workflow_service.execute_run(run_id)
        except Exception:
            logger.exception("Worker failed while processing run %s", run_id)
