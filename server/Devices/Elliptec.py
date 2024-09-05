import elliptec
import time

state = {"channels": []}

controller: elliptec.Controller = None
motors = []


def set_position(channel, position):
    if channel < 0 or channel >= len(motors):
        raise Exception("Invalid channel number")
    motor = motors[channel]
    if state["channels"][channel]["type"] == "linear":
        for _ in range(5):
            try:
                motor.set_distance(position)
                state["channels"][channel]["actualPosition"] = motor.get_distance()
                break
            except:
                pass
    elif state["channels"][channel]["type"] == "rotation":
        for _ in range(5):
            try:
                motor.set_angle(position)
                state["channels"][channel]["actualPosition"] = motor.get_angle()
                break
            except:
                pass
    else:
        raise Exception("Invalid channel type")

    state["channels"][channel]["targetPosition"] = position
    send_status_update()


def on_save_snapshot():
    return [channel["actualPosition"] for channel in state["channels"]]


if not hasattr(argv, "port"):
    raise Exception("Missing 'port' in Elliptec device parameters")
if not hasattr(argv, "channels"):
    raise Exception("Missing 'channels' in Elliptec device parameters")

controller = elliptec.Controller(argv.port, debug=False)
for ch in argv.channels:
    if ch.type == "linear":
        motor = elliptec.Linear(controller, ch.address, False)
        motors.append(motor)
        position = motor.get_distance()
        state["channels"].append(
            {"type": "linear", "actualPosition": position, "targetPosition": position}
        )
    elif ch.type == "rotation":
        motor = elliptec.Rotator(controller, ch.address, False)
        motors.append(motor)
        position = motor.get_angle()
        state["channels"].append(
            {"type": "rotation", "actualPosition": position, "targetPosition": position}
        )
    else:
        raise Exception("Invalid channel type")


def main():
    while True:
        for motor, st in zip(motors, state["channels"]):
            if st["type"] == "linear":
                try:
                    st["actualPosition"] = motor.get_distance()
                except:
                    pass
            elif st["type"] == "rotation":
                try:
                    st["actualPosition"] = motor.get_angle()
                except:
                    pass
            else:
                raise Exception("Invalid channel type")

        send_status_update()
        time.sleep(20)
