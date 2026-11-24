# Simple Audio Streamer

A small, dependency-free HTML5 audio player. It uses a single `<audio>` element, the browser's native control bar for seeking, volume, and AirPlay, and a custom playlist generated from audio files in `data/`.

- **Browser:** Vanilla HTML, CSS, and ES modules. No framework, no bundler.
- **Server:** Nginx in Docker (HTTP `Range` support, caching headers, and strict CSP). Designed to sit behind your reverse proxy or tunnel of choice.
- **Build:** A single Python 3 script that reads tags via `ffprobe` and generates `site/playlist.json`.

## Prerequisites

- **Python 3** and **`ffprobe`** (from FFmpeg) to build the playlist manifest.
- **Docker** and **Docker Compose** to run the server.

## Quick start

```bash
make build                       # data/ -> site/playlist.json
make up                          # docker compose up -d (runs build first)
xdg-open http://127.0.0.1:8099   # or open in your browser
```

`make up` depends on `build`, ensuring the manifest is never older than `data/`.

## Adding music

1. Create an album directory under `data/`, e.g., `data/SomeAlbum/`.
2. Drop audio files into it: `.mp3`, `.m4a`, `.m4b`, `.aac`, `.ogg`, `.oga`, `.opus`, `.flac`, `.wav`, or `.webm`.
3. Run `make build` and refresh the page.

### Metadata rules

- Title, artist, album, year, and track number are read from file tags.
- If a file lacks title/track tags, filenames matching `NN Title - extra.mp3` are parsed as track `NN` and title `Title`. Leading years (such as `2020 Vision`) are preserved as part of the title.
- Duration is extracted via `ffprobe`; without it, rows display `--:--`.
- Files placed directly in `data/` are grouped into a `"Singles"` album.
- Nested subdirectories inside an album folder are **not** traversed; the build script emits a warning rather than silently ignoring them.
- Hidden files (`._*`, `.DS_Store`, etc.) and files without an audio stream are skipped.
- Track numbers are preserved as tagged rather than renumbered, so missing tracks appear as gaps in the numbering.

`ffprobe` is required by default. You can pass `--no-probe` to `tools/build_playlist.py` to build from filenames and tags alone if needed, at the cost of omitting track durations.

## Project layout

```text
site/                    Document root (mounted read-only)
  index.html
  assets/app.js
  assets/styles.css
  assets/favicon.svg
  playlist.json          Generated; do not edit by hand
data/                    Audio files, served at /data/
  SomeAlbum/*.mp3
deploy/nginx.conf        Nginx server configuration
tools/build_playlist.py  Playlist manifest generator
tools/smoke_test.sh      HTTP and Range header verification
docker-compose.yml
Makefile
```

## Player behaviour

- Click a row to play; clicking the active row toggles play/pause.
- Automatically advances to the next track at the end of playback.
- Shuffle and repeat (`off` → `all` → `one`) states persist across visits in `localStorage`.
- The last played track, timestamp, and volume are restored on reload in a **paused** state (respecting browser autoplay policies).
- **Deep-linking:** `#track=8` selects a track by its tag number (or playlist position if untagged). When multiple albums exist, fragments are namespaced as `#track=<album>.<number>` (zero-indexed, e.g., `#track=1.2`). The URL hash updates during playback, and changing the hash selects the target track without forcing playback.
- **Media Session API:** Lock screen controls, headset buttons, and car head-unit displays work automatically where supported.
- **Keyboard shortcuts:** `Space` (play/pause), `←`/`→` (seek 10s), `N`/`P` (next/previous), `S` (shuffle), `R` (repeat), `M` (mute). Shortcuts are ignored when focus is on an interactive element or the native `<audio>` bar.

## Serving & deployment

`docker compose up -d` runs `nginx:1.27-alpine` with:

- `./site` mounted at `/srv/site` and `./data` at `/srv/data` (both read-only);
- Full-file audio responses (`200`) cached for 1 year (`immutable`); partial (`206`) and error responses are not cached long-term;
- `playlist.json` and `index.html` served with `no-cache` so updates appear immediately;
- Static assets (`.js`, `.css`, `.svg`) cached for 1 hour;
- Byte-range requests (`206` with `Content-Range`, `416` for out-of-bounds ranges);
- Security headers, a strict same-origin CSP, and disabled directory listings.

### Network & reverse proxy configuration

By default, the container binds only to `127.0.0.1:8099`. You can customize this via environment variables (or a `.env` file):

- `MUSIC_PORT` — Change the host port (default: `8099`).
- `MUSIC_BIND` — Change the bind interface (default: `127.0.0.1`; set to `0.0.0.0` to listen on all interfaces).

To expose the player publicly, place a reverse proxy (Caddy, Traefik, Nginx, Cloudflare Tunnel, etc.) in front of it using one of two patterns:

1. **Via host port:** Keep the default `127.0.0.1:8099` binding (or set `MUSIC_BIND=0.0.0.0` if your proxy runs inside a container) and proxy traffic to `http://127.0.0.1:8099` (or `http://host.docker.internal:8099`).
2. **Via Docker network:** Attach the `music-web` service to your reverse proxy's external Docker network in `docker-compose.yml` and proxy directly to `http://music-web:80` without publishing any host ports.

## Checks

```bash
make check   # Fails if site/playlist.json is out of sync with data/
make test    # Runs stale check + HTTP smoke tests against a running server
```

`tools/smoke_test.sh` verifies HTML rendering, manifest validity, audio MIME types, cache headers (ensuring audio is not gzip-compressed), CSP headers, dotfile denial, and HTTP `Range` responses (`200`, `206` with `Content-Range`, and `416` past EOF). Override the target URL with `BASE_URL=http://host:port`, or run `make test MUSIC_PORT=8123`.

> **Note:** Do not use `python3 -m http.server` for local testing—its standard library handler ignores `Range` headers, which breaks audio seeking. Always test against the Nginx container.

## Design notes

- **Why a static manifest?** Static web servers disable directory listings by default, and parsing ID3/Vorbis tags client-side adds bundle weight and latency. Pre-building a single JSON manifest keeps the frontend zero-dependency and loads durations immediately.
- **Why Nginx?** Nginx handles `Range` requests, MIME types, and cache-control headers natively, keeping the Python tooling strictly build-time.
- **Privacy:** Zero analytics, cookies, third-party fonts, or external CDN requests. The browser only fetches the HTML, CSS, JS, favicon, `playlist.json`, and requested audio files.
- **Updating audio files:** Because `200` audio responses are cached for a year, overwriting an existing file in place may leave clients with stale audio. Rename the file (or bump a version suffix in the filename) when replacing audio, then run `make build` so the manifest points to the new path.
- **Cover art:** Album covers are rendered purely with typographic CSS driven by album metadata tags, avoiding external image dependencies or embedded art extraction.

## Manifest format

```json
{
  "generated": "2026-11-24T09:35:00Z",
  "albums": [
    {
      "dir": "SomeAlbum",
      "name": "Some Album",
      "artist": "Example Artist",
      "year": "2026",
      "tracks": [
        {
          "title": "Opening Track",
          "artist": "Example Artist",
          "track": 1,
          "duration": 245.5,
          "src": "data/SomeAlbum/01%20Opening%20Track.mp3"
        }
      ]
    }
  ]
}
```

`src` paths are relative and percent-encoded so the player can be hosted at a domain root or under a subpath (provided `/data/` is routed alongside `index.html`). The `generated` timestamp is ignored by `make check` so rebuilding an unchanged library remains idempotent.