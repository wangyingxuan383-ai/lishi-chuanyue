#!/usr/bin/env python3
"""Prepare and build the locked Android libnode; never installs an APK."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / "sources.lock.json").read_text(encoding="utf-8"))
CACHE = Path(os.environ.get("LISHI_ANDROID_NODE_CACHE_ROOT", HERE.parents[1] / ".cache" / "r19" / "android-node")).expanduser().resolve()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(file):
    value = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def inspect_source(archive_override=None):
    archive = archive_override.resolve() if archive_override else CACHE / "downloads" / LOCK["node"]["file"]
    require(archive.is_file(), "Run fetch-source.mjs before preparing sources")
    require(sha256(archive) == LOCK["node"]["sha256"], "Node archive checksum differs from lock")
    root = LOCK["node"]["sourceRoot"]
    with tarfile.open(archive, "r:xz") as source:
        def text(name):
            return source.extractfile(f"{root}/{name}").read().decode("utf-8")
        version = text("src/node_version.h")
        actual = ".".join(re.search(rf"#define NODE_{part}_VERSION\s+(\d+)", version).group(1) for part in ("MAJOR", "MINOR", "PATCH"))
        require(actual == LOCK["node"]["version"], "Archive source version differs from lock")
        configure = text("configure.py")
        android = text("android_configure.py")
        require("parser.add_argument('--shared'" in configure, "Locked source has no shared-library configure option")
        require("shlib_suffix = 'so'" in configure and "options.dest_os == 'android'" in configure, "Android shared-library naming needs review")
        require('int(sys.argv[2]) < 24' in android, "Android API contract changed")
        require("--cross-compiling" in android and "--openssl-no-asm" in android, "Upstream Android configuration changed")
    return archive, {"node": actual, "sourceSha256": LOCK["node"]["sha256"], "api": LOCK["android"]["api"], "abi": LOCK["android"]["abi"], "sourceVerified": True, "compiled": False, "runtimeTested": False}


def prepare(archive):
    parent = CACHE / "sources"
    target = parent / LOCK["node"]["sourceRoot"]
    marker = target / ".lishi-source.json"
    if target.exists():
        require(marker.is_file() and json.loads(marker.read_text())["sourceSha256"] == LOCK["node"]["sha256"], "Existing source directory is not owned by this locked build")
        return target
    require(sys.version_info >= (3, 12), "Safe source extraction requires Python 3.12 or later")
    parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix="extract-", dir=parent))
    with tarfile.open(archive, "r:xz") as source:
        for member in source.getmembers():
            require(member.name == LOCK["node"]["sourceRoot"] or member.name.startswith(LOCK["node"]["sourceRoot"] + "/"), "Unexpected archive root")
        source.extractall(temporary, filter="data")
    extracted = temporary / LOCK["node"]["sourceRoot"]
    (extracted / ".lishi-source.json").write_text(json.dumps({"sourceSha256": LOCK["node"]["sha256"]}) + "\n")
    extracted.rename(target)
    temporary.rmdir()
    return target


def prepare_ndk(archive):
    require(platform.system() == "Linux", "Extract the Linux NDK on the Linux/WSL ext4 filesystem, not Windows")
    require(shutil.which("unzip"), "Linux build prerequisite missing: unzip")
    require(archive.is_file() and archive.stat().st_size == LOCK["ndk"]["bytes"], "Locked Linux NDK archive missing or incomplete")
    require(sha256(archive) == LOCK["ndk"]["sha256"], "Linux NDK archive SHA-256 differs from lock")
    root = LOCK["ndk"]["sourceRoot"]
    parent = CACHE / "toolchains"
    target = parent / root
    marker = target / ".lishi-ndk.json"
    if target.exists():
        require(marker.is_file() and json.loads(marker.read_text())["sha256"] == LOCK["ndk"]["sha256"], "Existing NDK directory is not owned by this locked build")
        return target
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            segments = member.filename.split("/")
            require(segments[0] == root and ".." not in segments and "\\" not in member.filename, "Unexpected NDK archive path")
    parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix="extract-ndk-", dir=parent))
    # unzip retains the executable permissions and relative symlinks in Google's archive.
    subprocess.run(["unzip", "-q", str(archive.resolve()), "-d", str(temporary)], check=True)
    extracted = temporary / root
    (extracted / ".lishi-ndk.json").write_text(json.dumps({"sha256": LOCK["ndk"]["sha256"]}) + "\n")
    extracted.rename(target)
    temporary.rmdir()
    return target


def build_environment(ndk):
    require(platform.system() == "Linux", "Android compilation requires the planned Linux/WSL build environment; Windows NDK binaries are not substituted")
    require(ndk is not None, "Pass --ndk with an extracted Linux NDK 28.2.13676358")
    ndk = ndk.resolve()
    properties = (ndk / "source.properties").read_text()
    require(re.search(r"Pkg.Revision\s*=\s*28\.2\.13676358\s*(?:\n|$)", properties), "Unexpected NDK version")
    binaries = ndk / "toolchains/llvm/prebuilt/linux-x86_64/bin"
    require((binaries / "aarch64-linux-android24-clang++").is_file(), "Linux arm64/API24 compiler missing")
    for command in ("make", "cc", "c++", "ar"):
        require(shutil.which(command), f"Linux build prerequisite missing: {command}")
    env = os.environ.copy()
    env.update({
        "PATH": str(binaries) + os.pathsep + env["PATH"],
        "CC": str(binaries / "aarch64-linux-android24-clang"),
        "CXX": str(binaries / "aarch64-linux-android24-clang++"),
        "AR": str(binaries / "llvm-ar"), "NM": str(binaries / "llvm-nm"),
        "CC_host": shutil.which("cc"), "CXX_host": shutil.which("c++"), "AR_host": shutil.which("ar"),
        "CFLAGS": "-fPIC", "CXXFLAGS": "-fPIC",
        "LDFLAGS": "-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384",
        "GYP_DEFINES": f"target_arch=arm64 v8_target_arch=arm64 android_target_arch=arm64 host_os=linux OS=android android_ndk_path={ndk}",
        "LISHI_ANDROID_NDK_ROOT": str(ndk),
    })
    return binaries, env


def configure(source, env):
    # The old patch shipped in this exact Node tarball does not match its V8 header.
    # Use the reviewed Android-only guard; never apply a fuzzy or unknown patch.
    patch_android_guard(source)
    patch_android_cpu_features(source, Path(env["LISHI_ANDROID_NDK_ROOT"]))
    patch_linux_host_trap_sources(source)
    args = [sys.executable, "configure.py", "--dest-cpu=arm64", "--dest-os=android", "--openssl-no-asm", "--cross-compiling", "--shared", "--without-npm"]
    subprocess.run(args, cwd=source, env=env, check=True)
    return args


def patch_android_guard(source):
    header = source / "deps/v8/src/trap-handler/trap-handler.h"
    original_hash = "fc19662c583a730bab84ed94f415db6893364d7f5ee89c55ab570647e4c25f28"
    patched_hash = "ea5cf905c3eebdebebca21d983f8f2ceffe56d1f81580e087cee4a078bd2635c"
    before = header.read_bytes()
    current = hashlib.sha256(before).hexdigest()
    if current == patched_hash:
        return
    require(current == original_hash, "V8 Android patch input does not match the reviewed Node source")
    old = b"// X64 on Linux, Windows, MacOS, FreeBSD.\n#if V8_HOST_ARCH_X64"
    new = b"// Android trap handlers are unsupported by the upstream Node Android port.\n#if V8_OS_ANDROID\n#define V8_TRAP_HANDLER_SUPPORTED false\n// X64 on Linux, Windows, MacOS, FreeBSD.\n#elif V8_HOST_ARCH_X64"
    require(before.count(old) == 1, "Android guard patch context is ambiguous")
    after = before.replace(old, new)
    require(hashlib.sha256(after).hexdigest() == patched_hash, "Android guard patch output differs from the reviewed result")
    header.write_bytes(after)
    (source / ".lishi-android-patch.json").write_text(json.dumps({"patch": "0001-disable-android-trap-handler.patch", "originalSha256": original_hash, "patchedSha256": patched_hash}) + "\n")


def patch_android_cpu_features(source, ndk):
    gyp = source / "deps/zlib/zlib.gyp"
    original_hash = "d57e1daed966e3fb4094b7d7b24012d1afa14472059965dbeb6e52e590abde5f"
    patched_hash = "111550feef2226f020cdbe7111169e3dc85f6b43322f63a716a506b499911d4e"
    implementation = ndk / "sources/android/cpufeatures/cpu-features.c"
    header = ndk / "sources/android/cpufeatures/cpu-features.h"
    require(sha256(implementation) == LOCK["ndk"]["cpuFeaturesCsha256"] and sha256(header) == LOCK["ndk"]["cpuFeaturesHsha256"], "NDK CPU-features implementation differs from the verified archive")
    copied = source / "deps/zlib/lishi_android_cpu_features.c"
    if copied.exists():
        require(sha256(copied) == LOCK["ndk"]["cpuFeaturesCsha256"], "Existing CPU-features source copy is not the locked NDK implementation")
    else:
        shutil.copyfile(implementation, copied)
    before = gyp.read_bytes()
    current = hashlib.sha256(before).hexdigest()
    if current == patched_hash:
        return
    require(current == original_hash, "zlib Android patch input does not match the reviewed Node source")
    old = b"          'conditions': [\n            ['OS!=\"win\"', {\n"
    new = b"          'conditions': [\n            ['OS==\"android\" and _toolset==\"target\"', {\n              'sources': [ '<(ZLIB_ROOT)/lishi_android_cpu_features.c' ],\n            }],\n            ['OS!=\"win\"', {\n"
    require(before.count(old) == 1, "Android CPU-features patch context is ambiguous")
    after = before.replace(old, new)
    require(hashlib.sha256(after).hexdigest() == patched_hash, "Android CPU-features patch output differs from the reviewed result")
    gyp.write_bytes(after)
    (source / ".lishi-android-cpufeatures-patch.json").write_text(json.dumps({"patch": "0002-link-android-cpufeatures.patch", "originalSha256": original_hash, "patchedSha256": patched_hash}) + "\n")


def patch_linux_host_trap_sources(source):
    # GYP's global OS is Android, while mksnapshot really runs on Linux/x64.
    # Preserve V8's host simulator handlers without enabling them on Android.
    record = LOCK["patches"]["linuxHostTrapSources"]
    patch = HERE / "patches" / record["patch"]
    require(sha256(patch) == record["patchSha256"], "Linux host trap-source patch differs from the reviewed patch")
    target = source / record["file"]
    current = sha256(target)
    if current == record["patchedSha256"]:
        return
    require(current == record["originalSha256"], "V8 GYP input differs from the locked Node source")
    require(shutil.which("patch"), "Linux build prerequisite missing: patch")
    subprocess.run(["patch", "-p1", "--batch", "--forward", "--fuzz=0", "--input", str(patch)], cwd=source, check=True)
    require(sha256(target) == record["patchedSha256"], "V8 Linux host trap-source patch output differs from the reviewed result")
    (source / ".lishi-linux-host-trap-sources-patch.json").write_text(json.dumps(record, indent=2) + "\n")


def verify_elf(library, binaries, soname, allowed_dependencies):
    readelf = binaries / "llvm-readelf"
    header = subprocess.check_output([str(readelf), "-h", str(library)], text=True)
    segments = subprocess.check_output([str(readelf), "-lW", str(library)], text=True)
    dynamic = subprocess.check_output([str(readelf), "-dW", str(library)], text=True)
    require("AArch64" in header and "ELF64" in header, "Product is not an ARM64 ELF shared library")
    loads = [line for line in segments.splitlines() if re.match(r"\s*LOAD\s", line)]
    require(loads and all(int(line.split()[-1], 16) >= LOCK["android"]["pageSize"] for line in loads), "ELF LOAD alignment does not support 16KiB pages")
    relro = [line.split() for line in segments.splitlines() if re.match(r"\s*GNU_RELRO\s", line)]
    relro_ends = [int(fields[2], 16) + int(fields[5], 16) for fields in relro]
    require(relro_ends and all(end % LOCK["android"]["pageSize"] == 0 for end in relro_ends), "ELF GNU_RELRO end does not support 16KiB pages")
    require(re.search(r"SONAME.*\[" + re.escape(soname) + r"\]", dynamic), f"Shared library SONAME must be APK-compatible {soname}")
    dependencies = re.findall(r"NEEDED.*\[(.*?)\]", dynamic)
    require(set(dependencies) <= allowed_dependencies, f"Unpackaged runtime dependencies: {dependencies}")
    return {"file": str(library), "bytes": library.stat().st_size, "sha256": sha256(library), "dependencies": dependencies, "loadAlignments": [line.split()[-1] for line in loads], "relroEnds": [hex(end) for end in relro_ends], "compiled": True, "staticVerified": True, "runtimeTested": False}


def verify(source, binaries):
    candidates = [source / "out/Release/lib.target/libnode.so", source / "out/Release/libnode.so"]
    library = next((file for file in candidates if file.is_file()), None)
    require(library, "No Android libnode.so build product found")
    return verify_elf(library, binaries, "libnode.so", {"libc++_shared.so", "libc.so", "libm.so", "libdl.so", "liblog.so"})


def export_notices(source, ndk):
    # Hashes are measured from the locked upstream archives, not selected licenses.
    destination = CACHE / "notices"
    require(not destination.is_symlink(), "Notice output must not be a symlink")
    files = {}
    for name, record in LOCK["notices"].items():
        origin = (source if record["source"] == "node" else ndk) / record["path"]
        require(origin.is_file() and sha256(origin) == record["sha256"], f"Upstream notice differs from the locked archive: {record['path']}")
        target = destination / name
        require(not target.is_symlink() and (not target.exists() or sha256(target) == record["sha256"]), f"Existing notice output differs: {name}")
        files[name] = {**record, "bytes": origin.stat().st_size}
    receipt = {
        "schema": 1, "nodeVersion": LOCK["node"]["version"], "nodeArchiveSha256": LOCK["node"]["sha256"],
        "ndkVersion": LOCK["ndk"]["version"], "ndkArchiveSha256": LOCK["ndk"]["sha256"], "files": files,
    }
    marker = destination / "manifest.json"
    require(not marker.is_symlink() and (not marker.exists() or json.loads(marker.read_text(encoding="utf-8")) == receipt), "Existing notice manifest is not this locked export")
    destination.mkdir(parents=True, exist_ok=True)
    for name, record in files.items():
        if not (destination / name).exists():
            shutil.copyfile((source if record["source"] == "node" else ndk) / record["path"], destination / name)
    marker.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return {"directory": str(destination), "manifestSha256": sha256(marker), "files": files}


def build_prototype(source, binaries, ndk, node_library, jobs):
    require(shutil.which("cmake"), "Linux JNI build prerequisite missing: cmake")
    output = CACHE / "prototype-build"
    subprocess.run([
        "cmake", "-S", str(HERE / "prototype"), "-B", str(output),
        f"-DCMAKE_TOOLCHAIN_FILE={ndk.resolve()}/build/cmake/android.toolchain.cmake",
        "-DANDROID_ABI=arm64-v8a", "-DANDROID_PLATFORM=android-24", "-DANDROID_STL=c++_shared",
        "-DCMAKE_BUILD_TYPE=Release", f"-DNODE_SOURCE_DIR={source}", f"-DNODE_LIBRARY={node_library}",
    ], check=True)
    subprocess.run(["cmake", "--build", str(output), "--parallel", str(jobs)], check=True)
    library = output / "liblishi_node_embed.so"
    require(library.is_file(), "No JNI shared-library build product found")
    return verify_elf(library, binaries, "liblishi_node_embed.so", {"libnode.so", "libc++_shared.so", "libc.so", "libm.so", "libdl.so", "liblog.so"})


def main():
    global CACHE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("inspect", "prepare", "prepare-ndk", "configure", "build", "verify", "prototype", "notices"), default="inspect")
    parser.add_argument("--ndk", type=Path)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--cache-dir", type=Path, help="Dedicated source/build directory; use the WSL ext4 filesystem for Linux builds")
    parser.add_argument("--source-archive", type=Path, help="Read the verified locked Node archive from a different download cache")
    parser.add_argument("--ndk-archive", type=Path, help="Read the verified Linux NDK archive from a different download cache")
    args = parser.parse_args()
    if args.cache_dir:
        CACHE = args.cache_dir.expanduser().resolve()
    require(CACHE != Path(CACHE.anchor) and CACHE != HERE.parents[1], "Use a dedicated build cache, not a filesystem or repository root")
    require(1 <= args.jobs <= 64, "jobs must be between 1 and 64")
    archive, result = inspect_source(args.source_archive)
    result["phase"] = args.phase
    result["cacheDirectory"] = str(CACHE)
    if args.phase == "prepare-ndk":
        ndk_archive = args.ndk_archive.resolve() if args.ndk_archive else CACHE / "downloads" / LOCK["ndk"]["file"]
        result["ndkDirectory"] = str(prepare_ndk(ndk_archive))
        result["ndkPrepared"] = True
    elif args.phase != "inspect":
        # Fail before extraction/configuration when a build was requested on the wrong host.
        if args.phase != "prepare":
            binaries, env = build_environment(args.ndk)
        source = prepare(archive)
        result["sourceDirectory"] = str(source)
        if args.phase in ("configure", "build"):
            result["configureArgs"] = configure(source, env)
        if args.phase == "build":
            # The top-level default also builds desktop cctest executables.
            # Use GYP's shared-runtime target and its required dependencies only.
            result["buildCommand"] = ["make", "-C", "out", f"-j{args.jobs}", "BUILDTYPE=Release", "libnode"]
            subprocess.run(result["buildCommand"], cwd=source, env=env, check=True)
        if args.phase in ("build", "verify"):
            result.update(verify(source, binaries))
        if args.phase == "prototype":
            result["nodeLibrary"] = verify(source, binaries)
            result["jniLibrary"] = build_prototype(source, binaries, args.ndk, result["nodeLibrary"]["file"], args.jobs)
            result["compiled"] = True
            result["staticVerified"] = True
        if args.phase in ("build", "verify", "prototype", "notices"):
            result["notices"] = export_notices(source, args.ndk.resolve())
    CACHE.mkdir(parents=True, exist_ok=True)
    (CACHE / f"{args.phase}-result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"Android Node gate not passed: {error}", file=sys.stderr)
        sys.exit(1)
