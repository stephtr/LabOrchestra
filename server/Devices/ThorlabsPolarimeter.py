import pyvisa
import time

argv: any

def main():
	rm = pyvisa.ResourceManager()
	with rm.open_resource(argv.device) as inst:
		print(inst.query("*IDN?"))

		print(inst.query("*RST"))
		print(inst.query("SENS:CALC:MODE F1024"))
		print(inst.query("SENS:CORR:WAV 1550e-9"))
		print(inst.query("SENS:POW:RANG:AUTO ON"))

		time.sleep(1)
		print(inst.query("SENS:DATA:LAT?"))
