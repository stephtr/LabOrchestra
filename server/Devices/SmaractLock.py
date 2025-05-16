import time
import numpy as np

state = {"lockZ": False}

argv: any
is_running: bool
send_status_update: callable
get_device_state: callable
action: callable
request: callable


def start_z_lock():
    state["lockZ"] = True
    action("het", None, 'setFFTAveragingDuration', [1000])


def stop_z_lock():
    state["lockZ"] = False

def main():
    osci_channel = 0
    smaract_z_channel = 0
    alpha = 1
    debug = True
    
    def get_peak_height():
        f, psd = request("het", None, "GetFFT", [osci_channel, heterodyne_frequency - 5e3, heterodyne_frequency + 5e3])
        return np.sum(psd)

    def get_move_by(move_mode):
        if move_mode == "closed-loop":
            return 0.010 # 10 nm
        if move_mode == "scan":
            return 0.100 # 100 mV
        raise Exception(f"Invalid move mode: {move_mode}")
    
    while is_running:
        try:
            if not state["lockZ"]:
                time.sleep(1)
                continue
            
            constants = get_device_state("constants")
            heterodyne_frequency = constants["HeterodyneFrequency"]
            smaract_state = get_device_state("smaract")
            
            move_mode = smaract_state["channels"][smaract_z_channel]["mode"]
            z_position = smaract_state["channels"][smaract_z_channel]["targetPosition"]
            move_by = get_move_by(move_mode)
            
            time.sleep(3)
            if not is_running or not state["lockZ"]: continue
            signal_zero = get_peak_height()
            
            # move to x - dx
            action("smaract", None, "move_to", [smaract_z_channel, z_position - move_by, move_mode])
            time.sleep(1)
            if not is_running or not state["lockZ"]: continue
            signal_minus = get_peak_height()

            # move to x + dx
            action("smaract", None, "move_to", [smaract_z_channel, z_position + move_by, move_mode])
            time.sleep(1)
            if not is_running or not state["lockZ"]: continue
            signal_plus = get_peak_height()
            
            if signal_zero == 0 or np.isnan(signal_zero):
                print(f"SmaractLock: signal is zero or NaN")
                continue
            
            # try to find the minimal position
            if debug:
                action("smaract", None, "move_to", [smaract_z_channel, z_position, move_mode])
            if signal_zero < min(signal_minus, signal_plus):
                if not debug:
                    action("smaract", None, "move_to", [smaract_z_channel, z_position, move_mode])
            else:
                relative_change = (signal_plus - signal_minus) / signal_zero
                gradient = relative_change / (2 * move_by)
                gradient = np.clip(gradient, -10, 10)
                if debug:
                    print(f"simulated move of smaract to new optimum by {alpha * gradient} {'µm' if move_mode == 'closed-loop' else 'V'}")
                else:
                    action("smaract", None, "move_to", [smaract_z_channel, z_position + alpha * gradient, move_mode])
        except Exception as e:
            print(f"SmaractLock: error {e}")
            time.sleep(1)


def on_save_snapshot():
    return None
