export {};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ScreenEdge = "top" | "bottom" | "left" | "right";

interface ZoneShape {
  type: "rectangle" | "rounded" | "circle" | "screen_edge_strip";
  radius?: number;
  edge?: ScreenEdge;
  thickness?: number;
}

type VolumeTarget =
  | { kind: "master" }
  | { kind: "mic" }
  | { kind: "app"; target: string }
  | { kind: "app_under_cursor" };

type ModifierKey = "none" | "shift" | "ctrl" | "alt";
type HorizontalWheelAction = "none" | "balance" | "media_track";

interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

interface ZoneConfig {
  id: string;
  name: string;
  monitor_id?: string | null;
  rect: Rect;
  shape: ZoneShape;
  visual_mode: "invisible" | "faint_tint" | "outline_on_hover" | "always_visible";
  opacity: number;
  target: VolumeTarget;
  step: number;
  acceleration: boolean;
  invert: boolean;
  modifiers: Modifiers;
  min_volume: number;
  max_volume: number;
  soft_start_limit?: number | null;
  middle_click_to_mute: boolean;
  coarse_modifier: ModifierKey;
  fine_modifier: ModifierKey;
  horizontal_action: HorizontalWheelAction;
  tick_sound: boolean;
  pulse_tint: boolean;
  enabled: boolean;
}

type OsdPosition =
  | "top_center"
  | "top_left"
  | "top_right"
  | "bottom_center"
  | "bottom_left"
  | "bottom_right"
  | "center"
  | "near_cursor";

interface OsdConfig {
  enabled: boolean;
  duration_ms: number;
  position: OsdPosition;
  hide_in_fullscreen: boolean;
  theme: string;
}

interface TimeProfile {
  enabled: boolean;
  start_hour: number;
  end_hour: number;
  max_volume: number;
}

interface FullscreenRule {
  disable_in_fullscreen: boolean;
  blacklisted_apps: string[];
}

interface ZoneProfile {
  id: string;
  name: string;
  zones: ZoneConfig[];
}

interface Settings {
  edit_mode: boolean;
  start_at_login: boolean;
  run_as_admin: boolean;
  osd: OsdConfig;
  time_profile: TimeProfile;
  fullscreen_rule: FullscreenRule;
  active_profile_id: string;
  profiles: ZoneProfile[];
  zones: ZoneConfig[];
}

interface AppAudioSession {
  id: string;
  name: string;
  volume: number;
  muted: boolean;
}

interface OsdPayload {
  volume: number;
  muted: boolean;
  target: string;
  duration_ms: number;
  position: OsdPosition;
  theme: string;
}

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
      };
      event: {
        listen<T = unknown>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
      };
    };
  }
}

/* ==================== WEB AUDIO TICK SOUND ==================== */

let audioCtx: AudioContext | null = null;

function playTickSound() {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!audioCtx && AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx) {
      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1200, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.018);
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.018);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.02);
    }
  } catch {
    // Silently ignore if audio autoplay is disabled
  }
}

/* ==================== OSD TEMPLATES (10 DISTINCT STYLES) ==================== */

const OSD_THEMES: { id: string; name: string; icon: string; desc: string }[] = [
  { id: "modern_fluent", name: "Modern Fluent", icon: "💎", desc: "Windows 11 Acrylic dark glass with glowing gradient" },
  { id: "cyberpunk", name: "Cyberpunk Neon", icon: "⚡", desc: "Hi-tech angled HUD with cyan & yellow glow" },
  { id: "macos_hud", name: "Mac Minimal", icon: "🍎", desc: "Translucent square HUD with 16 dynamic sound dots" },
  { id: "compact_pill", name: "Compact Pill", icon: "💊", desc: "Dynamic Island floating capsule, ultra-sleek" },
  { id: "circular_dial", name: "Circular Dial", icon: "🧭", desc: "Radial SVG progress ring with center percentage" },
  { id: "retro_pixel", name: "Retro Pixel", icon: "👾", desc: "8-bit CRT green phosphor arcade monitor" },
  { id: "gaming_rgb", name: "Gaming RGB", icon: "🌈", desc: "Animated chroma wave with stealth carbon frame" },
  { id: "studio_vu", name: "Studio VU", icon: "🎛️", desc: "Pro-audio analog dB markers & multi-color LED ladder" },
  { id: "neumorphic", name: "Neumorphic Soft", icon: "🔘", desc: "Tactile extruded dark card with sunken track" },
  { id: "aero_strip", name: "Aero Horizon", icon: "🌊", desc: "Cinematic wide glass bar with audio wave visualizer" },
];

function getSpeakerIcon(pct: number, muted: boolean): string {
  if (muted || pct === 0) return "🔇";
  if (pct < 33) return "🔈";
  if (pct < 66) return "🔉";
  return "🔊";
}

function renderOsdHtml(theme: string, pct: number, muted: boolean, target: string): string {
  const icon = getSpeakerIcon(pct, muted);
  const muteBadge = muted ? `<span class="osd-mute-badge">MUTED</span>` : "";

  switch (theme) {
    case "cyberpunk": {
      return `
        <div class="osd-cyberpunk">
          <div class="osd-row">
            <span>// ${target.toUpperCase()}</span>
            <span class="osd-pct">${pct}% ${muteBadge}</span>
          </div>
          <div class="osd-track">
            <div class="osd-fill" style="width: ${pct}%;"></div>
          </div>
        </div>
      `;
    }

    case "macos_hud": {
      const activeDots = Math.round((pct / 100) * 16);
      let dotsHtml = "";
      for (let i = 0; i < 16; i++) {
        dotsHtml += `<div class="osd-dot ${i < activeDots && !muted ? "active" : ""}"></div>`;
      }
      return `
        <div class="osd-macos-hud">
          <div class="osd-speaker-big">${muted ? "🔇" : "🔊"}</div>
          <div class="osd-dots">${dotsHtml}</div>
          ${muteBadge}
        </div>
      `;
    }

    case "compact_pill": {
      return `
        <div class="osd-compact-pill">
          <span class="osd-icon">${icon}</span>
          <div class="osd-track">
            <div class="osd-fill" style="width: ${pct}%;"></div>
          </div>
          <span class="osd-pct">${pct}%</span>
          ${muteBadge}
        </div>
      `;
    }

    case "circular_dial": {
      const circumference = 2 * Math.PI * 46;
      const offset = circumference - (pct / 100) * circumference;
      return `
        <div class="osd-circular-dial">
          <svg viewBox="0 0 120 120">
            <defs>
              <linearGradient id="accent-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#38bdf8" />
                <stop offset="100%" stop-color="#818cf8" />
              </linearGradient>
            </defs>
            <circle class="dial-bg" cx="60" cy="60" r="46" />
            <circle class="dial-bar" cx="60" cy="60" r="46"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${offset}" />
          </svg>
          <div class="dial-center">
            <div class="dial-icon">${icon}</div>
            <div class="dial-pct">${pct}%</div>
            ${muteBadge}
          </div>
        </div>
      `;
    }

    case "retro_pixel": {
      const totalBlocks = 14;
      const activeBlocks = Math.round((pct / 100) * totalBlocks);
      let blocksHtml = "";
      for (let i = 0; i < totalBlocks; i++) {
        blocksHtml += `<div class="osd-block ${i < activeBlocks && !muted ? "active" : ""}"></div>`;
      }
      return `
        <div class="osd-retro-pixel">
          <div class="osd-row">
            <span>VOL: ${target}</span>
            <span>${pct}% ${muted ? "[MUTED]" : ""}</span>
          </div>
          <div class="osd-blocks">${blocksHtml}</div>
        </div>
      `;
    }

    case "gaming_rgb": {
      return `
        <div class="osd-gaming-rgb">
          <div class="osd-row">
            <span>⚡ ${target}</span>
            <span style="color: #00eeff; font-family: monospace;">${pct}%</span>
            ${muteBadge}
          </div>
          <div class="osd-track">
            <div class="osd-fill" style="width: ${pct}%;"></div>
          </div>
        </div>
      `;
    }

    case "studio_vu": {
      const totalBars = 20;
      const activeBars = Math.round((pct / 100) * totalBars);
      let barsHtml = "";
      for (let i = 0; i < totalBars; i++) {
        let colorClass = "";
        if (i < activeBars && !muted) {
          if (i < 13) colorClass = "active-green";
          else if (i < 17) colorClass = "active-amber";
          else colorClass = "active-red";
        }
        barsHtml += `<div class="vu-bar ${colorClass}"></div>`;
      }
      return `
        <div class="osd-studio-vu">
          <div class="vu-labels">
            <span>-40dB</span><span>-20dB</span><span>-6dB</span><span>0dB</span><span>+6dB</span>
          </div>
          <div class="vu-meter">${barsHtml}</div>
          <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 6px;">
            <span>${target}</span>
            <span style="font-weight: bold; color: #38bdf8;">${pct}% ${muteBadge}</span>
          </div>
        </div>
      `;
    }

    case "neumorphic": {
      return `
        <div class="osd-neumorphic">
          <div class="osd-row">
            <span>${target}</span>
            <span style="color: #f59e0b; font-family: monospace;">${pct}%</span>
            ${muteBadge}
          </div>
          <div class="osd-track">
            <div class="osd-fill" style="width: ${pct}%;"></div>
          </div>
        </div>
      `;
    }

    case "aero_strip": {
      const waveBars = 16;
      let wavesHtml = "";
      for (let i = 0; i < waveBars; i++) {
        const height = Math.max(3, Math.round(Math.sin((i / waveBars) * Math.PI) * 14 * (pct / 100)));
        wavesHtml += `<div class="osd-wave-bar" style="height: ${height}px;"></div>`;
      }
      return `
        <div class="osd-aero-strip">
          <div class="osd-row">
            <span style="font-size: 13px; font-weight: 600;">${target}</span>
            <div class="osd-waves">${wavesHtml}</div>
            <span style="font-weight: bold; font-family: monospace; color: #38bdf8;">${pct}%</span>
            ${muteBadge}
          </div>
          <div class="osd-track" style="height: 6px; background: rgba(255,255,255,0.15); border-radius: 999px; overflow: hidden;">
            <div class="osd-fill" style="width: ${pct}%; height: 100%; background: #38bdf8; border-radius: 999px;"></div>
          </div>
        </div>
      `;
    }

    case "modern_fluent":
    default: {
      return `
        <div class="osd-modern-fluent">
          <div class="osd-row">
            <span class="osd-icon">${icon}</span>
            <span class="osd-title">${target}</span>
            <span class="osd-pct">${pct}%</span>
            ${muteBadge}
          </div>
          <div class="osd-track">
            <div class="osd-fill" style="width: ${pct}%;"></div>
          </div>
        </div>
      `;
    }
  }
}

