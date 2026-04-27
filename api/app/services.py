from __future__ import annotations

import asyncio
import json
import logging
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
from app.models import Artifact, ChatMessage, NodeExecution, Project, Run, RunEvent, generate_id, utcnow

logger = logging.getLogger("flowpro")

WORKFLOW_NODES = [
    {
        "node_id": "intent_parser",
        "node_name": "Intent Parser",
        "node_type": "ai",
        "model_profile": "fast_classifier",
        "output_path": "working/intent.json",
        "state_section": "working",
        "state_key": "intent",
    },
    {
        "node_id": "requirement_extractor",
        "node_name": "Requirement Extractor",
        "node_type": "ai",
        "model_profile": "json_extractor",
        "output_path": "working/requirements.json",
        "state_section": "working",
        "state_key": "requirements",
    },
    {
        "node_id": "outline_builder",
        "node_name": "Outline Builder",
        "node_type": "ai",
        "model_profile": "premium_writer",
        "output_path": "working/outline.md",
        "state_section": "working",
        "state_key": "outline",
    },
    {
        "node_id": "draft_writer",
        "node_name": "Draft Writer",
        "node_type": "ai",
        "model_profile": "premium_writer",
        "output_path": "working/draft.md",
        "state_section": "working",
        "state_key": "draft",
    },
    {
        "node_id": "critic_qa",
        "node_name": "Critic QA",
        "node_type": "ai",
        "model_profile": "deep_reasoner",
        "output_path": "working/qa_report.json",
        "state_section": "working",
        "state_key": "qa_report",
    },
    {
        "node_id": "final_writer",
        "node_name": "Final Writer",
        "node_type": "ai",
        "model_profile": "premium_writer",
        "output_path": "final/output.md",
        "state_section": "final",
        "state_key": "markdown",
    },
    {
        "node_id": "pdf_generator",
        "node_name": "PDF Generator",
        "node_type": "utility",
        "model_profile": None,
        "output_path": "final/output.pdf",
        "state_section": "final",
        "state_key": "pdf",
    },
]


