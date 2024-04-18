import time

state = {"pressure": 1}


def test():
    state["pressure"] += 1
    send_status_update({"pressure": state["pressure"]})


def main():
    while True:
        test()
        time.sleep(1)
