import time
import random
from typing import Callable

state = {"channels": []}

is_running: bool
send_status_update: Callable[[], None]

num_channels = 0


def set_position(iChannel, position, mode):
    if iChannel < 0 or iChannel >= num_channels:
        raise Exception("Invalid channel number")
    channel = state["channels"][iChannel]
    if channel["mode"] != mode:
        raise Exception("Invalid move mode")
    channel["targetPosition"] = position


def set_mode(channel, mode):
    if channel < 0 or channel >= num_channels:
        raise Exception("Invalid channel number")
    if not mode in ["closed-loop", "open-loop", "scan"]:
        raise Exception("Invalid move mode")
    state["channels"][channel]["mode"] = mode


def set_velocity(iChannel, velocity, mode):
    if iChannel < 0 or iChannel >= num_channels:
        raise Exception("Invalid channel number")
    channel = state["channels"][iChannel]
    if channel["mode"] != mode:
        raise Exception("Invalid move mode")
    channel["velocity"] = velocity


def stop():
    pass


def main():
    global num_channels
    num_channels = 3
    for i in range(num_channels):
        state["channels"].append(
            {
                "type": "linear",
                "targetPosition": 0,
                "actualPosition": 0,
                "mode": "closed-loop",
                "supportedModes": ["closed-loop", "open-loop", "scan"],
                "velocity": 1,
            }
        )

    while is_running:
        for i in range(num_channels):
            target_position = state["channels"][i]["targetPosition"]
            state["channels"][i]["actualPosition"] = target_position + random.uniform(
                -0.1, 0.1
            )
        send_status_update()
        time.sleep(0.1)
