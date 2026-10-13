"""Generate a local ADB QR and pair only its matching mDNS service.

Uses the installed SDK adb and qrcode; no credentials are written as text.
The QR image itself is the requested transient pairing credential. Both output
files are restricted to this project's ignored .cache directory. Never log
the QR payload/password.
"""

import argparse
import ipaddress
import json
from pathlib import Path
import secrets
import string
import subprocess
import sys
import time


def service_instance(name, kind):
    """Accept either adb's bare instance name or its qualified mDNS spelling."""
    name = name.rstrip(".")
    suffix = "." + kind.rstrip(".")
    if name.endswith(suffix + ".local"):
        return name[: -len(suffix + ".local")]
    if name.endswith(suffix):
        return name[: -len(suffix)]
    return name


def endpoint_host(endpoint):
    host, separator, port = endpoint.rpartition(":")
    if not separator or not port.isdigit() or not 1 <= int(port) <= 65535:
        return None
    try:
        return str(ipaddress.ip_address(host.strip("[]")))
    except ValueError:
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--adb", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if not 30 <= args.timeout <= 600:
        parser.error("timeout must be 30 to 600 seconds")

    project = Path(__file__).resolve().parent.parent
    cache = (project / ".cache").resolve()
    output = Path(args.output).resolve()
    result_path = Path(args.result).resolve()
    if not cache.is_relative_to(project) or any(
        path == cache or not path.is_relative_to(cache) for path in (output, result_path)
    ):
        parser.error("output and result must be files under the project's ignored .cache directory")
    if output == result_path or output.suffix.lower() != ".png" or result_path.suffix.lower() != ".json":
        parser.error("output must be a PNG and result must be a different JSON file")
    import qrcode

    service = "studio-" + secrets.token_hex(5)
    password = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(10))
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=12, border=4)
    qr.add_data(f"WIFI:T:ADB;S:{service};P:{password};;")
    qr.make(fit=True)
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        result_path.parent.mkdir(parents=True, exist_ok=True)
        # Invalidate an older successful session before creating a fresh QR.
        result_path.write_text(json.dumps({"paired": False, "serial": None}), encoding="utf-8")
        qr.make_image(fill_color="black", back_color="white").save(output)
    except (OSError, ValueError):
        print("Unable to prepare the local QR session files.", flush=True)
        return 3
    print("QR ready; waiting for the phone to scan.", flush=True)

    def adb(*argv, input_text=None, timeout=8):
        result = subprocess.run([args.adb, *argv], input=input_text,
                                capture_output=True, text=True, encoding="utf-8",
                                errors="replace", timeout=timeout)
        return result.returncode, (result.stdout + result.stderr).replace(password, "[redacted]")

    def services():
        code, text = adb("mdns", "services")
        if code != 0:
            raise RuntimeError("ADB discovery failed")
        return [line.split() for line in text.splitlines() if len(line.split()) == 3]

    deadline = time.monotonic() + args.timeout
    paired_ip = None
    matched_connections = set()
    try:
        while time.monotonic() < deadline:
            for name, kind, endpoint in services():
                kind = kind.rstrip(".")
                host = endpoint_host(endpoint)
                instance = service_instance(name, kind)
                if not host:
                    continue
                if not paired_ip and kind == "_adb-tls-pairing._tcp" and instance == service:
                    code, text = adb("pair", endpoint, input_text=password + "\n", timeout=20)
                    if code != 0 or "Successfully paired" not in text:
                        print("Matching QR service found, but pairing failed; generate a new QR.", flush=True)
                        return 2
                    paired_ip = host
                    print("Pairing succeeded; waiting for the device connection.", flush=True)
                if paired_ip and kind == "_adb-tls-connect._tcp" and host == paired_ip:
                    matched_connections.add(endpoint)
                    matched_connections.add(instance + "." + kind)
                    adb("connect", endpoint)
            if paired_ip:
                code, text = adb("devices", "-l")
                if code != 0:
                    raise RuntimeError("ADB device listing failed")
                connected = [line.split()[0] for line in text.splitlines()
                             if len(line.split()) >= 2 and line.split()[1] == "device"
                             and line.split()[0] in matched_connections]
                if connected:
                    # ADB may list one phone under both its IP and mDNS name.
                    # Only transports resolved for this QR's pairing IP qualify.
                    serial = sorted(connected, key=lambda item: (":" not in item, item))[0]
                    result_path.write_text(json.dumps({"paired": True, "serial": serial}), encoding="utf-8")
                    print("Connected device: " + serial, flush=True)
                    return 0
            time.sleep(1)
    except (OSError, subprocess.TimeoutExpired, RuntimeError):
        print("ADB discovery or pairing did not respond; QR session stopped.", flush=True)
        return 3
    print("QR session expired; no device connection confirmed.", flush=True)
    return 4


if __name__ == "__main__":
    sys.exit(main())
