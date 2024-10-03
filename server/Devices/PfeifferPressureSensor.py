import serial
import time

state = {"channels": []}

ser: serial.Serial = None
sensorStates = ["ok", "underrange", "overrange", "error"]


def send(command):
    ser.reset_input_buffer()
    ser.write((command + "\r\n").encode())
    result = ser.readline().strip().decode()
    if result != "\x06":
        if result == "\x15":
            error = request(None)
            raise Exception(f"Unexpected response: {error}")
        else:
            raise Exception(f"Unexpected response: {result}")
    time.sleep(0.05)


def request(command) -> str:
    if command is not None:
        send(command)
    ser.write(b"\x05")
    return ser.readline().strip().decode()


if not hasattr(argv, "port"):
    raise Exception("Missing 'port' in pressure sensor device parameters")
ser = serial.Serial(
    argv.port, 9600, 8, serial.PARITY_NONE, serial.STOPBITS_ONE, timeout=5
)

for i in range(3):
    try:
        request("RES")
        # sensorStatus = request("SEN").split(",")
        # sensorId = request("TID").split(",")
        pressureUnit = int(request("UNI"))
        if pressureUnit != 0 and pressureUnit != 4:  # mbar & hPa
            raise Exception("Unsupported pressure unit")
        send("COM,1")
        break
    except:
        continue
else:
    raise Exception("Couldn't initialize the pressure sensor.")


def main():
    while True:
        data = ser.readline().strip().decode().split(",")
        statusList = data[::2]
        pressureList = data[1::2]
        newState = []
        for s, p in zip(statusList, pressureList):
            status = int(s)
            isOk = status == 0
            newState.append(
                {"pressure": float(p) if isOk else 0, "status": sensorStates[status]}
            )
        state["channels"] = newState
        send_status_update()

def on_save_snapshot():
    return [channel["pressure"] if channel["status"] == "ok" else "-" for channel in state["channels"]]
