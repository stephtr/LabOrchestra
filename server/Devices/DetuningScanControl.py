import json
import time

state = {"measurementPlan": "[]"}

argv: any
is_running: bool
send_status_update: callable
get_device_state: callable
action: callable


def saveMeasurementPlan(measurementPlan):
    state["measurementPlan"] = measurementPlan


def startScan(measurementPlan):
    state["measurementPlan"] = measurementPlan
    measurementPlan = json.loads(measurementPlan)
    main_state = get_device_state("main")
    initial_filename = main_state["filename"]
    rfgen_state = get_device_state("cavity_detuning")
    base_frequency = rfgen_state["channels"][0]["frequency"]
    if base_frequency < 8e9 or base_frequency > 10e9:
        raise Exception("Cavity detuning generator offset is out of range (8-10 GHz)")
    measurements = []
    for measurement in measurementPlan:
        if "offset" not in measurement or "duration" not in measurement:
            raise Exception(
                "Measurement plan must contain 'offset' and 'duration' keys"
            )
        if not isinstance(measurement["offset"], (int, float)) or not isinstance(
            measurement["duration"], (int, float)
        ):
            raise Exception("'offset' and 'duration' must be numbers")
        if measurement["duration"] <= 0:
            raise Exception("'duration' must be greater than 0")
        if measurement["offset"] < -10e6 or measurement["offset"] > 10e6:
            raise Exception("'offset' must be within +-10 MHz")
        measurements.append(
            {
                "frequency": base_frequency + measurement["offset"],
                "duration": measurement["duration"],
            }
        )

    try:
        for i, measurement in enumerate(measurements):
            action("main", None, "setFilename", [f"{initial_filename} SCAN_{i}"])
            action(
                "cavity_detuning", None, "set_frequency", [0, measurement["frequency"]]
            )
            action("main", None, "startRecording", [int(measurement["duration"] * 60)])
            action(
                "main",
                None,
                "setRemainingAdditionalRecordings",
                [len(measurements) - i - 1],
            )
            while is_running:
                main_state = get_device_state("main")
                if not main_state["isRecording"]:
                    break
                time.sleep(0.1)
    finally:
        action("main", None, "setRemainingAdditionalRecordings", [0])
        action("main", None, "setFilename", [initial_filename])
        action("cavity_detuning", None, "set_frequency", [0, base_frequency])


def get_settings():
    return state


def load_settings(settings):
    global state
    state = settings


def on_save_snapshot():
    return None
