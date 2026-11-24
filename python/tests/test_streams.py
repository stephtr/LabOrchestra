"""Streams: frames per client when the client can take them, never a backlog, every client its own view."""

import asyncio
import json
import time

import pytest

import laborchestra
from helpers import PASSPHRASE, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError
from laborchestra._hub import Hub


@pytest.fixture(scope="module")
def stream_server(tmp_path_factory):
    build_server()
    workspace, data = tmp_path_factory.mktemp("workspace"), tmp_path_factory.mktemp("data")
    devices = {"source": {"driver": "demo_stream", "config": {"frames_per_second": 200, "size": 8}}, "plain": {"driver": "demo_counter"}}
    (workspace / "devices.json").write_text(json.dumps({"devices": devices}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url)
    try:
        yield url
    finally:
        print(stop_server(process, log, workspace, url))


@pytest.fixture()
def lab(stream_server):
    with laborchestra.connect(stream_server, PASSPHRASE) as lab:
        lab.source.wait_ready(30)
        lab.plain.wait_ready(30)
        yield lab


def test_frames_arrive_in_order_with_their_data(lab):
    assert lab.source.schema["streams"] == ["frames"]
    with lab.stream("source", "frames") as frames:
        got = [frames.next(5) for _ in range(15)]
    sequences = [f.sequence for f in got]
    assert sequences == sorted(set(sequences)) and len(sequences) == 15  # strictly increasing
    assert all(f.meta == {"size": 8, "scale": 1.0} and len(f.data) == 32 for f in got)
    assert all(f.values()[0] == f.sequence and f.values()[1:] == [1, 2, 3, 4, 5, 6, 7] for f in got)  # the data is the frame's own
    assert got[0].array.dtype.name == "float32"


def test_a_slow_client_gets_fewer_frames_and_nothing_piles_up(lab):
    with lab.stream("source", "frames", window=2) as frames:
        taken, most_waiting = [], 0
        end = time.time() + 1.5
        while time.time() < end:
            taken.append(frames.next(5).sequence)
            most_waiting = max(most_waiting, frames.queued)
            time.sleep(0.1)  # 10 frames/s from a source that makes 200
        stats = frames.stats()
    assert 8 <= len(taken) <= 20  # about what the client could take
    assert most_waiting <= 2  # never more than the window
    skipped = taken[-1] - taken[0] + 1 - len(taken)
    assert skipped > 100  # the frames in between were replaced by newer ones, not queued
    assert stats["skipped"] >= skipped and stats["sent"] >= len(taken) and stats["rtt_ms"] > 0


def test_without_acknowledgements_exactly_the_window_is_sent(stream_server):
    async def main():
        received = []
        hub = Hub(f"{stream_server}/hub/streaming", PASSPHRASE)
        hub.on("frame")(lambda sub, seq, meta, data: received.append(seq))
        await hub.start()
        await hub.wait_connected(10)
        sub = await hub.invoke("subscribe", "source", "frames", {}, 3, 30)
        await asyncio.sleep(1.0)
        before = len(received)
        await hub.send("ack", sub, received[0])  # one acknowledged: one more may come
        await asyncio.sleep(0.5)
        after_one = len(received)
        await hub.close()
        return before, after_one

    before, after_one = asyncio.run(main())
    assert before == 3 and after_one == 4


def test_every_client_can_ask_for_its_own_view(stream_server, lab):
    with laborchestra.connect(stream_server, PASSPHRASE) as other:
        with lab.stream("source", "frames", {"scale": 2.0}) as mine, other.stream("source", "frames", {"scale": 5.0}) as theirs:
            assert mine.next(5).meta["scale"] == 2.0 and theirs.next(5).meta["scale"] == 5.0
            mine.update({"scale": 3.0})
            wait_for(lambda: mine.next(5).meta["scale"] == 3.0, 5, "the new view")
            assert theirs.next(5).meta["scale"] == 5.0  # not affected


def test_a_fast_and_a_slow_client_do_not_disturb_each_other(lab):
    with lab.stream("source", "frames", window=2) as fast, lab.stream("source", "frames", window=2) as slow:
        slow_taken = fast_taken = 0
        end = time.time() + 1.0
        while time.time() < end:
            fast.next(5)
            fast_taken += 1
            if fast_taken % 10 == 0:
                slow.next(5)
                slow_taken += 1
    assert fast_taken > 5 * slow_taken > 0  # the slow one did not hold the fast one back (it is capped at 30 fps by the server)


def test_unsubscribing_and_disconnecting_clean_up(stream_server, lab):
    stream = lab.stream("source", "frames")
    with stream as frames:
        frames.next(5)
        assert frames.stats()["sent"] >= 1
    time.sleep(0.3)
    with laborchestra.connect(stream_server, PASSPHRASE) as other:
        with other.stream("source", "frames") as frames:
            frames.next(5)
            assert len([s for s in [frames.stats()] if s]) == 1  # only this client's subscription is listed


def test_mistakes_are_explained(lab):
    with pytest.raises(RemoteError, match="has no stream 'nope'.*frames") as e:
        with lab.stream("source", "nope"):
            pass
    assert e.value.type == "LookupError"
    with pytest.raises(RemoteError, match="offers no streams"):
        with lab.stream("plain", "x"):
            pass
    with pytest.raises(RemoteError, match="does not exist"):
        with lab.stream("ghost", "x"):
            pass
