state = {"channels": [{"pressure": 9876, "status": 0}, {"pressure": 5432, "status": 0}]}


def on_save_snapshot():
    return [channel["pressure"] for channel in state["channels"]]
