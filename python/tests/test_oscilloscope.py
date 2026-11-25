"""The oscilloscope pipeline with the simulated acquisition: channel 0 has a tone at 100 kHz, channel 1 at 200 kHz, sample rate 2 MS/s."""

import json
import os
import signal
import time

import numpy as np
import pytest

import laborchestra
from helpers import PASSPHRASE, build_server, free_port, launch, stop_server, wait_for
from laborchestra import RemoteError

NO_DECIMATION = {"max_points": 100000}


@pytest.fixture(scope="module")
def osc_server(tmp_path_factory):
    build_server()
    workspace, data = tmp_path_factory.mktemp("workspace"), tmp_path_factory.mktemp("data")
    (workspace / "devices.json").write_text(json.dumps({"devices": {"osc": {"driver": "simulated_oscilloscope"}}}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url)
    try:
        yield url, data
    finally:
        print(stop_server(process, log, workspace, url))


@pytest.fixture()
def lab(osc_server):
    with laborchestra.connect(osc_server[0], PASSPHRASE) as lab:
        lab.osc.wait_ready(30)
        lab.osc.set_display_mode("fft")
        lab.osc.set_fft_bin_count(8192)
        lab.osc.set_channel_active(2, False)
        yield lab


def frame_with(frames, condition, timeout=15):
    """The first frame (from now on) that satisfies the condition."""
    end = time.time() + timeout
    while time.time() < end:
        frame = frames.next(5)
        if condition(frame):
            return frame
    raise AssertionError("no frame like that")


def spectra(frame):
    meta = frame.meta
    values = frame.array.reshape(len(meta["channels"]), meta["length"])
    return np.linspace(meta["x_min_decimated"], meta["x_max_decimated"], meta["length"]), values


def test_the_spectrum_shows_the_tones_where_they_are(lab):
    schema = lab.osc.schema
    assert schema["class"] == "SimulatedOscilloscope" and schema["streams"] == ["display"]
    assert {"start", "stop", "set_range", "set_channel_active", "set_coupling", "set_fft_frequency", "set_fft_bin_count",
            "set_averaging_mode", "set_fft_averaging_duration", "set_fft_window_function", "set_display_mode",
            "reset_fft_storage", "get_fft"} <= {a["name"] for a in schema["actions"]}
    wait_for(lambda: lab.osc.state["running"] and lab.osc.state["sample_rate"] == 2e6, 20, "running at 2 MS/s")

    with lab.stream("osc", "display", NO_DECIMATION) as frames:
        frame = frame_with(frames, lambda f: f.meta["mode"] == "fft" and f.meta["fft_length"] == 8192)
        time.sleep(1.0)  # the averaging settles
        frame = frame_with(frames, lambda f: True)
    meta = frame.meta
    assert meta["channels"] == [0, 1] and meta["length"] == 4097 and not meta["envelope"] and meta["sample_rate"] == 2e6
    assert (meta["x_min"], meta["x_max"]) == (0, 1e6)
    f, values = spectra(frame)
    for row, tone in zip(values, (100e3, 200e3)):
        assert abs(f[np.argmax(row)] - tone) <= 500  # a bin is 244 Hz
        assert row.max() - np.median(row) > 40  # dB above the noise


def test_zooming_and_decimation(lab):
    with lab.stream("osc", "display", {"x_min": 90e3, "x_max": 110e3, "max_points": 100000}) as frames:
        frame = frame_with(frames, lambda f: f.meta["x_max_decimated"] < 120e3)
        f, values = spectra(frame)
        assert abs(f[0] - 90e3) < 500 and abs(f[-1] - 110e3) < 500 and len(f) < 100  # only the part asked for
        assert abs(f[np.argmax(values[0])] - 100e3) <= 500

        frames.update({"max_points": 2000})  # the whole range, reduced to what a screen can show
        frame = frame_with(frames, lambda f: f.meta["envelope"])
    f, values = spectra(frame)
    assert len(f) < 2200 and len(f) % 2 == 0
    assert values[0].max() - np.median(values[0]) > 40  # the peak survives: it is the maximum of its bucket


def test_the_time_trace_has_the_amplitude_and_length_of_the_signal(lab):
    lab.osc.set_display_mode("time")
    with lab.stream("osc", "display", NO_DECIMATION) as frames:
        frame = frame_with(frames, lambda f: f.meta["mode"] == "time")
    _, values = spectra(frame)
    assert abs(frame.meta["x_max"] - 8191 / 2e6) < 1e-9  # the length of an FFT block
    assert 0.36 < values[0].max() < 0.44 and -0.44 < values[0].min() < -0.36  # 0.4 x range 1 V
    lab.osc.set_display_mode("fft")


def test_controls_change_the_pipeline_and_mistakes_are_explained(lab):
    lab.osc.set_fft_bin_count(1024)
    with lab.stream("osc", "display", NO_DECIMATION) as frames:
        frame = frame_with(frames, lambda f: f.meta["fft_length"] == 1024)
        assert frame.meta["length"] == 513
        lab.osc.set_channel_active(2, True)
        assert frame_with(frames, lambda f: f.meta["channels"] == [0, 1, 2]).meta["channels"] == [0, 1, 2]
        lab.osc.set_channel_active(2, False)
    with pytest.raises(RemoteError, match="power of two") as e:
        lab.osc.set_fft_bin_count(1000)
    assert e.value.type == "ValueError"
    with pytest.raises(RemoteError, match="Unknown window function 'nope'"):
        lab.osc.set_fft_window_function("nope")
    with pytest.raises(RemoteError, match="no channel 9"):
        lab.osc.set_channel_active(9, True)
    with pytest.raises(RemoteError, match="Invalid coupling"):
        lab.osc.set_coupling(0, "XX")
    lab.osc.set_fft_window_function("hann")
    assert lab.osc.state["fft_window_function"] == "hann"
    lab.osc.set_fft_window_function("blackman")


def test_the_fft_agrees_with_a_plain_dft_and_get_fft_returns_the_spectrum(lab):
    assert lab.osc.state["fft_engine"] == ("managed" if os.environ.get("LABORCHESTRA_MANAGED_FFT") else "pffft")  # CI must build the native library
    assert lab.osc.fft_self_test() < 1e-3
    lab.osc.set_fft_bin_count(8192)
    wait_for(lambda: lab.osc.get_fft(0, 90e3, 110e3)[0], 10, "a spectrum")
    time.sleep(0.8)
    f, psd = lab.osc.get_fft(0, 90e3, 110e3)
    assert abs(f[int(np.argmax(psd))] - 100e3) <= 500 and 80e3 < f[0] and f[-1] < 120e3


def test_stopping_stops_the_frames_and_starting_resumes_them(lab):
    with lab.stream("osc", "display", NO_DECIMATION) as frames:
        frames.next(5)
        lab.osc.stop()
        assert lab.osc.state["running"] is False
        time.sleep(0.5)
        while True:
            try:
                frames.next(0.6)  # what was already on its way
            except TimeoutError:
                break
        lab.osc.start()
        assert lab.osc.state["running"] is True
        frames.next(10)  # frames again


def test_a_recording_has_the_channels_as_continuous_npy_files(osc_server, lab):
    name = f"osc {int(time.time() * 1000)}"
    start = time.time()
    with lab.recording(name):
        time.sleep(1.5)
        assert lab.osc.state["recording"] is True
    seconds = time.time() - start
    rec = laborchestra.load_recording(osc_server[1] / "recordings" / name)
    c1, c2 = rec.channel("osc", 1), rec.channel("osc", 2)
    assert c1.dtype == np.float32 and len(c1) == len(c2)
    assert 1.2 * 2e6 < len(c1) < (seconds + 0.2) * 2e6  # about as many samples as the time at 2 MS/s
    assert 0.36 < np.abs(c1[:100000]).max() < 0.44

    # continuous: no gaps, so a clean spectral line (a gap would smear it)
    spectrum = np.abs(np.fft.rfft(np.asarray(c1[:1 << 18]) * np.hanning(1 << 18))) ** 2
    freq = np.fft.rfftfreq(1 << 18, 1 / 2e6)
    assert abs(freq[np.argmax(spectrum)] - 100e3) < 50
    assert 10 * np.log10(spectrum.max() / np.median(spectrum)) > 60
    f2 = np.fft.rfftfreq(1 << 18, 1 / 2e6)[np.argmax(np.abs(np.fft.rfft(np.asarray(c2[:1 << 18]) * np.hanning(1 << 18))))]
    assert abs(f2 - 200e3) < 50

    averaged, axis = np.load(rec.base / "osc_F1.npy"), np.load(rec.base / "osc_f.npy")
    assert len(averaged) == len(axis) == 4097 and abs(axis[np.argmax(averaged)] - 100e3) <= 500
    assert rec.header["final_state"]["osc"]["state"]["sample_rate"] == 2e6


def test_after_a_crash_the_npy_files_of_the_recording_are_repaired(tmp_path):
    workspace, data = tmp_path / "workspace", tmp_path / "data"
    workspace.mkdir()
    (workspace / "devices.json").write_text(json.dumps({"devices": {"osc": {"driver": "simulated_oscilloscope"}}}))
    url = f"http://127.0.0.1:{free_port()}"
    first, log1 = launch(workspace, data, url)
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            lab.osc.wait_ready(30)
            lab.start_recording("crash")
            time.sleep(1.5)
        first.kill()  # the writers never get to finish their files
        first.wait()
    finally:
        log1.close()
    raw = data / "recordings" / "crash" / "osc_C1.npy"
    assert np.load(raw).shape == (0,)  # the header still says: nothing

    second, log2 = launch(workspace, data, f"http://127.0.0.1:{free_port()}")
    try:
        repaired = np.load(raw)
        assert len(repaired) > 1_000_000 and repaired.dtype == np.float32
        assert laborchestra.load_recording(data / "recordings" / "crash").interrupted
    finally:
        second.terminate()
        second.wait(20)
        log2.close()


def test_a_picoscope_without_the_sdk_says_what_to_install(tmp_path_factory):
    """No hardware in CI: both drivers must load, and without the PicoSDK (or a unit) the device reports why instead of crashing."""
    build_server()
    workspace, data = tmp_path_factory.mktemp("workspace"), tmp_path_factory.mktemp("data")
    (workspace / "devices.json").write_text(json.dumps({"devices": {"ps5": {"driver": "picoscope_5000a"}, "ps4": {"driver": "picoscope_4000a"}}}))
    url = f"http://127.0.0.1:{free_port()}"
    process, log = launch(workspace, data, url)
    try:
        with laborchestra.connect(url, PASSPHRASE) as lab:
            assert {"picoscope_4000a", "picoscope_5000a"} <= {d["driver"] for d in lab.list_drivers()}
            for device in (lab.ps5, lab.ps4):
                wait_for(lambda: device.status == "error" and device.error, 30, "error of a missing unit")
            assert "PicoSDK" in lab.ps5.error or "No Picoscope" in lab.ps5.error
    finally:
        print(stop_server(process, log, workspace, url))


def test_the_oscilloscope_fits_its_profile_and_names_the_units_of_its_fields(lab):
    from laborchestra.profiles import FrequencyGenerator, Oscilloscope, check_schema

    schema = lab.osc.schema
    # an oscilloscope with a signal generator: two profiles, the second one with its state under "generator" (both have "channels")
    assert sorted(schema["profiles"], key=lambda p: p["name"]) == [{"name": "frequency_generator", "version": 1, "at": "generator"}, {"name": "oscilloscope", "version": 1}]
    assert schema["units"] == {"fft_frequency": "Hz", "sample_rate": "Hz", "channels.*.range_in_millivolts": "mV",
                               "generator.channels.*.frequency": "Hz", "generator.channels.*.power": "dBm"}
    problems = check_schema(Oscilloscope, schema, lab.osc.state)
    assert not problems, "\n".join(problems)  # every action of the profile, with its parameters, and the typed state
    problems = check_schema(FrequencyGenerator.at("generator"), schema, lab.osc.state)
    assert not problems, "\n".join(problems)
    broken = {**schema, "actions": [a for a in schema["actions"] if a["name"] != "set_coupling"]}
    assert check_schema(Oscilloscope, broken) == ["the action set_coupling is missing"]


def peak(lab, settle=1.0):
    with lab.stream("osc", "display", NO_DECIMATION) as frames:
        frame_with(frames, lambda f: f.meta["mode"] == "fft" and f.meta["fft_length"] == 8192)
        time.sleep(settle)
        f, values = spectra(frame_with(frames, lambda f: True))
    return f[np.argmax(values[0])], values[0].max() - np.median(values[0])


def test_the_signal_generator_is_a_frequency_generator_next_to_the_oscilloscope(lab):
    osc = lab.osc
    try:
        osc.set_frequency(0, 150e3)
        assert osc.state["generator"]["channels"][0]["frequency"] == 150e3  # the state shows the effect when the action returns
        position, height = peak(lab)
        assert abs(position - 150e3) <= 500 and height > 40
        osc.set_on(0, False)
        assert osc.state["generator"]["channels"][0]["is_on"] is False
        wait_for(lambda: peak(lab, 0.2)[1] < 20, 20, "only noise to be left")  # the averaging forgets the tone within seconds
    finally:
        osc.set_frequency(0, 100e3)
        osc.set_on(0, True)
    with pytest.raises(RemoteError, match="no generator channel 3"):
        osc.set_frequency(3, 1e3)
    with pytest.raises(RemoteError, match="must be positive"):
        osc.set_frequency(0, 0)


def test_only_picoscopes_with_a_signal_generator_offer_one(lab):
    names = lambda d: sorted(p["name"] for p in d["profiles"])
    actions = lambda d: {a["name"] for a in d["actions"]}
    ps5, ps4 = lab.describe_driver("picoscope_5000a"), lab.describe_driver("picoscope_4000a")
    assert names(ps5) == ["frequency_generator", "oscilloscope"] and {"set_frequency", "set_power", "set_on"} <= actions(ps5)
    assert names(ps4) == ["oscilloscope"] and not {"set_frequency", "set_power", "set_on"} & actions(ps4)
    assert {"generator.channels.*.frequency": "Hz", "generator.channels.*.power": "dBm"}.items() <= ps5["units"].items()
