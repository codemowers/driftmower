#!/usr/bin/env python3
"""Validate release tags and publish immutable desktop/chart release assets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import quote

NUMBER = r"(?:0|[1-9][0-9]*)"
IDENTIFIER = r"(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
VERSION = re.compile(rf"v{NUMBER}\.{NUMBER}\.{NUMBER}(?:-{IDENTIFIER}(?:\.{IDENTIFIER})*)?")
TARGETS = ("linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64")


def release_version(tag):
    if not VERSION.fullmatch(tag):
        raise ValueError("Release tags must be vMAJOR.MINOR.PATCH[-PRERELEASE]")
    return tag.removeprefix("v")


def metadata(event, ref_type, tag):
    if event != "push" or ref_type != "tag":
        return {"publish": "false"}
    version = release_version(tag)
    return {"publish": "true", "version": tag, "chart_version": version,
            "prerelease": str("-" in version).lower()}


def gh(*arguments):
    result = subprocess.run(["gh", *arguments], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "GitHub CLI request failed")
    return result.stdout


def lookup_release(repo, tag):
    result = subprocess.run(["gh", "api", "--include",
                             f"repos/{repo}/releases/tags/{quote(tag, safe='')}"],
                            capture_output=True, text=True)
    header, separator, body = result.stdout.partition("\n\n")
    status = re.match(r"HTTP/\S+ (\d+)", header)
    if status and status[1] == "404":
        return None
    if result.returncode or not separator or not status or status[1] != "200":
        raise RuntimeError(result.stderr.strip() or "Could not look up GitHub release")
    return json.loads(body)


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def publish(repo, tag, directory):
    version = release_version(tag)
    files = [directory / f"driftmower-desktop-{target}" for target in TARGETS]
    files.append(directory / f"driftmower-{version}.tgz")
    for path in files:
        if not path.is_file():
            raise ValueError(f"Missing release asset: {path.name}")
    sums = directory / "SHA256SUMS"
    sums.write_text("".join(f"{checksum(path)}  {path.name}\n" for path in sorted(files)))
    files.append(sums)

    release = lookup_release(repo, tag)
    if release is None:
        arguments = ["release", "create", tag, "--repo", repo, "--verify-tag",
                     "--draft", "--title", tag, "--generate-notes"]
        if "-" in version:
            arguments.append("--prerelease")
        gh(*arguments)
        release = {"draft": True, "assets": []}

    existing = {asset["name"]: asset for asset in release["assets"]}
    # Validate every existing asset before uploading anything. Never replace a
    # published binary on a rerun; only resume uploads of missing assets.
    with tempfile.TemporaryDirectory(prefix="driftmower-release-") as temporary:
        for path in files:
            asset = existing.get(path.name)
            if asset is None:
                continue
            digest = asset.get("digest") or ""
            if not digest.startswith("sha256:"):
                gh("release", "download", tag, "--repo", repo, "--pattern", path.name,
                   "--dir", temporary)
                digest = "sha256:" + checksum(Path(temporary) / path.name)
            if digest != "sha256:" + checksum(path):
                raise ValueError(f"Published asset differs: {path.name}; use a new release tag")
        for path in files:
            if path.name not in existing:
                gh("release", "upload", tag, str(path), "--repo", repo)

    if release["draft"]:
        gh("release", "edit", tag, "--repo", repo, "--draft=false",
           "--prerelease=" + str("-" in version).lower())
    print(f"Release assets ready: https://github.com/{repo}/releases/tag/{tag}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("metadata")
    upload = commands.add_parser("publish")
    upload.add_argument("--repo", required=True)
    upload.add_argument("--tag", required=True)
    upload.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "metadata":
        values = metadata(os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REF_TYPE"],
                          os.environ["GITHUB_REF_NAME"])
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            for key, value in values.items():
                stream.write(f"{key}={value}\n")
    else:
        publish(args.repo, args.tag, args.directory)


if __name__ == "__main__":
    main()
