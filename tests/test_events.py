from postcaptain.events import (
    Event,
    EventKind,
    Sensitivity,
    Source,
    extract_ticket,
    stable_event_id,
)


def test_extract_ticket_from_branch():
    assert extract_ticket("ABC-123-new-feature") == "ABC-123"
    assert extract_ticket("feature/PROJ-42-thing") == "PROJ-42"


def test_extract_ticket_first_match_and_fallback_order():
    assert extract_ticket(None, "", "see WEB-9 for context") == "WEB-9"
    assert extract_ticket("no key here", "DEV-7") == "DEV-7"


def test_extract_ticket_none():
    assert extract_ticket("just-a-branch", None) is None
    # lowercase / no number should not match
    assert extract_ticket("abc-123") is None


def test_stable_event_id_is_deterministic():
    a = stable_event_id(Source.COPILOT, "sess", "req")
    b = stable_event_id("copilot", "sess", "req")
    assert a == b == "copilot:sess:req"


def test_sensitivity_rank_ordering():
    assert Sensitivity.LOW.rank < Sensitivity.MEDIUM.rank < Sensitivity.SENSITIVE.rank


def test_event_coerces_string_enums():
    e = Event(
        event_id="x",
        kind="ai_interaction",
        source="copilot",
        ts=1,
        sensitivity="sensitive",
        payload={},
    )
    assert e.kind is EventKind.AI_INTERACTION
    assert e.source is Source.COPILOT
    assert e.sensitivity is Sensitivity.SENSITIVE
