state = {"channels": [{"pressure": 9876, "status": "ok"}, {"pressure": 5432, "status": "ok"}]}


def on_save_snapshot():
    return [channel["pressure"] for channel in state["channels"]]