/* ==================== OSD OVERLAY VIEW ==================== */

function initOsdView() {
  document.body.classList.add("osd-view");
  const appEl = document.getElementById("app");
  if (!appEl) return;

  appEl.innerHTML = `<div id="osd-root"></div>`;
  const root = document.getElementById("osd-root")!;
  let hideTimer: number | null = null;

  if (window.__TAURI__?.event) {
    window.__TAURI__.event.listen<OsdPayload>("osd-show", (evt) => {
      const payload = evt.payload;
      const pct = Math.min(100, Math.max(0, Math.round(payload.volume * 100)));
      const theme = payload.theme || "modern_fluent";

      root.innerHTML = renderOsdHtml(theme, pct, payload.muted, payload.target || "Master");
      root.classList.add("visible");

      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
      }

      hideTimer = window.setTimeout(() => {
        root.classList.remove("visible");
      }, payload.duration_ms || 1200);
    });
  }
}

/* ==================== ZONE OVERLAY VIEW ==================== */

async function initZoneOverlay(zoneId: string) {
  document.body.classList.add("zone-overlay");
  const appEl = document.getElementById("app");
  if (!appEl) return;

  appEl.innerHTML = `
    <div id="zone-container">
      <div class="edit-badge" id="edit-badge">
        <span>X:</span><input type="number" id="in-x" />
        <span>Y:</span><input type="number" id="in-y" />
        <span>W:</span><input type="number" id="in-w" />
        <span>H:</span><input type="number" id="in-h" />
        <button class="lock-btn" id="lock-btn" title="Exit Edit Mode">Lock</button>
      </div>
      <div class="zone-center-title" id="zone-center-title"></div>
      <div class="resize-handle handle-nw" data-handle="nw"></div>
      <div class="resize-handle handle-n" data-handle="n"></div>
      <div class="resize-handle handle-ne" data-handle="ne"></div>
      <div class="resize-handle handle-e" data-handle="e"></div>
      <div class="resize-handle handle-se" data-handle="se"></div>
      <div class="resize-handle handle-s" data-handle="s"></div>
      <div class="resize-handle handle-sw" data-handle="sw"></div>
      <div class="resize-handle handle-w" data-handle="w"></div>
    </div>
  `;

  const container = document.getElementById("zone-container")!;
  const inX = document.getElementById("in-x") as HTMLInputElement;
  const inY = document.getElementById("in-y") as HTMLInputElement;
  const inW = document.getElementById("in-w") as HTMLInputElement;
  const inH = document.getElementById("in-h") as HTMLInputElement;
  const lockBtn = document.getElementById("lock-btn")!;
  const centerTitle = document.getElementById("zone-center-title")!;

  let currentZone: ZoneConfig | null = null;
  let isEditMode = false;
  let pulseTimer: number | null = null;

  async function loadConfig() {
    if (!window.__TAURI__?.core) return;
    try {
      currentZone = await window.__TAURI__.core.invoke<ZoneConfig | null>("get_zone_config", {
        zoneId,
      });
      isEditMode = await window.__TAURI__.core.invoke<boolean>("get_edit_mode");
      applyState();
    } catch (err) {
      console.error("Failed to load zone config:", err);
    }
  }

  function applyState() {
    if (!currentZone) return;

    if (isEditMode) {
      document.body.classList.add("edit-mode");
    } else {
      document.body.classList.remove("edit-mode");
    }

    inX.value = `${currentZone.rect.x}`;
    inY.value = `${currentZone.rect.y}`;
    inW.value = `${currentZone.rect.width}`;
    inH.value = `${currentZone.rect.height}`;

    centerTitle.textContent = `${currentZone.name} (${currentZone.rect.width} × ${currentZone.rect.height})`;

    container.style.setProperty("--zone-opacity", `${currentZone.opacity}`);
    container.className = "";

    // Apply Shape
    if (currentZone.shape.type === "rectangle") {
      container.classList.add("shape-rectangle");
    } else if (currentZone.shape.type === "rounded") {
      container.classList.add("shape-rounded");
      if (currentZone.shape.radius) {
        container.style.borderRadius = `${currentZone.shape.radius}px`;
      }
    } else if (currentZone.shape.type === "circle") {
      container.classList.add("shape-circle");
    } else if (currentZone.shape.type === "screen_edge_strip") {
      const edge = currentZone.shape.edge || "top";
      container.classList.add(`shape-strip-${edge}`);
    }

    // Apply Visual Mode
    if (currentZone.visual_mode === "invisible") {
      container.classList.add("mode-invisible");
    } else if (currentZone.visual_mode === "faint_tint") {
      container.classList.add("mode-faint-tint");
    } else if (currentZone.visual_mode === "outline_on_hover") {
      container.classList.add("mode-outline-on-hover");
    } else if (currentZone.visual_mode === "always_visible") {
      container.classList.add("mode-always-visible");
    }
  }

  async function updateRect(x: number, y: number, w: number, h: number) {
    if (!currentZone || !window.__TAURI__?.core) return;

    // Edge snapping threshold: 16px
    const snap = 16;
    let snX = x;
    let snY = y;
    if (Math.abs(snX) < snap) snX = 0;
    if (Math.abs(snY) < snap) snY = 0;

    const newRect: Rect = {
      x: Math.round(snX),
      y: Math.round(snY),
      width: Math.max(50, Math.round(w)),
      height: Math.max(24, Math.round(h)),
    };

    currentZone.rect = newRect;
    inX.value = `${newRect.x}`;
    inY.value = `${newRect.y}`;
    inW.value = `${newRect.width}`;
    inH.value = `${newRect.height}`;
    centerTitle.textContent = `${currentZone.name} (${newRect.width} × ${newRect.height})`;

    await window.__TAURI__.core.invoke("update_zone_rect", {
      zoneId,
      rect: newRect,
    });
  }

  lockBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("set_edit_mode", { enabled: false });
    }
  });

  const onInputChange = () => {
    const x = parseInt(inX.value) || 0;
    const y = parseInt(inY.value) || 0;
    const w = parseInt(inW.value) || 50;
    const h = parseInt(inH.value) || 24;
    updateRect(x, y, w, h);
  };

  inX.addEventListener("change", onInputChange);
  inY.addEventListener("change", onInputChange);
  inW.addEventListener("change", onInputChange);
  inH.addEventListener("change", onInputChange);

  // Arrow key nudge in edit mode
  window.addEventListener("keydown", (e) => {
    if (!isEditMode || !currentZone) return;
    if (document.activeElement?.tagName === "INPUT") return;

    const delta = e.shiftKey ? 10 : 1;
    let { x, y, width, height } = currentZone.rect;

    switch (e.key) {
      case "ArrowUp": y -= delta; break;
      case "ArrowDown": y += delta; break;
      case "ArrowLeft": x -= delta; break;
      case "ArrowRight": x += delta; break;
      default: return;
    }

    e.preventDefault();
    updateRect(x, y, width, height);
  });

  // Drag and Resize handlers
  let activeAction: string | null = null;
  let startMouseX = 0;
  let startMouseY = 0;
  let startRect: Rect = { x: 0, y: 0, width: 0, height: 0 };

  container.addEventListener("mousedown", (e) => {
    if (!isEditMode || !currentZone) return;
    const target = e.target as HTMLElement;

    if (target.classList.contains("resize-handle")) {
      activeAction = target.dataset.handle || null;
    } else if (target === container || target.closest("#zone-container")) {
      if (target.closest(".edit-badge")) return;
      activeAction = "move";
    }

    if (activeAction) {
      e.preventDefault();
      document.body.classList.add("is-dragging");
      startMouseX = e.screenX;
      startMouseY = e.screenY;
      startRect = { ...currentZone.rect };
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (!activeAction || !currentZone) return;

    const dx = e.screenX - startMouseX;
    const dy = e.screenY - startMouseY;

    let { x, y, width, height } = startRect;

    if (activeAction === "move") {
      x += dx;
      y += dy;
    } else if (activeAction === "e") {
      width += dx;
    } else if (activeAction === "w") {
      x += dx;
      width -= dx;
    } else if (activeAction === "s") {
      height += dy;
    } else if (activeAction === "n") {
      y += dy;
      height -= dy;
    } else if (activeAction === "se") {
      width += dx;
      height += dy;
    } else if (activeAction === "sw") {
      x += dx;
      width -= dx;
      height += dy;
    } else if (activeAction === "ne") {
      width += dx;
      y += dy;
      height -= dy;
    } else if (activeAction === "nw") {
      x += dx;
      width -= dx;
      y += dy;
      height -= dy;
    }

    updateRect(x, y, width, height);
  });

  window.addEventListener("mouseup", () => {
    activeAction = null;
    document.body.classList.remove("is-dragging");
  });

  // Tauri event listeners
  if (window.__TAURI__?.event) {
    window.__TAURI__.event.listen<boolean>("edit-mode-changed", (evt) => {
      isEditMode = evt.payload;
      applyState();
    });

    window.__TAURI__.event.listen("settings-updated", () => {
      loadConfig();
    });

    window.__TAURI__.event.listen<string>("zone-pulse", (evt) => {
      if (evt.payload === zoneId) {
        container.classList.add("pulse-active");
        if (pulseTimer !== null) {
          window.clearTimeout(pulseTimer);
        }
        pulseTimer = window.setTimeout(() => {
          container.classList.remove("pulse-active");
        }, 220);

        if (currentZone?.tick_sound) {
          playTickSound();
        }
      }
    });
  }

  await loadConfig();
}