class AuthService:
    def __init__(self) -> None:
        self.password_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

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
        statement = select(Artifact).where(Artifact.project_id == project_id, Artifact.deleted_at.is_(None))
        if prefix:
            safe_prefix = self.validate_relative_path(prefix)
            statement = statement.where(Artifact.path.startswith(safe_prefix))
        statement = statement.order_by(desc(Artifact.created_at))
        result = await db.execute(statement)
        return list(result.scalars().all())

    async def delete_file(self, db: AsyncSession, project: Project, relative_path: str) -> Artifact:
        safe_path = self.validate_relative_path(relative_path)
        result = await db.execute(
            select(Artifact).where(
                Artifact.project_id == project.id,
                Artifact.path == safe_path,
                Artifact.deleted_at.is_(None),
            )
        )
        artifact = result.scalar_one_or_none()
        if not artifact:
            raise HTTPException(status_code=404, detail="Artifact not found.")

        await self._run_s3(
            "delete_object",
            Bucket=settings.cloudflare_r2_bucket,
            Key=self.build_object_key(project, safe_path),
        )
        artifact.deleted_at = utcnow()
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

    async def _run_completion(
        self,
        *,
        model_profile: str,
        system_prompt: str,
        user_prompt: str,
        expect_json: bool,
    ) -> dict[str, Any]:
        last_error: Exception | None = None
        for model_name in settings.model_profiles[model_profile]:
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
        raise RuntimeError(f"OpenRouter completion failed for profile {model_profile}: {last_error}")

    async def run_chat_completion(self, *, model_profile: str, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        return await self._run_completion(
            model_profile=model_profile,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            expect_json=False,
        )

    async def run_json_completion(self, *, model_profile: str, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        return await self._run_completion(
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

    async def create_run(self, db: AsyncSession, project: Project, message: str) -> Run:
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
        for node in WORKFLOW_NODES:
            db.add(
                NodeExecution(
                    id=generate_id("nex"),
                    run_id=run.id,
                    node_id=node["node_id"],
                    node_name=node["node_name"],
                    node_type=node["node_type"],
                    status="waiting",
                    model_profile=node["model_profile"],
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
        node.status = "failed"
        node.error_message = str(error)
        node.completed_at = utcnow()
        run.status = "failed"
        run.error_message = str(error)
        run.updated_at = utcnow()
        run.completed_at = utcnow()
        await self.emit_event(db, run.id, "node.failed", {"run_id": run.id, "node_id": node.node_id, "error": str(error)})
        await self.emit_event(db, run.id, "run.failed", {"run_id": run.id, "error": str(error)})
        await db.commit()

    async def _artifact_event(self, db: AsyncSession, run_id: str, node_id: str, artifact: Artifact) -> None:
        await self.emit_event(
            db,
            run_id,
            "artifact.created",
            {"run_id": run_id, "node_id": node_id, "artifact_id": artifact.id, "path": artifact.path},
        )

    def _mock_ai_result(self, node: dict[str, Any], input_json: dict[str, Any]) -> dict[str, Any]:
        user_message = str(input_json.get("user_message") or input_json.get("message") or "Create a professional document.")
        uploaded_files = input_json.get("uploaded_files") or []
        if node["node_id"] == "intent_parser":
            content: Any = {
                "document_type": "Proposal",
                "target_audience": "Internal stakeholders",
                "goal": user_message[:160],
                "tone": "Professional",
                "requested_outputs": ["markdown", "pdf"],
                "missing_information": [],
            }
        elif node["node_id"] == "requirement_extractor":
            content = {
                "requirements": [
                    "Produce a complete document in Markdown.",
                    "Keep the structure clear and ready for PDF export.",
                ],
                "constraints": [
                    "Stay aligned with the user's request.",
                    "Use only project-scoped files and generated artifacts.",
                ],
                "must_include": [
                    "Executive summary",
                    "Key deliverables",
                    "Next steps",
                ],
                "must_avoid": [
                    "Unsupported claims",
                    "Placeholder TODO content",
                ],
                "source_notes": [
                    f"User message: {user_message}",
                    f"Uploaded file count: {len(uploaded_files)}",
                ],
            }
        elif node["node_id"] == "outline_builder":
            content = "\n".join(
                [
                    "# Document Outline",
                    "",
                    "## Executive Summary",
                    "## Background",
                    "## Proposed Approach",
                    "## Deliverables",
                    "## Risks and Mitigations",
                    "## Next Steps",
                ]
            )
        elif node["node_id"] == "draft_writer":
            content = "\n".join(
                [
                    "# Draft Document",
                    "",
                    "## Executive Summary",
                    f"This draft responds to the request: {user_message}",
                    "",
                    "## Background",
                    "The project is being prepared inside FlowPro with stable infrastructure primitives.",
                    "",
                    "## Proposed Approach",
                    "The workflow converts the request into requirements, a document outline, a draft, and a final deliverable.",
                    "",
                    "## Deliverables",
                    "- Markdown output",
                    "- PDF output",
                    "- Inspectable run history and artifacts",
                    "",
                    "## Risks and Mitigations",
                    "- Validate storage paths to keep all writes within the project root.",
                    "- Use mock mode to test infrastructure without external model dependency.",
                    "",
                    "## Next Steps",
                    "Review, approve, and continue with the final revision.",
                ]
            )
        elif node["node_id"] == "critic_qa":
            content = {
                "overall_score": 93,
                "issues": [
                    "The draft can be tightened for clarity.",
                ],
                "recommended_fixes": [
                    "Shorten repetitive phrasing.",
                    "Ensure the summary and next steps are explicit.",
                ],
                "final_instruction": "Produce a concise, polished final document with explicit action items.",
            }
        elif node["node_id"] == "final_writer":
            content = "\n".join(
                [
                    "# Final Document",
                    "",
                    "## Executive Summary",
                    f"This final document fulfills the request: {user_message}",
                    "",
                    "## Background",
                    "FlowPro executed the fixed Document Generator workflow and preserved all run artifacts for inspection.",
                    "",
                    "## Proposed Approach",
                    "The app stores user files in project-scoped Cloudflare R2 paths, executes ordered workflow nodes, and streams live run state back to the UI.",
                    "",
                    "## Deliverables",
                    "- Final Markdown document",
                    "- Generated PDF",
                    "- File records, node executions, and run events",
                    "",
                    "## Next Steps",
                    "Review the generated files in the Output Viewer and Files tabs, then download or delete as needed.",
                ]
            )
        else:
            raise RuntimeError(f"Unsupported mock node: {node['node_id']}")

        return {
            "content": content if isinstance(content, str) else json.dumps(content, indent=2),
            "parsed": content if isinstance(content, dict) else None,
            "model_used": f"mock/{node['node_id']}",
            "token_input": 0,
            "token_output": 0,
            "cost_estimate": 0.0,
        }

    async def _run_ai_node(
        self,
        db: AsyncSession,
        project: Project,
        run: Run,
        node: dict[str, Any],
        input_json: dict[str, Any],
        system_prompt: str,
        user_prompt: str,
        state: dict[str, Any],
        expect_json: bool,
    ) -> Any:
        node_row = await self._load_node(db, run.id, node["node_id"])
        node_row.status = "running"
        node_row.started_at = utcnow()
        node_row.input_json = input_json
        await self.emit_event(db, run.id, "node.started", {"run_id": run.id, "node_id": node["node_id"]})
        await db.commit()
        try:
            result = self._mock_ai_result(node, input_json) if settings.mock_ai else (
                await self.openrouter.run_json_completion(
                    model_profile=node["model_profile"],
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )
                if expect_json
                else await self.openrouter.run_chat_completion(
                    model_profile=node["model_profile"],
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                )
            )
            content = result["parsed"] if expect_json else result["content"]
            mime_type = "application/json" if expect_json else "text/markdown"
            payload = json.dumps(content, indent=2) if expect_json else content
            artifact = await self.storage.write_file(
                db,
                project,
                node["output_path"],
                payload,
                mime_type,
                "node",
                run.id,
                node["node_id"],
            )
            state[node["state_section"]][node["state_key"]] = artifact.id
            run.state_json = state
            run.updated_at = utcnow()
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
            await self._artifact_event(db, run.id, node["node_id"], artifact)
            await self.emit_event(
                db,
                run.id,
                "node.completed",
                {"run_id": run.id, "node_id": node["node_id"], "artifact_id": artifact.id},
            )
            await db.commit()
            return content
        except Exception as error:
            await self._mark_failure(db, run, node_row, error)
            raise

    async def _run_pdf_node(
        self,
        db: AsyncSession,
        project: Project,
        run: Run,
        node: dict[str, Any],
        markdown_text: str,
        state: dict[str, Any],
    ) -> None:
        node_row = await self._load_node(db, run.id, node["node_id"])
        node_row.status = "running"
        node_row.started_at = utcnow()
        node_row.input_json = {"path": "final/output.md", "markdown_length": len(markdown_text)}
        await self.emit_event(db, run.id, "node.started", {"run_id": run.id, "node_id": node["node_id"]})
        await db.commit()
        try:
            html = self.pdf_service.markdown_to_html(markdown_text)
            pdf_bytes = await self.pdf_service.html_to_pdf(html)
            artifact = await self.storage.write_file(
                db,
                project,
                node["output_path"],
                pdf_bytes,
                "application/pdf",
                "node",
                run.id,
                node["node_id"],
            )
            state[node["state_section"]][node["state_key"]] = artifact.id
            run.state_json = state
            run.status = "completed"
            run.updated_at = utcnow()
            run.completed_at = utcnow()
            node_row.status = "completed"
            node_row.output_json = {"artifact_id": artifact.id, "path": artifact.path, "html_length": len(html)}
            node_row.completed_at = utcnow()
            await self._artifact_event(db, run.id, node["node_id"], artifact)
            await self.emit_event(
                db,
                run.id,
                "node.completed",
                {"run_id": run.id, "node_id": node["node_id"], "artifact_id": artifact.id},
            )
            await self.emit_event(db, run.id, "run.completed", {"run_id": run.id})
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

            run.status = "running"
            run.updated_at = utcnow()
            await self.emit_event(db, run.id, "run.started", {"run_id": run.id})
            await db.commit()

            uploaded_files = await self.storage.list_files(db, project.id, "input")
            state = run.state_json or {"input": {}, "working": {}, "final": {}}
            context: dict[str, Any] = {
                "message": run.input_message,
                "uploaded_files": [{"filename": item.filename, "path": item.path, "artifact_id": item.id} for item in uploaded_files],
            }

            try:
                context["intent"] = await self._run_ai_node(
                    db,
                    project,
                    run,
                    WORKFLOW_NODES[0],
                    {"user_message": context["message"], "uploaded_files": context["uploaded_files"]},
                    "Extract the user's document-generation intent into the required JSON shape. Always return the requested keys.",
                    f"User message:\n{context['message']}\n\nUploaded files:\n{json.dumps(context['uploaded_files'], indent=2)}\n\nReturn JSON with keys: document_type, target_audience, goal, tone, requested_outputs, missing_information.",
                    state,
                    True,
                )
                context["requirements"] = await self._run_ai_node(
                    db,
                    project,
                    run,
                    WORKFLOW_NODES[1],
                    {
                        "user_message": context["message"],
                        "uploaded_files": context["uploaded_files"],
                        "intent": context["intent"],
                    },
                    "Extract concrete requirements, constraints, must_include, must_avoid, and source_notes. Return only valid JSON.",
                    f"User message:\n{context['message']}\n\nUploaded files:\n{json.dumps(context['uploaded_files'], indent=2)}\n\nIntent JSON:\n{json.dumps(context['intent'], indent=2)}",
                    state,
                    True,
                )
                context["outline"] = await self._run_ai_node(
                    db,
                    project,
                    run,
                    WORKFLOW_NODES[2],
                    {
                        "user_message": context["message"],
                        "intent": context["intent"],
                        "requirements": context["requirements"],
                    },
                    "Write a strong markdown outline for the requested document. Use structure, headings, and bullets. Do not write the full document.",
                    f"User message:\n{context['message']}\n\nIntent JSON:\n{json.dumps(context['intent'], indent=2)}\n\nRequirements JSON:\n{json.dumps(context['requirements'], indent=2)}",
                    state,
                    False,
                )
                context["draft"] = await self._run_ai_node(
                    db,
                    project,
                    run,
                    WORKFLOW_NODES[3],
                    {
                        "user_message": context["message"],
                        "intent": context["intent"],
                        "requirements": context["requirements"],
                        "outline": context["outline"],
                    },
                    "Write the complete markdown draft using the outline and every extracted requirement.",
                    f"User message:\n{context['message']}\n\nIntent JSON:\n{json.dumps(context['intent'], indent=2)}\n\nRequirements JSON:\n{json.dumps(context['requirements'], indent=2)}\n\nOutline Markdown:\n{context['outline']}",
                    state,
                    False,
                )
                context["qa_report"] = await self._run_ai_node(
                    db,
                    project,
                    run,
                    WORKFLOW_NODES[4],
                    {
                        "user_message": context["message"],
                        "requirements": context["requirements"],
                        "draft": context["draft"],
                    },
                    "Audit the draft against the requirements. Return JSON with overall_score, issues, recommended_fixes, and final_instruction.",
                    f"User message:\n{context['message']}\n\nRequirements JSON:\n{json.dumps(context['requirements'], indent=2)}\n\nDraft Markdown:\n{context['draft']}",
                    state,
                    True,
                )
                context["final_markdown"] = await self._run_ai_node(
                    db,
                    project,
                    run,
                    WORKFLOW_NODES[5],
                    {
                        "user_message": context["message"],
                        "requirements": context["requirements"],
                        "draft": context["draft"],
                        "qa_report": context["qa_report"],
                    },
                    "Revise the draft into the final markdown document. Apply the QA recommendations and final instruction. Produce only markdown.",
                    f"User message:\n{context['message']}\n\nRequirements JSON:\n{json.dumps(context['requirements'], indent=2)}\n\nDraft Markdown:\n{context['draft']}\n\nQA Report JSON:\n{json.dumps(context['qa_report'], indent=2)}",
                    state,
                    False,
                )
                db.add(
                    ChatMessage(
                        id=generate_id("msg"),
                        project_id=project.id,
                        run_id=run.id,
                        role="assistant",
                        content=context["final_markdown"],
                    )
                )
                await db.commit()
                await self._run_pdf_node(db, project, run, WORKFLOW_NODES[6], context["final_markdown"], state)
            except Exception:
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
