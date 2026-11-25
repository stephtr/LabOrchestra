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
    assert 4 <= len(taken) <= 20  # about what the client could take (a shared CI machine may take fewer)
    assert most_waiting <= 3  # two waiting at the client (and one that was on its way): no backlog
    skipped = taken[-1] - taken[0] + 1 - len(taken)
    assert skipped > 100  # the frames in between were replaced by newer ones, not queued
    assert stats["skipped"] >= skipped and stats["sent"] >= len(taken) and 0 < stats["rtt_ms"] < 50  # the slowness is not mistaken for distance


def test_a_far_away_client_still_gets_the_full_frame_rate(stream_server):
    # acknowledgements come 300 ms late, as over a long distance: with a window of 2 that would be 6 frames/s
    async def main():
        received = []
        hub = Hub(f"{stream_server}/hub/streaming", PASSPHRASE)
        loop = asyncio.get_running_loop()

        def on_frame(sub, seq, meta, data):
            received.append((loop.time(), seq))
            # the frame arrives, and the confirmation takes 300 ms to get back: that is what a far away server sees
            loop.call_later(0.3, lambda: asyncio.ensure_future(hub.send("received", sub, seq)))
            loop.call_later(0.3, lambda: asyncio.ensure_future(hub.send("ack", sub, seq)))

        hub.on("frame")(on_frame)
        await hub.start()
        await hub.wait_connected(10)
        sub = await hub.invoke("subscribe", "source", "frames", {}, 2, 30)
        await asyncio.sleep(4.0)
        stats = next(s for s in await hub.invoke("get_stats") if s["subscription"] == sub)
        await hub.close()
        return received, stats

    received, stats = asyncio.run(main())
    start = received[0][0]
    late = [t for t, _ in received if t - start > 2.0]  # after the window had time to adapt
    assert len(late) >= 24, f"{len(late)} frames in 2 s: the long round trip slowed the stream down"  # 30 fps would be 60, a window of 2 would give 13; a busy CI machine manages about 35
    assert 250 < stats["rtt_ms"] < 450 and 9 <= stats["window"] <= 64
    assert stats["in_flight"] <= stats["window"]


def test_a_far_away_and_busy_client_has_a_bounded_backlog(stream_server):
    # 300 ms away (received comes late) and slow: it processes 5 frames/s
    async def main():
        arrived, processed = [], []
        hub = Hub(f"{stream_server}/hub/streaming", PASSPHRASE)
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()

        def on_frame(sub, seq, meta, data):
            arrived.append(seq)
            queue.put_nowait((sub, seq))
            loop.call_later(0.3, lambda: asyncio.ensure_future(hub.send("received", sub, seq)))

        hub.on("frame")(on_frame)
        await hub.start()
        await hub.wait_connected(10)
        await hub.invoke("subscribe", "source", "frames", {}, 2, 30)
        worst = 0
        end = loop.time() + 4
        while loop.time() < end:
            try:
                sub, seq = await asyncio.wait_for(queue.get(), 1)
            except asyncio.TimeoutError:
                continue
            worst = max(worst, queue.qsize())
            processed.append(seq)
            await asyncio.sleep(0.2)
            await hub.send("ack", sub, seq)
        await hub.close()
        return worst, len(arrived), len(processed)

    worst, arrived, processed = asyncio.run(main())
    # The server learns that the client is busy one round trip late: 2 frames waiting plus what 300 ms put on the way (9 at 30 fps),
    # not the dozens that a window of 64 would allow. A display draws the newest frame and skips the rest.
    assert worst <= 2 + 9 + 3
    assert arrived <= processed + 16


def test_a_client_that_never_acknowledges_gets_a_bounded_number_of_frames(stream_server):
    async def main():
        received = []
        hub = Hub(f"{stream_server}/hub/streaming", PASSPHRASE)
        hub.on("frame")(lambda sub, seq, meta, data: received.append(seq))
        await hub.start()
        await hub.wait_connected(10)
        await hub.invoke("subscribe", "source", "frames", {}, 8, 30)
        await asyncio.sleep(2.0)
        count = len(received)
        await hub.close()
        return count

    assert asyncio.run(main()) == 8  # the window, not 60 frames


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
