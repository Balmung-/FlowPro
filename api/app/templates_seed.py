"""Seed templates for the FlowPro template-driven workflow engine.

Templates are stored as JSON in the `templates.config_json` column. The
WorkflowService reads `nodes` from this config and runs them in order.

Node config schema (linear v1):
    {
        "id": str,                # unique within template
        "name": str,
        "type": "ai" | "plan" | "pdf_generator",
        # AI/plan nodes need either `model` (preferred) or `model_profile` (legacy):
        "model": str | None,           # direct OpenRouter model id, e.g. "anthropic/claude-3.5-sonnet"
        "model_profile": str | None,   # legacy fallback bundle; resolves to settings.model_profiles[slug]
        "system_prompt": str,          # persistent role/persona for the AI (optional)
        # User prompt: structured form (preferred) — `instruction` describes what the
        # node should do, plus tick boxes that auto-include context. Legacy form
        # uses `user_prompt_template` with ${var} placeholders.
        "instruction": str,            # preferred — the task in plain English
        "include_message": bool,       # auto-include the user's chat message (default True)
        "include_uploaded_files": bool,# auto-include the uploaded files list (default False)
        "user_prompt_template": str,   # legacy fallback; uses ${var} substitutions
        "reads": [str],                # state references like "working.intent" — auto-injected as a context block
        "output": {
            "format": "json" | "markdown" | "pdf",
            "path": str,               # project-relative, must start with allowed prefix
            "state_section": str,
            "state_key": str
        },
        "mock_content": Any            # optional; strings/dicts/lists walked for ${var} substitution in MOCK_AI mode
    }
"""
from __future__ import annotations

from typing import Any

