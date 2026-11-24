import time
import numpy as np
import requests

argv: any
is_running: bool
get_device_state: callable

if not argv.deviceName:
	raise ValueError("`deviceName` is required")
if not argv.selectedChannel:
	raise ValueError("`selectedChannel` is required")
if not argv.uploadUrl:
	raise ValueError("`uploadUrl` is required")
if not argv.apiKey:
	raise ValueError("`apiKey` is required")

def main():
	pressure_readings = []
	start = time.time()
	time_interval = argv.timeInterval if hasattr(argv, 'timeInterval') else 60
	while is_running:
		try:
			pressureState = get_device_state(argv.deviceName)
			pressure = pressureState["channels"][argv.selectedChannel]["pressure"]
			
			if pressure:
				pressure_readings.append(pressure)
			
			if time.time() - start > time_interval and len(pressure_readings) > 0:
				average_pressure = np.mean(pressure_readings)
				pressure_readings = []
				start = time.time()

				sensors = [{
					"id": f'{argv.deviceName}-{argv.selectedChannel}',
					"value": average_pressure,
					"unit": "mbar",
				}]
				
				# Upload the average pressure to the server
				with requests.post(argv.uploadUrl, json={'sensors': sensors}, headers={'Authorization': f'Bearer {argv.apiKey}'}) as response:
					if response.status_code >= 300:
						print(f"Failed to upload data: {response.status_code} {response.text}")

		except Exception as e:
			pass
		time.sleep(1)
