/* Static playlist player: no dependencies, one <audio> element. */

const STORAGE_KEY = "ewo-player:v1";

const ICON_PLAY = `
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
    <path d="M8 5.5v13l11-6.5-11-6.5Z"></path>
  </svg>`;

const ICON_PAUSE = `
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"></path>
  </svg>`;

const els = {
  app: document.getElementById("app"),
  player: document.getElementById("player"),
  audio: document.getElementById("audio"),
  npTitle: document.getElementById("np-title"),
  npArtist: document.getElementById("np-artist"),
  notice: document.getElementById("notice"),
  announcer: document.getElementById("announcer"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  shuffle: document.getElementById("shuffle"),
  repeat: document.getElementById("repeat"),
  repeatLabel: document.getElementById("repeat-label"),
};

const state = {
  queue: [],
  rows: new Map(),
  order: [],
  pos: 0,
  current: -1,
  albumCount: 0,
  repeat: "off",
  shuffle: false,
  pendingSeek: null,
  failed: new Set(),
  playRequested: false,
  savedAt: 0,
  lastPositionUpdate: 0,
  wired: false,
};

/* ---------- helpers ---------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value; // constants only
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

function formatTotal(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function albumStats(album) {
  const count = album.tracks.length;
  const total = album.tracks.reduce(
    (sum, track) => sum + (Number.isFinite(track.duration) ? track.duration : 0),
    0,
  );
  const parts = [`${count} ${count === 1 ? "track" : "tracks"}`];
  if (total > 0) parts.push(formatTotal(total));
  return parts.join(" · ");
}

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function parseHash() {
  const match = /^#track=(?:(\d+)\.)?(\d+)$/.exec(window.location.hash);
  if (!match) return null;
  return {
    album: match[1] == null ? null : Number(match[1]),
    number: Number(match[2]),
  };
}

function trackFragment(index) {
  const entry = state.queue[index];
  if (!entry) return "1";
  const number = entry.track ? entry.track.track : null;
  const withinAlbum = Number.isInteger(number) && number > 0
    ? String(number)
    : String(entry.localIndex + 1);
  return state.albumCount > 1 ? `${entry.albumIndex}.${withinAlbum}` : withinAlbum;
}

function findIndexForFragment({ album, number }) {
  if (!Number.isInteger(number) || number < 1) return -1;

  if (album != null) {
    const inAlbum = state.queue.filter((entry) => entry.albumIndex === album);
    const byTag = inAlbum.find((entry) => entry.track.track === number);
    if (byTag) return byTag.index;
    const byPosition = inAlbum[number - 1];
    return byPosition ? byPosition.index : -1;
  }

  // A bare number is a tag when the library has any. Only fall back to a
  // playlist position when nothing is tagged, so #track=5 cannot silently
  // land on the sixth row of an album that simply lacks a track 5.
  const hasTags = state.queue.some(
    (entry) => Number.isInteger(entry.track.track) && entry.track.track > 0,
  );
  if (hasTags) {
    const byTag = state.queue.find((entry) => entry.track.track === number);
    return byTag ? byTag.index : -1;
  }
  return number <= state.queue.length ? number - 1 : -1;
}

function setHash(index) {
  const next = `#track=${trackFragment(index)}`;
  if (window.location.hash === next) return;
  try {
    window.history.replaceState(null, "", next);
  } catch {
    /* ignore */
  }
}

function announce(text) {
  if (!els.announcer) return;
  els.announcer.textContent = "";
  window.setTimeout(() => {
    els.announcer.textContent = text;
  }, 40);
}

let noticeTimer = 0;

function showNotice(text) {
  if (!els.notice) return;
  els.notice.textContent = text;
  els.notice.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    els.notice.hidden = true;
  }, 7000);
}

function hideNotice() {
  if (!els.notice) return;
  els.notice.hidden = true;
  window.clearTimeout(noticeTimer);
}

/* ---------- rendering ---------- */