DOCUMENT_GENERATOR_CONFIG: dict[str, Any] = {
    "name": "Document Generator",
    "description": "Convert a chat request into a polished Markdown document and a styled PDF.",
    "default_viewer": "markdown",
    "allowed_viewers": ["markdown", "pdf", "json"],
    "nodes": [
        {
            "id": "intent_parser",
            "name": "Intent Parser",
            "type": "ai",
            "model": "openai/gpt-4o-mini",
            "system_prompt": "Extract the user's document-generation intent into the required JSON shape. Always return the requested keys.",
            "instruction": "Return JSON with these keys: document_type, target_audience, goal, tone, requested_outputs, missing_information.",
            "include_message": True,
            "include_uploaded_files": True,
            "reads": [],
            "output": {
                "format": "json",
                "path": "working/intent.json",
                "state_section": "working",
                "state_key": "intent",
            },
            "mock_content": {
                "document_type": "Proposal",
                "target_audience": "Internal stakeholders",
                "goal": "${message_short}",
                "tone": "Professional",
                "requested_outputs": ["markdown", "pdf"],
                "missing_information": [],
            },
        },
        {
            "id": "requirement_extractor",
            "name": "Requirement Extractor",
            "type": "ai",
            "model": "openai/gpt-4.1-mini",
            "system_prompt": "Extract concrete requirements, constraints, must_include, must_avoid, and source_notes. Return only valid JSON.",
            "instruction": "Using the user's request and the parsed intent above, extract concrete requirements. Return JSON with these keys: requirements, constraints, must_include, must_avoid, source_notes.",
            "include_message": True,
            "include_uploaded_files": True,
            "reads": ["working.intent"],
            "output": {
                "format": "json",
                "path": "working/requirements.json",
                "state_section": "working",
                "state_key": "requirements",
            },
            "mock_content": {
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
                    "User message: ${message}",
                ],
            },
        },
        {
            "id": "outline_builder",
            "name": "Outline Builder",
            "type": "ai",
            "model": "anthropic/claude-3.5-sonnet",
            "system_prompt": "Write a strong markdown outline for the requested document. Use structure, headings, and bullets. Do not write the full document.",
            "instruction": "Build a well-structured markdown outline for the document the user wants. Return only the outline (headings + bullets), not the full document.",
            "include_message": True,
            "include_uploaded_files": False,
            "reads": ["working.intent", "working.requirements"],
            "output": {
                "format": "markdown",
                "path": "working/outline.md",
                "state_section": "working",
                "state_key": "outline",
            },
            "mock_content": "# Document Outline\n\n## Executive Summary\n## Background\n## Proposed Approach\n## Deliverables\n## Risks and Mitigations\n## Next Steps",
        },
        {
            "id": "draft_writer",
            "name": "Draft Writer",
            "type": "ai",
            "model": "anthropic/claude-3.5-sonnet",
            "system_prompt": "Write the complete markdown draft using the outline and every extracted requirement.",
            "instruction": "Expand the outline into a full markdown draft. Cover every section. Honor every requirement and constraint.",
            "include_message": True,
            "include_uploaded_files": False,
            "reads": ["working.intent", "working.requirements", "working.outline"],
            "output": {
                "format": "markdown",
                "path": "working/draft.md",
                "state_section": "working",
                "state_key": "draft",
            },
            "mock_content": "# Draft Document\n\n## Executive Summary\nThis draft responds to the request: ${message}\n\n## Background\nThe project is being prepared inside FlowPro with stable infrastructure primitives.\n\n## Proposed Approach\nThe workflow converts the request into requirements, a document outline, a draft, and a final deliverable.\n\n## Deliverables\n- Markdown output\n- PDF output\n- Inspectable run history and artifacts\n\n## Risks and Mitigations\n- Validate storage paths to keep all writes within the project root.\n- Use mock mode to test infrastructure without external model dependency.\n\n## Next Steps\nReview, approve, and continue with the final revision.",
        },
        {
            "id": "critic_qa",
            "name": "Critic QA",
            "type": "ai",
            "model": "openai/o3-mini",
            "system_prompt": "Audit the draft against the requirements. Return JSON with overall_score, issues, recommended_fixes, and final_instruction.",
            "instruction": "Audit the draft against the requirements. Return JSON with these keys: overall_score (0-100), issues (list), recommended_fixes (list), final_instruction (string telling the next node what to fix).",
            "include_message": True,
            "include_uploaded_files": False,
            "reads": ["working.requirements", "working.draft"],
            "output": {
                "format": "json",
                "path": "working/qa_report.json",
                "state_section": "working",
                "state_key": "qa_report",
            },
            "mock_content": {
                "overall_score": 93,
                "issues": [
                    "The draft can be tightened for clarity.",
                ],
                "recommended_fixes": [
                    "Shorten repetitive phrasing.",
                    "Ensure the summary and next steps are explicit.",
                ],
                "final_instruction": "Produce a concise, polished final document with explicit action items.",
            },
        },
        {
            "id": "final_writer",
            "name": "Final Writer",
            "type": "ai",
            "model": "anthropic/claude-3.5-sonnet",
            "system_prompt": "Revise the draft into the final markdown document. Apply the QA recommendations and final instruction. Produce only markdown.",
            "instruction": "Revise the draft into the final document, applying the QA report's recommended fixes and following its final_instruction. Output only markdown.",
            "include_message": True,
            "include_uploaded_files": False,
            "reads": ["working.requirements", "working.draft", "working.qa_report"],
            "output": {
                "format": "markdown",
                "path": "final/output.md",
                "state_section": "final",
                "state_key": "markdown",
            },
            "mock_content": "# Proposal: Internal AI Document Cockpit\n\n## Executive Summary\nThis proposal addresses the request: ${message_no_period}.\nIt recommends a focused Phase 1 implementation that delivers a stable internal workflow from request to Markdown and PDF output.\n\n## Problem\nTeams need a predictable way to turn a brief request into a reviewable document package.\nCurrent ad-hoc drafting is slow, hard to audit, and difficult to repeat.\n\n## Proposed Solution\n- Capture request context in a project workspace.\n- Execute a templated multi-node generation workflow with live run visibility.\n- Store intermediate and final artifacts in project-scoped R2 paths.\n- Provide markdown and PDF outputs for immediate review and download.\n\n## Deliverables\n- Intent, requirements, outline, draft, QA report, final markdown, and final PDF artifacts.\n- Live node status, run events, and state inspector.\n- File browser actions: upload, preview, download, delete.\n\n## Success Criteria\n- A user can submit a request and track node execution in real time.\n- Final markdown and PDF are generated and accessible in one run.\n- The run remains inspectable for auditing and troubleshooting.\n\n## Next Steps\nApprove this implementation baseline, run team trials with MOCK_AI mode, then enable production model profiles after workflow sign-off.",
        },
        {
            "id": "pdf_generator",
            "name": "PDF Generator",
            "type": "pdf_generator",
            "system_prompt": "",
            "instruction": "",
            "user_prompt_template": "",
            "reads": ["final.markdown"],
            "output": {
                "format": "pdf",
                "path": "final/output.pdf",
                "state_section": "final",
                "state_key": "pdf",
            },
        },
    ],
}


