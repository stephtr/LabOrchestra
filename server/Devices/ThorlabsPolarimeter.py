import pyvisa
import time

argv: any

def main():
	rm = pyvisa.ResourceManager()
	#with rm.open_resource(argv.device) as inst:
	with rm.open_resource("USB0::0x1313::0x8031::M00503241::INSTR") as inst:
		try:
			inst.timeout = 5000
			print(inst.query("*IDN?"))

			print(inst.write("*RST"))
			print(inst.write("SENS:CALC:MODE F1024"))
			print(inst.write("SENS:CORR:WAV 1550e-9"))
			print(inst.write("SENS:POW:RANG:AUTO ON"))

			time.sleep(1)
			print(inst.query("SENS:DATA:LAT?"))
		finally:
			inst.close()

main()
