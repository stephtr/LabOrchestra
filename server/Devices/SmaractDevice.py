from smaract import ctl
import time
from typing import Callable, Any

state = {"channels": []}

argv: Any
is_running: bool
send_status_update: Callable[[], None]

if not hasattr(argv, "device"):
	raise Exception("Smaract: Missing `device`")

handle = ctl.Open(argv.device)
num_channels = 0

def get_scale_factor(move_mode):
	if move_mode == "closed-loop":
		return 1_000_000
	elif move_mode == "scan":
		return 65535 / 100
	else:
		return 1


def move_to(iChannel, position, mode):
    if iChannel < 0 or iChannel >= num_channels:
        raise Exception("Invalid channel number")
    channel = state["channels"][iChannel]
    if channel["mode"] != mode:
        raise Exception("Invalid move mode")
    if mode == "open-loop":
        position -= channel["targetPosition"]
    channel["targetPosition"] = position
    ctl.Move(handle, channel, int(position * get_scale_factor(channel["mode"]) + 0.5))


def set_mode(iChannel, mode):
	if iChannel < 0 or iChannel >= num_channels:
		raise Exception("Invalid channel number")
	if not mode in ["closed-loop", "open-loop", "scan"]:
		raise Exception("Invalid move mode")
	ctl.SetProperty_i32(handle, iChannel, ctl.Property.MOVE_MODE, ctl.MoveMode.CL_ABSOLUTE if mode == "closed-loop" else ctl.MoveMode.STEP if mode == "open-loop" else ctl.MoveMode.SCAN_ABSOLUTE)
	target_position = ctl.GetProperty_i64(handle, iChannel, ctl.Property.TARGET_POSITION)
	move_velocity = ctl.GetProperty_i64(handle, iChannel, ctl.Property.MOVE_VELOCITY)
	scale_factor = get_scale_factor(mode)
	channel = state["channels"][iChannel]
	channel["mode"] = mode
	channel["targetPosition"] = 0 if mode == "open-loop" else target_position / scale_factor
	channel["velocity"] = move_velocity / scale_factor

def set_velocity(iChannel, velocity, mode):
    if iChannel < 0 or iChannel >= num_channels:
        raise Exception("Invalid channel number")
    channel = state["channels"][iChannel]
    if channel["mode"] != mode:
        raise Exception("Invalid move mode")
    ctl.SetProperty_i64(handle, iChannel, ctl.Property.MOVE_VELOCITY, int(velocity * get_scale_factor(mode) + 0.5))
    channel["velocity"] = velocity

def stop():
	for i in range(num_channels):
		ctl.Stop(handle, i)

def main():
	global num_channels
	num_channels = ctl.GetProperty_i32(handle, 0, ctl.Property.NUMBER_OF_CHANNELS)
	for i in range(num_channels):
		channel_type = ctl.GetProperty_i32(handle, i, ctl.Property.POS_MOVEMENT_TYPE)
		target_position = ctl.GetProperty_i64(handle, i, ctl.Property.TARGET_POSITION)
		actual_position = ctl.GetProperty_i64(handle, i, ctl.Property.POSITION)
		move_mode = ctl.GetProperty_i32(handle, i, ctl.Property.MOVE_MODE)
		move_velocity = ctl.GetProperty_i64(handle, i, ctl.Property.MOVE_VELOCITY)
		if not channel_type in [ctl.MovementType.LINEAR, ctl.MovementType.ROTATORY, ctl.MovementType.GONIOMETER]:
			state["channels"].append({
				"type": "unknown",
				"targetPosition": 0,
				"actualPosition": 0,
				"mode": "unknown",
				"supportedModes": [],
			})
			continue
		converted_move_mode = "closed-loop" if move_mode == ctl.MoveMode.CL_ABSOLUTE else "open-loop" if move_mode == ctl.MoveMode.STEP else "scan" if move_mode == ctl.MoveMode.SCAN_ABSOLUTE else "unknown"
		scale_factor = get_scale_factor(converted_move_mode)
		state["channels"].append({
			"type": "linear" if channel_type == ctl.MovementType.LINEAR else "rotation",
			"targetPosition": 0 if move_mode == "open-loop" else target_position / scale_factor,
			"actualPosition": actual_position / 1_000_000, # convert to um
			"velocity": move_velocity / scale_factor,
			"mode": converted_move_mode,
			"supportedModes": ["closed-loop", "open-loop", "scan"], # todo: get supported modes from device
		})

	while is_running:
		try:
			for i in range(num_channels):
				actual_position = ctl.GetProperty_i64(handle, i, ctl.Property.POSITION)
				state["channels"][i]["actualPosition"] = actual_position
			send_status_update()
		except Exception as e:
			pass
		time.sleep(0.1)
	ctl.Close(handle)

def on_save_snapshot():
    return [channel["actualPosition"] for channel in state["channels"]]
