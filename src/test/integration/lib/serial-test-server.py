import json
import os
import pathlib
import select
import signal
import sys
import time
import tty


base = pathlib.Path(sys.argv[1])
master, slave = os.openpty()
tty.setraw(slave)
os.set_blocking(master, False)
running = True
received = bytearray()


def stop(_signal, _frame):
    global running
    running = False


signal.signal(signal.SIGTERM, stop)
(base / "serial-path").write_text(os.ttyname(slave))
last_banner = 0
try:
    while running:
        if not received and time.monotonic() - last_banner >= 0.25:
            os.write(master, b"ANUBIS_SERIAL_READY\r\n")
            last_banner = time.monotonic()
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            continue
        data = os.read(master, 4096)
        received.extend(data)
        temporary = base / "serial-input.json.tmp"
        temporary.write_text(json.dumps(list(received)))
        temporary.replace(base / "serial-input.json")
        if received.endswith(b"\n"):
            os.write(master, b"PTY_RX:" + bytes(received).rstrip(b"\r\n") + b"\n")
finally:
    os.close(master)
    os.close(slave)