function render(manifest) {
  const albums = (manifest.albums || []).filter(
    (album) => Array.isArray(album.tracks) && album.tracks.length > 0,
  );

  els.app.replaceChildren();
  els.app.setAttribute("aria-busy", "false");

  if (albums.length === 0) {
    els.app.append(
      el("div", { class: "status", role: "status" },
        el("p", { text: "No tracks found." }),
        el("p", { text: "Add audio files under data/ and run `make build`." }),
      ),
    );
    return;
  }

  state.queue = [];
  state.rows.clear();
  state.albumCount = albums.length;

  if (albums.length > 1) {
    els.app.append(el("h1", { class: "visually-hidden", text: "Music" }));
  }

  albums.forEach((album, albumIndex) => {
    const singleAlbum = albums.length === 1;
    const headingTag = singleAlbum ? "h1" : "h2";
    const headingId = `album-${albumIndex}`;
    const listId = albumIndex === 0 ? "playlist" : `playlist-${albumIndex}`;

    const cover = el("div", { class: "cover", "aria-hidden": "true" },
      el("p", { class: "cover__artist", text: album.artist || "Album" }),
      el("p", { class: "cover__title", text: album.name }),
      el("p", { class: "cover__year", text: album.year || "" }),
    );

    const meta = el("div", { class: "album__meta" },
      el("p", { class: "eyebrow", text: singleAlbum ? "Album" : "Release" }),
      el(headingTag, { class: "album__title", id: headingId, text: album.name }),
      album.artist ? el("p", { class: "album__artist", text: album.artist }) : null,
      el("p", { class: "album__stats", text: albumStats(album) }),
    );

    const header = el("header", { class: "album__header" }, cover, meta);

    const list = el("ol", { class: "tracks", id: listId, role: "list", tabindex: "-1" });

    album.tracks.forEach((track, trackIndex) => {
      const index = state.queue.length;
      state.queue.push({ album, albumIndex, track, localIndex: trackIndex, index });

      if (!state.rows.has(index)) {
        const number = Number.isInteger(track.track) ? track.track : trackIndex + 1;
        const showArtist = track.artist && track.artist !== album.artist;

        const row = el("li", { class: "track", "data-index": String(index) },
          el("button", {
            type: "button",
            class: "track__button",
            "aria-label": `Play ${track.title}`,
          },
            el("span", { class: "track__number", "aria-hidden": "true", text: String(number) }),
            el("span", { class: "track__body" },
              el("span", { class: "track__title", text: track.title }),
              showArtist ? el("span", { class: "track__artist", text: track.artist }) : null,
            ),
            el("span", { class: "track__duration", text: formatDuration(track.duration) }),
            el("span", { class: "track__state", "aria-hidden": "true", html: ICON_PLAY }),
          ),
        );

        state.rows.set(index, row);
        list.append(row);
      }
    });

    const section = el("section", { class: "album", "aria-labelledby": headingId }, header, list);
    els.app.append(section);
  });

  const first = albums[0];
  document.title = albums.length === 1
    ? `${first.name}${first.artist ? ` — ${first.artist}` : ""}`
    : "Music";

  els.player.hidden = false;
  restoreState();
}

function buildOrder() {
  const indices = state.queue.map((_, index) => index);

  if (!state.shuffle) {
    state.order = indices;
    state.pos = state.current >= 0 ? state.current : 0;
    return;
  }

  const rest = state.current >= 0
    ? indices.filter((index) => index !== state.current)
    : indices.slice();
  shuffleInPlace(rest);
  state.order = state.current >= 0 ? [state.current, ...rest] : rest;
  state.pos = 0;
}

/* ---------- selection and transport ---------- */

function select(index, options = {}) {
  const {
    autoplay = true,
    seek = null,
    hash = true,
    speak = autoplay,
    toggle = false,
  } = options;
  if (index < 0 || index >= state.queue.length) return;

  if (autoplay && index === state.current) {
    if (toggle) {
      togglePlay();
      return;
    }
    if (els.audio.error) {
      restartCurrent({ seek });
      return;
    }
    els.audio.currentTime = 0;
    state.playRequested = true;
    els.audio.play().catch(() => {});
    return;
  }

  const entry = state.queue[index];
  state.current = index;
  state.pos = Math.max(0, state.order.indexOf(index));
  state.pendingSeek = Number.isFinite(seek) ? Math.max(0, seek) : null;

  els.audio.src = entry.track.src;
  els.audio.load();

  updateNowPlaying(entry);
  updateRows();
  updateMediaSession(entry);
  if (speak) announce(`Now playing: ${entry.track.title}`);
  if (hash) setHash(index);

  saveState(true);

  if (autoplay) {
    state.playRequested = true;
    els.audio.play().catch((error) => {
      if (error && error.name === "NotAllowedError") {
        state.playRequested = false;
        showNotice("Press play to start playback.");
      } else if (error && error.name !== "AbortError") {
        showNotice("Playback could not start.");
      }
    });
  }
}

