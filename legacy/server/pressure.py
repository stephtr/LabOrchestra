import time

state = {"channels": [{"pressure": 1}]}


def test():
    print("Hello world from Python!")
    state["channels"][0]["pressure"] = 0


def main():
    while True:
        state["channels"][0]["pressure"] += 1
        send_status_update()
        time.sleep(1)
