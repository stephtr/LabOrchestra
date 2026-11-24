state = {
    "channels": [
        {"type": "rotation", "actualPosition": 123, "targetPosition": 123},
        {"type": "rotation", "actualPosition": 123, "targetPosition": 123},
        {"type": "rotation", "actualPosition": 123, "targetPosition": 123},
        {"type": "rotation", "actualPosition": 123, "targetPosition": 123},
    ]
}


def set_position(channel, position):
    if channel < 0 or channel >= len(state["channels"]):
        raise Exception("Invalid channel number")
    channel = state["channels"][channel]
    channel["targetPosition"] = position
    channel["actualPosition"] = position - 0.2
    send_status_update()


def on_save_snapshot():
    return [channel["actualPosition"] for channel in state["channels"]]
