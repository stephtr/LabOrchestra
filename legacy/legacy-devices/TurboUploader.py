import time
import numpy as np
import requests

argv: any
is_running: bool
get_device_state: callable

if not argv.deviceName:
	raise ValueError("`deviceName` is required")
if not argv.uploadUrl:
	raise ValueError("`uploadUrl` is required")
if not argv.apiKey:
	raise ValueError("`apiKey` is required")

# Zustände, in denen der Turbo-Treiber noch keine Messwerte gelesen hat
NO_DATA_STATUS = ("initializing", "connecting", "connected")


def selected_channels(n_channels):
	"""Optional `selectedChannels`, z. B. 0, "0,1" oder [0, 1]. Ohne Angabe: alle Pumpen."""
	selection = getattr(argv, "selectedChannels", None)
	if selection is None or selection == "":
		return list(range(n_channels))
	if isinstance(selection, (int, float)):
		return [int(selection)]
	if isinstance(selection, str):
		return [int(s) for s in selection.split(",") if s.strip()]
	return [int(s) for s in selection]


def has_live_data(channel):
	status = str(channel.get("status", ""))
	if status in NO_DATA_STATUS:
		return False
	# "error: <Fehlercode>" meldet die Pumpe selbst (Drehzahl ist gültig),
	# "error: <Exception-Text>" kommt vom Verbindungsaufbau (keine Messwerte)
	if status.startswith("error:") and status != f"error: {channel.get('errorCode')}":
		return False
	return True


def main():
	time_interval = float(getattr(argv, "timeInterval", None) or 60)
	readings = {}
	start = time.time()
	last_error = None
	while is_running:
		try:
			channels = get_device_state(argv.deviceName)["channels"]
			for index in selected_channels(len(channels)):
				channel = channels[index]
				if has_live_data(channel) and channel.get("actualSpeed") is not None:
					readings.setdefault(index, []).append(float(channel["actualSpeed"]))

			if time.time() - start > time_interval:
				sensors = [{
					"id": f"{argv.deviceName}-{index}",
					"value": round(float(np.mean(values)), 1),
					"unit": "Hz",
				} for index, values in sorted(readings.items()) if values]
				readings = {}
				start = time.time()

				# Upload the average rotation speed to the server
				if sensors:
					with requests.post(argv.uploadUrl, json={'sensors': sensors}, headers={'Authorization': f'Bearer {argv.apiKey}'}, timeout=10) as response:
						if response.status_code >= 300:
							print(f"Failed to upload data: {response.status_code} {response.text}")
			last_error = None
		except Exception as e:
			# Fehler einmal ausgeben statt still zu schlucken, aber nicht jede Sekunde
			if str(e) != last_error:
				print(f"Turbo upload error: {e}")
				last_error = str(e)
		time.sleep(1)
