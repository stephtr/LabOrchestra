import serial
import time

state = {"channels": []}

if not hasattr(argv, "port"):
    raise Exception("Missing 'port' in pressure sensor device parameters")

ser: serial.Serial = None


def send(command):
    ser.reset_input_buffer()
    ser.write(command + "\r\n")
    result = ser.readline().strip("\r\n")
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
    ser.write("\x05")
    return ser.readline().strip("\r\n")


serial.Serial(argv.port, 9600, 8, serial.PARITY_NONE, serial.STOPBITS_ONE, timeout=5)
ser.open()
request("RES")
status = request("SEN").split(",")
sensorId = request("TID").split(",")
pressureUnit = int(request("UNI"))
if pressureUnit != 0 and pressureUnit != 4: # mbar & hPa
	raise Exception("Unsupported pressure unit")
send("COM,1")

def main():
    while True:
        data = ser.readline().strip("\r\n").split(",")
        status = int(data[::2])
        pressure = float(data[1::2])
        for i, (s, p) in enumerate(zip(status, pressure)):
			state["channels"][i] = {"pressure": p, "status": s == 1}
          