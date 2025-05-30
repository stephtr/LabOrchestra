import pyvisa
import time

state = { "status": "not found", "theta": 0, "eta": 0, "DOP": 0, "power": 0}


class PaxData:
	# 1170,95294,5,134283776,6,5856,29712,3.349497e-2,1.38085,-8.918476e-2,-2.549722e-1,9.227656e-1,7.660135e-5
    revs: int
    timestamp: int
    paxOpMode: int
    paxFlags: int
    paxTIARange: int
    adcMin: int
    adcMax: int
    revTime: float
    misAdj: float
    theta: float
    eta: float
    DOP: float
    Ptotal: float
    def __init__(self, revs, timestamp, paxOpMode, paxFlags, paxTIARange, adcMin, adcMax, revTime, misAdj, theta, eta, DOP, Ptotal):
        self.revs = int(revs)
        self.timestamp = int(timestamp)
        self.paxOpMode = int(paxOpMode)
        self.paxFlags = int(paxFlags)
        self.paxTIARange = int(paxTIARange)
        self.adcMin = int(adcMin)
        self.adcMax = int(adcMax)
        self.revTime = float(revTime)
        self.misAdj = float(misAdj)
        self.theta = float(theta)
        self.eta = float(eta)
        self.DOP = float(DOP)
        self.Ptotal = float(Ptotal)


argv: any
is_running: bool
send_status_update: callable

rm = pyvisa.ResourceManager()
inst = rm.open_resource(argv.device)

def main():
	idn = inst.query("*IDN?")
	if not idn.startswith("THORLABS,PAX"):
		raise Exception("Not a Thorlabs Polarimeter")
	#inst.write("*RST")
	inst.write("SENS:CALC:MODE F1024")
	inst.write("SENS:CORR:WAV 1550e-9")
	inst.write("SENS:POW:RANG:AUTO ON")
	inst.write("INP:ROT:STAT ON")

	time.sleep(1)
	while is_running:
		try:
			result = PaxData(*inst.query("SENS:DATA:LAT?").split(","))
			status = "ok"
			if result.paxFlags & 0x01:
				status = "motor speed too low"
			elif result.paxFlags & 0x02:
				status = "motor speed too high"
			elif result.paxFlags & 0x04:
				status = "power too low"
			elif result.paxFlags & 0x08:
				status = "power too high"
			elif result.paxFlags & 0x10:
				status = "temperature too low"
			elif result.paxFlags & 0x0dff:
				status = "error"
			state["status"] = status
			state["theta"] = result.theta
			state["eta"] = result.eta
			state["DOP"] = result.DOP
			state["power"] = result.Ptotal
		except Exception as e:
			print(f"Error: {e}")
			state["status"] = "error"
			state["theta"] = 0
			state["eta"] = 0
			state["DOP"] = 0
			state["power"] = 0
		send_status_update()
		time.sleep(0.33)
	inst.write("INP:ROT:STAT OFF")
	inst.close()
