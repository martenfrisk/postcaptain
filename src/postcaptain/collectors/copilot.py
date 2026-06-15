"""GitHub Copilot chat collector — the priority AI-usage signal (design §4/§10).

On macOS, VS Code stores chat history per workspace under
``~/Library/Application Support/Code/User/workspaceStorage/<hash>/``:

  * ``state.vscdb`` — a SQLite key/value table (``ItemTable``). The key
    ``chat.ChatSessionStore.index`` holds the *session manifest* (sessionId,
    title, lastMessageDate, isEmpty). Older VS Code builds stored chat inline
    under ``interactive.sessions``; modern builds externalize it.
  * ``chatSessions/<sessionId>.json`` — the full content: a ``requests`` array
    where each entry has the user ``message.text``, the ``response`` parts,
    ``modelId``, ``agent``, ``result.timings``, ``followups`` and a
    ``timestamp``.
  * ``workspace.json`` — ``folder`` URI, mapped to a ``project`` key.

This collector uses ``state.vscdb`` as the manifest (to skip empty sessions and
recover titles) and joins content from the JSON session files, emitting one
``ai_interaction`` event per request. Tokens are estimated heuristically
(chars ÷ 4) — a ranking signal, not a bill (design §4/§12).

There is no official Copilot export API; the format here is reverse-engineered
from live data and may shift between VS Code versions. Keep parsing defensive.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote, urlparse

from ..events import Event, EventKind, Sensitivity, Source, extract_ticket, stable_event_id

# Copilot prompts/responses contain proprietary code → always sensitive (§8).
_SENSITIVITY = Sensitivity.SENSITIVE

# VS Code editor flavors that share the same storage layout.
_USER_DIR_CANDIDATES = (
    "Code/User",
    "Code - Insiders/User",
    "VSCodium/User",
)

_SESSION_INDEX_KEY = "chat.ChatSessionStore.index"

# chars-per-token heuristic for the token *ranking* signal (design §4/§12).
_CHARS_PER_TOKEN = 4


def default_user_dirs() -> list[Path]:
    """Existing VS Code ``User`` directories for the current macOS user."""
    base = Path.home() / "Library" / "Application Support"
    return [base / c for c in _USER_DIR_CANDIDATES if (base / c).is_dir()]


@dataclass
class _Workspace:
    """One ``workspaceStorage/<hash>`` directory."""

    storage_dir: Path

    @property
    def state_db(self) -> Path:
        return self.storage_dir / "state.vscdb"

    @property
    def sessions_dir(self) -> Path:
        return self.storage_dir / "chatSessions"

    def project(self) -> Optional[str]:
        """Project key from ``workspace.json``'s ``folder`` URI (basename)."""
        wf = self.storage_dir / "workspace.json"
        if not wf.is_file():
            return None
        try:
            data = json.loads(wf.read_text())
        except (OSError, json.JSONDecodeError):
            return None
        folder = data.get("folder") or data.get("workspace")
        if not folder:
            return None
        path = unquote(urlparse(folder).path) if "://" in folder else folder
        return Path(path).name or None


def _read_session_index(state_db: Path) -> dict[str, dict[str, Any]]:
    """Return the session manifest from ``state.vscdb``, keyed by sessionId.

    Opens a temp copy read-only so a running VS Code (which may hold a lock on
    the live DB) is never disturbed. Returns ``{}`` if the DB or key is absent.
    """
    if not state_db.is_file():
        return {}
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "state.vscdb"
        shutil.copy2(state_db, copy)
        conn = sqlite3.connect(f"file:{copy}?mode=ro&immutable=1", uri=True)
        try:
            row = conn.execute(
                "SELECT value FROM ItemTable WHERE key = ?", (_SESSION_INDEX_KEY,)
            ).fetchone()
        except sqlite3.DatabaseError:
            return {}
        finally:
            conn.close()
    if not row or not row[0]:
        return {}
    try:
        return json.loads(row[0]).get("entries", {})
    except (json.JSONDecodeError, AttributeError):
        return {}


def _agent_mode(agent_id: Optional[str]) -> str:
    """Coarse interaction mode from the agent id (ask vs edit/agent)."""
    a = (agent_id or "").lower()
    if "edit" in a or "agent" in a:
        return "agent"
    return "ask"


