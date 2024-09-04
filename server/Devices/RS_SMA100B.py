from RsSmab import *

state = {"channels": [{"frequency": 0, "power": 0, "isOn": False}]}

smab = None


def update_state():
    state["channels"][0]["frequency"] = smab.source.frequency.get_frequency()
    state["channels"][0]["power"] = smab.source.power.get_power()
    state["channels"][0]["isOn"] = smab.output.state.get_value()
    send_status_update()


def set_frequency(channel, frequency):
    if channel != 0:
        raise Exception("Invalid channel number")
    smab.source.frequency.set_frequency(frequency)
    update_state()


def set_power(channel, power):
    if channel != 0:
        raise Exception("Invalid channel number")
    smab.source.power.set_power(power)
    update_state()


if not hasattr(argv, "ipAddress"):
    raise Exception("Missing 'ipAddress' in RS_SMA100B device parameters")

smab = RsSmab(f"TCPIP::{argv.ipAddress}::hislip0")
update_state()
