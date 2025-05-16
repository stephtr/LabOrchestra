import time
import numpy as np

correction_eta = np.deg2rad(0.2)
correction_theta = np.deg2rad(1.2)

state = {"lockH": False, "outOfLockRange": True}

argv: any
is_running: bool
send_status_update: callable
get_device_state: callable
action: callable

if not hasattr(argv, "polarizationDeviceName"):
    raise ValueError("`polarizationDeviceName` is required")
if not hasattr(argv, "waveplateDeviceName"):
    raise ValueError("`waveplateDeviceName` is required")
if not hasattr(argv, "waveplateQWPChannel") or not hasattr(argv, "waveplateHWPChannel"):
    raise ValueError("`waveplateQWPChannel` and `waveplateHWPChannel` are required")


def wait():
    time.sleep(1)


def start_polarization_lock():
    state["lockH"] = True


def stop_polarization_lock():
    state["lockH"] = False


def main():
    correct_QWP_next = False
    while is_running:
        try:
            polarizationState = get_device_state(argv.polarizationDeviceName)
            if polarizationState["status"] != "ok" or polarizationState["DOP"] < 0.8:
                wait()
                continue
            theta = np.rad2deg(polarizationState["theta"]) - correction_theta
            eta = np.rad2deg(polarizationState["eta"]) - correction_eta
            out_of_lock_range = bool(np.abs(theta) > 5 or np.abs(eta) > 5)
            if state["outOfLockRange"] != out_of_lock_range:
                state["outOfLockRange"] = out_of_lock_range
                send_status_update()
            if not state["lockH"]:
                wait()
                continue
            if out_of_lock_range:
                raise Exception("PolarizationLock: polarization out of lock range (+- 5°)")

            waveplateState = get_device_state(argv.waveplateDeviceName)
            QWP_channel = waveplateState["channels"][argv.waveplateQWPChannel]
            HWP_channel = waveplateState["channels"][argv.waveplateHWPChannel]
            if QWP_channel["type"] != "rotation" or HWP_channel["type"] != "rotation":
                raise Exception("PolarizationLock: waveplate channels are not rotation")

            if correct_QWP_next and np.abs(eta) < 0.2:
                if np.abs(theta) > 0.2:
                    correct_QWP_next = False
                else:
                    wait()
                    continue

            if correct_QWP_next:
                action(
                    argv.waveplateDeviceName,
                    None,
                    "set_position",
                    [argv.waveplateQWPChannel, QWP_channel["targetPosition"] + eta / 2],
                )
            else:
                action(
                    argv.waveplateDeviceName,
                    None,
                    "set_position",
                    [argv.waveplateHWPChannel, HWP_channel["targetPosition"] + theta / 2],
                )
            correct_QWP_next = not correct_QWP_next
        except Exception as e:
            print(f"PolarizationLock: error {e}")
            pass
        wait()


def on_save_snapshot():
    return None