/* ============================================================
   SETTINGS WINDOW VIEW (OVERHAULED MODERN UI)
   ============================================================ */

async function initSettingsView() {
  document.body.classList.add("settings-view");
  const appEl = document.getElementById("app");
  if (!appEl) return;

  appEl.innerHTML = `
    <div class="settings-container">
      <!-- Modern Header -->
      <div class="app-header">
        <div class="brand-section">
          <div class="brand-icon">🔊</div>
          <div class="brand-text">
            <h1>VolZone</h1>
            <span>Screen Zone Scroll-Wheel Audio Controller</span>
          </div>
        </div>
        <div class="header-actions">
          <button class="edit-mode-pill" id="header-edit-pill">
            <span class="pill-dot"></span>
            <span id="header-edit-label">Edit Mode: Off</span>
          </button>
          <button class="btn" id="theme-btn">☀️ Light</button>
        </div>
      </div>

      <!-- Emergency Panic Alert Banner -->
      <div class="panic-banner" id="panic-banner" style="display: none;">
        <span>⚠️ EMERGENCY PANIC: Wheel hooks disengaged for safety.</span>
        <button class="btn btn-primary" id="unpanic-btn">Resume Hooks</button>
      </div>

      <!-- Live Master Volume Bar -->
      <div class="card">
        <div class="card-title">
          <span>Master Output Control</span>
          <span style="font-size: 12px; font-weight: normal; color: var(--text-muted);">Real-time Audio Engine</span>
        </div>
        <div class="volume-strip">
          <button class="vol-icon-btn" id="live-mute-btn" title="Toggle Mute">🔊</button>
          <input type="range" class="vol-slider" id="live-vol-slider" min="0" max="100" value="50" />
          <span class="vol-label" id="live-vol-label">50%</span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn" id="vol-step-up-btn">Step Up (+5%)</button>
          <button class="btn" id="vol-step-down-btn">Step Down (-5%)</button>
          <button class="btn" id="vol-toggle-mute-btn">Toggle Mute</button>
        </div>
      </div>

      <!-- Screen Zones Section -->
      <div class="card">
        <div class="card-title">
          <span>Screen Zones (<span id="zone-count-badge">0</span>)</span>
          <button class="btn btn-primary" id="add-zone-btn">+ Add Screen Zone</button>
        </div>
        <p style="font-size: 13px; color: var(--text-secondary); margin: 0 0 12px 0;">
          Hover your mouse pointer over any defined screen zone and scroll your wheel to adjust volume instantly.
        </p>
        <div class="zone-grid" id="zone-grid-container"></div>
      </div>

      <!-- Zone Inspector Modal / Card -->
      <div class="card" id="zone-inspector" style="display: none; border-color: var(--accent);">
        <div class="card-title">
          <span id="inspector-title" style="color: var(--accent);">Zone Inspector</span>
          <div style="display: flex; gap: 6px;">
            <button class="btn" id="dup-zone-btn">Duplicate</button>
            <button class="btn btn-danger" id="del-zone-btn">Delete</button>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Zone Name</label>
            <input type="text" class="form-control" id="z-name" />
          </div>
          <div class="form-group">
            <label>Target Audio Device</label>
            <select class="form-control" id="z-target">
              <option value="master">Master Volume</option>
              <option value="mic">Microphone Input</option>
              <option value="app_under_cursor">App Under Cursor</option>
              <option value="app">Specific Application</option>
            </select>
          </div>
        </div>

        <div class="form-group" id="app-select-group" style="display: none;">
          <label>Specific Application</label>
          <select class="form-control" id="z-app-target"></select>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Shape</label>
            <select class="form-control" id="z-shape">
              <option value="rectangle">Rectangle</option>
              <option value="rounded">Rounded Rectangle</option>
              <option value="circle">Circle</option>
              <option value="screen_edge_strip">Screen Edge Strip</option>
            </select>
          </div>
          <div class="form-group" id="radius-group" style="display: none;">
            <label>Corner Radius (px)</label>
            <input type="number" class="form-control" id="z-radius" min="2" max="100" value="12" />
          </div>
          <div class="form-group" id="strip-group" style="display: none;">
            <label>Screen Edge</label>
            <select class="form-control" id="z-edge">
              <option value="top">Top Edge</option>
              <option value="bottom">Bottom Edge</option>
              <option value="left">Left Edge</option>
              <option value="right">Right Edge</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Visual Mode</label>
            <select class="form-control" id="z-mode">
              <option value="invisible">Invisible (Stealth)</option>
              <option value="faint_tint">Faint Tint</option>
              <option value="outline_on_hover">Outline on Hover</option>
              <option value="always_visible">Always Visible</option>
            </select>
          </div>
          <div class="form-group">
            <label>Opacity (<span id="opacity-val">25%</span>)</label>
            <input type="range" class="vol-slider" id="z-opacity" min="0" max="100" value="25" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Step Size (<span id="step-val">2%</span>)</label>
            <input type="range" class="vol-slider" id="z-step" min="1" max="15" value="2" />
          </div>
          <div class="form-group">
            <label>Horizontal Tilt Wheel Action</label>
            <select class="form-control" id="z-horiz-action">
              <option value="none">None / Default</option>
              <option value="media_track">Next / Previous Media Track</option>
              <option value="balance">Audio Balance</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Min Volume Limit (<span id="min-vol-val">0%</span>)</label>
            <input type="range" class="vol-slider" id="z-min-vol" min="0" max="100" value="0" />
          </div>
          <div class="form-group">
            <label>Max Volume Limit (<span id="max-vol-val">100%</span>)</label>
            <input type="range" class="vol-slider" id="z-max-vol" min="0" max="100" value="100" />
          </div>
          <div class="form-group">
            <label>Soft Start Max Jump</label>
            <select class="form-control" id="z-soft-start">
              <option value="none">Disabled (No Limit)</option>
              <option value="0.05">5% max jump</option>
              <option value="0.08">8% max jump</option>
              <option value="0.10">10% max jump</option>
              <option value="0.15">15% max jump</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Coarse Modifier (2.5x step)</label>
            <select class="form-control" id="z-coarse-mod">
              <option value="shift">Shift</option>
              <option value="ctrl">Ctrl</option>
              <option value="alt">Alt</option>
              <option value="none">None</option>
            </select>
          </div>
          <div class="form-group">
            <label>Fine Modifier (0.25x step)</label>
            <select class="form-control" id="z-fine-mod">
              <option value="ctrl">Ctrl</option>
              <option value="shift">Shift</option>
              <option value="alt">Alt</option>
              <option value="none">None</option>
            </select>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 14px;">
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
            <input type="checkbox" id="z-accel" /> Wheel Acceleration
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
            <input type="checkbox" id="z-invert" /> Invert Direction
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
            <input type="checkbox" id="z-middle-mute" /> Middle-Click to Mute
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
            <input type="checkbox" id="z-pulse-tint" /> Pulse Tint on Change
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
            <input type="checkbox" id="z-tick-sound" /> Mechanical Tick Sound
          </label>
        </div>
      </div>

      <!-- On-Screen Display (OSD) Studio with 10 Themes & Position Set -->
      <div class="card">
        <div class="card-title">
          <span>On-Screen Display (OSD) Studio</span>
          <button class="btn btn-primary" id="test-osd-btn">🚀 Test OSD On Screen</button>
        </div>

        <div class="switch-row">
          <label for="g-osd">Show On-Screen Display Overlay</label>
          <input type="checkbox" class="toggle-switch" id="g-osd" />
        </div>
        <div class="switch-row">
          <label for="g-osd-hide-fullscreen">Hide OSD in Fullscreen Applications (Games/Movies)</label>
          <input type="checkbox" class="toggle-switch" id="g-osd-hide-fullscreen" />
        </div>

        <!-- 10 OSD Themes Visual Gallery -->
        <label style="display: block; font-size: 13px; font-weight: 700; margin: 18px 0 10px 0;">
          Select Theme Style (10 Available)
        </label>
        <div class="osd-themes-grid" id="osd-themes-grid"></div>

        <!-- Position Set & Duration -->
        <div class="position-grid-container">
          <div class="position-matrix" id="pos-matrix">
            <button class="pos-btn" data-pos="top_left" title="Top Left">TL</button>
            <button class="pos-btn" data-pos="top_center" title="Top Center">TC</button>
            <button class="pos-btn" data-pos="top_right" title="Top Right">TR</button>
            <button class="pos-btn" data-pos="near_cursor" title="Near Mouse Cursor" style="grid-column: 1 / span 3; font-size: 10px;">Near Cursor</button>
            <button class="pos-btn" data-pos="center" title="Screen Center" style="grid-column: 1 / span 3; font-size: 10px;">Center</button>
            <button class="pos-btn" data-pos="bottom_left" title="Bottom Left">BL</button>
            <button class="pos-btn" data-pos="bottom_center" title="Bottom Center">BC</button>
            <button class="pos-btn" data-pos="bottom_right" title="Bottom Right">BR</button>
          </div>
          <div class="pos-details">
            <div class="form-group">
              <label>Current Position: <strong id="pos-label" style="color: var(--accent);">Top Center</strong></label>
            </div>
            <div class="form-group">
              <label>OSD Display Duration (<span id="osd-dur-val">1200ms</span>)</label>
              <input type="range" class="vol-slider" id="g-osd-dur" min="400" max="4000" step="100" value="1200" />
            </div>
          </div>
        </div>

        <!-- Live In-Settings Preview Box -->
        <div class="osd-live-preview-box" id="osd-live-preview"></div>
      </div>

      <!-- Profiles & Rules -->
      <div class="card">
        <div class="card-title">
          <span>Profiles & Automation Rules</span>
          <button class="btn" id="save-new-profile-btn">+ Save As Profile</button>
        </div>
        <div class="form-row">
          <div class="form-group" style="flex: 2;">
            <label>Active Profile</label>
            <select class="form-control" id="profile-select"></select>
          </div>
          <div class="form-group" style="flex: 1; align-self: flex-end;">
            <button class="btn btn-danger" id="delete-profile-btn" style="width: 100%; height: 38px;">Delete Profile</button>
          </div>
        </div>
        <div class="switch-row">
          <label for="g-fullscreen-disable">Auto-disable zones when games / fullscreen apps are focused</label>
          <input type="checkbox" class="toggle-switch" id="g-fullscreen-disable" />
        </div>
        <div class="switch-row">
          <label for="g-autostart">Start VolZone automatically on system login</label>
          <input type="checkbox" class="toggle-switch" id="g-autostart" />
        </div>
      </div>

      <!-- Night Mode (Time Profile) -->
      <div class="card">
        <div class="card-title">
          <span>Night Mode (Volume Limiter)</span>
          <label style="font-size: 13px; font-weight: normal; cursor: pointer;">
            <input type="checkbox" id="night-enable" /> Enable
          </label>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Start Hour (24h)</label>
            <input type="number" class="form-control" id="night-start" min="0" max="23" value="22" />
          </div>
          <div class="form-group">
            <label>End Hour (24h)</label>
            <input type="number" class="form-control" id="night-end" min="0" max="23" value="7" />
          </div>
          <div class="form-group">
            <label>Night Max Cap (<span id="night-cap-val">30%</span>)</label>
            <input type="range" class="vol-slider" id="night-cap" min="5" max="100" value="30" />
          </div>
        </div>
      </div>

      <!-- Configuration & Diagnostics -->
      <div class="card">
        <div class="card-title">Configuration Management & Safety</div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn" id="export-btn">Export JSON</button>
          <button class="btn" id="import-btn">Import JSON</button>
          <button class="btn" id="open-logs-btn">Open Logs Folder</button>
          <button class="btn btn-danger" id="panic-now-btn">Emergency Panic (Unhook)</button>
          <button class="btn btn-danger" id="reset-btn">Reset to Defaults</button>
        </div>
      </div>
    </div>

    <!-- Modal for Import/Export -->
    <div id="modal-backdrop" class="modal-backdrop" style="display: none;">
      <div class="modal-content">
        <h3 id="modal-title" style="margin-top: 0;">Configuration JSON</h3>
        <textarea id="modal-text"></textarea>
        <div class="modal-footer">
          <button class="btn" id="modal-close-btn">Cancel</button>
          <button class="btn btn-primary" id="modal-action-btn">Apply</button>
        </div>
      </div>
    </div>
  `;

  let settings: Settings | null = null;
  let selectedZoneIndex: number | null = null;
  let audioApps: AppAudioSession[] = [];

  async function loadSettings() {
    if (!window.__TAURI__?.core) return;
    try {
      settings = await window.__TAURI__.core.invoke<Settings>("get_settings");
      try {
        audioApps = await window.__TAURI__.core.invoke<AppAudioSession[]>("list_audio_apps");
      } catch {
        audioApps = [];
      }
      renderHeader();
      renderProfiles();
      renderZoneGrid();
      renderOsdStudio();
      renderGlobalPreferences();
      updateVolumePreview();

      try {
        const autostart = await window.__TAURI__.core.invoke<boolean>("is_autostart_enabled");
        const autoEl = document.getElementById("g-autostart") as HTMLInputElement;
        if (autoEl) autoEl.checked = autostart;
      } catch {}

      try {
        const isPanicked = await window.__TAURI__.core.invoke<boolean>("is_panic_disengaged");
        const panicEl = document.getElementById("panic-banner");
        if (panicEl) panicEl.style.display = isPanicked ? "flex" : "none";
      } catch {}
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }

  async function save() {
    if (!settings || !window.__TAURI__?.core) return;

    // Sync zones to active profile
    const activeProf = settings.profiles.find((p) => p.id === settings!.active_profile_id);
    if (activeProf) {
      activeProf.zones = JSON.parse(JSON.stringify(settings.zones));
    }

    await window.__TAURI__.core.invoke("save_settings", { newSettings: settings });
    renderHeader();
  }

  function renderHeader() {
    if (!settings) return;
    const editPill = document.getElementById("header-edit-pill");
    const editLabel = document.getElementById("header-edit-label");
    const countBadge = document.getElementById("zone-count-badge");

    if (editPill && editLabel) {
      if (settings.edit_mode) {
        editPill.classList.add("active");
        editLabel.textContent = "Edit Mode: Active (Click to Lock)";
      } else {
        editPill.classList.remove("active");
        editLabel.textContent = "Edit Mode: Off";
      }
    }
    if (countBadge) {
      countBadge.textContent = `${settings.zones.length}`;
    }
  }

  async function updateVolumePreview() {
    if (!window.__TAURI__?.core) return;
    try {
      const vol = await window.__TAURI__.core.invoke<number>("get_master_volume");
      const muted = await window.__TAURI__.core.invoke<boolean>("get_master_mute");
      const pct = Math.round(vol * 100);
      const slider = document.getElementById("live-vol-slider") as HTMLInputElement;
      const label = document.getElementById("live-vol-label")!;
      const iconBtn = document.getElementById("live-mute-btn")!;

      if (slider) slider.value = `${pct}`;
      if (label) label.textContent = `${pct}%`;
      if (iconBtn) iconBtn.textContent = getSpeakerIcon(pct, muted);
    } catch (e) {
      console.warn("Could not read master volume:", e);
    }
  }

  function renderProfiles() {
    const sel = document.getElementById("profile-select") as HTMLSelectElement;
    if (!settings || !sel) return;

    sel.innerHTML = "";
    if (settings.profiles.length === 0) {
      settings.profiles = [
        {
          id: "default",
          name: "Default Profile",
          zones: JSON.parse(JSON.stringify(settings.zones)),
        },
      ];
      settings.active_profile_id = "default";
    }

    settings.profiles.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      opt.selected = p.id === settings!.active_profile_id;
      sel.appendChild(opt);
    });
  }

  function renderZoneGrid() {
    const gridEl = document.getElementById("zone-grid-container")!;
    if (!settings) return;

    gridEl.innerHTML = "";
    settings.zones.forEach((z, idx) => {
      const card = document.createElement("div");
      card.className = `zone-card ${selectedZoneIndex === idx ? "selected" : ""}`;

      let shapeIcon = "▭";
      if (z.shape.type === "rounded") shapeIcon = "▢";
      if (z.shape.type === "circle") shapeIcon = "◯";
      if (z.shape.type === "screen_edge_strip") shapeIcon = "═";

      card.innerHTML = `
        <div class="zone-card-top">
          <div class="zone-title-area">
            <div class="zone-shape-icon">${shapeIcon}</div>
            <div class="zone-name">${z.name}</div>
          </div>
          <input type="checkbox" class="toggle-switch zone-toggle" ${z.enabled ? "checked" : ""} data-idx="${idx}" title="Toggle Zone" />
        </div>
        <div class="zone-meta">
          <span class="zone-badge">${z.rect.width} × ${z.rect.height}px</span>
          <span class="zone-badge">Target: ${z.target.kind}</span>
          <span class="zone-badge">Step: ${z.step}%</span>
        </div>
        <div style="display: flex; gap: 6px; justify-content: flex-end;">
          <button class="btn" style="padding: 3px 8px; font-size: 11px;" data-action="edit">Configure</button>
        </div>
      `;

      card.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("zone-toggle")) return;
        selectedZoneIndex = idx;
        renderZoneGrid();
        renderInspector();
      });

      card.querySelector(".zone-toggle")?.addEventListener("change", async (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        settings!.zones[idx].enabled = checked;
        await save();
      });

      card.querySelector('[data-action="edit"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedZoneIndex = idx;
        renderZoneGrid();
        renderInspector();
      });

      gridEl.appendChild(card);
    });

    if (selectedZoneIndex !== null && settings.zones[selectedZoneIndex]) {
      renderInspector();
    } else {
      document.getElementById("zone-inspector")!.style.display = "none";
    }
  }

  function renderInspector() {
    if (selectedZoneIndex === null || !settings || !settings.zones[selectedZoneIndex]) return;
    const z = settings.zones[selectedZoneIndex];
    const inspector = document.getElementById("zone-inspector")!;
    inspector.style.display = "block";

    (document.getElementById("inspector-title") as HTMLElement).textContent = `Configure Zone: ${z.name}`;
    (document.getElementById("z-name") as HTMLInputElement).value = z.name;

    // Target Selection
    const targetSel = document.getElementById("z-target") as HTMLSelectElement;
    const appGroup = document.getElementById("app-select-group")!;
    const appSel = document.getElementById("z-app-target") as HTMLSelectElement;

    targetSel.value = z.target.kind;
    if (z.target.kind === "app") {
      appGroup.style.display = "block";
      appSel.innerHTML = "";
      audioApps.forEach((a) => {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = `${a.name} (${Math.round(a.volume * 100)}%)`;
        opt.selected = (z.target as { kind: "app"; target: string }).target === a.id;
        appSel.appendChild(opt);
      });
    } else {
      appGroup.style.display = "none";
    }

    // Shape
    (document.getElementById("z-shape") as HTMLSelectElement).value = z.shape.type;
    const radGroup = document.getElementById("radius-group")!;
    const stripGroup = document.getElementById("strip-group")!;
    radGroup.style.display = z.shape.type === "rounded" ? "block" : "none";
    stripGroup.style.display = z.shape.type === "screen_edge_strip" ? "block" : "none";

    if (z.shape.radius) (document.getElementById("z-radius") as HTMLInputElement).value = `${z.shape.radius}`;
    if (z.shape.edge) (document.getElementById("z-edge") as HTMLSelectElement).value = z.shape.edge;

    // Visual Mode & Opacity
    (document.getElementById("z-mode") as HTMLSelectElement).value = z.visual_mode;
    (document.getElementById("z-opacity") as HTMLInputElement).value = `${Math.round(z.opacity * 100)}`;
    document.getElementById("opacity-val")!.textContent = `${Math.round(z.opacity * 100)}%`;

    // Step & Tuning
    (document.getElementById("z-step") as HTMLInputElement).value = `${Math.round(z.step)}`;
    document.getElementById("step-val")!.textContent = `${Math.round(z.step)}%`;
    (document.getElementById("z-horiz-action") as HTMLSelectElement).value = z.horizontal_action || "none";

    // Volume Limits & Soft Start
    (document.getElementById("z-min-vol") as HTMLInputElement).value = `${Math.round((z.min_volume ?? 0) * 100)}`;
    document.getElementById("min-vol-val")!.textContent = `${Math.round((z.min_volume ?? 0) * 100)}%`;

    (document.getElementById("z-max-vol") as HTMLInputElement).value = `${Math.round((z.max_volume ?? 1) * 100)}`;
    document.getElementById("max-vol-val")!.textContent = `${Math.round((z.max_volume ?? 1) * 100)}%`;

    const softStartSel = document.getElementById("z-soft-start") as HTMLSelectElement;
    softStartSel.value = z.soft_start_limit != null ? `${z.soft_start_limit}` : "none";

    // Modifiers
    (document.getElementById("z-coarse-mod") as HTMLSelectElement).value = z.coarse_modifier || "shift";
    (document.getElementById("z-fine-mod") as HTMLSelectElement).value = z.fine_modifier || "ctrl";

    // Toggles
    (document.getElementById("z-accel") as HTMLInputElement).checked = z.acceleration;
    (document.getElementById("z-invert") as HTMLInputElement).checked = z.invert;
    (document.getElementById("z-middle-mute") as HTMLInputElement).checked = z.middle_click_to_mute ?? false;
    (document.getElementById("z-pulse-tint") as HTMLInputElement).checked = z.pulse_tint ?? true;
    (document.getElementById("z-tick-sound") as HTMLInputElement).checked = z.tick_sound ?? false;
  }

  function renderOsdStudio() {
    if (!settings) return;
    const osd = settings.osd || {
      enabled: true,
      duration_ms: 1200,
      position: "top_center",
      hide_in_fullscreen: true,
      theme: "modern_fluent",
    };

    (document.getElementById("g-osd") as HTMLInputElement).checked = osd.enabled;
    (document.getElementById("g-osd-hide-fullscreen") as HTMLInputElement).checked = osd.hide_in_fullscreen;
    (document.getElementById("g-osd-dur") as HTMLInputElement).value = `${osd.duration_ms || 1200}`;
    document.getElementById("osd-dur-val")!.textContent = `${osd.duration_ms || 1200}ms`;

    // Render 10 Theme Cards
    const themesGrid = document.getElementById("osd-themes-grid")!;
    themesGrid.innerHTML = "";
    OSD_THEMES.forEach((t) => {
      const card = document.createElement("div");
      card.className = `theme-card ${osd.theme === t.id ? "active" : ""}`;
      card.innerHTML = `
        <div class="theme-card-icon">${t.icon}</div>
        <div class="theme-card-title">${t.name}</div>
      `;
      card.addEventListener("click", async () => {
        settings!.osd.theme = t.id;
        renderOsdStudio();
        await save();
      });
      themesGrid.appendChild(card);
    });

    // Render Position Matrix (9-box selector)
    const posMatrix = document.getElementById("pos-matrix")!;
    posMatrix.querySelectorAll(".pos-btn").forEach((btn) => {
      const b = btn as HTMLButtonElement;
      if (b.dataset.pos === osd.position) {
        b.classList.add("active");
      } else {
        b.classList.remove("active");
      }
    });

    const posLabel = document.getElementById("pos-label")!;
    posLabel.textContent = osd.position.replace(/_/g, " ").toUpperCase();

    // Render Live Preview
    const previewBox = document.getElementById("osd-live-preview")!;
    previewBox.innerHTML = renderOsdHtml(osd.theme, 65, false, "Master Output");
  }

  function renderGlobalPreferences() {
    if (!settings) return;
    (document.getElementById("g-fullscreen-disable") as HTMLInputElement).checked =
      settings.fullscreen_rule?.disable_in_fullscreen ?? true;

    const tp = settings.time_profile || { enabled: false, start_hour: 22, end_hour: 7, max_volume: 0.3 };
    (document.getElementById("night-enable") as HTMLInputElement).checked = tp.enabled;
    (document.getElementById("night-start") as HTMLInputElement).value = `${tp.start_hour}`;
    (document.getElementById("night-end") as HTMLInputElement).value = `${tp.end_hour}`;
    (document.getElementById("night-cap") as HTMLInputElement).value = `${Math.round(tp.max_volume * 100)}`;
    document.getElementById("night-cap-val")!.textContent = `${Math.round(tp.max_volume * 100)}%`;
  }

  // Profile management event listeners
  document.getElementById("profile-select")?.addEventListener("change", async (e) => {
    const profId = (e.target as HTMLSelectElement).value;
    if (window.__TAURI__?.core) {
      try {
        settings = await window.__TAURI__.core.invoke<Settings>("switch_profile", { profileId: profId });
        selectedZoneIndex = 0;
        renderZoneGrid();
      } catch (err) {
        console.error("Failed to switch profile:", err);
      }
    }
  });

  document.getElementById("save-new-profile-btn")?.addEventListener("click", async () => {
    if (!settings) return;
    const name = prompt("Enter a name for the new profile:");
    if (!name || !name.trim()) return;
    const newId = `profile-${Date.now()}`;
    const newProf: ZoneProfile = {
      id: newId,
      name: name.trim(),
      zones: JSON.parse(JSON.stringify(settings.zones)),
    };
    settings.profiles.push(newProf);
    settings.active_profile_id = newId;
    renderProfiles();
    await save();
  });

  document.getElementById("delete-profile-btn")?.addEventListener("click", async () => {
    if (!settings || settings.profiles.length <= 1) {
      alert("Cannot delete the only remaining profile.");
      return;
    }
    const idx = settings.profiles.findIndex((p) => p.id === settings!.active_profile_id);
    if (idx !== -1) {
      settings.profiles.splice(idx, 1);
      settings.active_profile_id = settings.profiles[0].id;
      settings.zones = JSON.parse(JSON.stringify(settings.profiles[0].zones));
      renderProfiles();
      selectedZoneIndex = 0;
      renderZoneGrid();
      await save();
    }
  });

  // Zone Inspector Input Event Listeners
  document.getElementById("z-name")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].name = (e.target as HTMLInputElement).value;
      renderZoneGrid();
      await save();
    }
  });

  document.getElementById("z-target")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const val = (e.target as HTMLSelectElement).value;
      if (val === "master") settings.zones[selectedZoneIndex].target = { kind: "master" };
      else if (val === "mic") settings.zones[selectedZoneIndex].target = { kind: "mic" };
      else if (val === "app_under_cursor") settings.zones[selectedZoneIndex].target = { kind: "app_under_cursor" };
      else if (val === "app") {
        const firstAppId = audioApps[0]?.id || "default";
        settings.zones[selectedZoneIndex].target = { kind: "app", target: firstAppId };
      }
      renderInspector();
      await save();
    }
  });

  document.getElementById("z-app-target")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const appId = (e.target as HTMLSelectElement).value;
      settings.zones[selectedZoneIndex].target = { kind: "app", target: appId };
      await save();
    }
  });

  document.getElementById("z-shape")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const type = (e.target as HTMLSelectElement).value as ZoneShape["type"];
      if (type === "rounded") {
        settings.zones[selectedZoneIndex].shape = { type, radius: 12 };
      } else if (type === "screen_edge_strip") {
        settings.zones[selectedZoneIndex].shape = { type, edge: "top", thickness: 28 };
      } else {
        settings.zones[selectedZoneIndex].shape = { type };
      }
      renderInspector();
      await save();
    }
  });

  document.getElementById("z-radius")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const radius = parseInt((e.target as HTMLInputElement).value) || 12;
      settings.zones[selectedZoneIndex].shape = { type: "rounded", radius };
      await save();
    }
  });

  document.getElementById("z-edge")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const edge = (e.target as HTMLSelectElement).value as ScreenEdge;
      settings.zones[selectedZoneIndex].shape = { type: "screen_edge_strip", edge, thickness: 28 };
      await save();
    }
  });

  document.getElementById("z-mode")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].visual_mode = (e.target as HTMLSelectElement).value as ZoneConfig["visual_mode"];
      await save();
    }
  });

  document.getElementById("z-opacity")?.addEventListener("input", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const val = parseInt((e.target as HTMLInputElement).value);
      settings.zones[selectedZoneIndex].opacity = val / 100;
      document.getElementById("opacity-val")!.textContent = `${val}%`;
      await save();
    }
  });

  document.getElementById("z-step")?.addEventListener("input", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const val = parseInt((e.target as HTMLInputElement).value);
      settings.zones[selectedZoneIndex].step = val;
      document.getElementById("step-val")!.textContent = `${val}%`;
      await save();
    }
  });

  document.getElementById("z-horiz-action")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].horizontal_action = (e.target as HTMLSelectElement).value as HorizontalWheelAction;
      await save();
    }
  });

  document.getElementById("z-min-vol")?.addEventListener("input", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const val = parseInt((e.target as HTMLInputElement).value);
      settings.zones[selectedZoneIndex].min_volume = val / 100;
      document.getElementById("min-vol-val")!.textContent = `${val}%`;
      await save();
    }
  });

  document.getElementById("z-max-vol")?.addEventListener("input", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const val = parseInt((e.target as HTMLInputElement).value);
      settings.zones[selectedZoneIndex].max_volume = val / 100;
      document.getElementById("max-vol-val")!.textContent = `${val}%`;
      await save();
    }
  });

  document.getElementById("z-soft-start")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const val = (e.target as HTMLSelectElement).value;
      settings.zones[selectedZoneIndex].soft_start_limit = val === "none" ? null : parseFloat(val);
      await save();
    }
  });

  document.getElementById("z-coarse-mod")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].coarse_modifier = (e.target as HTMLSelectElement).value as ModifierKey;
      await save();
    }
  });

  document.getElementById("z-fine-mod")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].fine_modifier = (e.target as HTMLSelectElement).value as ModifierKey;
      await save();
    }
  });

  document.getElementById("z-accel")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].acceleration = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  document.getElementById("z-invert")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].invert = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  document.getElementById("z-middle-mute")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].middle_click_to_mute = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  document.getElementById("z-pulse-tint")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].pulse_tint = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  document.getElementById("z-tick-sound")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].tick_sound = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  // ==================== ADD SCREEN ZONE BUTTON ====================
  document.getElementById("add-zone-btn")?.addEventListener("click", async () => {
    if (!settings) return;

    const count = settings.zones.length;
    const offset = (count % 8) * 36;
    const newId = `zone-${Date.now()}`;
    const newZone: ZoneConfig = {
      id: newId,
      name: `Screen Zone ${count + 1}`,
      monitor_id: null,
      rect: { x: 100 + offset, y: 100 + offset, width: 340, height: 75 },
      shape: { type: "rectangle" },
      visual_mode: "faint_tint",
      opacity: 0.28,
      target: { kind: "master" },
      step: 2,
      acceleration: false,
      invert: false,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      min_volume: 0,
      max_volume: 1,
      soft_start_limit: null,
      middle_click_to_mute: false,
      coarse_modifier: "shift",
      fine_modifier: "ctrl",
      horizontal_action: "none",
      tick_sound: false,
      pulse_tint: true,
      enabled: true,
    };

    settings.zones.push(newZone);
    selectedZoneIndex = settings.zones.length - 1;

    // Automatically enable edit mode so the user sees the newly spawned zone on their screen
    settings.edit_mode = true;
    renderHeader();
    renderZoneGrid();
    await save();

    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("set_edit_mode", { enabled: true });
    }
  });

  document.getElementById("dup-zone-btn")?.addEventListener("click", async () => {
    if (selectedZoneIndex === null || !settings) return;
    const orig = settings.zones[selectedZoneIndex];
    const copy: ZoneConfig = JSON.parse(JSON.stringify(orig));
    copy.id = `zone-${Date.now()}`;
    copy.name = `${orig.name} (Copy)`;
    copy.rect.x += 30;
    copy.rect.y += 30;
    settings.zones.push(copy);
    selectedZoneIndex = settings.zones.length - 1;
    renderZoneGrid();
    await save();
  });

  document.getElementById("del-zone-btn")?.addEventListener("click", async () => {
    if (selectedZoneIndex === null || !settings) return;
    settings.zones.splice(selectedZoneIndex, 1);
    selectedZoneIndex = settings.zones.length > 0 ? 0 : null;
    renderZoneGrid();
    await save();
  });

  // Global preferences listeners
  document.getElementById("g-fullscreen-disable")?.addEventListener("change", async (e) => {
    if (settings) {
      if (!settings.fullscreen_rule) {
        settings.fullscreen_rule = { disable_in_fullscreen: true, blacklisted_apps: [] };
      }
      settings.fullscreen_rule.disable_in_fullscreen = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  // Time profile listeners
  document.getElementById("night-enable")?.addEventListener("change", async (e) => {
    if (settings) {
      if (!settings.time_profile) {
        settings.time_profile = { enabled: false, start_hour: 22, end_hour: 7, max_volume: 0.3 };
      }
      settings.time_profile.enabled = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  document.getElementById("night-start")?.addEventListener("change", async (e) => {
    if (settings?.time_profile) {
      settings.time_profile.start_hour = parseInt((e.target as HTMLInputElement).value) || 22;
      await save();
    }
  });

  document.getElementById("night-end")?.addEventListener("change", async (e) => {
    if (settings?.time_profile) {
      settings.time_profile.end_hour = parseInt((e.target as HTMLInputElement).value) || 7;
      await save();
    }
  });

  document.getElementById("night-cap")?.addEventListener("input", async (e) => {
    if (settings?.time_profile) {
      const val = parseInt((e.target as HTMLInputElement).value) || 30;
      settings.time_profile.max_volume = val / 100;
      document.getElementById("night-cap-val")!.textContent = `${val}%`;
      await save();
    }
  });

  // OSD listeners
  document.getElementById("g-osd")?.addEventListener("change", async (e) => {
    if (settings) {
      if (!settings.osd) {
        settings.osd = { enabled: true, duration_ms: 1200, position: "top_center", hide_in_fullscreen: true, theme: "modern_fluent" };
      }
      settings.osd.enabled = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  document.getElementById("g-osd-hide-fullscreen")?.addEventListener("change", async (e) => {
    if (settings?.osd) {
      settings.osd.hide_in_fullscreen = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  document.getElementById("g-osd-dur")?.addEventListener("input", async (e) => {
    if (settings?.osd) {
      const dur = parseInt((e.target as HTMLInputElement).value) || 1200;
      settings.osd.duration_ms = dur;
      document.getElementById("osd-dur-val")!.textContent = `${dur}ms`;
      await save();
    }
  });

  // Position Matrix click handling
  document.getElementById("pos-matrix")?.addEventListener("click", async (e) => {
    const target = (e.target as HTMLElement).closest(".pos-btn") as HTMLButtonElement | null;
    if (!target || !settings) return;
    const pos = target.dataset.pos as OsdPosition;
    if (pos) {
      settings.osd.position = pos;
      renderOsdStudio();
      await save();
    }
  });

  // Test OSD on screen button
  document.getElementById("test-osd-btn")?.addEventListener("click", async () => {
    if (window.__TAURI__?.core && settings?.osd) {
      await window.__TAURI__.core.invoke("trigger_osd", {
        theme: settings.osd.theme,
        position: settings.osd.position,
      });
    }
  });

  // Master volume slider & test buttons
  document.getElementById("live-vol-slider")?.addEventListener("input", async (e) => {
    const val = parseInt((e.target as HTMLInputElement).value);
    document.getElementById("live-vol-label")!.textContent = `${val}%`;
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("set_master_volume", { level: val / 100 });
      updateVolumePreview();
    }
  });

  document.getElementById("vol-step-up-btn")?.addEventListener("click", async () => {
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("test_volume", { action: "up" });
      updateVolumePreview();
    }
  });

  document.getElementById("vol-step-down-btn")?.addEventListener("click", async () => {
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("test_volume", { action: "down" });
      updateVolumePreview();
    }
  });

  const onMuteToggle = async () => {
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("toggle_master_mute");
      updateVolumePreview();
    }
  };
  document.getElementById("vol-toggle-mute-btn")?.addEventListener("click", onMuteToggle);
  document.getElementById("live-mute-btn")?.addEventListener("click", onMuteToggle);

  // Header Edit Mode Toggle Pill
  document.getElementById("header-edit-pill")?.addEventListener("click", async () => {
    if (!window.__TAURI__?.core) return;
    const current = await window.__TAURI__.core.invoke<boolean>("get_edit_mode");
    const next = !current;
    await window.__TAURI__.core.invoke("set_edit_mode", { enabled: next });
    if (settings) {
      settings.edit_mode = next;
      renderHeader();
    }
  });

  // Theme toggle button
  const themeBtn = document.getElementById("theme-btn")!;
  themeBtn.addEventListener("click", () => {
    const isDark = document.body.getAttribute("data-theme") !== "light";
    if (isDark) {
      document.body.setAttribute("data-theme", "light");
      themeBtn.textContent = "🌙 Dark";
    } else {
      document.body.removeAttribute("data-theme");
      themeBtn.textContent = "☀️ Light";
    }
  });

  // Modal for Import / Export
  const modalBackdrop = document.getElementById("modal-backdrop")!;
  const modalText = document.getElementById("modal-text") as HTMLTextAreaElement;
  const modalActionBtn = document.getElementById("modal-action-btn")!;
  let modalMode: "export" | "import" = "export";

  document.getElementById("export-btn")?.addEventListener("click", () => {
    if (!settings) return;
    modalMode = "export";
    (document.getElementById("modal-title") as HTMLElement).textContent = "Export Configuration JSON";
    modalText.value = JSON.stringify(settings, null, 2);
    modalText.readOnly = true;
    modalActionBtn.textContent = "Copy to Clipboard";
    modalBackdrop.style.display = "flex";
  });

  document.getElementById("import-btn")?.addEventListener("click", () => {
    modalMode = "import";
    (document.getElementById("modal-title") as HTMLElement).textContent = "Import Configuration JSON";
    modalText.value = "";
    modalText.readOnly = false;
    modalActionBtn.textContent = "Apply & Save";
    modalBackdrop.style.display = "flex";
  });

  document.getElementById("modal-close-btn")?.addEventListener("click", () => {
    modalBackdrop.style.display = "none";
  });

  modalActionBtn.addEventListener("click", async () => {
    if (modalMode === "export") {
      await navigator.clipboard.writeText(modalText.value);
      alert("Configuration JSON copied to clipboard!");
      modalBackdrop.style.display = "none";
    } else {
      try {
        const parsed = JSON.parse(modalText.value) as Settings;
        settings = parsed;
        await save();
        modalBackdrop.style.display = "none";
        renderHeader();
        renderProfiles();
        renderZoneGrid();
        renderOsdStudio();
        renderGlobalPreferences();
        alert("Configuration imported and applied successfully!");
      } catch (e) {
        alert(`Invalid JSON format: ${e}`);
      }
    }
  });

  document.getElementById("reset-btn")?.addEventListener("click", async () => {
    if (!window.__TAURI__?.core) return;
    if (confirm("Reset all settings and zones to default configuration?")) {
      await window.__TAURI__.core.invoke("reset_config");
      loadSettings();
    }
  });

  document.getElementById("g-autostart")?.addEventListener("change", async (e) => {
    if (window.__TAURI__?.core) {
      const enabled = (e.target as HTMLInputElement).checked;
      await window.__TAURI__.core.invoke("set_autostart_enabled", { enabled });
    }
  });

  document.getElementById("open-logs-btn")?.addEventListener("click", async () => {
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("open_logs_folder");
    }
  });

  document.getElementById("panic-now-btn")?.addEventListener("click", async () => {
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("panic_shutdown");
      const panicEl = document.getElementById("panic-banner");
      if (panicEl) panicEl.style.display = "flex";
    }
  });

  document.getElementById("unpanic-btn")?.addEventListener("click", async () => {
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("unpanic");
      const panicEl = document.getElementById("panic-banner");
      if (panicEl) panicEl.style.display = "none";
    }
  });

  // Listen to Tauri events in Settings window
  if (window.__TAURI__?.event) {
    window.__TAURI__.event.listen<boolean>("edit-mode-changed", (evt) => {
      if (settings) {
        settings.edit_mode = evt.payload;
        renderHeader();
      }
    });

    window.__TAURI__.event.listen("settings-updated", async () => {
      if (window.__TAURI__?.core) {
        try {
          settings = await window.__TAURI__.core.invoke<Settings>("get_settings");
          renderHeader();
          renderProfiles();
          renderZoneGrid();
        } catch (e) {
          console.warn("Could not reload settings after update:", e);
        }
      }
    });

    window.__TAURI__.event.listen<[number, boolean]>("volume-synced", (evt) => {
      const [pct, muted] = evt.payload;
      const slider = document.getElementById("live-vol-slider") as HTMLInputElement;
      const label = document.getElementById("live-vol-label");
      const iconBtn = document.getElementById("live-mute-btn");
      if (slider) slider.value = `${pct}`;
      if (label) label.textContent = `${pct}%`;
      if (iconBtn) iconBtn.textContent = getSpeakerIcon(pct, muted);
    });

    window.__TAURI__.event.listen("panic-triggered", () => {
      const panicEl = document.getElementById("panic-banner");
      if (panicEl) panicEl.style.display = "flex";
    });

    window.__TAURI__.event.listen("panic-cleared", () => {
      const panicEl = document.getElementById("panic-banner");
      if (panicEl) panicEl.style.display = "none";
    });
  }

  await loadSettings();
}

/* ==================== INITIALIZATION ==================== */

window.addEventListener("DOMContentLoaded", async () => {
  let label = "settings";
  if (window.__TAURI__?.core) {
    try {
      label = await window.__TAURI__.core.invoke<string>("get_current_window_label");
    } catch (e) {
      console.warn("Could not retrieve window label via IPC:", e);
    }
  }

  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const zoneIdParam = params.get("zone_id");

  if (label === "volzone-osd" || label === "osd" || view === "osd") {
    initOsdView();
  } else if (label.startsWith("zone-") || zoneIdParam) {
    const targetZoneId = label.startsWith("zone-") ? label : zoneIdParam!;
    initZoneOverlay(targetZoneId);
  } else {
    initSettingsView();
  }
});
