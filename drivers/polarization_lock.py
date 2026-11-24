# /// script
# requires-python = ">=3.11"
# ///
"""Keeps the polarization at a polarimeter constant by turning two waveplates (a quarter- and a half-wave plate)."""

import math

from laborchestra import Device, action


class PolarizationLock(Device):
    polarimeter = "tweezer_polarization"  # the device that measures: status, theta, eta (radians), dop
    waveplates = "elliptec"  # the device with the waveplates: channels with target_position, action set_position
    qwp_channel = 0
    hwp_channel = 1
    min_dop = 0.8  # below this the measurement is not trusted
    lock_range_deg = 5.0  # further away than this: out of range, nothing is corrected
    eta_offset_deg = 0.2  # where the polarimeter's zero is
    theta_offset_deg = 1.2

    state = {"is_locking": False, "out_of_lock_range": True}

    @action
    def start_lock(self):
        self.state["is_locking"] = True

    @action
    def stop_lock(self):
        self.state["is_locking"] = False

    def run(self):
        plates = self.lab[self.waveplates]
        for name in (self.polarimeter, self.waveplates):  # both have to be there before anything is corrected
            while self.running:
                try:
                    self.lab[name].wait_ready(5)
                    break
                except TimeoutError:
                    self.log.info("Waiting for '%s'", name)
        correct_qwp_next = False
        warned = False
        while self.running:
            try:
                reading = self.lab[self.polarimeter].state
                if reading["status"] != "ok" or reading["dop"] < self.min_dop:
                    self.sleep(1)
                    continue
                theta = math.degrees(reading["theta"]) - self.theta_offset_deg
                eta = math.degrees(reading["eta"]) - self.eta_offset_deg
                out_of_range = abs(theta) > self.lock_range_deg or abs(eta) > self.lock_range_deg
                self.state["out_of_lock_range"] = out_of_range
                if out_of_range and self.state["is_locking"]:
                    if not warned:  # once per episode, not every second
                        self.log.warning("The polarization is out of the lock range (+-%g degrees): not correcting", self.lock_range_deg)
                    warned = True
                else:
                    warned = False
                if not self.state["is_locking"] or out_of_range:
                    self.sleep(1)
                    continue

                channels = plates.state["channels"]
                qwp, hwp = channels[self.qwp_channel], channels[self.hwp_channel]
                if qwp["type"] != "rotation" or hwp["type"] != "rotation":
                    raise ValueError("The waveplate channels are not rotation stages")

                # one plate per step, alternating; the plate that is already good enough waits
                if correct_qwp_next and abs(eta) < 0.2:
                    if abs(theta) > 0.2:
                        correct_qwp_next = False
                    else:
                        self.sleep(1)
                        continue
                if correct_qwp_next:
                    plates.set_position(self.qwp_channel, qwp["target_position"] + eta / 2)
                else:
                    plates.set_position(self.hwp_channel, hwp["target_position"] + theta / 2)
                correct_qwp_next = not correct_qwp_next
            except Exception:
                self.log.exception("The lock could not correct")
            self.sleep(1)
