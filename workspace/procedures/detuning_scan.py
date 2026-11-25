from laborchestra import procedure


@procedure(devices=["rf"], title="Detuning scan")
async def detuning_scan(lab, offsets_khz: list[float], duration_s: float = 60, name: str = "scan", channel: int = 0, max_offset_khz: float = 10_000):
    """Records at several detunings of the cavity.

    For every offset the generator is set to its starting frequency plus the offset, and the signal is recorded for `duration_s`.
    The generator is back at its starting frequency when the scan ends, also when it is aborted or fails.

    Args:
        offsets_khz: offsets from the starting frequency in kHz, e.g. -500, -250, 0, 250, 500
        duration_s: how long each offset is recorded
        name: recordings are called "<name>_000", "<name>_001", ...
        channel: the output of the generator
        max_offset_khz: offsets beyond this are refused, before anything is changed
    """
    too_far = [o for o in offsets_khz if abs(o) > max_offset_khz]
    if too_far:
        raise ValueError(f"The offset(s) {too_far} kHz are beyond the limit of {max_offset_khz:g} kHz")
    if duration_s <= 0:
        raise ValueError("duration_s must be greater than 0")
    base = lab.rf.state["channels"][channel]["frequency"]
    try:
        for i, offset in enumerate(lab.progress(offsets_khz, "offsets")):
            lab.status(f"offset {offset:+g} kHz")
            await lab.rf.set_frequency(channel, base + offset * 1e3)
            async with lab.recording(f"{name}_{i:03d}", tags={"offset_khz": offset, "index": i, "base_frequency_hz": base}):
                await lab.sleep(duration_s)
        lab.status("scan finished")
        return {"recordings": len(offsets_khz), "base_frequency_hz": base}
    finally:
        await lab.rf.set_frequency(channel, base)
