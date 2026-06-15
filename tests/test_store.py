from postcaptain.events import Event, EventKind, Sensitivity, Source
from postcaptain.store import EventStore


def _ev(event_id="copilot:s:r", ts=1000, project="repo", ticket="ABC-1"):
    return Event(
        event_id=event_id,
        kind=EventKind.AI_INTERACTION,
        source=Source.COPILOT,
        ts=ts,
        sensitivity=Sensitivity.SENSITIVE,
        payload={"prompt": "hi", "tokens_est": 3},
        project=project,
        ticket=ticket,
    )


def test_roundtrip(tmp_path):
    with EventStore(tmp_path / "t.db") as store:
        assert store.add(_ev()) is True
        got = store.query(kind=EventKind.AI_INTERACTION)
        assert len(got) == 1
        e = got[0]
        assert e.event_id == "copilot:s:r"
        assert e.payload["tokens_est"] == 3
        assert e.ticket == "ABC-1"


def test_insert_is_idempotent(tmp_path):
    with EventStore(tmp_path / "t.db") as store:
        assert store.add(_ev()) is True
        assert store.add(_ev()) is False  # same event_id → ignored
        assert store.count() == 1


def test_query_filters(tmp_path):
    with EventStore(tmp_path / "t.db") as store:
        store.add_many(
            [
                _ev(event_id="a", ts=100, project="p1", ticket="ABC-1"),
                _ev(event_id="b", ts=200, project="p2", ticket="ABC-2"),
                _ev(event_id="c", ts=300, project="p1", ticket="ABC-1"),
            ]
        )
        assert len(store.query(project="p1")) == 2
        assert len(store.query(ticket="ABC-2")) == 1
        assert len(store.query(since=150, until=250)) == 1
        # ordered ascending by ts
        ids = [e.event_id for e in store.query()]
        assert ids == ["a", "b", "c"]
