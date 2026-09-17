// app.js — Boson Avatar call demo.
//
// Looks like the eval site, but Start Call plays a recorded conversation in
// the call frame instead of joining a LiveKit room. The camera and microphone
// are real local devices: they drive the self-view and the level meter and
// are never recorded or sent anywhere.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pref = {
    get: (k) => { try { return localStorage.getItem("demo." + k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem("demo." + k, v); } catch (e) { /* private mode */ } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fmt = (sec) => { const s = Math.max(0, Math.floor(sec)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

  const CONVERSATIONS = {
    office: { video: "media/office.mp4", idle: "media/office-idle.mp4", poster: "media/office.jpg" },
    vacation: { video: "media/vacation.mp4", idle: "media/vacation-idle.mp4", poster: "media/vacation.jpg" },
  };
  const CONNECT_MIN_MS = 3000;   // how long "Connecting…" shows at least (longer if the video is still loading)
  const LOAD_TIMEOUT_MS = 20000;

  const video = $("avatar-video");
  // When the recording finishes, the call does not end: this 4 s loop (the
  // last 2 s played backward, then forward again, rendered by ffmpeg — see
  // README) keeps the Avatar moving until End Call.
  const idleVideo = $("idle-video");
  const poster = $("poster");
  const frame = $("frame");
  const inner = document.querySelector(".stage-inner");
  const avatarLayer = $("avatar-layer");
  const cameraLayer = $("camera-layer");
  const camVideo = $("camera-video");
  const pipHit = $("pip-hit");
  const timerEl = $("call-timer");

  // phase: "rest" | "connecting" | "live".
  let phase = "rest";
  let callToken = 0;             // bumps on every start/end so stale call work bails out

  // ------------------------------------------------------------------ theme
  const savedTheme = pref.get("theme"); if (savedTheme) root.dataset.theme = savedTheme;
  const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const syncThemeBtn = () => {
    const label = isDark() ? "Switch to light theme" : "Switch to dark theme";
    $("theme-btn").setAttribute("aria-label", label); $("theme-btn").title = label;
  };
  $("theme-btn").onclick = () => { root.dataset.theme = isDark() ? "light" : "dark"; pref.set("theme", root.dataset.theme); syncThemeBtn(); };
  syncThemeBtn();

  // --------------------------------------------------------- settings drawer
  const app = document.querySelector(".app");
  const isOpen = () => $("sidebar").classList.contains("open");
  const setSidebar = (open, focusId) => {
    $("sidebar").classList.toggle("open", open);
    $("sidebar").setAttribute("aria-hidden", String(!open));
    app.classList.toggle("settings-open", open);
    $("scrim").hidden = !(open && matchMedia("(max-width: 900px)").matches);
    $("settings-btn").setAttribute("aria-expanded", String(open));
    if (open) setTimeout(() => {
      const f = (focusId && $(focusId).querySelector('.opt[aria-checked="true"]')) || $("sidebar").querySelector('.opt[aria-checked="true"]:not(:disabled)');
      if (f) f.focus({ preventScroll: true });
    }, 220);
  };
  $("settings-btn").onclick = () => setSidebar(!isOpen());
  $("close-settings").onclick = () => { setSidebar(false); $("settings-btn").focus(); };
  $("scrim").onclick = () => setSidebar(false);
  matchMedia("(max-width: 900px)").addEventListener("change", () => { if (isOpen()) setSidebar(true); });

  // --------------------------------------------------- Geist switch (radios)
  const wireSwitch = (id, apply) => {
    const opts = () => [...document.querySelectorAll(`#${id} .opt`)];
    for (const b of opts()) b.onclick = () => apply(b.dataset.value);
    $(id).addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const list = opts().filter((b) => !b.disabled);
      if (!list.length) return;
      const i = list.findIndex((b) => b.getAttribute("aria-checked") === "true");
      const next = list[(i + (e.key === "ArrowRight" ? 1 : list.length - 1)) % list.length];
      apply(next.dataset.value); next.focus(); e.preventDefault();
    });
  };
  const markSwitch = (id, value) => {
    for (const b of document.querySelectorAll(`#${id} .opt`)) {
      const on = b.dataset.value === value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };

  // ------------------------------------------------------------ conversation
  let convo = CONVERSATIONS[pref.get("convo")] ? pref.get("convo") : "office";
  const setConvo = (key) => {
    if (!CONVERSATIONS[key] || phase !== "rest") return;
    convo = key;
    markSwitch("convo", key);
    pref.set("convo", key);
    const c = CONVERSATIONS[key];
    if (poster.getAttribute("src") !== c.poster) {
      poster.classList.add("loading");
      poster.onload = () => { poster.classList.remove("loading"); sizeFrame(); };
      poster.src = c.poster;
    }
    if (video.getAttribute("src") !== c.video) { video.preload = "metadata"; video.src = c.video; }
    if (idleVideo.getAttribute("src") !== c.idle) { idleVideo.preload = "metadata"; idleVideo.src = c.idle; }
  };
  wireSwitch("convo", setConvo);

  // ----------------------------------------------------------------- display
  // The frame always fills the stage; its shape is the chosen aspect ratio
  // (the square recording is cropped to fit, centred).
  const RATIOS = { "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4 };
  let ratioKey = RATIOS[pref.get("ratio")] ? pref.get("ratio") : "1:1";
  const frameRatio = () => RATIOS[ratioKey];
  const setRatio = (key) => {
    if (!RATIOS[key]) key = "1:1";
    ratioKey = key;
    markSwitch("ratio", key);
    root.dataset.ratio = key;
    pref.set("ratio", key);
    sizeFrame();
  };
  // Which feed fills the frame when the self-view appears (tap the tile to swap during a call).
  let mainViewPref = pref.get("mainView") === "camera" ? "camera" : "avatar";
  const setMainView = (value) => {
    mainViewPref = value === "camera" ? "camera" : "avatar";
    markSwitch("main-view", mainViewPref);
    pref.set("mainView", mainViewPref);
    if (!cameraLayer.hidden && main !== mainViewPref) setMain(mainViewPref);
  };
  const setTimerMode = (mode) => {
    mode = mode === "off" ? "off" : "on";
    markSwitch("timer-mode", mode);
    root.dataset.timer = mode;
    pref.set("timer", mode);
    sizePip();
  };
  wireSwitch("ratio", setRatio);
  wireSwitch("timer-mode", setTimerMode);
  wireSwitch("main-view", setMainView);

  // ------------------------------------------------------------------ alerts
  // One banner at a time (highest priority wins), dismissable, same markup as
  // the eval site's notes. During a call the banner floats (CSS), so the
  // video never resizes under it.
  const notes = new Map();
  const NOTE_PRIORITY = ["media", "camera", "mic"];
  const ICONS = {
    error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>',
    warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 9.5v4.5M12 17h.01"/></svg>',
  };
  let shownSig = "";
  // Phones (portrait or on their side) during a call: an alert shows as a
  // one-line toggle so it never covers the video or timer; the steps are one
  // tap away and stay readable by screen readers while collapsed.
  const COMPACT_SCREEN = "(max-width: 600px), (max-height: 500px)";
  const compactContext = () => phase === "live" && matchMedia(COMPACT_SCREEN).matches;
  const CHEVRON = '<svg class="note-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
  // Where the alert goes during a call on a small screen:
  //  "bar"  — one-line toggle (portrait: above the stage; landscape: docked
  //           bottom right beside the frame, as wide as the free space there);
  //  "icon" — landscape with too little room beside the frame: a warning icon
  //           button that opens the details in a small panel.
  const noteLayout = () => {
    if (!compactContext()) return { mode: "full" };
    if (!matchMedia(SHORT_LANDSCAPE).matches) return { mode: "bar" };
    const side = Math.floor(document.documentElement.clientWidth - frame.getBoundingClientRect().right - 28 - 12);
    return side >= 200 ? { mode: "bar", dock: Math.min(320, side) } : { mode: "icon" };
  };
  let expandedKey = null;                 // survives rebuilds (retry nudges, resizes)
  // Icon-only alerts are announced through one persistent status line, and
  // only when the alert itself changes (not on resize or rotation rebuilds).
  let announced = "";
  const announce = (key, title) => {
    if (announced === key + title) return;
    announced = key + title;
    $("note-announce").textContent = title;
  };
  const closeNotePop = (focus) => {
    const pop = $("note-pop");
    if (!pop || pop.hidden) return false;
    pop.hidden = true;
    expandedKey = null;
    const btn = document.querySelector(".note-icon-btn");
    if (btn) { btn.setAttribute("aria-expanded", "false"); if (focus) btn.focus(); }
    return true;
  };
  const seenKeys = new Set();             // first appearance gets a one-time highlight
  const renderNotes = () => {
    const top = [...notes].sort((a, b) => NOTE_PRIORITY.indexOf(a[0]) - NOTE_PRIORITY.indexOf(b[0]))[0];
    const layout = noteLayout();
    const sig = top ? [top[0], top[1].title, top[1].body, top[1].rev, layout.mode, layout.dock].join("|") : "";
    if (sig === shownSig) return;
    shownSig = sig;
    const box = $("notes");
    box.replaceChildren();
    box.style.width = layout.dock ? `${layout.dock}px` : "";
    box.classList.toggle("dock-icon", layout.mode === "icon");
    if (!top) { expandedKey = null; announced = ""; return; }
    const [key, n] = top;
    if (expandedKey && expandedKey !== key) expandedKey = null;
    const firstTime = !seenKeys.has(key + n.title);
    seenKeys.add(key + n.title);
    const motion = !prefersReducedMotion();
    // A soft amber ring around the whole surface, on top of its own shadow.
    const highlight = (el) => {
      if (!motion || !firstTime) return;
      const base = getComputedStyle(el).boxShadow;
      const own = base && base !== "none" ? base + ", " : "";
      el.animate([{ boxShadow: `${own}0 0 0 0 rgba(245,165,36,.5)` }, { boxShadow: `${own}0 0 0 6px rgba(245,165,36,0)` }], { duration: 900, iterations: 2, easing: "ease-out" });
    };

    const el = document.createElement("div");
    el.className = "note note-" + n.kind;
    el.setAttribute("role", n.kind === "error" ? "alert" : "status");
    const icon = document.createElement("span"); icon.className = "note-icon"; icon.innerHTML = ICONS[n.kind] || ICONS.warning;
    const body = document.createElement("span"); body.className = "note-body"; body.id = "note-body"; body.textContent = n.body;
    const x = document.createElement("button");
    x.type = "button"; x.className = "btn btn-tertiary btn-sq btn-sm dismiss"; x.setAttribute("aria-label", "Dismiss"); x.textContent = "×";
    x.onclick = () => { expandedKey = null; clearNote(key); };
    const open = expandedKey === key;
    const setOpen = (v, ctl) => { expandedKey = v ? key : null; ctl.setAttribute("aria-expanded", String(v)); };

    if (layout.mode === "icon") {
      const strong = document.createElement("strong"); strong.textContent = n.title;
      el.classList.add("note-pop"); el.id = "note-pop"; el.hidden = !open;
      el.append(icon, strong, body, x);
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "note-icon-btn note-" + n.kind;
      btn.setAttribute("aria-label", `${n.title}, show details`);
      btn.title = n.title;
      btn.setAttribute("aria-controls", "note-pop"); btn.setAttribute("aria-expanded", String(open));
      btn.innerHTML = ICONS[n.kind] || ICONS.warning;
      btn.onclick = () => { const v = el.hidden; el.hidden = !v; setOpen(v, btn); };
      announce(key, n.title);
      const dock = document.createElement("div"); dock.className = "note-dock";
      dock.append(el, btn);
      box.appendChild(dock);
      if (motion) btn.animate(n.rev > 0
        ? [{ transform: "translateX(0)" }, { transform: "translateX(-5px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }]
        : [{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], { duration: n.rev > 0 ? 320 : 180, easing: "ease-out" });
      highlight(btn);
      return;
    }

    let title;
    if (layout.mode === "bar") {
      el.classList.add("compact");
      el.classList.toggle("expanded", open);
      title = document.createElement("button");
      title.type = "button"; title.className = "note-toggle";
      title.setAttribute("aria-expanded", String(open)); title.setAttribute("aria-controls", "note-body");
      const label = document.createElement("span"); label.className = "note-toggle-text"; label.textContent = n.title;
      title.append(label);
      title.insertAdjacentHTML("beforeend", CHEVRON);
      title.onclick = () => { const v = !el.classList.contains("expanded"); el.classList.toggle("expanded", v); setOpen(v, title); };
    } else {
      title = document.createElement("strong"); title.textContent = n.title;
    }
    el.append(icon, title, body, x);
    if (motion) {
      el.animate(n.rev > 0
        ? [{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }]
        : [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }],
        { duration: n.rev > 0 ? 320 : 180, easing: "ease-out" });
    }
    box.appendChild(el);
    if (layout.mode === "bar") highlight(el);
  };
  addEventListener("resize", () => { if (phase === "live") renderNotes(); });
  matchMedia(COMPACT_SCREEN).addEventListener("change", () => renderNotes());
  // Showing the same alert again (a repeated failure) nudges it so the retry visibly registered.
  const setNote = (key, kind, title, body) => {
    const cur = notes.get(key);
    const rev = cur && cur.title === title && cur.body === body ? cur.rev + 1 : 0;
    notes.set(key, { kind, title, body, rev });
    // A repeat is confirmed for screen readers too, not only by the shake.
    if (rev > 0) $("note-announce").textContent = rev % 2 ? `Still: ${title}` : `${title}, again`;
    renderNotes();
  };
  const clearNote = (key) => { if (notes.delete(key)) renderNotes(); };

  // ------------------------------------------------------------ frame sizing
  // The frame takes all the room the stage has, at the chosen aspect ratio:
  // below the heading (collapsed during a call) and above the control row;
  // on a phone held sideways, beside the heading and controls.
  const SHORT_LANDSCAPE = "(max-height: 500px) and (orientation: landscape)";
  function sizeFrame() {
    const stage = $("stage");
    const cs = getComputedStyle(stage);
    const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const short = matchMedia(SHORT_LANDSCAPE).matches;
    const minSide = short ? 140 : 200;
    const wrapH = document.querySelector(".stage-wrap").clientHeight;
    const title = $("rest-title");
    const headH = phase === "live" ? 0 : title.offsetHeight + (parseFloat(getComputedStyle(title).marginBottom) || 0);
    const rowH = $("start-row").offsetHeight;
    const availH = short ? wrapH - padV : wrapH - padV - headH - rowH;
    const availW = short ? inner.clientWidth - 28 - Math.min(348, $("start-row").scrollWidth + 8) : inner.clientWidth;
    const ratio = frameRatio();
    const w = Math.max(minSide, Math.min(availW, Math.max(minSide, availH) * ratio));
    inner.style.setProperty("--pw", `${Math.round(w)}px`);
    inner.style.setProperty("--ph", `${Math.round(w / ratio)}px`);
    sizePip();
  }
  new ResizeObserver(() => sizeFrame()).observe(document.querySelector(".stage-wrap"));

  // ------------------------------------------------------------------- phase
  const LOCK_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
  function setPhase(next) {
    phase = next;
    root.dataset.phase = next;
    $("status-chip").textContent = { rest: "Idle", connecting: "Connecting", live: "Live" }[next];
    // One control row: Start Call before, End Call during the call.
    const endFocused = document.activeElement === $("btn-end");
    const startFocused = document.activeElement === $("btn-start");
    $("btn-start").hidden = next === "live";
    $("btn-end").hidden = next !== "live";
    $("btn-start").disabled = next !== "rest";
    if (next === "live" && startFocused) $("btn-end").focus({ preventScroll: true });
    if (next === "rest" && endFocused) $("btn-start").focus({ preventScroll: true });
    if (next === "connecting") {
      $("rest-title").textContent = "Starting your call…";
      $("start-label").textContent = "Connecting…";
    } else {
      // Ending a call returns to the starting screen.
      $("rest-title").textContent = "Welcome to Higgs Avatar";
      $("start-label").textContent = "Start Call";
    }
    const locked = next !== "rest";
    for (const b of document.querySelectorAll("#convo .opt")) b.disabled = locked;
    $("convo-help").innerHTML = locked ? `<span class="help-lock">${LOCK_ICON}End the call to switch conversations.</span>` : "Plays when you start a call.";
    if (next !== "live") timerEl.classList.remove("running");
    // Self-view: only while the call is live.
    if (next === "live" && camStream && cameraLayer.hidden) showCameraLayer();
    if (next !== "live" && !cameraLayer.hidden) hideCameraLayer(next === "connecting");
    syncCamButton();
    syncMicButton();
    renderNotes();
    sizeFrame();
  }

  // -------------------------------------------------------------------- call
  const waitCanPlay = () => new Promise((resolve, reject) => {
    if (video.readyState >= 3) return resolve();
    const cleanup = () => { clearTimeout(timer); video.removeEventListener("canplay", ok); video.removeEventListener("error", bad); };
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error("media error")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, LOAD_TIMEOUT_MS);
    video.addEventListener("canplay", ok);
    video.addEventListener("error", bad);
  });

  async function startCall() {
    if (phase !== "rest") return;
    const token = ++callToken;
    closeMenus();
    clearNote("media");
    clearTimeout(holdTimer); video.classList.remove("holding");
    stopIdle();
    setPhase("connecting");
    const c = CONVERSATIONS[convo];
    if (video.getAttribute("src") !== c.video) video.src = c.video;
    video.preload = "auto";
    if (idleVideo.getAttribute("src") !== c.idle) idleVideo.src = c.idle;
    idleVideo.preload = "auto";
    idleVideo.load();
    // Start (muted) inside the click so the browser counts this element as
    // user-started; the unmuted play after "connecting" is then allowed.
    video.muted = true;
    video.play().then(() => { if (phase === "connecting") video.pause(); }).catch(() => {});
    try {
      await Promise.all([sleep(CONNECT_MIN_MS), waitCanPlay()]);
    } catch (e) {
      if (token !== callToken) return;
      video.pause();
      setNote("media", "error", "Couldn't start the call", "The conversation video didn't load. Check your connection and try again.");
      setPhase("rest");
      return;
    }
    if (token !== callToken) return;
    try { video.currentTime = 0; } catch (e) { /* not seekable yet */ }
    video.muted = false;
    try {
      await video.play();
    } catch (e) {
      // Autoplay with sound refused: keep the call going silently and offer a tap.
      video.muted = true;
      try { await video.play(); } catch (e2) { /* nothing more to try */ }
      $("btn-enable-audio").hidden = false;
    }
    if (token !== callToken) return;
    setPhase("live");
    if (!video.paused) { video.classList.add("has-frames"); timerEl.classList.add("running"); }
    sizePip();
    tickTimer();
  }

  // Ending a call stops the recording and hides the self-view; the camera and
  // mic stay as you set them, so the next call starts with them.
  let holdTimer = 0;
  function endCall() {
    if (phase === "rest") return;
    callToken++;
    video.pause();
    stopIdle();
    closeMenus();
    $("btn-enable-audio").hidden = true;
    // Hold the last frame while it fades to the poster, instead of snapping to frame one.
    video.classList.add("holding");
    const keepFocus = !document.activeElement || document.activeElement === document.body;
    setPhase("rest");
    video.classList.remove("has-frames");
    requestAnimationFrame(() => video.classList.remove("holding"));
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { try { video.currentTime = 0; } catch (e) { /* ignore */ } }, 400);
    if (keepFocus) $("btn-start").focus({ preventScroll: true });
  }

  video.addEventListener("playing", () => {
    if (phase !== "live") return;
    video.classList.add("has-frames");
    if (!timerEl.classList.contains("running")) { timerEl.classList.add("running"); sizePip(); }
  });
  video.addEventListener("ended", () => { if (phase === "live") startIdle(); });

  // ---------------------------------------------------------------- idle loop
  // The loop's first frame follows the recording's last one, and its last
  // frame leads back into its first, so the motion never visibly restarts.
  let idleActive = false;
  let idleSeconds = 0;          // time spent looping, added to the call timer
  let idleLastTs = 0;
  function startIdle() {
    idleActive = true;
    idleSeconds = 0;
    idleLastTs = 0;
    try { idleVideo.currentTime = 0; } catch (e) { /* not loaded yet */ }
    // Shown only once it is actually playing; until then the last frame holds.
    idleVideo.play().then(() => { if (idleActive) idleVideo.classList.add("active"); }).catch(() => {});
  }
  function stopIdle() {
    idleActive = false;
    idleVideo.pause();
    idleVideo.classList.remove("active");
    setTimeout(() => { if (!idleActive) try { idleVideo.currentTime = 0; } catch (e) { /* ignore */ } }, 400);
  }
  video.addEventListener("error", () => {
    if (phase !== "live") return;
    endCall();
    setNote("media", "error", "The call dropped", "The conversation video stopped loading. Check your connection and start again.");
  });
  $("btn-start").onclick = startCall;
  $("btn-end").onclick = endCall;

  // ------------------------------------------------------------------- timer
  // MM:SS of the recording's playback position, continuing through the idle loop.
  let lastSecond = -1;
  function tickTimer(ts) {
    if (phase !== "live") { lastSecond = -1; $("timer-text").textContent = "00:00"; return; }
    if (idleActive && !idleVideo.paused && typeof ts === "number") {
      if (idleLastTs) idleSeconds += (ts - idleLastTs) / 1000;
      idleLastTs = ts;
    } else {
      idleLastTs = 0;
    }
    const s = Math.floor(idleActive ? (video.duration || 0) + idleSeconds : video.currentTime || 0);
    if (s !== lastSecond) {
      const grew = String(lastSecond).length !== String(s).length;
      lastSecond = s;
      $("timer-text").textContent = fmt(s);
      if (grew) sizePip();
    }
    requestAnimationFrame(tickTimer);
  }

  // Browsers that refuse sound on their own get one tap to turn it on.
  $("btn-enable-audio").onclick = () => {
    video.muted = false;
    if (phase === "live") video.play().catch(() => {});
    $("btn-enable-audio").hidden = true;
  };

  // ------------------------------------------------------ device permissions
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isFirefox = /Firefox|FxiOS/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|Chromium|Edg|OPR|FxiOS|Android/i.test(ua);
  const secureContext = () => window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  function unblockSteps(thing, Thing) {
    if (isIOS && isSafari) return `Tap aA in the address bar, then Website Settings › ${Thing} › Allow, and try again.`;
    if (isIOS) return `Open the iPhone Settings app, find this browser, turn on ${Thing}, and try again.`;
    if (isAndroid) return `Tap the icon left of the address, open Permissions, allow ${thing}, and try again.`;
    if (isSafari) return `Open Safari › Settings for This Website, set ${Thing} to Allow, and try again.`;
    if (isFirefox) return `Click the ${thing} icon in the address bar, clear the block, and try again.`;
    return `Click the site settings icon at the left of the address bar, allow ${thing}, and try again.`;
  }
  // [kind, title, body]; kind also colours the button's status dot.
  function deviceProblem(which, e) {
    const thing = which === "camera" ? "camera" : "microphone";
    const Thing = which === "camera" ? "Camera" : "Microphone";
    const name = e && e.name;
    if (name === "insecure") return ["warning", `${Thing} needs a secure page`, `Open this demo over HTTPS (or on localhost) to use the ${thing}.`];
    if (name === "NotAllowedError" || name === "SecurityError") return ["warning", `${Thing} blocked`, unblockSteps(thing, Thing)];
    if (name === "NotFoundError" || name === "OverconstrainedError") return ["error", `No ${thing} found`, `Connect a ${thing} and try again.`];
    if (name === "NotReadableError" || name === "AbortError") return ["error", `${Thing} busy`, `Another app may be using the ${thing}. Close it and try again.`];
    return ["error", `${Thing} unavailable`, (e && e.message) || `The ${thing} could not be started.`];
  }
  async function permissionState(which) {
    try { return (await navigator.permissions.query({ name: which === "camera" ? "camera" : "microphone" })).state; }
    catch (e) { return "unknown"; }
  }
  // A saved device id that no longer exists falls back to any device.
  async function getMedia(which, deviceId) {
    const camera = which === "camera";
    const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    const constraints = (id) => camera
      ? { video: id ? { ...base, deviceId: { exact: id } } : { ...base, facingMode: "user" } }
      : { audio: id ? { deviceId: { exact: id } } : true };
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (e) {
      if (deviceId && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) return navigator.mediaDevices.getUserMedia(constraints(""));
      throw e;
    }
  }
  const setDot = (id, kind) => { $(id).className = "cb-dot" + (kind === "error" ? " err" : kind === "warning" ? " warn" : ""); };

  // ------------------------------------------------------------------ camera
  // Devices only ever turn on from your own click (never on page load).
  let camStream = null;
  let camDeviceId = pref.get("camDevice") || "";
  let camBusy = false;
  let camToken = 0;
  let camAspect = 4 / 3;
  let main = "avatar";           // which feed fills the frame
  let hideTimer = 0;

  function syncCamButton() {
    const btn = $("btn-cam");
    btn.setAttribute("aria-checked", String(!!camStream));
    btn.setAttribute("aria-busy", String(camBusy));
    btn.title = camBusy ? "Waiting for the camera…" : camStream ? "Turn camera off" : "Turn camera on";
  }

  async function startCamera(deviceId = camDeviceId) {
    if (camBusy) return;
    if (!secureContext()) { const [k, t, b] = deviceProblem("camera", { name: "insecure" }); setDot("dot-cam", k); setNote("camera", k, t, b); return; }
    camBusy = true;
    const token = ++camToken;
    syncCamButton();
    // Only show the tile (with its spinner) before the stream when no prompt
    // can refuse it; otherwise it would flash on and off after a denial.
    const switching = !!camStream;
    if (!switching && phase === "live" && (await permissionState("camera")) === "granted" && token === camToken) showCameraLayer();
    try {
      const stream = await getMedia("camera", deviceId);
      if (token !== camToken) { stream.getTracks().forEach((t) => t.stop()); return; }
      if (camStream) camStream.getTracks().forEach((t) => t.stop());
      camStream = stream;
      const track = stream.getVideoTracks()[0];
      const s = track.getSettings ? track.getSettings() : {};
      camDeviceId = s.deviceId || deviceId || "";
      pref.set("camDevice", camDeviceId);
      // Mirror a front-facing camera like every call app; never a rear one.
      camVideo.classList.toggle("mirror", s.facingMode !== "environment");
      if (s.width && s.height) camAspect = s.width / s.height;
      track.addEventListener("ended", () => {
        if (camStream !== stream) return;
        stopCamera();
        setDot("dot-cam", "error");
        setNote("camera", "error", "Camera disconnected", "Plug it back in or choose another camera.");
      });
      // The self-view shows only during a live call; turned on before the
      // call, the camera runs and the tile appears once the call is live.
      if (phase === "live" && cameraLayer.hidden) showCameraLayer();
      camVideo.srcObject = stream;
      camVideo.play().catch(() => {});
      setDot("dot-cam", null);
      clearNote("camera");
      sizePip();
    } catch (e) {
      if (token !== camToken) return;
      if (!camStream) hideCameraLayer(true);
      const [k, t, b] = deviceProblem("camera", e);
      setDot("dot-cam", k);
      setNote("camera", k, t, b);
    } finally {
      if (token === camToken) camBusy = false;
      syncCamButton();
      if (!$("cam-menu").hidden) renderMenu("camera");
    }
  }

  function stopCamera({ immediate = false } = {}) {
    camToken++;
    camBusy = false;
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    syncCamButton();
    hideCameraLayer(immediate);
  }

  function showCameraLayer() {
    clearTimeout(hideTimer);
    cameraLayer.getAnimations().forEach((a) => a.cancel());
    // A camera already running before the call has its frames ready: no spinner.
    cameraLayer.classList.toggle("ready", !!camStream && camVideo.readyState >= 2);
    if (camStream && camVideo.paused) camVideo.play().catch(() => {});
    cameraLayer.hidden = false;
    pipHit.hidden = false;
    setMain(mainViewPref, { instant: true });
    flashHint();
    if (!prefersReducedMotion()) cameraLayer.animate([{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(.4,0,.2,1)" });
  }
  function hideCameraLayer(immediate) {
    const finish = () => {
      cameraLayer.hidden = true; pipHit.hidden = true;
      if (!camStream) { cameraLayer.classList.remove("ready"); camVideo.srcObject = null; }
      setMain("avatar", { instant: true });
    };
    clearTimeout(hideTimer);
    if (cameraLayer.hidden) { if (!camStream) { cameraLayer.classList.remove("ready"); camVideo.srcObject = null; } return; }
    if (immediate || prefersReducedMotion()) return finish();
    // If the camera is the main view, the Avatar grows back first, then the tile fades out.
    const wasMain = main === "camera";
    if (wasMain) setMain("avatar");
    pipHit.hidden = true;
    hideTimer = setTimeout(() => {
      cameraLayer.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.9)" }], { duration: 160, easing: "ease-in" }).onfinish = finish;
    }, wasMain ? 320 : 0);
  }
  camVideo.addEventListener("playing", () => cameraLayer.classList.add("ready"));
  // Some browsers keep drawing a <video> at its old size after its box has
  // been resized by a transition, leaving a strip of background showing.
  // Once a swap or resize settles, nudge each video's layout so it redraws.
  const nudgeVideos = () => {
    const vids = [video, idleVideo, camVideo];
    for (const v of vids) v.classList.add("repaint");
    requestAnimationFrame(() => requestAnimationFrame(() => { for (const v of vids) v.classList.remove("repaint"); }));
  };
  frame.addEventListener("transitionend", (e) => {
    if ((e.target === frame || e.target.classList.contains("layer")) && (e.propertyName === "width" || e.propertyName === "height")) nudgeVideos();
  });
  camVideo.addEventListener("resize", () => {
    if (camVideo.videoWidth && camVideo.videoHeight) { camAspect = camVideo.videoWidth / camVideo.videoHeight; sizePip(); }
  });
  $("btn-cam").onclick = () => {
    if (camStream || camBusy) stopCamera(); else startCamera();
  };

  // -------------------------------------------------------- picture-in-picture
  // The tile is sized from the frame and its content's aspect ratio. If the
  // frame is too narrow for a top-corner tile beside the centred timer, the
  // tile shrinks a little; if that would make it too small to tap, the timer
  // moves to the top corner away from the tile instead.
  let corner = ["tl", "tr", "bl", "br"].includes(pref.get("pipCorner")) ? pref.get("pipCorner") : "br";
  frame.dataset.corner = corner;
  function pipLayout() {
    const fw = parseFloat(inner.style.getPropertyValue("--pw")) || frame.clientWidth;
    const fh = parseFloat(inner.style.getPropertyValue("--ph")) || frame.clientHeight;
    const side = Math.min(fw, fh);
    const narrow = matchMedia("(max-width: 600px)").matches;
    const m = side < 480 || narrow ? 8 : 12;
    const aspect = clamp(main === "avatar" ? camAspect : frameRatio(), 9 / 16, 16 / 9);
    const base = clamp(Math.round(side * (narrow ? 0.3 : 0.28)), narrow ? 104 : side < 300 ? 72 : 88, 200);
    let w = aspect >= 1 ? base : Math.round(base * 1.2 * aspect);
    let h = aspect >= 1 ? Math.round(base / aspect) : Math.round(base * 1.2);
    let timerSide = "";
    const timerShown = phase === "live" && root.dataset.timer === "on" && timerEl.classList.contains("running");
    if (corner[0] === "b" && timerShown) {
      const room = (fw - (timerEl.offsetWidth || 76)) / 2 - 8 - m;   // space beside the centred timer
      if (w > room) {
        if (room >= 72) { h = Math.round(h * room / w); w = Math.round(room); }
        else timerSide = corner[1] === "l" ? "r" : "l";
      }
    }
    return { w, h, m, timerSide };
  }
  function sizePip() {
    const { w, h, timerSide } = pipLayout();
    frame.style.setProperty("--pip-w", w + "px");
    frame.style.setProperty("--pip-h", h + "px");
    if (timerSide) frame.dataset.timerside = timerSide; else delete frame.dataset.timerside;
  }
  function setMain(which, { instant = false } = {}) {
    main = which;
    if (instant) frame.classList.add("no-anim");
    avatarLayer.dataset.slot = which === "avatar" ? "main" : "pip";
    cameraLayer.dataset.slot = which === "avatar" ? "pip" : "main";
    sizePip();
    pipHit.setAttribute("aria-label", which === "avatar" ? "Show your camera in the main view" : "Show the Avatar in the main view");
    pipHit.title = which === "avatar" ? "Swap: your camera in the main view" : "Swap: the Avatar in the main view";
    if (instant) { void frame.offsetWidth; frame.classList.remove("no-anim"); }
  }
  const CORNER_NAMES = { tl: "top left", tr: "top right", bl: "bottom left", br: "bottom right" };
  const setCorner = (c, announce) => {
    corner = c; frame.dataset.corner = c; pref.set("pipCorner", c);
    sizePip();
    if (announce) $("pip-announce").textContent = `Picture moved to the ${CORNER_NAMES[c]} corner.`;
  };
  // Touch has no hover: show the swap badge for a few seconds whenever the tile appears or changes.
  let hintTimer = 0;
  const flashHint = () => { pipHit.classList.add("hint"); clearTimeout(hintTimer); hintTimer = setTimeout(() => pipHit.classList.remove("hint"), 3500); };

  // Tap swaps; drag moves the tile and snaps it to the nearest corner.
  let drag = null;
  let suppressClickUntil = 0;
  const pipEls = () => [pipHit, main === "avatar" ? cameraLayer : avatarLayer];
  pipHit.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const { w, h, m } = pipLayout();
    const fw = frame.clientWidth, fh = frame.clientHeight;
    const left = corner[1] === "l" ? m : fw - m - w;
    const top = corner[0] === "t" ? m : fh - m - h;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, left, top, w, h, fw, fh, m, dx: 0, dy: 0 };
    pipHit.setPointerCapture(e.pointerId);
  });
  pipHit.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    let dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) { drag.moved = true; frame.classList.add("dragging"); pipHit.classList.add("dragging"); }
    dx = clamp(dx, drag.m - drag.left, drag.fw - drag.m - drag.w - drag.left);
    dy = clamp(dy, drag.m - drag.top, drag.fh - drag.m - drag.h - drag.top);
    drag.dx = dx; drag.dy = dy;
    for (const el of pipEls()) el.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) return;
    suppressClickUntil = performance.now() + 400;
    const cx = d.left + d.dx + d.w / 2, cy = d.top + d.dy + d.h / 2;
    const next = (cy < d.fh / 2 ? "t" : "b") + (cx < d.fw / 2 ? "l" : "r");
    frame.classList.add("settling");
    frame.classList.remove("dragging"); pipHit.classList.remove("dragging");
    setCorner(next, next !== corner);
    for (const el of pipEls()) el.style.transform = "";
    setTimeout(() => frame.classList.remove("settling"), 340);
  };
  pipHit.addEventListener("pointerup", endDrag);
  pipHit.addEventListener("pointercancel", endDrag);
  pipHit.addEventListener("click", () => {
    if (performance.now() < suppressClickUntil || cameraLayer.hidden) return;
    setMain(main === "avatar" ? "camera" : "avatar");
    flashHint();
  });
  pipHit.addEventListener("keydown", (e) => {
    const moves = { ArrowLeft: [null, "l"], ArrowRight: [null, "r"], ArrowUp: ["t", null], ArrowDown: ["b", null] };
    const mv = moves[e.key]; if (!mv) return;
    e.preventDefault();
    const next = (mv[0] || corner[0]) + (mv[1] || corner[1]);
    if (next !== corner) setCorner(next, true);
  });

  // -------------------------------------------------------------- microphone
  let micStream = null;
  let micDeviceId = pref.get("micDevice") || "";
  let micBusy = false;
  let micToken = 0;
  let meterCtx = null, meterRaf = 0;

  function syncMicButton() {
    const btn = $("btn-mic");
    btn.setAttribute("aria-checked", String(!!micStream));
    btn.setAttribute("aria-busy", String(micBusy));
    btn.title = micBusy ? "Waiting for the microphone…" : micStream ? "Turn microphone off" : "Turn microphone on";
  }
  async function startMic(deviceId = micDeviceId) {
    if (micBusy) return;
    if (!secureContext()) { const [k, t, b] = deviceProblem("mic", { name: "insecure" }); setDot("dot-mic", k); setNote("mic", k, t, b); return; }
    micBusy = true;
    const token = ++micToken;
    syncMicButton();
    try {
      const stream = await getMedia("mic", deviceId);
      if (token !== micToken) { stream.getTracks().forEach((t) => t.stop()); return; }
      stopMicTracks();
      micStream = stream;
      const track = stream.getAudioTracks()[0];
      micDeviceId = (track.getSettings && track.getSettings().deviceId) || deviceId || "";
      pref.set("micDevice", micDeviceId);
      track.addEventListener("ended", () => { if (micStream === stream) stopMic(); });
      startMeter(track);
      setDot("dot-mic", null);
      clearNote("mic");
    } catch (e) {
      if (token !== micToken) return;
      const [k, t, b] = deviceProblem("mic", e);
      setDot("dot-mic", k);
      setNote("mic", k, t, b);
    } finally {
      if (token === micToken) micBusy = false;
      syncMicButton();
      if (!$("mic-menu").hidden) renderMenu("mic");
    }
  }
  function stopMicTracks() {
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterRaf = 0;
    if (meterCtx) { try { meterCtx.close(); } catch (e) { /* closed */ } meterCtx = null; }
  }
  function stopMic() {
    micToken++;
    micBusy = false;
    stopMicTracks();
    syncMicButton();
  }
  // The capsule inside the mic icon fills from the bottom with your level:
  // fast attack, slower release, so speech reads as steady, not flickery.
  function startMeter(track) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const fill = $("lvl-mic");
    if (!Ctx) return;
    try {
      meterCtx = new Ctx();
      const analyser = meterCtx.createAnalyser();
      analyser.fftSize = 512;
      meterCtx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let level = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const raw = Math.min(1, Math.sqrt(sum / buf.length) * 5);
        level = raw > level ? level * 0.4 + raw * 0.6 : level * 0.9;
        // capsule spans y 3..14 of the 24-unit icon
        const topPct = ((3 + 11 * (1 - level)) / 24) * 100;
        fill.style.clipPath = `inset(${topPct.toFixed(1)}% 0 0 0)`;
        meterRaf = requestAnimationFrame(tick);
      };
      meterRaf = requestAnimationFrame(tick);
    } catch (e) { /* the meter is decoration */ }
  }
  $("btn-mic").onclick = () => {
    if (micStream || micBusy) stopMic(); else startMic();
  };

  // ----------------------------------------------------------- device menus
  const MENUS = {
    camera: { menu: "cam-menu", arrow: "cam-arrow", group: "cam-group", kind: "videoinput", title: "Camera", empty: "No cameras found", noun: "Camera", on: () => !!camStream, current: () => camDeviceId, label: () => (camStream ? camStream.getVideoTracks()[0].label : ""), pick: (id) => startCamera(id) },
    mic: { menu: "mic-menu", arrow: "mic-arrow", group: "mic-group", kind: "audioinput", title: "Microphone", empty: "No microphones found", noun: "Microphone", on: () => !!micStream, current: () => micDeviceId, label: () => (micStream ? micStream.getAudioTracks()[0].label : ""), pick: (id) => startMic(id) },
  };
  // Keep an open menu inside the viewport (it anchors to its button group).
  // Keep an open menu inside the viewport: shift it sideways, and open it
  // upward or downward, whichever fits (scrolling it if neither does).
  // Measured from the anchor and layout sizes, not the menu's own rect,
  // which is scaled while its open animation runs.
  function fitMenu(menu) {
    const anchor = menu.parentElement.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = innerHeight;
    const gap = 8;
    menu.style.maxHeight = "";
    const width = menu.offsetWidth, height = menu.offsetHeight;
    let shift = 0;
    if (anchor.left + width > vw - 12) shift = vw - 12 - width - anchor.left;
    if (anchor.left + shift < 12) shift = 12 - anchor.left;
    menu.style.left = `${Math.round(shift)}px`;
    const above = anchor.top - gap - 8, below = vh - anchor.bottom - gap - 8;
    const up = height <= above || (height > below && above >= below);
    menu.style.top = up ? "auto" : `calc(100% + ${gap}px)`;
    menu.style.bottom = up ? `calc(100% + ${gap}px)` : "auto";
    menu.style.transformOrigin = up ? "bottom left" : "top left";
    const room = up ? above : below;
    if (height > room) { menu.style.maxHeight = `${Math.max(120, Math.floor(room))}px`; menu.style.overflowY = "auto"; }
  }
  async function renderMenu(which) {
    const cfg = MENUS[which];
    const menu = $(cfg.menu);
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === cfg.kind && d.deviceId !== "communications"); } catch (e) { /* none */ }
    const hadFocus = menu.contains(document.activeElement);
    const unnamed = devices.length > 0 && devices.every((d) => !d.label);
    menu.replaceChildren();
    const title = document.createElement("div"); title.className = "menu-title"; title.textContent = cfg.title;
    menu.appendChild(title);
    if (!devices.length) {
      const p = document.createElement("div"); p.className = "menu-empty"; p.textContent = cfg.empty;
      menu.appendChild(p);
    }
    const on = cfg.on();
    const current = cfg.current();
    devices.sort((x, y) => (y.deviceId === "default") - (x.deviceId === "default"));
    devices.forEach((d, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "menu-item"; b.setAttribute("role", "menuitemradio");
      // Only a device that is actually running gets the check.
      // (the running track may report an alias such as "default", so its label also counts)
      const checked = on && (d.deviceId === current || (!!d.label && d.label === cfg.label()) || devices.length === 1);
      b.setAttribute("aria-checked", String(!!checked));
      b.innerHTML = '<svg class="check" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg><span class="txt"><span></span></span>';
      // Chrome lists the system default separately as "Default - <name>".
      const label = d.deviceId === "default" ? `System default${d.label ? ` (${d.label.replace(/^Default\s*-\s*/i, "")})` : ""}` : d.label;
      b.querySelector(".txt span").textContent = label || `${cfg.noun} ${i + 1}`;
      b.onclick = () => { openMenu(which, false); $(cfg.arrow).focus(); cfg.pick(d.deviceId); };
      menu.appendChild(b);
    });
    if (unnamed) {
      const p = document.createElement("div"); p.className = "menu-empty";
      p.textContent = `Names appear once you allow ${cfg.noun.toLowerCase()} access.`;
      menu.appendChild(p);
    }
    fitMenu(menu);
    if (hadFocus || menu.dataset.focusOnRender) {
      delete menu.dataset.focusOnRender;
      const f = menu.querySelector('.menu-item[aria-checked="true"]') || menu.querySelector(".menu-item");
      if (f) f.focus();
    }
  }
  function openMenu(which, open) {
    const cfg = MENUS[which];
    if (open) for (const other of Object.keys(MENUS)) if (other !== which) openMenu(other, false);
    $(cfg.menu).hidden = !open;
    $(cfg.arrow).setAttribute("aria-expanded", String(open));
    if (open) { $(cfg.menu).dataset.focusOnRender = "1"; renderMenu(which); }
  }
  const closeMenus = () => { for (const k of Object.keys(MENUS)) openMenu(k, false); };
  for (const [which, cfg] of Object.entries(MENUS)) {
    $(cfg.arrow).addEventListener("click", (e) => { e.stopPropagation(); openMenu(which, $(cfg.menu).hidden); });
    $(cfg.menu).addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = [...$(cfg.menu).querySelectorAll(".menu-item")];
      const i = items.indexOf(document.activeElement);
      const next = items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
      if (next) { next.focus(); e.preventDefault(); }
    });
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".note-dock")) closeNotePop(false);
    for (const [which, cfg] of Object.entries(MENUS)) if (!$(cfg.menu).hidden && !$(cfg.group).contains(e.target)) openMenu(which, false);
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      for (const [which, cfg] of Object.entries(MENUS)) if (!$(cfg.menu).hidden) renderMenu(which);
    });
  }

  // --------------------------------------------------------------- keyboard
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (closeNotePop(true)) return;
    for (const [which, cfg] of Object.entries(MENUS)) {
      if (!$(cfg.menu).hidden) { openMenu(which, false); $(cfg.arrow).focus(); return; }
    }
    if (isOpen()) { setSidebar(false); $("settings-btn").focus(); }
  });
  addEventListener("pagehide", () => {
    for (const s of [camStream, micStream]) if (s) s.getTracks().forEach((t) => t.stop());
  });

  // -------------------------------------------------------------------- init
  setConvo(convo);
  setRatio(ratioKey);
  setTimerMode(pref.get("timer"));
  markSwitch("main-view", mainViewPref);
  syncCamButton();
  syncMicButton();
  setMain("avatar", { instant: true });
  setPhase("rest");
  if (new URLSearchParams(location.search).get("settings")) setSidebar(true);
  matchMedia(SHORT_LANDSCAPE).addEventListener("change", sizeFrame);
})();
