"""Offline ARM64 APK/R8 checks. Never reads application credentials or devices."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import zipfile


def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(args):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", check=False)
    return result.returncode, result.stdout + result.stderr


def dex_entries(data):
    if not data.startswith(b"dex\n") or len(data) < 112:
        raise ValueError("invalid DEX header")
    def word(offset):
        if not 0 <= offset <= len(data) - 4:
            raise ValueError("DEX word exceeds file")
        return struct.unpack_from("<I", data, offset)[0]
    def table(size_offset, offset_offset, row_size):
        count, offset = word(size_offset), word(offset_offset)
        if offset > len(data) or count > (len(data) - offset) // row_size:
            raise ValueError("DEX table exceeds file")
        return (offset + i * row_size for i in range(count))
    def uleb(offset):
        value = 0
        for shift in range(0, 35, 7):
            if offset >= len(data):
                raise ValueError("DEX ULEB128 exceeds file")
            byte = data[offset]
            offset += 1
            if shift == 28 and byte > 15:
                raise ValueError("DEX ULEB128 exceeds uint32")
            value |= (byte & 127) << shift
            if byte < 128:
                return value, offset
        raise ValueError("invalid DEX ULEB128")
    if word(32) != len(data) or word(36) != 112 or word(40) != 0x12345678:
        raise ValueError("unsupported DEX layout")
    strings = []
    for row in table(56, 60, 4):
        _, offset = uleb(word(row))
        end = data.index(0, offset)
        # JNI identifiers being checked are ASCII; unrelated MUTF-8 is opaque.
        strings.append(data[offset:end].decode("utf-8", errors="replace"))
    types = [strings[word(row)] for row in table(64, 68, 4)]
    method_ids = [struct.unpack_from("<HHI", data, row) for row in table(88, 92, 8)]
    defined = set()
    methods = set()
    for row in table(96, 100, 32):
        class_index = word(row)
        defined.add(types[class_index])
        offset = word(row + 24)
        if not offset:
            continue
        counts = []
        for _ in range(4):
            count, offset = uleb(offset)
            counts.append(count)
        # Each encoded field/method needs at least two/three bytes. This also
        # bounds loops for malformed inputs before decoding their contents.
        if (counts[0] + counts[1]) * 2 + (counts[2] + counts[3]) * 3 > len(data) - offset:
            raise ValueError("DEX class data exceeds file")
        for _ in range(counts[0] + counts[1]):
            _, offset = uleb(offset)
            _, offset = uleb(offset)
        for count in counts[2:]:
            method_index = 0
            for _ in range(count):
                difference, offset = uleb(offset)
                method_index += difference
                _, offset = uleb(offset)  # access flags
                _, offset = uleb(offset)  # code offset; native methods may be 0
                owner, _, name = method_ids[method_index]
                if owner != class_index:
                    raise ValueError("DEX method defined under wrong class")
                # method_ids alone includes references to methods that need
                # not be defined. Only class_data proves the JNI method exists.
                methods.add((types[owner], strings[name]))
    return defined, methods


def check_elf(data):
    if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", data, 18)[0] != 183:
        raise ValueError("expected little-endian ELF64 ARM64")
    offset = struct.unpack_from("<Q", data, 32)[0]
    size, count = struct.unpack_from("<HH", data, 54)
    if size != 56 or not 1 <= count <= 1024 or offset + size * count > len(data):
        raise ValueError("invalid ELF program header")
    loads = []
    for index in range(count):
        row = struct.unpack_from("<IIQQQQQQ", data, offset + index * size)
        if row[0] != 1:
            continue
        if row[7] < 16384 or row[7] & (row[7] - 1) or row[2] % row[7] != row[3] % row[7]:
            raise ValueError("ELF LOAD not 16KiB compatible")
        if row[2] + row[5] > len(data) or row[5] > row[6]:
            raise ValueError("ELF LOAD exceeds file")
        loads.append(hex(row[7]))
    if not loads:
        raise ValueError("missing ELF LOAD")
    return loads


def unsigned_package(apk):
    """A failed signature may be accepted only when no signing material exists."""
    with zipfile.ZipFile(apk) as archive:
        if any(re.fullmatch(r"META-INF/[^/]+\.(?:MF|SF|RSA|DSA|EC)", name, re.IGNORECASE)
               for name in archive.namelist()):
            return False
    # A damaged v2/v3 block can fall back to the same missing-v1-manifest error
    # as an unsigned APK. Never downgrade such a package to unsigned success.
    with open(apk, "rb") as stream:
        tail = b""
        while chunk := stream.read(1024 * 1024):
            block = tail + chunk
            if b"APK Sig Block 42" in block:
                return False
            tail = block[-15:]
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--native", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--allow-unsigned", action="store_true")
    parser.add_argument("--require-r8", action="store_true")
    parser.add_argument("--require-non-debuggable", action="store_true")
    parser.add_argument("--reference-apk", type=Path)
    args = parser.parse_args()
    if args.output.resolve() in {path.resolve() for path in (args.apk, args.native, args.reference_apk) if path}:
        raise ValueError("report path must not overwrite an input artifact")
    sdk = Path(os.environ["ANDROID_HOME"])
    tools = sdk / "build-tools" / "36.0.0"
    strip = Path(os.environ["NDK_HOME"]) / "toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-strip.exe"
    for path in [args.apk, args.native, tools / "zipalign.exe", tools / "apksigner.bat", strip]:
        if not path.is_file():
            raise ValueError("required artifact/tool missing: " + str(path))
    code, _ = run([tools / "zipalign.exe", "-c", "-P", "16", "4", args.apk])
    if code:
        raise ValueError("APK ZIP alignment failed")
    code, signature = run([tools / "apksigner.bat", "verify", "--verbose", "--print-certs", args.apk])
    signed = code == 0 and bool(re.search(r"Verified using v2 scheme.*true", signature))
    if not signed and not args.allow_unsigned:
        raise ValueError("APK signature v2 verification failed")
    if not signed and ("Missing META-INF/MANIFEST.MF" not in signature or not unsigned_package(args.apk)):
        raise ValueError("failed signature is not a recognized unsigned package")
    certificates = re.findall(r"Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F]{64})", signature)
    if signed and len(certificates) != 1:
        raise ValueError("expected one verified APK signer")
    cert = certificates[0].lower() if certificates else None
    if args.reference_apk:
        code, reference = run([tools / "apksigner.bat", "verify", "--print-certs", args.reference_apk])
        other = re.findall(r"Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F]{64})", reference)
        if code or not cert or len(other) != 1 or cert != other[0].lower():
            raise ValueError("signature differs from reference APK")
    with zipfile.ZipFile(args.apk) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("duplicate APK entries")
        libraries = [name for name in names if name.startswith("lib/") and name.endswith(".so")]
        expected = "lib/arm64-v8a/liblishi_app_lib.so"
        if libraries != [expected] or archive.getinfo(expected).file_size > 512 * 1024 * 1024:
            raise ValueError("unexpected/oversized native library")
        native = archive.read(expected)
        loads = check_elf(native)
        packed_hash = hashlib.sha256(native).hexdigest()
        compiled_hash = digest(args.native)
        comparison = "exact"
        if packed_hash != compiled_hash:
            # AGP strips release libraries. Compare with the same explicit strip
            # operation on a private copy; never mutate Cargo's original file.
            with tempfile.TemporaryDirectory(prefix="lishi-apk-check-") as folder:
                stripped = Path(folder) / "stripped.so"
                code, _ = run([strip, "--strip-unneeded", "-o", stripped, args.native])
                if code or packed_hash != digest(stripped):
                    raise ValueError("packed native bytes differ from compiled/stripped artifact")
            comparison = "strip-unneeded"
        defined, methods = set(), set()
        for name in names:
            if re.fullmatch(r"classes\d*\.dex", name):
                classes, members = dex_entries(archive.read(name))
                defined.update(classes)
                methods.update(members)
        required = {
            "Lio/timejump/lishi/RustSecretStoreBridge;": ["loadForRust"],
            "Lio/timejump/lishi/RustFileAccessBridge;": ["openFdForRust"],
            "Lio/timejump/lishi/SecretStorePlugin;": ["save", "delete", "status"],
            "Lio/timejump/lishi/DocumentPickerPlugin;": ["openDocument", "ensureIdle"],
        }
        for owner, members in required.items():
            if owner not in defined or any((owner, member) not in methods for member in members):
                raise ValueError("JNI/plugin entry removed or renamed: " + owner)
        rustls = sorted(name for name in defined if name.startswith("Lorg/rustls/platformverifier/"))
        if not rustls:
            raise ValueError("Rustls Android verifier missing after DEX processing")
    mapping = Path(__file__).resolve().parent.parent / "src-tauri/gen/android/app/build/outputs/mapping/universalRelease/mapping.txt"
    if args.require_r8:
        if not mapping.is_file() or not mapping.stat().st_size:
            raise ValueError("R8 mapping unavailable")
        text = mapping.read_text(encoding="utf-8")
        for owner in required:
            name = owner[1:-1].replace("/", ".")
            if f"{name} -> {name}:" not in text:
                raise ValueError("R8 mapping renamed required JNI/plugin class: " + name)
    code, manifest = run([tools / "aapt.exe", "dump", "badging", args.apk])
    if code or "package: name='io.timejump.lishi'" not in manifest:
        raise ValueError("unexpected APK application ID")
    debuggable = "application-debuggable" in manifest
    if args.require_non_debuggable and debuggable:
        raise ValueError("release APK is debuggable")
    report = {
        "apk": str(args.apk.resolve()), "bytes": args.apk.stat().st_size, "sha256": digest(args.apk),
        "applicationId": "io.timejump.lishi", "debuggable": debuggable,
        "signatureV2": signed, "certificateSha256": cert, "zip16KiB": True, "elfLoads": loads,
        "nativeComparison": comparison, "packedNativeSha256": packed_hash, "packedNativeBytes": len(native),
        "requiredJniClasses": len(required), "requiredJniMethodDefinitions": sum(map(len, required.values())), "rustlsDexClasses": rustls,
        "r8MappingVerified": args.require_r8, "deviceTestsExecuted": False, "modelRequestsExecuted": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