function restartCurrent(options = {}) {
  const entry = state.queue[state.current];
  if (!entry) return;

  state.failed.delete(state.current);
  state.pendingSeek = Number.isFinite(options.seek) ? Math.max(0, options.seek) : null;
  els.audio.src = entry.track.src;
  els.audio.load();
  state.playRequested = true;
  hideNotice();
  els.audio.play().catch((error) => {
    if (error && error.name === "NotAllowedError") {
      state.playRequested = false;
      showNotice("Press play to start playback.");
    } else if (error && error.name !== "AbortError") {
      showNotice("Playback could not start.");
    }
  });
}

function togglePlay() {
  if (!els.audio.getAttribute("src")) {
    if (state.queue.length) select(state.order[0] ?? 0);
    return;
  }

  if (els.audio.error) {
    restartCurrent();
    return;
  }

  if (els.audio.paused) {
    state.playRequested = true;
    els.audio.play().catch((error) => {
      if (error && error.name !== "AbortError") {
        state.playRequested = false;
        showNotice("Playback could not start.");
      }
    });
  } else {
    state.playRequested = false;
    els.audio.pause();
  }
}

function advance(direction, options = {}) {
  const { auto = false } = options;
  if (state.queue.length === 0) return;

  if (auto && state.repeat === "one" && state.current >= 0) {
    els.audio.currentTime = 0;
    state.playRequested = true;
    els.audio.play().catch(() => {});
    return;
  }

  if (state.current < 0) {
    select(state.order[0] ?? 0, { autoplay: true });
    return;
  }

  let pos = state.pos + direction;
  const last = state.order.length - 1;

  if (pos < 0 || pos > last) {
    if (auto && state.repeat !== "all") {
      els.audio.pause();
      updateRows();
      saveState(true);
      return;
    }
    pos = (pos + state.order.length) % state.order.length;
  }

  select(state.order[pos], { autoplay: true });
}

function seekBy(delta) {
  if (!els.audio.getAttribute("src")) return;
  const duration = els.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  els.audio.currentTime = clamp(els.audio.currentTime + delta, 0, Math.max(0, duration - 0.2));
}

function toggleMute() {
  els.audio.muted = !els.audio.muted;
  saveState(true);
  announce(els.audio.muted ? "Muted" : "Unmuted");
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  buildOrder();
  applyShuffleUI();
  saveState(true);
  announce(`Shuffle ${state.shuffle ? "on" : "off"}`);
}

function cycleRepeat() {
  state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  applyRepeatUI();
  saveState(true);
  announce(`Repeat: ${state.repeat}`);
}

/* ---------- UI updates ---------- */

function updateNowPlaying(entry) {
  els.npTitle.textContent = entry.track.title;
  const artist = entry.track.artist || entry.album.artist || "";
  els.npArtist.textContent = artist;
}

function updateRows() {
  const playing = !els.audio.paused && !els.audio.ended;

  for (const [index, row] of state.rows) {
    const active = index === state.current;
    const entry = state.queue[index];
    const button = row.querySelector(".track__button");
    const stateIcon = row.querySelector(".track__state");
    if (!button || !stateIcon) continue;

    row.classList.toggle("is-active", active);
    row.classList.toggle("is-playing", active && playing);
    stateIcon.innerHTML = active && playing ? ICON_PAUSE : ICON_PLAY;

    if (active) {
      row.setAttribute("aria-current", "true");
      button.setAttribute(
        "aria-label",
        `${playing ? "Pause" : "Play"} ${entry.track.title}`,
      );
    } else {
      row.removeAttribute("aria-current");
      button.setAttribute("aria-label", `Play ${entry.track.title}`);
    }
  }
}

function applyShuffleUI() {
  els.shuffle.setAttribute("aria-pressed", state.shuffle ? "true" : "false");
  els.shuffle.setAttribute("aria-label", `Shuffle: ${state.shuffle ? "on" : "off"}`);
}

function applyRepeatUI() {
  const labels = { off: "Repeat: off", all: "Repeat: all", one: "Repeat: one" };
  const mode = state.repeat;
  els.repeat.setAttribute("aria-pressed", mode === "off" ? "false" : "true");
  els.repeat.setAttribute("aria-label", labels[mode]);
  els.repeat.title = `${labels[mode]} (R)`;
  els.repeat.dataset.repeat = mode;
  if (els.repeatLabel) els.repeatLabel.textContent = mode === "one" ? "Repeat 1" : "Repeat";
}

