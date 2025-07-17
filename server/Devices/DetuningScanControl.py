import json
import time
import socket

state = {"measurementPlan": "[]"}

argv: any
is_running: bool
send_status_update: callable
get_device_state: callable
action: callable

phase_noise_control_port = 65432


def saveMeasurementPlan(measurementPlan):
    state["measurementPlan"] = measurementPlan


def startScan(measurementPlan):
    state["measurementPlan"] = measurementPlan
    measurementPlan = json.loads(measurementPlan)
    main_state = get_device_state("main")
    initial_filename = main_state["Filename"]
    rfgen_state = get_device_state("cavity_detuning")
    base_frequency = rfgen_state["channels"][0]["frequency"]
    if base_frequency < 8e9 or base_frequency > 10e9:
        raise Exception(f"Cavity detuning generator frequency ({base_frequency/1e3} kHz) is out of range (8-10 GHz)")
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
    
    def wait_for_recording_to_finish():
        while is_running:
            main_state = get_device_state("main")
            if not main_state["IsRecording"]:
                break
            time.sleep(0.25)

    try:
        try:
            phase_noise_control = socket.create_connection(("127.0.0.1", phase_noise_control_port), timeout=0.5)
        except:
            phase_noise_control = None
        for i, measurement in enumerate(measurements):
            action(
                "cavity_detuning", None, "set_frequency", [0, measurement["frequency"]]
            )
            
            if phase_noise_control:
                phase_noise_control.sendall(b'pause')
                time.sleep(0.5)
                
                action("main", None, "setFilename", [f"{initial_filename} SCAN_{i}_pre"])
                action("main", None, "startRecording", [20])
                wait_for_recording_to_finish()
            
                phase_noise_control.sendall(b'resume')
                time.sleep(0.5)

            action("main", None, "setFilename", [f"{initial_filename} SCAN_{i}"])
            action("main", None, "startRecording", [int(measurement["duration"] * 60)])
            action(
                "main",
                None,
                "setRemainingAdditionalRecordings",
                [len(measurements) - i - 1],
            )
            wait_for_recording_to_finish()
            
            if phase_noise_control:
                phase_noise_control.sendall(b'pause')
                time.sleep(0.5)
                
                action("main", None, "setFilename", [f"{initial_filename} SCAN_{i}_post"])
                action("main", None, "startRecording", [20])
                wait_for_recording_to_finish()
            
                phase_noise_control.sendall(b'resume')

    finally:
        action("main", None, "setRemainingAdditionalRecordings", [0])
        action("main", None, "setFilename", [initial_filename])
        action("cavity_detuning", None, "set_frequency", [0, base_frequency])
        if phase_noise_control:
            phase_noise_control.close()


def get_settings():
    return state


def load_settings(settings):
    global state
    state = settings


def on_save_snapshot():
    return None
