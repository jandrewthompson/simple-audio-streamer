#!/usr/bin/env python3
"""Build site/playlist.json from the audio files under data/.

Each immediate subdirectory of data/ becomes one album. Files dropped
directly in data/ are grouped into a synthetic album ("Singles", or
"Singles (loose files)" when a real Singles/ folder exists).

Metadata is read with ffprobe, which is required by default. Per-file
probe failures fall back to a "NN Title - extra" filename and a null
duration. `--no-probe` skips ffprobe entirely, for environments without it.

Usage:
    python3 tools/build_playlist.py
    python3 tools/build_playlist.py --check      # exit 1 when stale
    python3 tools/build_playlist.py --allow-empty

Relative, percent-encoded URLs are written so the manifest works whether
the site is served from a domain root or a subdirectory.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

AUDIO_EXTENSIONS = {
    ".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".oga", ".opus",
    ".flac", ".wav", ".webm",
}

# "01 O Holy Night - ALL DEMO" -> track 1, title "O Holy Night"
# A track prefix needs a separator, so "2020 Vision" is not track 202.
FILENAME_RE = re.compile(
    r"^(?:(?P<track>\d{1,2})(?=[\s._\-])[\s._\-]+(?!\d))?"
    r"(?P<title>.+?)(?:\s+-\s+(?P<suffix>.+))?$"
)

SINGLES_ALBUM = "Singles"
PROBE_TIMEOUT = 30


class BuildError(Exception):
    """A problem the user can fix, reported without a traceback."""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the playlist manifest.")
    parser.add_argument("--data", default="data", type=Path,
                        help="directory containing album subdirectories (default: data)")
    parser.add_argument("--out", default="site/playlist.json", type=Path,
                        help="output manifest (default: site/playlist.json)")
    parser.add_argument("--url-prefix", default="data",
                        help="URL path prefix that serves --data (default: data)")
    parser.add_argument("--check", action="store_true",
                        help="verify the output is up to date instead of writing it")
    parser.add_argument("--allow-empty", action="store_true",
                        help="succeed when no audio files are found")
    parser.add_argument("--no-probe", action="store_true",
                        help="skip ffprobe; use filenames only and no durations")
    return parser.parse_args(argv)


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def printable(text: str) -> str:
    """Replace lone surrogates from undecodable filenames with '?'."""
    return text.encode("utf-8", "replace").decode("utf-8")


def sorted_by_name(paths: list[Path]) -> list[Path]:
    return sorted(paths, key=lambda p: (p.name.casefold(), p.name))


def audio_files(directory: Path) -> list[Path]:
    try:
        children = list(directory.iterdir())
    except OSError as exc:
        raise BuildError(f"cannot read {directory}: {exc}") from exc

    return sorted_by_name([
        path for path in children
        if path.is_file()
        and not path.name.startswith(".")
        and path.suffix.lower() in AUDIO_EXTENSIONS
    ])


def probe(path: Path, ffprobe: str | None) -> dict:
    """Return tags, duration and probe status for one file."""
    empty = {"tags": {}, "duration": None, "failed": False, "has_audio": None}
    if not ffprobe:
        return empty

    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=PROBE_TIMEOUT, check=True,
        )
        payload = json.loads(result.stdout or "{}")
    except (subprocess.SubprocessError, ValueError, OSError):
        return {**empty, "failed": True}

    fmt = payload.get("format") or {}
    streams = payload.get("streams") or []
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    tags: dict[str, str] = {}
    if audio:
        tags.update({str(k).lower(): str(v) for k, v in (audio.get("tags") or {}).items()})
    tags.update({str(k).lower(): str(v) for k, v in (fmt.get("tags") or {}).items()})

    duration = _duration(fmt.get("duration"))
    if duration is None and audio:
        duration = _duration(audio.get("duration"))

    return {
        "tags": tags,
        "duration": duration,
        "failed": False,
        "has_audio": audio is not None,
    }


def _duration(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, 2) if number > 0 else None


def parse_track_number(value: str | None) -> int | None:
    if not value:
        return None
    match = re.match(r"\s*(\d{1,4})", value)
    if not match:
        return None
    number = int(match.group(1))
    return number if number > 0 else None


def fallback_from_filename(path: Path) -> tuple[int | None, str]:
    stem = path.stem.strip()
    if not stem:
        return None, path.stem
    if stem.isdigit():
        return None, stem

    match = FILENAME_RE.match(stem)
    if not match:
        return None, stem

    track = int(match.group("track")) if match.group("track") else None
    title = match.group("title").strip() or stem
    return track, title


def year_from(tags: dict[str, str]) -> str:
    for key in ("date", "year"):
        value = tags.get(key) or ""
        if re.match(r"^\d{4}", value):
            return value[:4]
    return ""


def build_album(
    display_name: str,
    dir_label: str,
    files: list[Path],
    data_root: Path,
    url_prefix: str,
    ffprobe: str | None,
) -> dict | None:
    entries: list[tuple[Path, dict]] = []
    for path in files:
        info = probe(path, ffprobe)
        if info["failed"]:
            warn(f"{path}: ffprobe failed, using filename and no duration")
        elif info["has_audio"] is False:
            warn(f"{path}: no audio stream, skipping")
            continue
        entries.append((path, info))

    if not entries:
        return None

    album_name = ""
    artist = ""
    year = ""
    for _, info in entries:
        tags = info["tags"]
        album_name = album_name or (tags.get("album") or "").strip()
        artist = artist or (tags.get("album_artist") or tags.get("artist") or "").strip()
        year = year or year_from(tags)

    tracks = [make_track(path, info, data_root, url_prefix) for path, info in entries]
    tracks.sort(key=lambda t: (
        t["track"] is None,
        t["track"] if t["track"] is not None else 0,
        t["src"].casefold(),
        t["src"],
    ))

    seen: dict[int, str] = {}
    for track in tracks:
        number = track["track"]
        if number is None:
            continue
        if number in seen:
            warn(f"{display_name}: duplicate track {number} "
                 f"({seen[number]!r} and {track['title']!r})")
        else:
            seen[number] = track["title"]

    return {
        "dir": printable(dir_label),
        "name": printable(album_name or display_name),
        "artist": printable(artist),
        "year": year,
        "tracks": tracks,
    }


def make_track(path: Path, info: dict, data_root: Path, url_prefix: str) -> dict:
    tags = info["tags"]
    fb_track, fb_title = fallback_from_filename(path)

    title = (tags.get("title") or "").strip() or fb_title
    artist = (tags.get("artist") or tags.get("album_artist") or "").strip()
    tagged_track = parse_track_number(tags.get("track"))
    track = tagged_track if tagged_track is not None else fb_track

    relative = path.relative_to(data_root).as_posix()
    src = f"{url_prefix}/{relative}" if url_prefix else relative

    return {
        "title": printable(title),
        "artist": printable(artist),
        "track": track,
        "duration": info["duration"],
        "src": quote(src, safe="/", errors="surrogateescape"),
    }


def nested_audio(directory: Path) -> Path | None:
    """Return one nested audio file, if any, so albums cannot silently lose tracks."""
    try:
        for child in sorted_by_name([p for p in directory.iterdir() if p.is_dir()]):
            if child.name.startswith("."):
                continue
            for path in child.rglob("*"):
                if (path.is_file() and not path.name.startswith(".")
                        and path.suffix.lower() in AUDIO_EXTENSIONS):
                    return path
    except OSError:
        return None
    return None


def build_manifest(data_root: Path, url_prefix: str, use_probe: bool) -> dict:
    if not data_root.is_dir():
        raise BuildError(f"data directory not found: {data_root}")

    ffprobe = shutil.which("ffprobe") if use_probe else None
    if use_probe and not ffprobe:
        raise BuildError("ffprobe is required for metadata; install ffmpeg "
                         "or pass --no-probe")

    try:
        children = list(data_root.iterdir())
    except OSError as exc:
        raise BuildError(f"cannot read {data_root}: {exc}") from exc

    album_dirs = sorted_by_name([
        child for child in children
        if child.is_dir() and not child.name.startswith(".")
    ])

    albums: list[dict] = []

    loose = audio_files(data_root)
    if loose:
        name = SINGLES_ALBUM
        existing = {child.name.casefold() for child in album_dirs}
        if name.casefold() in existing:
            name = f"{name} (loose files)"
        album = build_album(name, ".", loose, data_root, url_prefix, ffprobe)
        if album:
            albums.append(album)

    for child in album_dirs:
        album = build_album(child.name, child.name, audio_files(child),
                            data_root, url_prefix, ffprobe)
        if album:
            albums.append(album)
        buried = nested_audio(child)
        if buried:
            warn(f"{child.name}: ignoring nested audio such as "
                 f"{buried.relative_to(child)} (only files directly in an "
                 f"album folder are included)")

    singles = next((album for album in albums if album["dir"] == "."), None)
    if singles and any(
        album is not singles and album["name"].casefold() == singles["name"].casefold()
        for album in albums
    ):
        singles["name"] = f'{singles["name"]} (loose files)'

    total = sum(len(album["tracks"]) for album in albums)
    print(f"found {total} track(s) in {len(albums)} album(s)", flush=True)

    return {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "albums": albums,
    }


def serialise(manifest: dict) -> str:
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def comparable(manifest: Any) -> Any:
    if not isinstance(manifest, dict):
        return None
    clone = copy.deepcopy(manifest)
    clone.pop("generated", None)
    return clone


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        handle = os.fdopen(fd, "w", encoding="utf-8")
        with handle:
            os.fchmod(handle.fileno(), 0o644)  # mkstemp starts at 0600
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        try:
            dir_fd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def check(path: Path, manifest: dict) -> int:
    if not path.exists():
        print(f"stale: {path} does not exist", file=sys.stderr)
        return 1

    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"stale: cannot read {path}: {exc}", file=sys.stderr)
        return 1

    if not isinstance(existing, dict) or not isinstance(existing.get("albums"), list):
        print(f"stale: {path} is not a valid manifest", file=sys.stderr)
        return 1

    if comparable(existing) == comparable(manifest):
        print(f"{path} is up to date")
        return 0

    print(f"stale: {path} does not match data/; rerun the same build command",
          file=sys.stderr)
    return 1


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    prefix = args.url_prefix.strip().strip("/")
    if "://" in prefix:
        print("error: --url-prefix must be a path, not an absolute URL",
              file=sys.stderr)
        return 2

    try:
        manifest = build_manifest(args.data, prefix, not args.no_probe)
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    total = sum(len(album["tracks"]) for album in manifest["albums"])
    if total == 0 and not args.allow_empty:
        print(f"error: no audio files found under {args.data}; "
              f"pass --allow-empty to publish an empty playlist", file=sys.stderr)
        return 1

    if args.check:
        return check(args.out, manifest)

    try:
        write_atomic(args.out, serialise(manifest))
    except OSError as exc:
        print(f"error: cannot write {args.out}: {exc}", file=sys.stderr)
        return 1

    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