/* ---------- persistence ---------- */

function saveState(force = false) {
  const now = Date.now();
  if (!force && now - state.savedAt < 4000) return;
  state.savedAt = now;

  const entry = state.queue[state.current];
  const position = state.pendingSeek != null
    ? state.pendingSeek
    : els.audio.ended
      ? 0
      : Number.isFinite(els.audio.currentTime) ? els.audio.currentTime : 0;

  const payload = {
    src: entry ? entry.track.src : null,
    position,
    volume: els.audio.volume,
    muted: els.audio.muted,
    shuffle: state.shuffle,
    repeat: state.repeat,
  };

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable; playback still works */
  }
}

function restoreState() {
  let saved = null;
  try {
    saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    saved = null;
  }

  if (saved && typeof saved === "object") {
    if (Number.isFinite(saved.volume)) els.audio.volume = clamp(saved.volume, 0, 1);
    if (typeof saved.muted === "boolean") els.audio.muted = saved.muted;
    if (["off", "all", "one"].includes(saved.repeat)) state.repeat = saved.repeat;
    if (typeof saved.shuffle === "boolean") state.shuffle = saved.shuffle;
  }

  applyShuffleUI();
  applyRepeatUI();
  buildOrder();

  const hash = parseHash();
  let index = -1;
  let hashResolved = false;

  if (hash) {
    index = findIndexForFragment(hash);
    hashResolved = index >= 0;
  }

  if (index < 0 && saved && typeof saved.src === "string") {
    index = state.queue.findIndex((entry) => entry.track.src === saved.src);
  }

  let seek = null;
  if (index >= 0 && saved && saved.src === state.queue[index].track.src
      && Number.isFinite(saved.position)) {
    seek = saved.position;
  }

  if (index < 0) index = 0;

  select(index, {
    autoplay: false,
    seek,
    hash: hashResolved,
    speak: false,
  });
}

/* ---------- media session ---------- */

function updateMediaSession(entry) {
  if (!("mediaSession" in navigator) || typeof window.MediaMetadata !== "function") return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: entry.track.title,
      artist: entry.track.artist || entry.album.artist || "",
      album: entry.album.name,
    });
  } catch {
    /* ignore */
  }
}

function updatePositionState(force = false) {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;

  const now = Date.now();
  if (!force && now - state.lastPositionUpdate < 900) return;
  state.lastPositionUpdate = now;

  const { duration, currentTime, playbackRate } = els.audio;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return;

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
      position: clamp(currentTime, 0, duration),
    });
  } catch {
    /* ignore */
  }
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  const bind = (action, handler) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* unsupported action */
    }
  };

  bind("play", () => {
    els.audio.play().catch(() => {});
  });
  bind("pause", () => els.audio.pause());
  bind("previoustrack", () => advance(-1));
  bind("nexttrack", () => advance(1));
  bind("seekbackward", (details) => seekBy(-(details.seekOffset || 10)));
  bind("seekforward", (details) => seekBy(details.seekOffset || 10));
  bind("seekto", (details) => {
    if (Number.isFinite(details.seekTime)) seekBy(details.seekTime - els.audio.currentTime);
  });
  bind("stop", () => {
    els.audio.pause();
    els.audio.currentTime = 0;
  });
}

/* ---------- events ---------- */

function nextPlayableIndex() {
  if (!state.order.length) return null;
  for (let step = 1; step <= state.order.length; step += 1) {
    const pos = (state.pos + step) % state.order.length;
    const index = state.order[pos];
    if (!state.failed.has(index)) return index;
  }
  return null;
}

function handleError() {
  if (state.current < 0 || !els.audio.error) return;

  const entry = state.queue[state.current];
  const row = state.rows.get(state.current);
  state.failed.add(state.current);
  if (row) row.classList.add("is-error");
  if (state.playRequested) {
    showNotice(`“${entry.track.title}” could not be played.`);
  }

  if (!state.playRequested || state.queue.length <= 1) return;

  const failedIndex = state.current;
  window.setTimeout(() => {
    if (state.current !== failedIndex || !els.audio.error) return;
    const next = nextPlayableIndex();
    if (next == null) {
      showNotice("No playable tracks remain.");
      return;
    }
    select(next, { autoplay: true, hash: true });
  }, 900);
}

