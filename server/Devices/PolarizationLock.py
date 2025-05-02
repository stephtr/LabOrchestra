import time
import numpy as np

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
    print("PolarizationLock: start")
    state["lockH"] = True
    send_status_update()


def stop_polarization_lock():
    state["lockH"] = False
    send_status_update()


def main():
    correct_QWP_next = False
    while is_running:
        try:
            polarizationState = get_device_state(argv.polarizationDeviceName)
            if polarizationState["status"] != "ok" or polarizationState["DOP"] < 0.8:
                raise Exception()
            theta = np.rad2deg(polarizationState["theta"])
            eta = np.rad2deg(polarizationState["eta"])
            out_of_lock_range = bool(np.abs(theta) > 5 or np.abs(eta) > 5)
            if state["outOfLockRange"] != out_of_lock_range:
                state["outOfLockRange"] = out_of_lock_range
                send_status_update()
            if not state["lockH"]:
                raise Exception()
            if out_of_lock_range:
                print("PolarizationLock: polarization out of lock range (+- 5°)")
                raise Exception()

            waveplateState = get_device_state(argv.waveplateDeviceName)
            QWP_channel = waveplateState["channels"][argv.waveplateQWPChannel]
            HWP_channel = waveplateState["channels"][argv.waveplateHWPChannel]
            if QWP_channel["type"] != "rotation" or HWP_channel["type"] != "rotation":
                print("PolarizationLock: waveplate channels are not rotation")
                raise Exception()
            if correct_QWP_next:
                action(
                    argv.waveplateDeviceName,
                    argv.waveplateQWPChannel,
                    "set_position",
                    [QWP_channel["targetPosition"] - eta / 2],
                )
            else:
                action(
                    argv.waveplateDeviceName,
                    argv.waveplateHWPChannel,
                    "set_position",
                    [HWP_channel["targetPosition"] - theta / 2],
                )
            correct_QWP_next = not correct_QWP_next
        except:
            pass
        wait()

def on_save_snapshot():
    return None
