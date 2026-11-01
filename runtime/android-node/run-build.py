#!/usr/bin/env python3
"""Launch one locked Linux build and preserve its real process identity/result."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import uuid
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / "sources.lock.json").read_text(encoding="utf-8"))


def now():
    return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def identity(pid, command):
    # Field 22 follows a parenthesized comm that can itself contain spaces.
    tail = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    actual = [os.fsdecode(part) for part in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if part]
    return {"pid": pid, "startTicks": int(tail[19]), "command": actual or command}


def write_record(file, record):
    temporary = file.with_name(file.name + ".new")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)


def conflicting_processes(source):
    found = []
    for process in Path("/proc").iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            command = [part.decode() for part in (process / "cmdline").read_bytes().split(b"\0") if part]
            if not command:
                continue
            cwd = (process / "cwd").resolve()
            names = [Path(part).name for part in command[:2]]
            phase = command[command.index("--phase") + 1] if "--phase" in command else None
            builder = "build.py" in names and phase in ("build", "prototype", "configure")
            compiler = Path(command[0]).name in ("make", "gmake", "ninja", "cc1plus", "clang", "clang++", "c++", "g++") and cwd.is_relative_to(source)
            if builder or compiler:
                found.append({"pid": int(process.name), "command": command})
        except (OSError, ValueError, UnicodeError):
            continue
    return found


def worker(args, file):
    import fcntl
    record = json.loads(file.read_text(encoding="utf-8"))
    record.update(bootId=boot_id(), worker=identity(os.getpid(), sys.argv), state="starting")
    write_record(file, record)
    try:
        with (args.cache_dir / "build-worker.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            conflicts = conflicting_processes(args.cache_dir / "sources" / LOCK["node"]["sourceRoot"])
            if conflicts:
                record["conflicts"] = conflicts
                raise RuntimeError("A build already owns the source tree; refusing a duplicate")
            command = [sys.executable, str(HERE / "build.py"), "--phase", "build",
                       "--cache-dir", str(args.cache_dir), "--source-archive", str(args.source_archive),
                       "--ndk", str(args.ndk), "--jobs", str(args.jobs)]
            record["startedAt"] = now()
            record["command"] = command
            # The child inherits this worker's session and redirected log.
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL)
            record.update(state="running", child=identity(child.pid, command))
            write_record(file, record)
            exit_code = child.wait()
            record["exitCode"] = exit_code
            if exit_code != 0:
                raise RuntimeError(f"Node build exited with status {exit_code}")
            receipt = args.cache_dir / "build-result.json"
            raw = receipt.read_bytes()
            value = json.loads(raw)
            if not value.get("compiled") or not value.get("staticVerified") or value.get("phase") != "build":
                raise RuntimeError("The successful build has no valid static verification receipt")
            if receipt.stat().st_mtime_ns < record["createdAtUnixNs"]:
                raise RuntimeError("The build receipt predates this run")
            record["receipt"] = {"path": str(receipt), "sha256": hashlib.sha256(raw).hexdigest(), "data": value}
            record["state"] = "succeeded"
    except Exception as error:
        record["state"] = "failed"
        if record.get("exitCode") is None:
            record["exitCode"] = 1
        record["error"] = f"{type(error).__name__}: {error}"
        print(record["error"], file=sys.stderr, flush=True)
    finally:
        record["finishedAt"] = now()
        write_record(file, record)
    return 0 if record["state"] == "succeeded" else 1


def main():
    import time
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--source-archive", type=Path, required=True)
    parser.add_argument("--ndk", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--label", default="node-build")
    parser.add_argument("--worker-record", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if platform.system() != "Linux":
        parser.error("Run the Android build worker in Linux/WSL")
    args.cache_dir = args.cache_dir.expanduser().resolve()
    args.source_archive = args.source_archive.resolve()
    args.ndk = args.ndk.resolve()
    if not 1 <= args.jobs <= 64 or not re.fullmatch(r"[a-z0-9-]+", args.label):
        parser.error("Invalid job count or log label")
    if args.worker_record:
        return worker(args, args.worker_record.resolve())
    runs = args.cache_dir / "runs"
    logs = args.cache_dir / "logs"
    runs.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    run_id = f"{args.label}-{datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"
    file = runs / f"{run_id}.json"
    log = logs / f"{args.label}.log"
    if log.exists():
        parser.error("The requested log already exists; choose a new label to preserve it")
    record = {"schemaVersion": 1, "runId": run_id, "state": "queued", "createdAt": now(),
              "createdAtUnixNs": time.time_ns(), "bootId": boot_id(), "log": str(log), "exitCode": None}
    write_record(file, record)
    command = [sys.executable, str(Path(__file__).resolve()), "--cache-dir", str(args.cache_dir),
               "--source-archive", str(args.source_archive), "--ndk", str(args.ndk), "--jobs", str(args.jobs),
               "--label", args.label, "--worker-record", str(file)]
    with log.open("x", encoding="utf-8") as output:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                 start_new_session=True, close_fds=True)
    print(json.dumps({"runId": run_id, "record": str(file), "workerPid": child.pid, "log": str(log)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
