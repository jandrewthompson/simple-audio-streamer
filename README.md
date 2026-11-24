# Christmas 2026 — audio player

A small, dependency-free HTML5 player. One `<audio>` element, a native control
bar for seeking/volume/AirPlay, and a custom playlist generated from the files
in `data/`.

- **Browser:** vanilla HTML, CSS and ES modules. No framework, no bundler.
- **Server:** nginx in Docker (HTTP `Range`, caching, CSP). Cloudflare Tunnel
  sits in front of it; that part lives outside this project.
- **Build:** one Python script that reads tags with `ffprobe` and writes
  `site/playlist.json`.

## Quick start

```bash
make build          # data/ -> site/playlist.json
make up             # docker compose up -d (also runs build first)
xdg-open http://127.0.0.1:8099   # or just visit it
```

`make up` depends on `build`, so the manifest is never older than `data/`.

## Adding music

1. Create or use an album folder under `data/`, e.g. `data/Christmas 2026/`.
2. Drop audio files in it: `.mp3`, `.m4a`, `.m4b`, `.aac`, `.ogg`, `.oga`,
   `.opus`, `.flac`, `.wav`, `.webm`.
3. Run `make build` and refresh the page.

Metadata rules:

- Title, artist, album, year and track number come from the file tags.
- If a file has no title/track tag, `NN Title - extra.mp3` is parsed as
  track `NN`, title `Title`. Leading years such as `2020 Vision` are left
  alone.
- Duration always comes from `ffprobe`; without it the row shows `--:--`.
- Files directly in `data/` become a "Singles" album.
- Nested folders inside an album are **not** included. The build warns rather
  than silently dropping them.
- Hidden files (`._*`, `.DS_Store`, etc.) and files with no audio stream are
  skipped.
- Track numbers are preserved as tagged, so a missing source track shows as a
  gap (this album has no track 5).

`ffprobe` is required by default. `--no-probe` builds from filenames alone if
you ever need it, at the cost of durations.

## Layout

```
site/                    document root (served read-only)
  index.html
  assets/app.js
  assets/styles.css
  assets/favicon.svg
  playlist.json          generated; do not edit by hand
data/                    audio files, served at /data/
  Christmas 2026/*.mp3
deploy/nginx.conf        server config
tools/build_playlist.py  manifest generator
tools/smoke_test.sh      HTTP checks
docker-compose.yml
Makefile
```

## Player behaviour

- Click a row to play it; clicking the active row toggles play/pause.
- Auto-advance at the end of a track.
- Shuffle and repeat (off → all → one) persist across visits.
- Last track, position and volume are restored, **paused** — browsers block
  audible autoplay, and starting on load would be rude.
- `#track=8` deep-links a track. The number is the tag number when one exists,
  otherwise the playlist position. With more than one album the fragment is
  namespaced as `#track=<album>.<number>` (albums and positions are zero-based),
  e.g. `#track=1.2`. The hash updates as you play, and pasting a new hash while
  the page is open selects the track without starting playback.
- Media Session metadata and handlers: lock screen, headset buttons and car
  displays work where the browser supports them.
- Keyboard: `Space` play/pause, `←`/`→` seek 10s, `N`/`P` next/previous,
  `S` shuffle, `R` repeat, `M` mute. Shortcuts are ignored while a link,
  button, form field, the native audio control or any other interactive
  element has focus.

## Serving

`docker compose up -d` runs `nginx:1.27-alpine` with:

- `/srv/site` from `./site` and `/srv/data` from `./data`, both read-only;
- full-file audio cached for a year; partial (Range) audio and error responses
  are not given a long lifetime;
- `playlist.json`, `index.html` and the page revalidated (`no-cache`);
- assets cached for an hour so a new manifest is picked up quickly;
- Range requests (nginx replies `206`/`Content-Range`, `416` for bad ranges);
- security headers and a same-origin CSP;
- no directory listing.

The container binds to `127.0.0.1:8099` only. Set `MUSIC_PORT` to change the
host port, or `MUSIC_BIND=0.0.0.0` to listen on every interface.

To expose it through the existing Cloudflare Tunnel, either set
`MUSIC_BIND=0.0.0.0` and point a public hostname at
`http://host.docker.internal:8099` (on Linux, add
`extra_hosts: ["host.docker.internal:host-gateway"]` to the service), or attach
`music-web` to the tunnel's Docker network and point at `http://music-web:80`.
No ports need publishing for the second option.

## Checks

```bash
make check   # fails when site/playlist.json is stale
make test    # stale check + HTTP checks against a running server
```

`tools/smoke_test.sh` verifies the page body, the served manifest, MIME types
for every track, cache headers (including that audio is not compressed), the
CSP, dotfile denial and the range behaviour: `200`, `206` with the full
`Content-Range`, a 100-byte body, and `416` past EOF with no year-long cache.
Override the target with `BASE_URL=http://host:port`, or use
`make test MUSIC_PORT=8123`.

Do not use `python3 -m http.server` to preview: its stdlib handler ignores
`Range`, so seeking would download the whole track first. Use the container.

## Design notes

- **Why a manifest?** Static servers do not expose directory listings, and
  having every visitor parse ID3 tags would cost bytes and a dependency. One
  generated JSON file gives instant durations and one request.
- **Why nginx?** It already does Range, caching and headers correctly; the
  Python script stays build-time only.
- **Privacy:** no analytics, cookies, third-party fonts or CDN requests. The
  only network requests are the page, its three assets, the manifest and the
  selected audio.
- **Replacing a track:** keep the filename stable and the edge/browser can hold
  the old audio for a year. Rename the file instead; the manifest and player
  follow automatically. The manifest is generated, so do not hand-edit `src`
  (a manual `?v=` would fail `make check` and be overwritten by the next build).
- **Cover art:** none of the source files have embedded art, and the PNG in
  `data/` is a screenshot, so the cover is typographic CSS driven by the
  album tags.
- **Track 5:** absent from the source set; the UI intentionally shows numbers
  1–4 and 6–12 rather than renumbering.

## Manifest shape

```json
{
  "generated": "2026-11-24T09:35:00Z",
  "albums": [
    {
      "dir": "Christmas 2026",
      "name": "Christmas 2026",
      "artist": "EWO",
      "year": "2026",
      "tracks": [
        {
          "title": "O Holy Night",
          "artist": "EWO",
          "track": 1,
          "duration": 404.53,
          "src": "data/Christmas%202026/01%20O%20Holy%20Night%20-%20ALL%20DEMO.mp3"
        }
      ]
    }
  ]
}
```

`src` is relative and percent-encoded, so it never hardcodes a host and the
page can be mounted at a subpath as long as the server maps `/data/` there
too. `generated` is ignored by `--check`, so an unchanged library still
passes.
