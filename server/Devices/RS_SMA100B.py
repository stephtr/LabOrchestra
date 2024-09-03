from RsSmab import *
import time

state = {"channels": [{"frequency": 0, "power": 0, "isOn": False}]}

smab = None

def set_frequency(channel, frequency):
	if channel != 0:
		raise Exception("Invalid channel number")
	smab.source.frequency.set_frequency(frequency)

def set_power(channel, power):
	if channel != 0:
		raise Exception("Invalid channel number")
	smab.source.power.set_power(power)

def main(params):
	global smab
	if not hasattr(params, "ipAddress"):
		raise Exception("Missing 'ipAddress' in RS_SMA100B device parameters")

	smab = RsSmab(f"TCPIP::{params.ipAddress}::hislip0")
	while True:
		state["channels"][0]["frequency"] = smab.source.frequency.get_frequency()
		state["channels"][0]["power"] = smab.source.power.get_power()
		state["channels"][0]["isOn"] = smab.output.state.get_value()
		send_status_update()
		time.sleep(0.5)