function wireAudio() {
  const audio = els.audio;

  audio.addEventListener("loadedmetadata", () => {
    if (state.pendingSeek != null) {
      const target = Number.isFinite(audio.duration)
        ? clamp(state.pendingSeek, 0, Math.max(0, audio.duration - 0.2))
        : state.pendingSeek;
      try {
        audio.currentTime = target;
      } catch {
        /* ignore */
      }
      state.pendingSeek = null;
    }
    updateRows();
    updatePositionState(true);
  });

  audio.addEventListener("playing", () => {
    state.failed.delete(state.current);
    state.playRequested = true;
    const row = state.rows.get(state.current);
    if (row) row.classList.remove("is-error");
    hideNotice();
    updateRows();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    updatePositionState(true);
  });

  audio.addEventListener("play", () => {
    state.playRequested = true;
    updateRows();
    saveState(true);
  });

  audio.addEventListener("pause", () => {
    state.playRequested = false;
    updateRows();
    saveState(true);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  });

  audio.addEventListener("ended", () => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
    advance(1, { auto: true });
  });

  audio.addEventListener("timeupdate", () => {
    updatePositionState();
    saveState();
  });

  audio.addEventListener("volumechange", () => saveState());
  audio.addEventListener("seeked", () => saveState());
  audio.addEventListener("error", handleError);
}

function wireHash() {
  window.addEventListener("hashchange", () => {
    const hash = parseHash();
    if (!hash) return;
    const index = findIndexForFragment(hash);
    if (index < 0) {
      showNotice("That track link does not exist.");
      return;
    }
    if (index === state.current) return;
    select(index, { autoplay: false, hash: false, speak: false });
    announce(`Selected: ${state.queue[index].track.title}`);
  });
}

function wireControls() {
  els.prev.addEventListener("click", () => advance(-1));
  els.next.addEventListener("click", () => advance(1));
  els.shuffle.addEventListener("click", toggleShuffle);
  els.repeat.addEventListener("click", cycleRepeat);

  els.app.addEventListener("click", (event) => {
    const button = event.target.closest(".track__button");
    if (!button) return;
    const row = button.closest(".track");
    if (!row) return;
    const index = Number(row.dataset.index);
    if (Number.isInteger(index)) select(index, { autoplay: true, toggle: true });
  });
}

function wireKeyboard() {
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;

    const target = event.target;
    const interactive = target instanceof Element && target.closest(
      "a, button, input, select, textarea, summary, audio, video, [contenteditable='true']",
    );
    if (interactive || target?.isContentEditable) return;

    switch (event.key) {
      case " ":
      case "Spacebar":
        event.preventDefault();
        togglePlay();
        break;
      case "ArrowRight":
        event.preventDefault();
        seekBy(10);
        break;
      case "ArrowLeft":
        event.preventDefault();
        seekBy(-10);
        break;
      case "n":
      case "N":
        advance(1);
        break;
      case "p":
      case "P":
        advance(-1);
        break;
      case "m":
      case "M":
        toggleMute();
        break;
      case "s":
      case "S":
        toggleShuffle();
        break;
      case "r":
      case "R":
        cycleRepeat();
        break;
      default:
        break;
    }
  });
}

function wireLifecycle() {
  window.addEventListener("pagehide", () => saveState(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveState(true);
  });
}

function wireEverything() {
  if (state.wired) return;
  state.wired = true;
  wireAudio();
  wireControls();
  wireKeyboard();
  wireHash();
  wireLifecycle();
}

/* ---------- boot ---------- */

function showFatal(message, retry = true) {
  els.app.setAttribute("aria-busy", "false");
  els.app.replaceChildren(
    el("div", { class: "status", role: "alert" },
      el("p", { text: message }),
      retry
        ? el("p", {},
            el("button", {
              type: "button",
              class: "control",
              text: "Retry",
              onclick: () => window.location.reload(),
            }),
          )
        : null,
    ),
  );
  els.player.hidden = true;
}

async function init() {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("playlist.json", {
      cache: "no-cache",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const manifest = await response.json();
    if (!manifest || !Array.isArray(manifest.albums)) {
      throw new Error("malformed playlist");
    }

    setupMediaSession();
    wireEverything();
    render(manifest);
  } catch (error) {
    console.error(error);
    const message = error && error.name === "AbortError"
      ? "The playlist took too long to load."
      : `Could not load the playlist (${error.message || "unknown error"}).`;
    showFatal(message);
  } finally {
    window.clearTimeout(timer);
  }
}

init();
