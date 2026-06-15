"""Tests for the Copilot collector against a synthetic VS Code storage tree.

The fixtures mirror the real on-disk format observed on macOS: a ``state.vscdb``
SQLite key/value table with a ``chat.ChatSessionStore.index`` manifest, plus
``chatSessions/<id>.json`` content files and a ``workspace.json``.
"""

import json
import sqlite3
from pathlib import Path

from postcaptain.collectors import copilot
from postcaptain.events import EventKind, Sensitivity, Source


def _write_state_db(storage_dir: Path, entries: dict) -> None:
    db = storage_dir / "state.vscdb"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
    conn.execute(
        "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
        ("chat.ChatSessionStore.index", json.dumps({"version": 1, "entries": entries})),
    )
    conn.commit()
    conn.close()


def _session(session_id, requests, last=123):
    return {
        "version": 3,
        "sessionId": session_id,
        "requesterUsername": "tester",
        "responderUsername": "GitHub Copilot",
        "creationDate": last,
        "lastMessageDate": last,
        "requests": requests,
    }


def _make_workspace(tmp_path: Path) -> Path:
    """Build one workspaceStorage/<hash> dir; return the VS Code User dir."""
    user = tmp_path / "Code" / "User"
    storage = user / "workspaceStorage" / "deadbeef"
    sessions = storage / "chatSessions"
    sessions.mkdir(parents=True)

    (storage / "workspace.json").write_text(
        json.dumps({"folder": "file:///Users/tester/Web/ABC-123-demo"})
    )

    sid_full = "11111111-1111-1111-1111-111111111111"
    sid_empty = "22222222-2222-2222-2222-222222222222"

    requests = [
        {
            "requestId": "req-0",
            "message": {"text": "Fix these type errors please"},
            "response": [{"value": "Here is the fix: ..."}],
            "modelId": "copilot/gpt-4.1",
            "agent": {"id": "github.copilot.editsAgent"},
            "result": {"timings": {"firstProgress": 100, "totalElapsed": 500}},
            "followups": [],
            "isCanceled": False,
            "timestamp": 1758000000000,
        },
        {
            "requestId": "req-1",
            "message": {"text": "still broken, try again"},
            "response": [{"value": "Updated."}, {"toolId": "x"}],  # non-text part ignored
            "modelId": "copilot/gpt-4.1",
            "agent": {"id": "github.copilot.default"},
            "result": {"timings": {"totalElapsed": 200}},
            "isCanceled": True,
            "timestamp": 1758000100000,
        },
    ]
    (sessions / f"{sid_full}.json").write_text(json.dumps(_session(sid_full, requests)))
    (sessions / f"{sid_empty}.json").write_text(json.dumps(_session(sid_empty, [])))

    _write_state_db(
        storage,
        {
            sid_full: {"sessionId": sid_full, "title": "Type errors", "isEmpty": False},
            sid_empty: {"sessionId": sid_empty, "title": "Empty", "isEmpty": True},
        },
    )
    return user


def test_collect_emits_one_event_per_request(tmp_path):
    user = _make_workspace(tmp_path)
    events = list(copilot.collect(user_dirs=[user]))
    # 2 requests from the full session; the empty session is skipped via manifest.
    assert len(events) == 2


def test_event_fields_and_payload(tmp_path):
    user = _make_workspace(tmp_path)
    events = list(copilot.collect(user_dirs=[user]))
    first = next(e for e in events if e.payload["request_index"] == 0)

    assert first.kind is EventKind.AI_INTERACTION
    assert first.source is Source.COPILOT
    assert first.sensitivity is Sensitivity.SENSITIVE
    assert first.ts == 1758000000000
    assert first.project == "ABC-123-demo"
    assert first.ticket == "ABC-123"  # extracted from the workspace folder name

    p = first.payload
    assert p["model"] == "copilot/gpt-4.1"
    assert p["agent_mode"] == "agent"  # editsAgent → agent
    assert p["request_count"] == 2
    assert p["elapsed_ms"] == 500
    assert p["session_title"] == "Type errors"
    # chars ÷ 4 heuristic
    assert p["prompt_tokens_est"] == len("Fix these type errors please") // 4
    assert p["tokens_est"] == p["prompt_tokens_est"] + p["response_tokens_est"]


def test_event_id_is_stable_and_idempotent(tmp_path):
    user = _make_workspace(tmp_path)
    ids1 = sorted(e.event_id for e in copilot.collect(user_dirs=[user]))
    ids2 = sorted(e.event_id for e in copilot.collect(user_dirs=[user]))
    assert ids1 == ids2
    assert ids1[0].startswith("copilot:")


def test_response_text_only_joins_textual_parts(tmp_path):
    user = _make_workspace(tmp_path)
    events = list(copilot.collect(user_dirs=[user]))
    second = next(e for e in events if e.payload["request_index"] == 1)
    assert second.payload["response_chars"] == len("Updated.")
    assert second.payload["is_canceled"] is True
    assert second.payload["agent_mode"] == "ask"


def test_missing_storage_is_noop(tmp_path):
    assert list(copilot.collect(user_dirs=[tmp_path / "nope"])) == []
