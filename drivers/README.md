# Drivers

Single-file devices for the lab's instruments. Copy one into the `devices/` folder of your workspace (or point `file` in
`devices.json` at it), then add it on the Devices page. Each file names what it needs in its header (PEP 723), so every
device gets an environment with exactly that.

| File | Device |
|---|---|
| `elliptec.py` | Thorlabs Elliptec rotation / linear / slider stages |
| `thorlabs_polarimeter.py` | Thorlabs PAX polarimeter |
| `polarization_lock.py` | keeps the polarization constant with two waveplates (uses the two above) |

Every driver has the option `simulate`: without hardware it runs on made-up values (and says so in its state:
`simulated`), so a new setup can be tried out and the dashboard built before an instrument is connected.
