state = {"channels": [{"frequency": 1000, "power": 0, "isOn": False}]}


def set_frequency(channel, frequency):
    if channel != 0:
        raise Exception("Invalid channel number")
    state["channels"][0]["frequency"] = frequency
    send_status_update()


def set_power(channel, power):
    if channel != 0:
        raise Exception("Invalid channel number")
    state["channels"][0]["power"] = power
    send_status_update()


def set_on(channel, isOn):
    if channel != 0:
        raise Exception("Invalid channel number")
    state["channels"][0]["isOn"] = isOn
    send_status_update()


def on_save_snapshot():
    return state["channels"]
