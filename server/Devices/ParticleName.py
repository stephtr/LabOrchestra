import time
from openai import OpenAI

argv: any
is_running: bool
get_device_state: callable
send_status_update: callable

state = {"name": ""}

def get_settings():
	return state

def load_settings(settings):
	global state
	state = settings


def generate_particle_name(client: OpenAI):
	response = client.responses.create(model="gpt-4o", input="Output a first and a given name for a solid nanoparticle which is used in a physics experiment. It should be close to an ordinary german name, just with a slight fun quantum twist. But not just adding quantum-. Output just the total name.", temperature=1)
	return response.output_text.strip()

def main():
	client = OpenAI(api_key=argv.openai_api_key)
	if not state["name"]:
		state["name"] = generate_particle_name(client)
	
	previous_pressure = None
	while is_running:
		try:
			pressureState = get_device_state("pressure")
			pressure = pressureState["channels"][0]["pressure"]
			
			if previous_pressure and pressure and previous_pressure >= 1e-2 and pressure < 1e-2:
				state["name"] = generate_particle_name(client)
				send_status_update()
			
			if pressure:
				previous_pressure = pressure
		except:
			pass
		time.sleep(1)
