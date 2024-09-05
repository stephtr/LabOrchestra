import elliptec
import time

state = {"channels": []}

controller: elliptec.Controller = None
motors = []


def set_position(channel, position):
    if channel < 0 or channel >= len(motors):
        raise Exception("Invalid channel number")
    motor = motors[channel]
    if state["channels"][channel].type == "linear":
        motor.move_to_distance(position)
    elif state["channels"][channel].type == "rotation":
        motor.move_to_angle(position)
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

controller = elliptec.Controller(argv.port)
for ch in argv.channels:
    if ch.type == "linear":
        motor = elliptec.Linear(controller, ch.address)
        motors.append(motor)
        position = motor.get_distance()
        state.append(
            {"type": "linear", "actualPosition": position, "targetPosition": position}
        )
    elif ch.type == "rotation":
        motor = elliptec.Rotator(controller, ch.address)
        motors.append(motor)
        position = motor.get_angle()
        state.append(
            {"type": "rotation", "actualPosition": position, "targetPosition": position}
        )
    else:
        raise Exception("Invalid channel type")


def main():
    while True:
        for motor, st in zip(motors, state["channels"]):
            if st.type == "linear":
                st["actualPosition"] = motor.get_distance()
            elif ch.type == "rotation":
                st["actualPosition"] = motor.get_angle()
            else:
                raise Exception("Invalid channel type")

        send_status_update()
        time.sleep(1)