def _response_text(response: Any) -> str:
    """Join the markdown ``value`` of textual response parts; ignore the rest."""
    if not isinstance(response, list):
        return ""
    out: list[str] = []
    for part in response:
        if isinstance(part, dict) and isinstance(part.get("value"), str):
            out.append(part["value"])
    return "".join(out)


def _est_tokens(chars: int) -> int:
    return chars // _CHARS_PER_TOKEN


def parse_session(
    session_path: Path,
    *,
    project: Optional[str] = None,
    title: Optional[str] = None,
) -> Iterator[Event]:
    """Yield one ``ai_interaction`` Event per request in a session JSON file."""
    try:
        data = json.loads(session_path.read_text())
    except (OSError, json.JSONDecodeError):
        return

    session_id = data.get("sessionId") or session_path.stem
    requests = data.get("requests") or []
    request_count = len(requests)
    # Fallback event time for requests missing their own timestamp.
    session_ts = data.get("lastMessageDate") or data.get("creationDate") or 0
    # The workspace folder name can itself carry a ticket key as a last resort.
    ticket = extract_ticket(project)

    for idx, req in enumerate(requests):
        if not isinstance(req, dict):
            continue
        request_id = req.get("requestId") or f"{idx}"
        message = req.get("message") or {}
        prompt = message.get("text", "") if isinstance(message, dict) else ""
        response = _response_text(req.get("response"))
        prompt_chars = len(prompt)
        response_chars = len(response)

        agent = req.get("agent") or {}
        agent_id = agent.get("id") if isinstance(agent, dict) else None
        timings = (req.get("result") or {}).get("timings") or {}
        followups = req.get("followups") or []

        payload: dict[str, Any] = {
            "tool": "copilot",
            "session_id": session_id,
            "session_title": title or data.get("customTitle"),
            "request_id": request_id,
            "request_index": idx,
            "request_count": request_count,
            "prompt": prompt,
            "prompt_chars": prompt_chars,
            "response_chars": response_chars,
            "prompt_tokens_est": _est_tokens(prompt_chars),
            "response_tokens_est": _est_tokens(response_chars),
            "tokens_est": _est_tokens(prompt_chars + response_chars),
            "model": req.get("modelId"),
            "agent_id": agent_id,
            "agent_mode": _agent_mode(agent_id),
            "elapsed_ms": timings.get("totalElapsed"),
            "is_canceled": bool(req.get("isCanceled")),
            "followup_count": len(followups) if isinstance(followups, list) else 0,
        }

        yield Event(
            event_id=stable_event_id(Source.COPILOT, session_id, request_id),
            kind=EventKind.AI_INTERACTION,
            source=Source.COPILOT,
            ts=int(req.get("timestamp") or session_ts),
            sensitivity=_SENSITIVITY,
            payload=payload,
            project=project,
            ticket=ticket,
        )


def parse_workspace(ws: _Workspace) -> Iterator[Event]:
    """Yield events for one workspace, using the state.vscdb index as manifest."""
    index = _read_session_index(ws.state_db)
    project = ws.project()
    sessions_dir = ws.sessions_dir

    if not sessions_dir.is_dir():
        return

    for session_file in sorted(sessions_dir.glob("*.json")):
        meta = index.get(session_file.stem, {})
        # Trust the manifest's emptiness flag to skip no-op sessions cheaply.
        if meta.get("isEmpty") is True:
            continue
        yield from parse_session(
            session_file, project=project, title=meta.get("title")
        )


def collect(user_dirs: Optional[list[Path]] = None) -> Iterator[Event]:
    """Yield ``ai_interaction`` events from all local VS Code Copilot history.

    Pass ``user_dirs`` to point at specific VS Code ``User`` directories
    (used by tests); defaults to the standard macOS locations.
    """
    dirs = user_dirs if user_dirs is not None else default_user_dirs()
    for user_dir in dirs:
        storage = user_dir / "workspaceStorage"
        if not storage.is_dir():
            continue
        for storage_dir in sorted(storage.iterdir()):
            if storage_dir.is_dir():
                yield from parse_workspace(_Workspace(storage_dir))
