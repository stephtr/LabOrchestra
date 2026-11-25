"""The client's picture of the devices: a snapshot that is older than what an event already told it must not win."""

import asyncio

from laborchestra.lab import AsyncLab


def make():
    return AsyncLab("http://127.0.0.1:1", "token")


def test_an_older_snapshot_does_not_replace_a_newer_event():
    lab = make()
    lab._on_device("pressure", {"status": "ready", "state": {"a": 1}, "revision": 3, "version": 7})  # the event came first
    lab._take("pressure", {"status": "starting", "state": None, "revision": 0, "version": 5})  # then the older answer to get_devices
    assert lab._devices["pressure"]["status"] == "ready"
    lab._take("pressure", {"status": "error", "state": None, "revision": 3, "version": 9})
    assert lab._devices["pressure"]["status"] == "error"  # a newer one still wins


def test_patches_carry_the_version_on():
    lab = make()
    lab._on_device("pressure", {"status": "ready", "state": {"a": 1}, "revision": 3, "version": 7})
    lab._on_patch("pressure", 4, {"set": {"a": 2}}, 8)
    assert lab._devices["pressure"]["state"] == {"a": 2} and lab._devices["pressure"]["version"] == 8
    lab._take("pressure", {"status": "ready", "state": {"a": 1}, "revision": 3, "version": 7})  # an answer from before the patch
    assert lab._devices["pressure"]["state"] == {"a": 2}


def test_sync_keeps_what_events_said_while_it_was_asking():
    lab = make()

    async def run():
        async def invoke(method, *args):
            lab._on_device("new_one", {"status": "ready", "state": {}, "revision": 1, "version": 2})  # arrives during the call
            lab._on_device("pressure", {"status": "ready", "state": {"a": 5}, "revision": 9, "version": 10})
            return {"pressure": {"status": "starting", "state": None, "revision": 0, "version": 1}}

        lab._hub.invoke = invoke
        lab._devices["gone"] = {"status": "ready", "state": {}, "revision": 1, "version": 1}  # from before a reconnect
        await lab._sync()

    asyncio.run(run())
    assert set(lab._devices) == {"pressure", "new_one"}
    assert lab._devices["pressure"]["state"] == {"a": 5}