def _plan_node() -> dict[str, Any]:
    return {
        "id": "plan",
        "name": "Plan",
        "type": "plan",
        "model": "openai/o3-mini",
        "system_prompt": "You are the planning node. Produce a concise plantodo.md before any execution node acts.",
        "instruction": "Produce a concise plantodo.md covering: Goal, Current Understanding, Files Likely Involved, Structural Decision, Execution Steps, Risks, What Not To Do, Completion Criteria. Output markdown only.",
        "include_message": True,
        "include_uploaded_files": True,
        "reads": [],
        "output": {
            "format": "markdown",
            "path": "working/plantodo.md",
            "state_section": "working",
            "state_key": "plan",
        },
        "mock_content": "# Plan Todo\n\n## Goal\nDeliver the document the user requested: ${message_no_period}.\n\n## Current Understanding\nA chat request has been received and the templated workflow will turn it into a Markdown + PDF deliverable.\n\n## Files Likely Involved\n- working/intent.json\n- working/requirements.json\n- working/outline.md\n- working/draft.md\n- working/qa_report.json\n- final/output.md\n- final/output.pdf\n\n## Structural Decision\nUse the linear Document Generator pipeline. Each node hands off via files in the project root, no in-memory blob passing.\n\n## Execution Steps\n1. Parse intent.\n2. Extract requirements.\n3. Build outline.\n4. Write draft.\n5. QA the draft.\n6. Produce final markdown.\n7. Render PDF.\n\n## Risks\n- Model output drift between draft and final.\n- Missing user constraints if the brief is sparse.\n\n## What Not To Do\n- Do not patch broken outputs in later nodes; flag and stop instead.\n- Do not write files outside the project root.\n\n## Completion Criteria\nfinal/output.md and final/output.pdf exist and reflect the user's request.",
    }


# Document with Plan: same as Document Generator but with a Plan Node prepended
# that writes working/plantodo.md, which downstream nodes can reference.
DOCUMENT_WITH_PLAN_CONFIG: dict[str, Any] = {
    "name": "Document with Plan",
    "description": "Same as Document Generator, but starts with a Plan node that writes plantodo.md before the rest of the pipeline runs.",
    "default_viewer": "markdown",
    "allowed_viewers": ["markdown", "pdf", "json"],
    "nodes": [
        _plan_node(),
        *DOCUMENT_GENERATOR_CONFIG["nodes"],
    ],
}


SEED_TEMPLATES: list[dict[str, Any]] = [
    {
        "slug": "document_generator",
        "name": DOCUMENT_GENERATOR_CONFIG["name"],
        "description": DOCUMENT_GENERATOR_CONFIG["description"],
        "config_json": DOCUMENT_GENERATOR_CONFIG,
    },
    {
        "slug": "document_with_plan",
        "name": DOCUMENT_WITH_PLAN_CONFIG["name"],
        "description": DOCUMENT_WITH_PLAN_CONFIG["description"],
        "config_json": DOCUMENT_WITH_PLAN_CONFIG,
    },
]
