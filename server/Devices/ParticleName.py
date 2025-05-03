import time
from openai import OpenAI
from slack_sdk import WebClient

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
    name = client.responses.create(
        model="gpt-4o",
        input="Output a first and a given name for a solid nanoparticle which is used in a physics experiment. It should be close to an ordinary german name, just with a slight fun quantum twist. But not just adding quantum-. Output just the total name.",
        temperature=1,
    ).output_text
    return name.strip()


def send_welcome_message(openAI_client, name):
    try:
        if not hasattr(argv, "slack_token") or not hasattr(argv, "slack_channel"):
            print("ParticleName: Slack token or channel not provided.")
            return
        response = openAI_client.responses.create(
            model="gpt-4o",
            input=f'Write a funny welcome message for a nanoparticle named "{name}", which is trapped in a laser field and gonna be cooled and used in a quantum physics experiment.',
            temperature=1,
        ).output_text
        slack_client = WebClient(token=argv.slack_token)
        slack_client.chat_postMessage(channel=argv.slack_channel, text=response)
    except Exception as e:
        print(f"Error sending welcome message: {e}")


def main():
    client = OpenAI(api_key=argv.openai_api_key)
    if not state["name"]:
        state["name"] = generate_particle_name(client)

    previous_pressure = None
    while is_running:
        try:
            pressureState = get_device_state("pressure")
            pressure = pressureState["channels"][0]["pressure"]

            if (
                previous_pressure
                and pressure
                and previous_pressure >= 1e-2
                and pressure < 1e-2
            ):
                state["name"] = generate_particle_name(client)
                send_status_update()
                send_welcome_message(client, state["name"])

            if pressure:
                previous_pressure = pressure
        except:
            pass
        time.sleep(1)
