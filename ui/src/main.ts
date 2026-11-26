import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

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
  accent_color?: string;
  scale?: number;
  show_percentage?: boolean;
  show_target?: boolean;
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
  autostart_initialized?: boolean;
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
  accent_color?: string;
  scale?: number;
  show_percentage?: boolean;
  show_target?: boolean;
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
      gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.018);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.02);
    }
  } catch {
    // Ignore when WebAudio cannot start
  }
}

/* ==================== 18 OSD THEMES (VOLUME2 & MODERN) ==================== */

const OSD_THEMES: { id: string; name: string; icon: string }[] = [
  { id: "volume2_classic", name: "Volume² Classic", icon: "🎚️" },
  { id: "volume2_vertical", name: "Volume² Tower", icon: "📶" },
  { id: "win11_flyout", name: "Win 11 Flyout", icon: "🪟" },
  { id: "win10_flyout", name: "Win 10 Metro", icon: "⬛" },
  { id: "modern_fluent", name: "Modern Glass", icon: "💎" },
  { id: "compact_pill", name: "Dynamic Pill", icon: "💊" },
  { id: "minimal_line", name: "Slim Line", icon: "➖" },
  { id: "circular_dial", name: "Circle Ring", icon: "🧭" },
  { id: "rotary_knob", name: "Hi-Fi Knob", icon: "🎛️" },
  { id: "equalizer_bars", name: "Equalizer", icon: "📊" },
  { id: "macos_hud", name: "Mac Classic", icon: "🍎" },
  { id: "oled_badge", name: "OLED Corner", icon: "🔳" },
  { id: "cyberpunk", name: "Cyberpunk Neon", icon: "⚡" },
  { id: "retro_pixel", name: "Retro 8-Bit", icon: "👾" },
  { id: "gaming_rgb", name: "Gamer RGB", icon: "🌈" },
  { id: "studio_vu", name: "Studio VU Meter", icon: "📻" },
  { id: "neumorphic", name: "Soft 3D Card", icon: "🔘" },
  { id: "aero_strip", name: "Wave Horizon", icon: "🌊" },
];

const OSD_COLORS = ["#38bdf8", "#6366f1", "#10b981", "#f59e0b", "#f43f5e", "#e2e8f0"];

function getSpeakerIcon(pct: number, muted: boolean): string {
  if (muted || pct === 0) return "🔇";
  if (pct < 33) return "🔈";
  if (pct < 66) return "🔉";
  return "🔊";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface OsdRenderOptions {
  accent?: string;
  showPct?: boolean;
  showTarget?: boolean;
}

function renderOsdHtml(
  theme: string,
  pct: number,
  muted: boolean,
  target: string,
  opts: OsdRenderOptions = {}
): string {
  const icon = getSpeakerIcon(pct, muted);
  const muteBadge = muted ? `<span class="osd-mute-badge">MUTED</span>` : "";
  const showPct = opts.showPct !== false;
  const showTarget = opts.showTarget !== false;
  const accent = opts.accent || "#38bdf8";
  const safeTarget = escapeHtml(target || "Master Volume");
  const pctStr = showPct ? `${pct}%` : "";
  const effectivePct = muted ? 0 : pct;

  const styleAttr = `style="--osd-accent: ${accent};"`;

  switch (theme) {
    case "volume2_classic": {
      const total = 20;
      const onCount = Math.round((effectivePct / 100) * total);
      let ticks = "";
      for (let i = 0; i < total; i++) {
        ticks += `<div class="v2-tick ${i < onCount ? "on" : ""}"></div>`;
      }
      return `
        <div class="osd-volume2-classic" ${styleAttr}>
          <div class="osd-row">
            <span class="osd-icon">${icon}</span>
            <span class="osd-title">${showTarget ? safeTarget : ""}</span>
            ${muteBadge}
            ${showPct ? `<span class="osd-pct">${pctStr}</span>` : ""}
          </div>
          <div class="v2-ticks">${ticks}</div>
        </div>
      `;
    }

    case "volume2_vertical": {
      return `
        <div class="osd-volume2-vertical" ${styleAttr}>
          ${showPct ? `<div class="v2v-pct">${pctStr}</div>` : ""}
          <div class="v2v-track">
            <div class="v2v-fill" style="height: ${effectivePct}%;"></div>
          </div>
          ${muteBadge}
          <div class="v2v-icon">${icon}</div>
        </div>
      `;
    }

    case "win11_flyout": {
      return `
        <div class="osd-win11-flyout" ${styleAttr}>
          <span class="w11-icon">${icon}</span>
          <div class="w11-mid">
            ${showTarget ? `<div class="w11-target">${safeTarget} ${muted ? "• Muted" : ""}</div>` : ""}
            <div class="w11-track">
              <div class="w11-fill" style="width: ${effectivePct}%;"></div>
            </div>
          </div>
          ${showPct ? `<span class="w11-pct">${pct}</span>` : ""}
        </div>
      `;
    }

    case "win10_flyout": {
      return `
        <div class="osd-win10-flyout" ${styleAttr}>
          ${showTarget ? `<div class="w10-top">${safeTarget} ${muted ? "[MUTED]" : ""}</div>` : ""}
          <div class="w10-main">
            <span class="w10-icon">${icon}</span>
            <div class="w10-track">
              <div class="w10-fill" style="width: ${effectivePct}%;"></div>
            </div>
            ${showPct ? `<span class="w10-pct">${pct}</span>` : ""}
          </div>
        </div>
      `;
    }

    case "minimal_line": {
      return `
        <div class="osd-minimal-line" ${styleAttr}>
          <div class="ml-top">
            <span>${icon} ${showTarget ? safeTarget : ""} ${muteBadge}</span>
            ${showPct ? `<strong style="color: var(--osd-accent); font-family: monospace;">${pctStr}</strong>` : ""}
          </div>
          <div class="ml-track">
            <div class="ml-fill" style="width: ${effectivePct}%;"></div>
          </div>
        </div>
      `;
    }

    case "rotary_knob": {
      const circumference = 2 * Math.PI * 58;
      const arcLen = circumference * 0.75; // 270 deg sweep
      const filled = (effectivePct / 100) * arcLen;
      const rotDeg = -135 + (effectivePct / 100) * 270;
      return `
        <div class="osd-rotary-knob" ${styleAttr}>
          <svg viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="58" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="7"
              stroke-dasharray="${arcLen} ${circumference}" stroke-linecap="round"
              transform="rotate(135 70 70)" />
            <circle cx="70" cy="70" r="58" fill="none" stroke="${accent}" stroke-width="7"
              stroke-dasharray="${filled} ${circumference}" stroke-linecap="round"
              transform="rotate(135 70 70)" />
          </svg>
          <div class="rk-inner">
            <div style="width: 4px; height: 10px; background: ${accent}; border-radius: 2px; position: absolute; top: 5px; transform-origin: 50% 34px; transform: rotate(${rotDeg}deg);"></div>
            ${showPct ? `<div class="rk-pct">${pctStr}</div>` : `<div class="rk-pct">${icon}</div>`}
            ${showTarget ? `<div class="rk-sub">${muted ? "MUTED" : safeTarget}</div>` : ""}
          </div>
        </div>
      `;
    }

    case "equalizer_bars": {
      const cols = 12;
      const active = Math.round((effectivePct / 100) * cols);
      let bars = "";
      for (let i = 0; i < cols; i++) {
        const hPct = 28 + Math.round((i / (cols - 1)) * 72);
        bars += `<div class="eq-col ${i < active ? "on" : ""}" style="height: ${hPct}%;"></div>`;
      }
      return `
        <div class="osd-equalizer-bars" ${styleAttr}>
          <div class="eq-head">
            <span>${icon} ${showTarget ? safeTarget : ""}</span>
            <span>${muteBadge} ${showPct ? `<span style="color: var(--osd-accent); font-family: monospace;">${pctStr}</span>` : ""}</span>
          </div>
          <div class="eq-cols">${bars}</div>
        </div>
      `;
    }

    case "oled_badge": {
      return `
        <div class="osd-oled-badge" ${styleAttr}>
          ${muteBadge}
          <div class="ob-num">${showPct ? pct : icon}</div>
          <div class="ob-bar"><div class="ob-fill" style="width: ${effectivePct}%;"></div></div>
          ${showTarget ? `<div class="ob-lbl">${safeTarget}</div>` : ""}
        </div>
      `;
    }

    case "cyberpunk": {
      return `
        <div class="osd-cyberpunk" ${styleAttr}>
          <div class="osd-row">
            <span>${showTarget ? `// ${safeTarget.toUpperCase()}` : "// AUDIO"}</span>
            <span class="osd-pct">${pctStr} ${muteBadge}</span>
          </div>
          <div class="osd-track">
            <div class="osd-fill" style="width: ${effectivePct}%;"></div>
          </div>
        </div>
      `;
    }

    case "macos_hud": {
      const activeDots = Math.round((effectivePct / 100) * 16);
      let dotsHtml = "";
      for (let i = 0; i < 16; i++) {
        dotsHtml += `<div class="osd-dot ${i < activeDots ? "active" : ""}"></div>`;
      }
      return `
        <div class="osd-macos-hud" ${styleAttr}>
          <div class="osd-speaker-big">${muted ? "🔇" : "🔊"}</div>
          <div class="osd-dots">${dotsHtml}</div>
          ${muteBadge}
        </div>
      `;
    }

    case "compact_pill": {
      return `
        <div class="osd-compact-pill" ${styleAttr}>
          <span class="osd-icon">${icon}</span>
          <div class="osd-track">
            <div class="osd-fill" style="width: ${effectivePct}%;"></div>
          </div>
          ${showPct ? `<span class="osd-pct">${pctStr}</span>` : ""}
          ${muteBadge}
        </div>
      `;
    }

    case "circular_dial": {
      const circumference = 2 * Math.PI * 46;
      const offset = circumference - (effectivePct / 100) * circumference;
      return `
        <div class="osd-circular-dial" ${styleAttr}>
          <svg viewBox="0 0 120 120">
            <circle class="dial-bg" cx="60" cy="60" r="46" />
            <circle class="dial-bar" cx="60" cy="60" r="46"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${offset}" />
          </svg>
          <div class="dial-center">
            <div class="dial-icon">${icon}</div>
            ${showPct ? `<div class="dial-pct">${pctStr}</div>` : ""}
            ${muteBadge}
          </div>
        </div>
      `;
    }

    case "retro_pixel": {
      const totalBlocks = 14;
      const activeBlocks = Math.round((effectivePct / 100) * totalBlocks);
      let blocksHtml = "";
      for (let i = 0; i < totalBlocks; i++) {
        blocksHtml += `<div class="osd-block ${i < activeBlocks ? "active" : ""}"></div>`;
      }
      return `
        <div class="osd-retro-pixel" ${styleAttr}>
          <div class="osd-row">
            <span>${showTarget ? `VOL: ${safeTarget}` : "VOL"}</span>
            <span>${pctStr} ${muted ? "[MUTED]" : ""}</span>
          </div>
          <div class="osd-blocks">${blocksHtml}</div>
        </div>
      `;
    }

    case "gaming_rgb": {
      return `
        <div class="osd-gaming-rgb" ${styleAttr}>
          <div class="osd-row">
            <span>⚡ ${showTarget ? safeTarget : "Audio"}</span>
            ${showPct ? `<span style="color: #00eeff; font-family: monospace;">${pctStr}</span>` : ""}
            ${muteBadge}
          </div>
          <div class="osd-track">
            <div class="osd-fill" style="width: ${effectivePct}%;"></div>
          </div>
        </div>
      `;
    }

    case "studio_vu": {
      const totalBars = 20;
      const activeBars = Math.round((effectivePct / 100) * totalBars);
      let barsHtml = "";
      for (let i = 0; i < totalBars; i++) {
        let colorClass = "";
        if (i < activeBars) {
          if (i < 13) colorClass = "active-green";
          else if (i < 17) colorClass = "active-amber";
          else colorClass = "active-red";
        }
        barsHtml += `<div class="vu-bar ${colorClass}"></div>`;
      }
      return `
        <div class="osd-studio-vu" ${styleAttr}>
          <div class="vu-labels">
            <span>-40dB</span><span>-20dB</span><span>-6dB</span><span>0dB</span><span>+6dB</span>
          </div>
          <div class="vu-meter">${barsHtml}</div>
          <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 6px;">
            <span>${showTarget ? safeTarget : ""}</span>
            <span style="font-weight: bold; color: #38bdf8;">${pctStr} ${muteBadge}</span>
          </div>
        </div>
      `;
    }

    case "neumorphic": {
      return `
        <div class="osd-neumorphic" ${styleAttr}>
          <div class="osd-row">
            <span>${showTarget ? safeTarget : "Volume"}</span>
            ${showPct ? `<span style="color: var(--osd-accent); font-family: monospace;">${pctStr}</span>` : ""}
            ${muteBadge}
          </div>
          <div class="osd-track">
            <div class="osd-fill" style="width: ${effectivePct}%;"></div>
          </div>
        </div>
      `;
    }

    case "aero_strip": {
      const waveBars = 16;
      let wavesHtml = "";
      for (let i = 0; i < waveBars; i++) {
        const h = Math.max(3, Math.round(Math.sin((i / waveBars) * Math.PI) * 14 * (effectivePct / 100)));
        wavesHtml += `<div class="osd-wave-bar" style="height: ${h}px;"></div>`;
      }
      return `
        <div class="osd-aero-strip" ${styleAttr}>
          <div class="osd-row">
            <span style="font-size: 13px; font-weight: 600;">${showTarget ? safeTarget : "Volume"}</span>
            <div class="osd-waves">${wavesHtml}</div>
            ${showPct ? `<span style="font-weight: bold; font-family: monospace; color: var(--osd-accent);">${pctStr}</span>` : ""}
            ${muteBadge}
          </div>
          <div style="height: 6px; background: rgba(255,255,255,0.15); border-radius: 999px; overflow: hidden;">
            <div style="width: ${effectivePct}%; height: 100%; background: var(--osd-accent); border-radius: 999px;"></div>
          </div>
        </div>
      `;
    }

    case "modern_fluent":
    default: {
      return `
        <div class="osd-modern-fluent" ${styleAttr}>
          <div class="osd-row">
            <span class="osd-icon">${icon}</span>
            <span class="osd-title">${showTarget ? safeTarget : ""}</span>
            ${muteBadge}
            ${showPct ? `<span class="osd-pct">${pctStr}</span>` : ""}
          </div>
          <div class="osd-track">
            <div class="osd-fill" style="width: ${effectivePct}%;"></div>
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
  let fadeTimer: number | null = null;
  let winHideTimer: number | null = null;
  let idleCloseTimer: number | null = null;

  const displayPayload = (payload: OsdPayload) => {
    const pct = Math.min(100, Math.max(0, Math.round(payload.volume * 100)));
    const theme = payload.theme || "modern_fluent";
    const scale = payload.scale || 1.0;

    root.style.setProperty("--osd-scale", `${scale}`);
    root.innerHTML = renderOsdHtml(theme, pct, payload.muted, payload.target || "Master Volume", {
      accent: payload.accent_color || "#38bdf8",
      showPct: payload.show_percentage !== false,
      showTarget: payload.show_target !== false,
    });
    root.classList.add("visible");

    if (fadeTimer !== null) {
      window.clearTimeout(fadeTimer);
    }
    if (winHideTimer !== null) {
      window.clearTimeout(winHideTimer);
    }
    if (idleCloseTimer !== null) {
      window.clearTimeout(idleCloseTimer);
    }

    const dur = payload.duration_ms || 1200;
    fadeTimer = window.setTimeout(() => {
      root.classList.remove("visible");
      winHideTimer = window.setTimeout(() => {
        invoke("hide_osd_window").catch(() => {});
      }, 240);
    }, dur);

    // Unload idle OSD WebView2 renderer after 20s inactivity to keep background RAM minimal
    idleCloseTimer = window.setTimeout(() => {
      invoke("close_osd_window").catch(() => {});
    }, dur + 20000);
  };

  listen<OsdPayload>("osd-show", (evt) => {
    displayPayload(evt.payload);
  })
    .then(() => {
      invoke<OsdPayload | null>("get_last_osd")
        .then((recent) => {
          if (recent) displayPayload(recent);
        })
        .catch(() => {});
    })
    .catch((err) => {
      console.warn("Failed to listen for OSD events:", err);
    });
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
        <button class="lock-btn" id="lock-btn" title="Finish editing">Done</button>
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
    try {
      currentZone = await invoke<ZoneConfig | null>("get_zone_config", { zoneId });
      isEditMode = await invoke<boolean>("get_edit_mode");
      applyState();
    } catch (err) {
      console.error("Failed to load zone config:", err);
    }
  }

  function applyState() {
    if (!currentZone) return;

    document.body.classList.toggle("edit-mode", isEditMode);

    inX.value = `${currentZone.rect.x}`;
    inY.value = `${currentZone.rect.y}`;
    inW.value = `${currentZone.rect.width}`;
    inH.value = `${currentZone.rect.height}`;

    centerTitle.textContent = `${currentZone.name} (${currentZone.rect.width} × ${currentZone.rect.height})`;

    container.style.setProperty("--zone-opacity", `${currentZone.opacity}`);
    container.className = "";
    container.style.borderRadius = "";

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

  let dragThrottleTimer: number | null = null;
  function throttleUpdateWindowRect(rect: Rect) {
    if (dragThrottleTimer !== null) return;
    dragThrottleTimer = window.setTimeout(async () => {
      dragThrottleTimer = null;
      try {
        await invoke("update_zone_rect", { zoneId, rect });
      } catch (err) {
        console.error("Failed to update zone rect while dragging:", err);
      }
    }, 32);
  }

  async function updateRect(x: number, y: number, w: number, h: number) {
    if (!currentZone) return;
    const snap = 16;
    const snX = Math.abs(x) < snap ? 0 : x;
    const snY = Math.abs(y) < snap ? 0 : y;

    const newRect: Rect = {
      x: Math.round(snX),
      y: Math.round(snY),
      width: Math.max(40, Math.round(w)),
      height: Math.max(20, Math.round(h)),
    };

    currentZone.rect = newRect;
    inX.value = `${newRect.x}`;
    inY.value = `${newRect.y}`;
    inW.value = `${newRect.width}`;
    inH.value = `${newRect.height}`;
    centerTitle.textContent = `${currentZone.name} (${newRect.width} × ${newRect.height})`;

    try {
      await invoke("update_zone_rect", { zoneId, rect: newRect });
    } catch (err) {
      console.error("Failed to update zone rect:", err);
    }
  }

  lockBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await invoke("set_edit_mode", { enabled: false });
    } catch (err) {
      console.error("Failed to exit edit mode:", err);
    }
  });

  const onInputChange = () => {
    updateRect(
      parseInt(inX.value) || 0,
      parseInt(inY.value) || 0,
      parseInt(inW.value) || 50,
      parseInt(inH.value) || 24
    );
  };

  inX.addEventListener("change", onInputChange);
  inY.addEventListener("change", onInputChange);
  inW.addEventListener("change", onInputChange);
  inH.addEventListener("change", onInputChange);

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

    if (activeAction === "move") { x += dx; y += dy; }
    else if (activeAction === "e") { width += dx; }
    else if (activeAction === "w") { x += dx; width -= dx; }
    else if (activeAction === "s") { height += dy; }
    else if (activeAction === "n") { y += dy; height -= dy; }
    else if (activeAction === "se") { width += dx; height += dy; }
    else if (activeAction === "sw") { x += dx; width -= dx; height += dy; }
    else if (activeAction === "ne") { width += dx; y += dy; height -= dy; }
    else if (activeAction === "nw") { x += dx; width -= dx; y += dy; height -= dy; }

    const snap = 16;
    const newRect: Rect = {
      x: Math.round(Math.abs(x) < snap ? 0 : x),
      y: Math.round(Math.abs(y) < snap ? 0 : y),
      width: Math.max(40, Math.round(width)),
      height: Math.max(20, Math.round(height)),
    };

    currentZone.rect = newRect;
    inX.value = `${newRect.x}`;
    inY.value = `${newRect.y}`;
    inW.value = `${newRect.width}`;
    inH.value = `${newRect.height}`;
    centerTitle.textContent = `${currentZone.name} (${newRect.width} × ${newRect.height})`;
    throttleUpdateWindowRect(newRect);
  });

  window.addEventListener("mouseup", async () => {
    if (activeAction && currentZone) {
      activeAction = null;
      document.body.classList.remove("is-dragging");
      if (dragThrottleTimer !== null) {
        window.clearTimeout(dragThrottleTimer);
        dragThrottleTimer = null;
      }
      try {
        await invoke("update_zone_rect", { zoneId, rect: currentZone.rect });
      } catch (err) {
        console.error("Failed to commit final zone rect:", err);
      }
    } else {
      activeAction = null;
      document.body.classList.remove("is-dragging");
    }
  });

  listen<boolean>("edit-mode-changed", (evt) => {
    isEditMode = evt.payload;
    applyState();
  }).catch(() => {});

  listen("settings-updated", () => {
    if (activeAction !== null) return;
    loadConfig();
  }).catch(() => {});

  window.addEventListener(
    "wheel",
    async (e) => {
      e.preventDefault();
      try {
        await invoke("test_volume", { action: e.deltaY < 0 ? "up" : "down", showOsd: true });
      } catch (err) {
        console.warn("Direct overlay wheel invoke failed:", err);
      }
    },
    { passive: false }
  );

  listen<string>("zone-pulse", (evt) => {
    if (
      evt.payload === zoneId ||
      evt.payload === currentZone?.id ||
      evt.payload === currentZone?.id?.replace(/^zone-/, "")
    ) {
      container.classList.add("pulse-active");
      if (pulseTimer !== null) window.clearTimeout(pulseTimer);
      pulseTimer = window.setTimeout(() => container.classList.remove("pulse-active"), 220);
      if (currentZone?.tick_sound) playTickSound();
    }
  }).catch(() => {});

  await loadConfig();
}

/* ============================================================
   COMPACT VOLUME2-STYLE SIDEBAR & TAB SETTINGS UI
   ============================================================ */

async function initSettingsView() {
  document.body.classList.add("settings-view");
  const appEl = document.getElementById("app");
  if (!appEl) return;

  appEl.innerHTML = `
    <div class="v2-shell">
      <!-- Slim Top Bar -->
      <header class="v2-topbar">
        <div class="v2-brand">
          <div class="v2-brand-icon">🔊</div>
          <span class="v2-brand-name">Volume 3</span>
        </div>

        <div class="v2-top-vol" title="Quick Master Volume">
          <button class="vol-icon-btn" id="live-mute-btn" title="Mute / Unmute">🔊</button>
          <input type="range" class="vol-slider" id="live-vol-slider" min="0" max="100" value="50" />
          <span class="vol-label" id="live-vol-label">50%</span>
        </div>

        <div class="v2-top-actions">
          <button class="btn btn-sm" id="top-zones-toggle-btn" title="Turn all scroll areas on or off">Areas: ON</button>
          <button class="edit-mode-pill" id="header-edit-pill" title="Show & drag areas on screen (Ctrl+Alt+V)">
            <span class="pill-dot"></span>
            <span id="header-edit-label">Edit on Screen</span>
          </button>
          <button class="btn btn-sm" id="theme-btn" title="Switch Light / Dark look">☀️</button>
        </div>
      </header>

      <!-- Emergency Stop Banner -->
      <div class="panic-banner" id="panic-banner" style="display: none;">
        <span>⚠️ Scroll control is paused by Emergency Stop.</span>
        <button class="btn btn-sm btn-primary" id="unpanic-btn">Resume Scroll Control</button>
      </div>

      <!-- Volume2 Body: Sidebar + Active Tab -->
      <div class="v2-body">
        <aside class="v2-sidebar">
          <nav class="v2-nav-list">
            <button class="v2-nav-item active" data-tab="overview">
              <span class="v2-nav-icon">🏠</span><span>Quick Start</span>
            </button>
            <button class="v2-nav-item" data-tab="zones">
              <span class="v2-nav-icon">📐</span><span>Scroll Areas</span>
            </button>
            <button class="v2-nav-item" data-tab="osd">
              <span class="v2-nav-icon">🎨</span><span>Volume Popup</span>
            </button>
            <button class="v2-nav-item" data-tab="mixer">
              <span class="v2-nav-icon">🎛️</span><span>Sound Mixer</span>
            </button>
            <button class="v2-nav-item" data-tab="settings">
              <span class="v2-nav-icon">⚙️</span><span>Startup & Rules</span>
            </button>
            <button class="v2-nav-item" data-tab="help">
              <span class="v2-nav-icon">ℹ️</span><span>Status & Help</span>
            </button>
          </nav>

          <div class="v2-sidebar-footer">
            <div class="v2-status-pill">
              <span id="sidebar-zone-status">1 Active Area</span>
              <span class="v2-dot-ok" id="sidebar-hook-dot" title="Hook running"></span>
            </div>
            <div style="font-size: 10px; color: var(--text-muted); text-align: center;">
              Scroll over area = Change sound
            </div>
          </div>
        </aside>

        <main class="v2-main">
          <!-- ==================== TAB 1: QUICK START ==================== -->
          <section class="tab-panel active" id="tab-overview">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Quick Start</h2>
                <p class="panel-subtitle">Choose where on your screen rolling the mouse wheel adjusts sound.</p>
              </div>
              <button class="btn btn-sm btn-primary" id="quick-test-osd-btn">Preview Popup</button>
            </div>

            <!-- 1-Click Location Picker -->
            <div class="card">
              <div class="card-title">1. Pick Your Scroll Spot (One Click)</div>
              <div class="area-selector-grid">
                <button type="button" class="btn-area-select" data-quick-edge="bottom">
                  <span>⊞</span>
                  <div>
                    <span class="area-name">Windows Taskbar (Bottom)</span>
                    <span class="area-desc">Scroll anywhere over taskbar to control volume</span>
                  </div>
                </button>
                <button type="button" class="btn-area-select" data-quick-edge="top">
                  <span>⬆️</span>
                  <div>
                    <span class="area-name">Top Screen Edge</span>
                    <span class="area-desc">Slim strip across the top of your screen</span>
                  </div>
                </button>
                <button type="button" class="btn-area-select" data-quick-edge="left">
                  <span>⬅️</span>
                  <div>
                    <span class="area-name">Left Screen Edge</span>
                    <span class="area-desc">Slim vertical strip along left side</span>
                  </div>
                </button>
                <button type="button" class="btn-area-select" data-quick-edge="right">
                  <span>➡️</span>
                  <div>
                    <span class="area-name">Right Screen Edge</span>
                    <span class="area-desc">Slim vertical strip along right side</span>
                  </div>
                </button>
              </div>
            </div>

            <!-- Essential Easy Switches -->
            <div class="card">
              <div class="card-title">2. Everyday Switches</div>
              <div class="switch-row">
                <div>
                  <span class="switch-label-title">Enable Scroll Volume Control</span>
                  <span class="switch-label-sub">Turn all screen scroll areas on or off</span>
                </div>
                <input type="checkbox" class="toggle-switch" id="q-zones-enabled" checked />
              </div>
              <div class="switch-row">
                <div>
                  <span class="switch-label-title">Start Automatically With Windows</span>
                  <span class="switch-label-sub">Runs quietly in your system tray when PC starts</span>
                </div>
                <input type="checkbox" class="toggle-switch" id="q-autostart" checked />
              </div>
              <div class="switch-row">
                <div>
                  <span class="switch-label-title">Show Volume Popup (OSD)</span>
                  <span class="switch-label-sub">Display visual volume bar when scrolling</span>
                </div>
                <input type="checkbox" class="toggle-switch" id="q-osd-enabled" checked />
              </div>
              <div class="switch-row">
                <div>
                  <span class="switch-label-title">Pause During Fullscreen Games & Videos</span>
                  <span class="switch-label-sub">Prevents accidental changes while gaming or watching movies</span>
                </div>
                <input type="checkbox" class="toggle-switch" id="q-fullscreen" checked />
              </div>
            </div>

            <!-- Live Wheel Test Pad -->
            <div class="wheel-test-card" id="wheel-test-box">
              <div class="wheel-test-header">
                <span style="font-size: 22px;">🖱️</span>
                <div style="flex: 1;">
                  <div style="font-weight: 700; font-size: 12.5px;">3. Test Mouse Wheel Right Here</div>
                  <div style="font-size: 11px; color: var(--text-secondary);">Put your mouse here and spin the wheel up or down</div>
                </div>
                <div class="test-vol-number" id="test-vol-display">50%</div>
              </div>
              <div class="wheel-test-meter-track">
                <div class="wheel-test-meter-fill" id="test-meter-fill" style="width: 50%;"></div>
              </div>
              <div class="wheel-test-hint" id="test-wheel-hint">↕️ Waiting for mouse wheel...</div>
            </div>
          </section>

          <!-- ==================== TAB 2: SCROLL AREAS ==================== -->
          <section class="tab-panel" id="tab-zones">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Scroll Areas</h2>
                <p class="panel-subtitle">Manage screen zones, size, taskbar snap, and scroll feel.</p>
              </div>
              <div style="display: flex; gap: 6px;">
                <button class="btn btn-sm btn-primary" id="add-zone-btn">+ New Area</button>
                <button class="btn btn-sm" id="dup-zone-btn">Copy</button>
                <button class="btn btn-sm btn-danger" id="del-zone-btn">Delete</button>
              </div>
            </div>

            <!-- Compact Zone Selector Strip -->
            <div class="card" style="padding: 10px 12px;">
              <div class="zone-pills-row" id="zone-pills-container"></div>
            </div>

            <!-- Selected Area Editor -->
            <div class="card" id="zone-inspector" style="display: none;">
              <div class="card-title" style="margin-bottom: 10px;">
                <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
                  <input type="text" class="form-control" id="z-name" style="max-width: 210px; font-weight: 700;" placeholder="Area Name" />
                  <span class="badge-active-edge" id="active-edge-badge" style="font-size: 10px;">Bottom</span>
                </div>
                <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;">
                  <span>Active</span>
                  <input type="checkbox" class="toggle-switch" id="z-enabled" />
                </label>
              </div>

              <!-- Sub-Tabs inside Area Editor -->
              <div class="subtab-bar">
                <button type="button" class="subtab-btn active" data-ztab="place">Where & Size</button>
                <button type="button" class="subtab-btn" data-ztab="sound">Scroll & Sound</button>
                <button type="button" class="subtab-btn" data-ztab="look">Look & Limits</button>
              </div>

              <!-- Sub-tab 1: Where & Size -->
              <div class="subtab-pane active" id="ztab-place">
                <div class="screen-visualizer-container">
                  <div class="mini-monitor">
                    <div class="mini-screen-bezel">
                      <div class="mini-zone-edge edge-top" data-target-edge="top">Top Bar</div>
                      <div class="mini-screen-middle">
                        <div class="mini-zone-edge edge-left" data-target-edge="left">Left</div>
                        <div class="mini-zone-center" data-target-edge="center">Float</div>
                        <div class="mini-zone-edge edge-right" data-target-edge="right">Right</div>
                      </div>
                      <div class="mini-zone-edge edge-bottom" data-target-edge="bottom">⊞ Taskbar</div>
                    </div>
                    <div class="mini-stand"></div>
                  </div>

                  <div class="area-buttons-column">
                    <div class="area-selector-grid">
                      <button type="button" class="btn-area-select" data-edge="bottom">
                        <span>⊞</span><div><span class="area-name">Windows Taskbar</span><span class="area-desc">Bottom edge</span></div>
                      </button>
                      <button type="button" class="btn-area-select" data-edge="top">
                        <span>⬆️</span><div><span class="area-name">Top Bar</span><span class="area-desc">Top edge</span></div>
                      </button>
                      <button type="button" class="btn-area-select" data-edge="left">
                        <span>⬅️</span><div><span class="area-name">Left Edge</span><span class="area-desc">Left strip</span></div>
                      </button>
                      <button type="button" class="btn-area-select" data-edge="right">
                        <span>➡️</span><div><span class="area-name">Right Edge</span><span class="area-desc">Right strip</span></div>
                      </button>
                      <button type="button" class="btn-area-select" data-edge="center" style="grid-column: 1 / span 2;">
                        <span>🔲</span><div><span class="area-name">Custom Floating Box</span><span class="area-desc">Place anywhere on screen</span></div>
                      </button>
                    </div>
                  </div>
                </div>

                <div class="dimension-sliders-box">
                  <div style="margin-bottom: 10px;">
                    <div class="slider-header">
                      <label>Height / Thickness: <strong id="height-val-display" style="color: var(--accent);">40px</strong></label>
                      <input type="number" class="form-control number-compact" id="z-h" min="10" max="600" />
                    </div>
                    <input type="range" class="vol-slider" style="width: 100%;" id="z-height-slider" min="12" max="140" />
                    <div class="quick-chips-row">
                      <span class="quick-chip" data-set-height="48">Win 11 Taskbar (48px)</span>
                      <span class="quick-chip" data-set-height="40">Win 10 Taskbar (40px)</span>
                      <span class="quick-chip" data-set-height="24">Slim (24px)</span>
                      <span class="quick-chip" data-set-height="64">Tall (64px)</span>
                    </div>
                  </div>

                  <div>
                    <div class="slider-header">
                      <label>Width / Length: <strong id="width-val-display" style="color: var(--accent);">100%</strong></label>
                      <input type="number" class="form-control number-compact" id="z-w" min="40" max="7680" />
                    </div>
                    <input type="range" class="vol-slider" style="width: 100%;" id="z-width-slider" min="100" max="1920" />
                    <div class="quick-chips-row">
                      <span class="quick-chip" data-set-width="full">Full Width (100%)</span>
                      <span class="quick-chip" data-set-width="half">Half (50%)</span>
                      <span class="quick-chip" data-set-width="600">Medium (600px)</span>
                      <span class="quick-chip" data-set-width="380">Small (380px)</span>
                    </div>
                  </div>

                  <div style="margin-top: 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                    <span style="font-size: 11px; color: var(--text-secondary);">Position:</span>
                    <span style="font-size: 11px;">X</span>
                    <input type="number" class="form-control number-compact" id="z-x" style="width: 60px;" />
                    <span style="font-size: 11px;">Y</span>
                    <input type="number" class="form-control number-compact" id="z-y" style="width: 60px;" />
                    <button type="button" class="btn btn-sm" id="recenter-btn">Center</button>
                    <button type="button" class="btn btn-sm btn-primary" id="z-drag-screen-btn">Drag on Screen</button>
                  </div>
                </div>
              </div>

              <!-- Sub-tab 2: Scroll & Sound -->
              <div class="subtab-pane" id="ztab-sound">
                <div class="form-row">
                  <div class="form-group">
                    <label>What Should This Area Control?</label>
                    <select class="form-control" id="z-target">
                      <option value="master">All Computer Sound (Master)</option>
                      <option value="mic">Microphone Volume</option>
                      <option value="app_under_cursor">App Under Mouse Pointer</option>
                      <option value="app">A Specific App</option>
                    </select>
                  </div>
                  <div class="form-group" id="app-select-group" style="display: none;">
                    <label>Choose App</label>
                    <select class="form-control" id="z-app-target"></select>
                  </div>
                  <div class="form-group">
                    <label>Volume Change Per Scroll (<span id="step-val" style="color: var(--accent);">2%</span>)</label>
                    <input type="range" class="vol-slider" style="width: 100%; margin-top: 8px;" id="z-step" min="1" max="15" value="2" />
                  </div>
                </div>

                <div class="switch-row">
                  <div>
                    <span class="switch-label-title">Middle-Click to Mute / Unmute</span>
                    <span class="switch-label-sub">Press the scroll wheel button inside this area to mute</span>
                  </div>
                  <input type="checkbox" class="toggle-switch" id="z-middle-mute" />
                </div>
                <div class="switch-row">
                  <div>
                    <span class="switch-label-title">Speed Boost When Scrolling Fast</span>
                    <span class="switch-label-sub">Spin quickly to jump larger volume steps</span>
                  </div>
                  <input type="checkbox" class="toggle-switch" id="z-accel" />
                </div>
                <div class="switch-row">
                  <div>
                    <span class="switch-label-title">Flip Scroll Direction</span>
                    <span class="switch-label-sub">Swap scroll up and scroll down</span>
                  </div>
                  <input type="checkbox" class="toggle-switch" id="z-invert" />
                </div>

                <div class="form-row" style="margin-top: 10px; margin-bottom: 0;">
                  <div class="form-group">
                    <label>Side-Wheel Tilt Action</label>
                    <select class="form-control" id="z-horiz-action">
                      <option value="none">Do Nothing</option>
                      <option value="media_track">Next / Previous Song</option>
                      <option value="balance">Audio Left/Right Balance</option>
                    </select>
                  </div>
                  <div class="form-group">
                    <label>Fast Scroll Hold Key (2.5x)</label>
                    <select class="form-control" id="z-coarse-mod">
                      <option value="shift">Shift</option>
                      <option value="ctrl">Ctrl</option>
                      <option value="alt">Alt</option>
                      <option value="none">None</option>
                    </select>
                  </div>
                  <div class="form-group">
                    <label>Slow Precise Hold Key (0.25x)</label>
                    <select class="form-control" id="z-fine-mod">
                      <option value="ctrl">Ctrl</option>
                      <option value="shift">Shift</option>
                      <option value="alt">Alt</option>
                      <option value="none">None</option>
                    </select>
                  </div>
                </div>
              </div>

              <!-- Sub-tab 3: Look & Safety Limits -->
              <div class="subtab-pane" id="ztab-look">
                <div class="form-row">
                  <div class="form-group">
                    <label>How This Area Looks</label>
                    <select class="form-control" id="z-mode">
                      <option value="invisible">Completely Invisible</option>
                      <option value="faint_tint">Light Transparent Tint</option>
                      <option value="outline_on_hover">Show Border on Mouse Hover</option>
                      <option value="always_visible">Always Visible</option>
                    </select>
                  </div>
                  <div class="form-group">
                    <label>Visibility Strength (<span id="opacity-val">25%</span>)</label>
                    <input type="range" class="vol-slider" style="width: 100%; margin-top: 8px;" id="z-opacity" min="0" max="100" value="25" />
                  </div>
                </div>

                <div class="form-row">
                  <div class="form-group">
                    <label>Shape</label>
                    <select class="form-control" id="z-shape">
                      <option value="rectangle">Rectangle (Best for Bars)</option>
                      <option value="rounded">Rounded Corners</option>
                      <option value="circle">Circle</option>
                      <option value="screen_edge_strip">Screen Edge Strip</option>
                    </select>
                  </div>
                  <div class="form-group" id="radius-group" style="display: none;">
                    <label>Corner Roundness (px)</label>
                    <input type="number" class="form-control" id="z-radius" min="2" max="100" value="12" />
                  </div>
                  <div class="form-group" id="strip-group" style="display: none;">
                    <label>Pinned Edge</label>
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
                    <label>Lowest Allowed Volume (<span id="min-vol-val">0%</span>)</label>
                    <input type="range" class="vol-slider" style="width: 100%;" id="z-min-vol" min="0" max="100" value="0" />
                  </div>
                  <div class="form-group">
                    <label>Highest Allowed Volume (<span id="max-vol-val">100%</span>)</label>
                    <input type="range" class="vol-slider" style="width: 100%;" id="z-max-vol" min="0" max="100" value="100" />
                  </div>
                  <div class="form-group">
                    <label>Prevent Sudden Loud Jumps</label>
                    <select class="form-control" id="z-soft-start">
                      <option value="none">No Limit</option>
                      <option value="0.05">Max 5% jump at once</option>
                      <option value="0.08">Max 8% jump at once</option>
                      <option value="0.10">Max 10% jump at once</option>
                      <option value="0.15">Max 15% jump at once</option>
                    </select>
                  </div>
                </div>

                <div class="switch-row">
                  <span class="switch-label-title">Flash Area Light When Scrolling</span>
                  <input type="checkbox" class="toggle-switch" id="z-pulse-tint" />
                </div>
                <div class="switch-row">
                  <span class="switch-label-title">Play Gentle Click Sound on Scroll</span>
                  <input type="checkbox" class="toggle-switch" id="z-tick-sound" />
                </div>
              </div>
            </div>
          </section>

          <!-- ==================== TAB 3: VOLUME POPUP (OSD) ==================== -->
          <section class="tab-panel" id="tab-osd">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Volume Popup (OSD)</h2>
                <p class="panel-subtitle">Choose from 18 styles, screen position, colors, and size.</p>
              </div>
              <button class="btn btn-sm btn-primary" id="test-osd-btn">🚀 Show on Screen Now</button>
            </div>

            <!-- Live Preview -->
            <div class="osd-live-preview-box" id="osd-live-preview"></div>

            <!-- Theme Gallery -->
            <div class="card">
              <div class="card-title">
                <span>18 Popup Designs</span>
                <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;">
                  <span>Popup On</span>
                  <input type="checkbox" class="toggle-switch" id="g-osd" />
                </label>
              </div>
              <div class="osd-themes-grid" id="osd-themes-grid"></div>
            </div>

            <!-- Position, Color & Options -->
            <div class="card">
              <div class="grid-2" style="align-items: start; gap: 14px;">
                <div>
                  <label style="font-size: 12px; font-weight: 700; display: block; margin-bottom: 6px;">
                    Screen Position: <span id="pos-label" style="color: var(--accent);">TOP CENTER</span>
                  </label>
                  <div class="position-matrix" id="pos-matrix">
                    <button class="pos-btn" data-pos="top_left" title="Top Left">TL</button>
                    <button class="pos-btn" data-pos="top_center" title="Top Center">TC</button>
                    <button class="pos-btn" data-pos="top_right" title="Top Right">TR</button>
                    <button class="pos-btn" data-pos="near_cursor" style="grid-column: 1 / span 3;">Near Mouse Pointer</button>
                    <button class="pos-btn" data-pos="center" style="grid-column: 1 / span 3;">Screen Center</button>
                    <button class="pos-btn" data-pos="bottom_left" title="Bottom Left">BL</button>
                    <button class="pos-btn" data-pos="bottom_center" title="Bottom Center">BC</button>
                    <button class="pos-btn" data-pos="bottom_right" title="Bottom Right">BR</button>
                  </div>
                </div>

                <div style="display: flex; flex-direction: column; gap: 9px;">
                  <div>
                    <label style="font-size: 11.5px; font-weight: 600; display: block; margin-bottom: 5px;">Accent Color</label>
                    <div class="color-swatches" id="osd-color-swatches"></div>
                  </div>
                  <div>
                    <label style="font-size: 11.5px; font-weight: 600; display: block; margin-bottom: 3px;">
                      Stay Visible Time: <strong id="osd-dur-val" style="color: var(--accent);">1.2 sec</strong>
                    </label>
                    <input type="range" class="vol-slider" style="width: 100%;" id="g-osd-dur" min="400" max="4000" step="100" value="1200" />
                  </div>
                  <div>
                    <label style="font-size: 11.5px; font-weight: 600; display: block; margin-bottom: 3px;">Popup Size</label>
                    <select class="form-control" id="g-osd-scale">
                      <option value="0.85">Compact (85%)</option>
                      <option value="1">Normal (100%)</option>
                      <option value="1.2">Large (120%)</option>
                    </select>
                  </div>
                </div>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-subtle);">
                <label style="display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: pointer;">
                  <input type="checkbox" id="g-osd-hide-fullscreen" /> Hide in Fullscreen Apps
                </label>
                <label style="display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: pointer;">
                  <input type="checkbox" id="g-osd-show-target" /> Show Device/Area Name
                </label>
                <label style="display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: pointer;">
                  <input type="checkbox" id="g-osd-show-pct" /> Show Percentage Number
                </label>
              </div>
            </div>
          </section>

          <!-- ==================== TAB 4: SOUND MIXER ==================== -->
          <section class="tab-panel" id="tab-mixer">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Sound Mixer</h2>
                <p class="panel-subtitle">Control speakers, microphone, individual apps, and night limit.</p>
              </div>
              <button class="btn btn-sm" id="refresh-mixer-btn">🔄 Refresh Apps</button>
            </div>

            <!-- Master & Mic -->
            <div class="card">
              <div class="card-title">System Audio & Microphone</div>
              <div class="mixer-row">
                <span class="mixer-app-name">🔊 Main Speakers</span>
                <button class="btn btn-sm" id="mixer-master-mute">Mute</button>
                <input type="range" class="vol-slider" id="mixer-master-slider" min="0" max="100" value="50" />
                <span class="vol-label" id="mixer-master-pct">50%</span>
              </div>
              <div class="mixer-row" style="margin-bottom: 0;">
                <span class="mixer-app-name">🎙️ Microphone</span>
                <button class="btn btn-sm" id="mixer-mic-mute">Mute</button>
                <input type="range" class="vol-slider" id="mixer-mic-slider" min="0" max="100" value="100" />
                <span class="vol-label" id="mixer-mic-pct">100%</span>
              </div>
            </div>

            <!-- Active Apps -->
            <div class="card">
              <div class="card-title">Running Audio Apps</div>
              <div id="mixer-apps-list">
                <div style="font-size: 12px; color: var(--text-secondary);">Loading running audio apps...</div>
              </div>
            </div>

            <!-- Night Quiet Hours -->
            <div class="card">
              <div class="card-title">
                <span>Night Quiet Mode</span>
                <input type="checkbox" class="toggle-switch" id="night-enable" />
              </div>
              <p style="font-size: 11.5px; color: var(--text-secondary); margin: 0 0 10px 0;">
                Keep volume from getting too loud late at night while scrolling.
              </p>
              <div class="form-row" style="margin-bottom: 0;">
                <div class="form-group">
                  <label>Start Time (24-Hour)</label>
                  <input type="number" class="form-control" id="night-start" min="0" max="23" value="22" />
                </div>
                <div class="form-group">
                  <label>End Time (24-Hour)</label>
                  <input type="number" class="form-control" id="night-end" min="0" max="23" value="7" />
                </div>
                <div class="form-group">
                  <label>Maximum Allowed (<span id="night-cap-val" style="color: var(--accent);">30%</span>)</label>
                  <input type="range" class="vol-slider" style="width: 100%; margin-top: 8px;" id="night-cap" min="5" max="100" value="30" />
                </div>
              </div>
            </div>
          </section>

          <!-- ==================== TAB 5: STARTUP & RULES ==================== -->
          <section class="tab-panel" id="tab-settings">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Startup & Rules</h2>
                <p class="panel-subtitle">Auto-start behavior, saved layouts, backups, and safety.</p>
              </div>
            </div>

            <!-- Auto-Start -->
            <div class="card">
              <div class="card-title">
                <span>Windows Auto-Start</span>
                <span id="autostart-badge" class="zone-pill" style="font-size: 10.5px; padding: 2px 8px;">Checking...</span>
              </div>
              <div class="switch-row">
                <div>
                  <span class="switch-label-title">Start Volume 3 Automatically When PC Turns On</span>
                  <span class="switch-label-sub">Starts quietly in the taskbar tray (with no window popup)</span>
                </div>
                <input type="checkbox" class="toggle-switch" id="g-autostart" />
              </div>
              <div class="switch-row">
                <div>
                  <span class="switch-label-title">Pause Scroll Areas During Fullscreen Games / Videos</span>
                  <span class="switch-label-sub">Normal mouse wheel behavior returns automatically in fullscreen</span>
                </div>
                <input type="checkbox" class="toggle-switch" id="g-fullscreen-disable" />
              </div>
            </div>

            <!-- Saved Setups (Profiles) -->
            <div class="card">
              <div class="card-title">
                <span>Saved Area Layouts (Profiles)</span>
                <button class="btn btn-sm" id="save-new-profile-btn">+ Save Current Layout</button>
              </div>
              <div style="display: flex; gap: 8px; align-items: center;">
                <select class="form-control" id="profile-select" style="flex: 1;"></select>
                <button class="btn btn-sm btn-danger" id="delete-profile-btn">Delete</button>
              </div>
            </div>

            <!-- Backup & Reset -->
            <div class="card">
              <div class="card-title">Backup & Tools</div>
              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button class="btn btn-sm" id="export-btn">Export Backup</button>
                <button class="btn btn-sm" id="import-btn">Restore Backup</button>
                <button class="btn btn-sm" id="open-logs-btn">Open Log Folder</button>
                <button class="btn btn-sm btn-danger" id="panic-now-btn">Emergency Stop Hooks</button>
                <button class="btn btn-sm btn-danger" id="reset-btn">Reset Everything</button>
              </div>
            </div>
          </section>

          <!-- ==================== TAB 6: STATUS & HELP ==================== -->
          <section class="tab-panel" id="tab-help">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Status & Easy Guide</h2>
                <p class="panel-subtitle">Everything you need to know at a glance.</p>
              </div>
            </div>

            <div class="card">
              <div class="card-title">How Volume 3 Works (3 Simple Steps)</div>
              <div style="font-size: 12.5px; color: var(--text-secondary); line-height: 1.65;">
                1. Go to <strong>Quick Start</strong> and pick <strong>Windows Taskbar</strong> (or any screen edge).<br/>
                2. Move your mouse cursor onto that taskbar or screen edge.<br/>
                3. Roll your mouse wheel <strong>Up</strong> or <strong>Down</strong> to raise or lower sound — normal clicks still pass right through to Windows!
              </div>
            </div>

            <div class="card">
              <div class="card-title">System Check</div>
              <div class="switch-row">
                <span class="switch-label-title">Mouse Wheel Detector</span>
                <span id="status-hook-text" style="font-size: 12px; font-weight: 700; color: #10b981;">Active</span>
              </div>
              <div class="switch-row">
                <span class="switch-label-title">Auto-Start at Login</span>
                <span id="status-auto-text" style="font-size: 12px; font-weight: 700;">Checking...</span>
              </div>
              <div class="switch-row">
                <span class="switch-label-title">Administrator Mode</span>
                <span id="status-admin-text" style="font-size: 12px; font-weight: 700;">Checking...</span>
              </div>
            </div>

            <div class="card">
              <div class="card-title">Helpful Keyboard Shortcuts</div>
              <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.7;">
                • <code>Ctrl + Alt + V</code> — Show or hide scroll areas on screen for dragging.<br/>
                • <code>Ctrl + Alt + Shift + Esc</code> — Emergency Stop (instantly turns off mouse hooks).<br/>
                • Closing this window hides Volume 3 safely in the taskbar tray (right-click tray icon to Quit).
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>

    <!-- Backup Import/Export Modal -->
    <div id="modal-backdrop" class="modal-backdrop" style="display: none;">
      <div class="modal-content">
        <h3 id="modal-title" style="margin: 0 0 10px 0; font-size: 15px;">Backup JSON</h3>
        <textarea id="modal-text"></textarea>
        <div class="modal-footer">
          <button class="btn btn-sm" id="modal-close-btn">Cancel</button>
          <button class="btn btn-sm btn-primary" id="modal-action-btn">Apply</button>
        </div>
      </div>
    </div>
  `;

  let settings: Settings | null = null;
  let selectedZoneIndex = 0;
  let audioApps: AppAudioSession[] = [];

  // Sidebar Tab Switching
  document.querySelectorAll(".v2-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = (btn as HTMLElement).dataset.tab;
      if (!tab) return;
      document.querySelectorAll(".v2-nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      document.getElementById(`tab-${tab}`)?.classList.add("active");

      if (tab === "mixer") refreshMixer();
      if (tab === "help") refreshSystemCheck();
    });
  });

  // Scroll Areas Sub-tabs Switching
  document.querySelectorAll("[data-ztab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = (btn as HTMLElement).dataset.ztab;
      document.querySelectorAll("[data-ztab]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".subtab-pane").forEach((p) => p.classList.remove("active"));
      document.getElementById(`ztab-${target}`)?.classList.add("active");
    });
  });

  async function syncAutostartUI() {
    try {
      const autoOn = await invoke<boolean>("is_autostart_enabled");
      const autoEl = document.getElementById("g-autostart") as HTMLInputElement | null;
      const quickAuto = document.getElementById("q-autostart") as HTMLInputElement | null;
      const badge = document.getElementById("autostart-badge");
      const statusText = document.getElementById("status-auto-text");

      if (autoEl) autoEl.checked = autoOn;
      if (quickAuto) quickAuto.checked = autoOn;
      if (badge) {
        badge.textContent = autoOn ? "Enabled (On Login)" : "Off";
        badge.style.color = autoOn ? "#10b981" : "var(--text-secondary)";
      }
      if (statusText) {
        statusText.textContent = autoOn ? "Enabled" : "Disabled";
        statusText.style.color = autoOn ? "#10b981" : "#f59e0b";
      }
    } catch {}
  }

  async function ensureAudioAppsLoaded() {
    if (audioApps.length > 0) return;
    try {
      audioApps = await invoke<AppAudioSession[]>("list_audio_apps");
    } catch {
      audioApps = [];
    }
  }

  async function loadSettings() {
    try {
      settings = await invoke<Settings>("get_settings");
      if (selectedZoneIndex >= settings.zones.length) {
        selectedZoneIndex = Math.max(0, settings.zones.length - 1);
      }
      if (settings.zones.some((z) => z.target.kind === "app")) {
        await ensureAudioAppsLoaded();
      }

      renderHeader();
      renderQuickStart();
      renderProfiles();
      renderZonePills();
      renderInspector();
      renderOsdStudio();
      renderGlobalPreferences();
      updateVolumePreview();
      syncAutostartUI();
      refreshSystemCheck();
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }

  async function save() {
    if (!settings) return;
    const activeProf = settings.profiles.find((p) => p.id === settings!.active_profile_id);
    if (activeProf) {
      activeProf.zones = JSON.parse(JSON.stringify(settings.zones));
    }
    try {
      await invoke("save_settings", { newSettings: settings });
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
    renderHeader();
    renderQuickStart();
  }

  function renderHeader() {
    if (!settings) return;
    const editPill = document.getElementById("header-edit-pill");
    const editLabel = document.getElementById("header-edit-label");
    const topZonesBtn = document.getElementById("top-zones-toggle-btn");
    const sidebarStatus = document.getElementById("sidebar-zone-status");

    const enabledCount = settings.zones.filter((z) => z.enabled).length;

    if (editPill && editLabel) {
      editPill.classList.toggle("active", settings.edit_mode);
      editLabel.textContent = settings.edit_mode ? "Done Editing" : "Edit on Screen";
    }
    if (topZonesBtn) {
      topZonesBtn.textContent = enabledCount > 0 ? "Areas: ON" : "Areas: OFF";
      topZonesBtn.style.color = enabledCount > 0 ? "#10b981" : "#f59e0b";
    }
    if (sidebarStatus) {
      sidebarStatus.textContent =
        enabledCount === 1 ? "1 Active Area" : `${enabledCount} Active Areas`;
    }
  }

  function detectEdge(z: ZoneConfig): string {
    const screenW = window.screen.width || 1366;
    const screenH = window.screen.height || 768;
    if (z.rect.y >= screenH - 120 && z.rect.width >= screenW * 0.7) return "bottom";
    if (z.rect.y <= 40 && z.rect.width >= screenW * 0.7) return "top";
    if (z.rect.x <= 40 && z.rect.height >= screenH * 0.7) return "left";
    if (z.rect.x >= screenW - 120 && z.rect.height >= screenH * 0.7) return "right";
    return "center";
  }

  function renderQuickStart() {
    if (!settings) return;
    const anyOn = settings.zones.some((z) => z.enabled);
    const qZones = document.getElementById("q-zones-enabled") as HTMLInputElement | null;
    const qOsd = document.getElementById("q-osd-enabled") as HTMLInputElement | null;
    const qFs = document.getElementById("q-fullscreen") as HTMLInputElement | null;

    if (qZones) qZones.checked = anyOn;
    if (qOsd) qOsd.checked = settings.osd?.enabled ?? true;
    if (qFs) qFs.checked = settings.fullscreen_rule?.disable_in_fullscreen ?? true;

    const firstZone = settings.zones[selectedZoneIndex] || settings.zones[0];
    const activeEdge = firstZone ? detectEdge(firstZone) : "";
    document.querySelectorAll("[data-quick-edge]").forEach((btn) => {
      const edge = (btn as HTMLElement).dataset.quickEdge;
      btn.classList.toggle("active", edge === activeEdge);
    });
  }

  async function updateVolumePreview() {
    try {
      const vol = await invoke<number>("get_master_volume");
      const muted = await invoke<boolean>("get_master_mute");
      const pct = Math.round(vol * 100);
      const icon = getSpeakerIcon(pct, muted);

      const slider = document.getElementById("live-vol-slider") as HTMLInputElement | null;
      const label = document.getElementById("live-vol-label");
      const iconBtn = document.getElementById("live-mute-btn");
      if (slider) slider.value = `${pct}`;
      if (label) label.textContent = `${pct}%`;
      if (iconBtn) iconBtn.textContent = icon;

      const testDisp = document.getElementById("test-vol-display");
      const testFill = document.getElementById("test-meter-fill");
      if (testDisp) testDisp.textContent = `${pct}%`;
      if (testFill) testFill.style.width = `${pct}%`;
    } catch {}
  }

  function renderProfiles() {
    const sel = document.getElementById("profile-select") as HTMLSelectElement | null;
    if (!settings || !sel) return;
    sel.innerHTML = "";
    if (settings.profiles.length === 0) {
      settings.profiles = [
        { id: "default", name: "Default Layout", zones: JSON.parse(JSON.stringify(settings.zones)) },
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

  function renderZonePills() {
    const container = document.getElementById("zone-pills-container");
    if (!settings || !container) return;
    container.innerHTML = "";

    if (settings.zones.length === 0) {
      container.innerHTML = `<span style="font-size: 12px; color: var(--text-secondary);">No scroll areas yet. Click "+ New Area" above.</span>`;
      return;
    }

    settings.zones.forEach((z, idx) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `zone-pill ${idx === selectedZoneIndex ? "selected" : ""}`;
      pill.innerHTML = `<span class="dot ${z.enabled ? "on" : ""}"></span><span>${escapeHtml(z.name)}</span>`;
      pill.addEventListener("click", () => {
        selectedZoneIndex = idx;
        renderZonePills();
        renderInspector();
      });
      container.appendChild(pill);
    });
  }

  function renderInspector() {
    const inspector = document.getElementById("zone-inspector")!;
    if (!settings || settings.zones.length === 0 || !settings.zones[selectedZoneIndex]) {
      inspector.style.display = "none";
      return;
    }

    const z = settings.zones[selectedZoneIndex];
    inspector.style.display = "block";

    (document.getElementById("z-name") as HTMLInputElement).value = z.name;
    (document.getElementById("z-enabled") as HTMLInputElement).checked = z.enabled;

    const targetSel = document.getElementById("z-target") as HTMLSelectElement;
    const appGroup = document.getElementById("app-select-group")!;
    const appSel = document.getElementById("z-app-target") as HTMLSelectElement;

    targetSel.value = z.target.kind;
    if (z.target.kind === "app") {
      appGroup.style.display = "block";
      appSel.innerHTML = "";
      if (audioApps.length === 0) {
        ensureAudioAppsLoaded().then(() => {
          if (audioApps.length > 0 && settings?.zones[selectedZoneIndex]?.id === z.id) {
            renderInspector();
          }
        });
      }
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

    (document.getElementById("z-x") as HTMLInputElement).value = `${z.rect.x}`;
    (document.getElementById("z-y") as HTMLInputElement).value = `${z.rect.y}`;
    (document.getElementById("z-w") as HTMLInputElement).value = `${z.rect.width}`;
    (document.getElementById("z-h") as HTMLInputElement).value = `${z.rect.height}`;

    const screenW = window.screen.width || 1366;
    const currentEdge = detectEdge(z);

    const badge = document.getElementById("active-edge-badge");
    if (badge) {
      badge.textContent =
        currentEdge === "bottom" ? "Taskbar (Bottom)"
        : currentEdge === "top" ? "Top Bar"
        : currentEdge === "left" ? "Left Strip"
        : currentEdge === "right" ? "Right Strip"
        : "Floating";
    }

    document.querySelectorAll(".mini-zone-edge, .mini-zone-center").forEach((el) => {
      el.classList.toggle("active", (el as HTMLElement).dataset.targetEdge === currentEdge);
    });
    document.querySelectorAll(".btn-area-select[data-edge]").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.edge === currentEdge);
    });

    const hSlider = document.getElementById("z-height-slider") as HTMLInputElement;
    if (hSlider) hSlider.value = `${Math.min(140, Math.max(12, z.rect.height))}`;
    document.getElementById("height-val-display")!.textContent = `${z.rect.height}px`;

    const wSlider = document.getElementById("z-width-slider") as HTMLInputElement;
    if (wSlider) {
      wSlider.max = `${screenW}`;
      wSlider.value = `${Math.min(screenW, Math.max(100, z.rect.width))}`;
    }
    document.getElementById("width-val-display")!.textContent =
      z.rect.width >= screenW - 10 ? "100% (Full Width)" : `${z.rect.width}px`;

    (document.getElementById("z-shape") as HTMLSelectElement).value = z.shape.type;
    document.getElementById("radius-group")!.style.display = z.shape.type === "rounded" ? "block" : "none";
    document.getElementById("strip-group")!.style.display = z.shape.type === "screen_edge_strip" ? "block" : "none";
    if (z.shape.radius) (document.getElementById("z-radius") as HTMLInputElement).value = `${z.shape.radius}`;
    if (z.shape.edge) (document.getElementById("z-edge") as HTMLSelectElement).value = z.shape.edge;

    (document.getElementById("z-mode") as HTMLSelectElement).value = z.visual_mode;
    (document.getElementById("z-opacity") as HTMLInputElement).value = `${Math.round(z.opacity * 100)}`;
    document.getElementById("opacity-val")!.textContent = `${Math.round(z.opacity * 100)}%`;

    (document.getElementById("z-step") as HTMLInputElement).value = `${Math.round(z.step)}`;
    document.getElementById("step-val")!.textContent = `${Math.round(z.step)}%`;
    (document.getElementById("z-horiz-action") as HTMLSelectElement).value = z.horizontal_action || "none";

    (document.getElementById("z-min-vol") as HTMLInputElement).value = `${Math.round((z.min_volume ?? 0) * 100)}`;
    document.getElementById("min-vol-val")!.textContent = `${Math.round((z.min_volume ?? 0) * 100)}%`;
    (document.getElementById("z-max-vol") as HTMLInputElement).value = `${Math.round((z.max_volume ?? 1) * 100)}`;
    document.getElementById("max-vol-val")!.textContent = `${Math.round((z.max_volume ?? 1) * 100)}%`;

    (document.getElementById("z-soft-start") as HTMLSelectElement).value =
      z.soft_start_limit != null ? `${z.soft_start_limit}` : "none";
    (document.getElementById("z-coarse-mod") as HTMLSelectElement).value = z.coarse_modifier || "shift";
    (document.getElementById("z-fine-mod") as HTMLSelectElement).value = z.fine_modifier || "ctrl";

    (document.getElementById("z-accel") as HTMLInputElement).checked = z.acceleration;
    (document.getElementById("z-invert") as HTMLInputElement).checked = z.invert;
    (document.getElementById("z-middle-mute") as HTMLInputElement).checked = z.middle_click_to_mute ?? false;
    (document.getElementById("z-pulse-tint") as HTMLInputElement).checked = z.pulse_tint ?? true;
    (document.getElementById("z-tick-sound") as HTMLInputElement).checked = z.tick_sound ?? false;
  }

  function renderOsdStudio() {
    if (!settings) return;
    if (!settings.osd) {
      settings.osd = {
        enabled: true,
        duration_ms: 1200,
        position: "top_center",
        hide_in_fullscreen: true,
        theme: "modern_fluent",
        accent_color: "#38bdf8",
        scale: 1.0,
        show_percentage: true,
        show_target: true,
      };
    }
    const osd = settings.osd;
    const accent = osd.accent_color || "#38bdf8";

    (document.getElementById("g-osd") as HTMLInputElement).checked = osd.enabled;
    (document.getElementById("g-osd-hide-fullscreen") as HTMLInputElement).checked = osd.hide_in_fullscreen;
    (document.getElementById("g-osd-show-target") as HTMLInputElement).checked = osd.show_target !== false;
    (document.getElementById("g-osd-show-pct") as HTMLInputElement).checked = osd.show_percentage !== false;
    (document.getElementById("g-osd-dur") as HTMLInputElement).value = `${osd.duration_ms || 1200}`;
    document.getElementById("osd-dur-val")!.textContent = `${((osd.duration_ms || 1200) / 1000).toFixed(1)} sec`;
    (document.getElementById("g-osd-scale") as HTMLSelectElement).value = `${osd.scale || 1}`;

    const themesGrid = document.getElementById("osd-themes-grid")!;
    themesGrid.innerHTML = "";
    OSD_THEMES.forEach((t) => {
      const card = document.createElement("div");
      card.className = `theme-card ${osd.theme === t.id ? "active" : ""}`;
      card.innerHTML = `<div class="theme-card-icon">${t.icon}</div><div class="theme-card-title">${t.name}</div>`;
      card.addEventListener("click", async () => {
        settings!.osd.theme = t.id;
        renderOsdStudio();
        await save();
      });
      themesGrid.appendChild(card);
    });

    const swatchBox = document.getElementById("osd-color-swatches")!;
    swatchBox.innerHTML = "";
    OSD_COLORS.forEach((c) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `swatch-btn ${accent.toLowerCase() === c.toLowerCase() ? "active" : ""}`;
      btn.style.background = c;
      btn.addEventListener("click", async () => {
        settings!.osd.accent_color = c;
        renderOsdStudio();
        await save();
      });
      swatchBox.appendChild(btn);
    });

    const customPicker = document.createElement("input");
    customPicker.type = "color";
    customPicker.value = accent;
    customPicker.title = "Custom Color";
    customPicker.style.cssText = "width: 24px; height: 24px; padding: 0; border: none; background: transparent; cursor: pointer;";
    customPicker.addEventListener("change", async () => {
      settings!.osd.accent_color = customPicker.value;
      renderOsdStudio();
      await save();
    });
    swatchBox.appendChild(customPicker);

    document.getElementById("pos-matrix")?.querySelectorAll(".pos-btn").forEach((btn) => {
      const b = btn as HTMLButtonElement;
      b.classList.toggle("active", b.dataset.pos === osd.position);
    });
    document.getElementById("pos-label")!.textContent = osd.position.replace(/_/g, " ").toUpperCase();

    const previewBox = document.getElementById("osd-live-preview")!;
    previewBox.innerHTML = renderOsdHtml(osd.theme, 68, false, "Master Volume", {
      accent,
      showPct: osd.show_percentage !== false,
      showTarget: osd.show_target !== false,
    });
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

  async function refreshMixer() {
    try {
      const mVol = await invoke<number>("get_master_volume");
      const mMute = await invoke<boolean>("get_master_mute");
      const mPct = Math.round(mVol * 100);
      (document.getElementById("mixer-master-slider") as HTMLInputElement).value = `${mPct}`;
      document.getElementById("mixer-master-pct")!.textContent = `${mPct}%`;
      document.getElementById("mixer-master-mute")!.textContent = mMute ? "Unmute" : "Mute";
    } catch {}

    try {
      const micVol = await invoke<number>("get_mic_volume");
      const micMute = await invoke<boolean>("get_mic_mute");
      const micPct = Math.round(micVol * 100);
      (document.getElementById("mixer-mic-slider") as HTMLInputElement).value = `${micPct}`;
      document.getElementById("mixer-mic-pct")!.textContent = `${micPct}%`;
      document.getElementById("mixer-mic-mute")!.textContent = micMute ? "Unmute" : "Mute";
    } catch {}

    const appsEl = document.getElementById("mixer-apps-list")!;
    try {
      audioApps = await invoke<AppAudioSession[]>("list_audio_apps");
      if (audioApps.length === 0) {
        appsEl.innerHTML = `<div style="font-size: 12px; color: var(--text-secondary);">No apps are currently playing audio. Open a browser, music player, or video and click Refresh.</div>`;
        return;
      }

      appsEl.innerHTML = "";
      audioApps.forEach((appSession) => {
        const pct = Math.round(appSession.volume * 100);
        const row = document.createElement("div");
        row.className = "mixer-row";
        row.innerHTML = `
          <span class="mixer-app-name" title="${escapeHtml(appSession.name)} (PID ${escapeHtml(appSession.id)})">${escapeHtml(appSession.name)}</span>
          <button type="button" class="btn btn-sm app-mute-btn">${appSession.muted ? "Unmute" : "Mute"}</button>
          <input type="range" class="vol-slider app-vol-slider" min="0" max="100" value="${pct}" />
          <span class="vol-label app-vol-pct">${pct}%</span>
        `;

        const slider = row.querySelector(".app-vol-slider") as HTMLInputElement;
        const pctLbl = row.querySelector(".app-vol-pct")!;
        const muteBtn = row.querySelector(".app-mute-btn") as HTMLButtonElement;

        const assignBtn = document.createElement("button");
        assignBtn.type = "button";
        assignBtn.className = "btn btn-sm";
        assignBtn.title = `Assign a scroll area to ${appSession.name}`;
        assignBtn.textContent = "📐";
        assignBtn.addEventListener("click", async () => {
          if (!settings) return;
          if (settings.zones.length === 0) {
            await applyAreaEdge("bottom", 0);
          }
          const idx = selectedZoneIndex;
          if (settings.zones[idx]) {
            settings.zones[idx].target = { kind: "app", target: appSession.id };
            settings.zones[idx].name = `${appSession.name} Volume`;
            await save();
            renderZonePills();
            renderInspector();
            document.querySelector<HTMLElement>('.v2-nav-item[data-tab="zones"]')?.click();
          }
        });
        row.appendChild(assignBtn);

        slider.addEventListener("input", async () => {
          const val = parseInt(slider.value);
          pctLbl.textContent = `${val}%`;
          try {
            await invoke("set_app_volume", { appId: appSession.id, level: val / 100 });
          } catch {}
        });

        muteBtn.addEventListener("click", async () => {
          appSession.muted = !appSession.muted;
          muteBtn.textContent = appSession.muted ? "Unmute" : "Mute";
          try {
            await invoke("set_app_mute", { appId: appSession.id, muted: appSession.muted });
          } catch {}
        });

        appsEl.appendChild(row);
      });
    } catch {
      appsEl.innerHTML = `<div style="font-size: 12px; color: var(--text-secondary);">Unable to list audio apps on this system.</div>`;
    }
  }

  async function refreshSystemCheck() {
    try {
      const panicked = await invoke<boolean>("is_panic_disengaged");
      const panicEl = document.getElementById("panic-banner");
      if (panicEl) panicEl.style.display = panicked ? "flex" : "none";

      const hookText = document.getElementById("status-hook-text");
      const hookDot = document.getElementById("sidebar-hook-dot");
      if (hookText) {
        hookText.textContent = panicked ? "Paused (Emergency Stop)" : "Active & Listening";
        hookText.style.color = panicked ? "#ef4444" : "#10b981";
      }
      if (hookDot) {
        hookDot.className = panicked ? "v2-dot-off" : "v2-dot-ok";
      }
    } catch {}

    try {
      const isAdmin = await invoke<boolean>("is_elevated_admin");
      const adminText = document.getElementById("status-admin-text");
      if (adminText) {
        adminText.textContent = isAdmin ? "Yes (Elevated)" : "Standard User";
        adminText.style.color = isAdmin ? "#10b981" : "var(--text-secondary)";
      }
    } catch {}

    await syncAutostartUI();
  }

  // Apply Area Edge (bottom taskbar, top, left, right, center)
  async function applyAreaEdge(edge: string, targetZoneIndex?: number) {
    if (!settings) return;
    if (settings.zones.length === 0) {
      settings.zones.push({
        id: `zone-${Date.now()}`,
        name: "Windows Taskbar",
        monitor_id: null,
        rect: { x: 0, y: 724, width: 1366, height: 44 },
        shape: { type: "rectangle" },
        visual_mode: "invisible",
        opacity: 0.25,
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
        pulse_tint: false,
        enabled: true,
      });
      selectedZoneIndex = 0;
    }

    const idx = targetZoneIndex ?? selectedZoneIndex;
    const z = settings.zones[idx] || settings.zones[0];
    const screenW = window.screen.width || 1366;
    const screenH = window.screen.height || 768;

    if (edge === "bottom") {
      const h = Math.max(30, Math.min(64, z.rect.height || 44));
      z.rect = { x: 0, y: screenH - h, width: screenW, height: h };
      z.shape = { type: "rectangle" };
      if (z.name.includes("Zone") || z.name.includes("Top") || z.name.includes("Left") || z.name.includes("Right")) {
        z.name = "Windows Taskbar";
      }
    } else if (edge === "top") {
      const h = Math.max(20, Math.min(60, z.rect.height || 30));
      z.rect = { x: 0, y: 0, width: screenW, height: h };
      z.shape = { type: "rectangle" };
      if (z.name.includes("Taskbar") || z.name.includes("Left") || z.name.includes("Right")) {
        z.name = "Screen Top Bar";
      }
    } else if (edge === "left") {
      const w = Math.max(16, Math.min(60, z.rect.width >= screenW * 0.5 ? 28 : z.rect.width));
      z.rect = { x: 0, y: 0, width: w, height: screenH };
      z.shape = { type: "rectangle" };
    } else if (edge === "right") {
      const w = Math.max(16, Math.min(60, z.rect.width >= screenW * 0.5 ? 28 : z.rect.width));
      z.rect = { x: screenW - w, y: 0, width: w, height: screenH };
      z.shape = { type: "rectangle" };
    } else if (edge === "center") {
      const w = 420;
      const h = 180;
      z.rect = { x: Math.round((screenW - w) / 2), y: Math.round((screenH - h) / 2), width: w, height: h };
      z.shape = { type: "rounded", radius: 14 };
    }

    z.enabled = true;
    renderZonePills();
    renderInspector();
    renderQuickStart();
    try {
      await invoke("update_zone_rect", { zoneId: z.id, rect: z.rect });
    } catch {}
    await save();
  }

  // Event Listeners
  document.querySelectorAll("[data-quick-edge]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const edge = (e.currentTarget as HTMLElement).dataset.quickEdge;
      if (edge) applyAreaEdge(edge, selectedZoneIndex);
    });
  });

  document.querySelectorAll(".mini-zone-edge, .mini-zone-center, .btn-area-select[data-edge]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const t = e.currentTarget as HTMLElement;
      const edge = t.dataset.targetEdge || t.dataset.edge;
      if (edge) applyAreaEdge(edge);
    });
  });

  // Top bar & Quick Start Shared Handlers
  const toggleAllZonesFn = async () => {
    try {
      await invoke("toggle_all_zones");
      await loadSettings();
    } catch {}
  };
  document.getElementById("top-zones-toggle-btn")?.addEventListener("click", toggleAllZonesFn);
  document.getElementById("q-zones-enabled")?.addEventListener("change", async (e) => {
    if (!settings) return;
    const on = (e.target as HTMLInputElement).checked;
    settings.zones.forEach((z) => (z.enabled = on));
    await save();
    renderZonePills();
    renderInspector();
  });

  const handleAutostartToggle = async (enabled: boolean) => {
    try {
      const actual = await invoke<boolean>("set_autostart_enabled", { enabled });
      if (settings) {
        settings.start_at_login = actual;
        settings.autostart_initialized = true;
      }
      await syncAutostartUI();
    } catch (err) {
      console.error("Failed to set autostart:", err);
      await syncAutostartUI();
    }
  };
  document.getElementById("q-autostart")?.addEventListener("change", (e) => {
    handleAutostartToggle((e.target as HTMLInputElement).checked);
  });
  document.getElementById("g-autostart")?.addEventListener("change", (e) => {
    handleAutostartToggle((e.target as HTMLInputElement).checked);
  });

  document.getElementById("q-osd-enabled")?.addEventListener("change", async (e) => {
    if (!settings) return;
    settings.osd.enabled = (e.target as HTMLInputElement).checked;
    renderOsdStudio();
    await save();
  });

  document.getElementById("q-fullscreen")?.addEventListener("change", async (e) => {
    if (!settings) return;
    settings.fullscreen_rule.disable_in_fullscreen = (e.target as HTMLInputElement).checked;
    renderGlobalPreferences();
    await save();
  });

  // Quick Test Pad
  const wheelTestBox = document.getElementById("wheel-test-box");
  let testThrottle = false;
  wheelTestBox?.addEventListener(
    "wheel",
    async (e) => {
      e.preventDefault();
      if (testThrottle) return;
      testThrottle = true;
      setTimeout(() => (testThrottle = false), 55);

      const isUp = e.deltaY < 0;
      try {
        const newVol = await invoke<number>("test_volume", {
          action: isUp ? "up" : "down",
          showOsd: settings?.osd?.enabled ?? true,
        });
        const pct = Math.round(newVol * 100);
        document.getElementById("test-vol-display")!.textContent = `${pct}%`;
        (document.getElementById("test-meter-fill") as HTMLElement).style.width = `${pct}%`;
        document.getElementById("test-wheel-hint")!.innerHTML = isUp
          ? `<span style="color: #10b981;">▲ Volume UP</span> → <strong>${pct}%</strong>`
          : `<span style="color: #f59e0b;">▼ Volume DOWN</span> → <strong>${pct}%</strong>`;
        updateVolumePreview();
        playTickSound();
      } catch {}
    },
    { passive: false }
  );

  // Height & Width sliders + chips (throttled rect IPC during drag; persist config on release)
  let rectSliderTimer: number | null = null;
  function sendThrottledRect(zoneId: string, rect: Rect) {
    if (rectSliderTimer !== null) return;
    rectSliderTimer = window.setTimeout(() => {
      rectSliderTimer = null;
      invoke("update_zone_rect", { zoneId, rect }).catch(() => {});
    }, 32);
  }

  const hSlider = document.getElementById("z-height-slider") as HTMLInputElement;
  hSlider?.addEventListener("input", (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const val = parseInt((e.target as HTMLInputElement).value) || 40;
    const z = settings.zones[selectedZoneIndex];
    const screenH = window.screen.height || 768;
    z.rect.height = val;
    if (z.rect.y > screenH - 140) z.rect.y = screenH - val;
    document.getElementById("height-val-display")!.textContent = `${val}px`;
    (document.getElementById("z-h") as HTMLInputElement).value = `${val}`;
    (document.getElementById("z-y") as HTMLInputElement).value = `${z.rect.y}`;
    sendThrottledRect(z.id, z.rect);
  });
  hSlider?.addEventListener("change", () => save());

  document.getElementById("z-h")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const val = Math.max(10, parseInt((e.target as HTMLInputElement).value) || 40);
    const z = settings.zones[selectedZoneIndex];
    const screenH = window.screen.height || 768;
    z.rect.height = val;
    if (z.rect.y > screenH - 140) z.rect.y = screenH - val;
    renderInspector();
    try { await invoke("update_zone_rect", { zoneId: z.id, rect: z.rect }); } catch {}
    await save();
  });

  const wSlider = document.getElementById("z-width-slider") as HTMLInputElement;
  wSlider?.addEventListener("input", (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const val = parseInt((e.target as HTMLInputElement).value) || 1366;
    const z = settings.zones[selectedZoneIndex];
    const screenW = window.screen.width || 1366;
    z.rect.width = val;
    document.getElementById("width-val-display")!.textContent = val >= screenW - 10 ? "100% (Full Width)" : `${val}px`;
    (document.getElementById("z-w") as HTMLInputElement).value = `${val}`;
    sendThrottledRect(z.id, z.rect);
  });
  wSlider?.addEventListener("change", () => save());

  document.getElementById("z-w")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const val = Math.max(40, parseInt((e.target as HTMLInputElement).value) || 1366);
    settings.zones[selectedZoneIndex].rect.width = val;
    renderInspector();
    try { await invoke("update_zone_rect", { zoneId: settings.zones[selectedZoneIndex].id, rect: settings.zones[selectedZoneIndex].rect }); } catch {}
    await save();
  });

  document.querySelectorAll("[data-set-height]").forEach((chip) => {
    chip.addEventListener("click", async (e) => {
      if (!settings?.zones[selectedZoneIndex]) return;
      const h = parseInt((e.currentTarget as HTMLElement).dataset.setHeight || "40");
      const z = settings.zones[selectedZoneIndex];
      const screenH = window.screen.height || 768;
      z.rect.height = h;
      if (z.rect.y > screenH - 140) z.rect.y = screenH - h;
      renderInspector();
      try { await invoke("update_zone_rect", { zoneId: z.id, rect: z.rect }); } catch {}
      await save();
    });
  });

  document.querySelectorAll("[data-set-width]").forEach((chip) => {
    chip.addEventListener("click", async (e) => {
      if (!settings?.zones[selectedZoneIndex]) return;
      const mode = (e.currentTarget as HTMLElement).dataset.setWidth || "full";
      const z = settings.zones[selectedZoneIndex];
      const screenW = window.screen.width || 1366;
      if (mode === "full") { z.rect.x = 0; z.rect.width = screenW; }
      else if (mode === "half") { z.rect.width = Math.round(screenW / 2); z.rect.x = Math.round((screenW - z.rect.width) / 2); }
      else { const w = parseInt(mode) || 600; z.rect.width = w; z.rect.x = Math.max(0, Math.round((screenW - w) / 2)); }
      renderInspector();
      try { await invoke("update_zone_rect", { zoneId: z.id, rect: z.rect }); } catch {}
      await save();
    });
  });

  const onCoordChange = async () => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const z = settings.zones[selectedZoneIndex];
    z.rect.x = parseInt((document.getElementById("z-x") as HTMLInputElement).value) || 0;
    z.rect.y = parseInt((document.getElementById("z-y") as HTMLInputElement).value) || 0;
    try { await invoke("update_zone_rect", { zoneId: z.id, rect: z.rect }); } catch {}
    await save();
  };
  document.getElementById("z-x")?.addEventListener("change", onCoordChange);
  document.getElementById("z-y")?.addEventListener("change", onCoordChange);

  document.getElementById("recenter-btn")?.addEventListener("click", async () => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const z = settings.zones[selectedZoneIndex];
    z.rect.x = Math.max(0, Math.round(((window.screen.width || 1366) - z.rect.width) / 2));
    z.rect.y = Math.max(0, Math.round(((window.screen.height || 768) - z.rect.height) / 2));
    renderInspector();
    try { await invoke("update_zone_rect", { zoneId: z.id, rect: z.rect }); } catch {}
    await save();
  });

  // Zone Field Listeners
  document.getElementById("z-name")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].name = (e.target as HTMLInputElement).value;
    renderZonePills();
    await save();
  });
  document.getElementById("z-enabled")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].enabled = (e.target as HTMLInputElement).checked;
    renderZonePills();
    await save();
  });
  document.getElementById("z-target")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const val = (e.target as HTMLSelectElement).value;
    if (val === "master") settings.zones[selectedZoneIndex].target = { kind: "master" };
    else if (val === "mic") settings.zones[selectedZoneIndex].target = { kind: "mic" };
    else if (val === "app_under_cursor") settings.zones[selectedZoneIndex].target = { kind: "app_under_cursor" };
    else if (val === "app") settings.zones[selectedZoneIndex].target = { kind: "app", target: audioApps[0]?.id || "default" };
    renderInspector();
    await save();
  });
  document.getElementById("z-app-target")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].target = { kind: "app", target: (e.target as HTMLSelectElement).value };
    await save();
  });
  document.getElementById("z-shape")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const type = (e.target as HTMLSelectElement).value as ZoneShape["type"];
    if (type === "rounded") settings.zones[selectedZoneIndex].shape = { type, radius: 12 };
    else if (type === "screen_edge_strip") settings.zones[selectedZoneIndex].shape = { type, edge: "top", thickness: 28 };
    else settings.zones[selectedZoneIndex].shape = { type };
    renderInspector();
    await save();
  });
  document.getElementById("z-radius")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].shape = { type: "rounded", radius: parseInt((e.target as HTMLInputElement).value) || 12 };
    await save();
  });
  document.getElementById("z-edge")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].shape = { type: "screen_edge_strip", edge: (e.target as HTMLSelectElement).value as ScreenEdge, thickness: 28 };
    await save();
  });
  document.getElementById("z-mode")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].visual_mode = (e.target as HTMLSelectElement).value as ZoneConfig["visual_mode"];
    await save();
  });
  document.getElementById("z-opacity")?.addEventListener("input", (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const val = parseInt((e.target as HTMLInputElement).value);
    settings.zones[selectedZoneIndex].opacity = val / 100;
    document.getElementById("opacity-val")!.textContent = `${val}%`;
  });
  document.getElementById("z-opacity")?.addEventListener("change", () => save());
  document.getElementById("z-step")?.addEventListener("input", (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const val = parseInt((e.target as HTMLInputElement).value);
    settings.zones[selectedZoneIndex].step = val;
    document.getElementById("step-val")!.textContent = `${val}%`;
  });
  document.getElementById("z-step")?.addEventListener("change", () => save());
  document.getElementById("z-horiz-action")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].horizontal_action = (e.target as HTMLSelectElement).value as HorizontalWheelAction;
    await save();
  });
  document.getElementById("z-min-vol")?.addEventListener("input", (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const val = parseInt((e.target as HTMLInputElement).value);
    settings.zones[selectedZoneIndex].min_volume = val / 100;
    document.getElementById("min-vol-val")!.textContent = `${val}%`;
  });
  document.getElementById("z-min-vol")?.addEventListener("change", () => save());
  document.getElementById("z-max-vol")?.addEventListener("input", (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const val = parseInt((e.target as HTMLInputElement).value);
    settings.zones[selectedZoneIndex].max_volume = val / 100;
    document.getElementById("max-vol-val")!.textContent = `${val}%`;
  });
  document.getElementById("z-max-vol")?.addEventListener("change", () => save());
  document.getElementById("z-soft-start")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const val = (e.target as HTMLSelectElement).value;
    settings.zones[selectedZoneIndex].soft_start_limit = val === "none" ? null : parseFloat(val);
    await save();
  });
  document.getElementById("z-coarse-mod")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].coarse_modifier = (e.target as HTMLSelectElement).value as ModifierKey;
    await save();
  });
  document.getElementById("z-fine-mod")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].fine_modifier = (e.target as HTMLSelectElement).value as ModifierKey;
    await save();
  });
  document.getElementById("z-accel")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].acceleration = (e.target as HTMLInputElement).checked;
    await save();
  });
  document.getElementById("z-invert")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].invert = (e.target as HTMLInputElement).checked;
    await save();
  });
  document.getElementById("z-middle-mute")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].middle_click_to_mute = (e.target as HTMLInputElement).checked;
    await save();
  });
  document.getElementById("z-pulse-tint")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].pulse_tint = (e.target as HTMLInputElement).checked;
    await save();
  });
  document.getElementById("z-tick-sound")?.addEventListener("change", async (e) => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones[selectedZoneIndex].tick_sound = (e.target as HTMLInputElement).checked;
    await save();
  });

  // Add / Copy / Delete Zones
  document.getElementById("add-zone-btn")?.addEventListener("click", async () => {
    if (!settings) return;
    const count = settings.zones.length;
    const offset = (count % 6) * 32;
    const newZone: ZoneConfig = {
      id: `zone-${Date.now()}`,
      name: `Scroll Area ${count + 1}`,
      monitor_id: null,
      rect: { x: 120 + offset, y: 120 + offset, width: 340, height: 64 },
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
    settings.edit_mode = true;
    renderZonePills();
    renderInspector();
    await save();
    try { await invoke("set_edit_mode", { enabled: true }); } catch {}
  });

  document.getElementById("dup-zone-btn")?.addEventListener("click", async () => {
    if (!settings?.zones[selectedZoneIndex]) return;
    const orig = settings.zones[selectedZoneIndex];
    const copy: ZoneConfig = JSON.parse(JSON.stringify(orig));
    copy.id = `zone-${Date.now()}`;
    copy.name = `${orig.name} Copy`;
    copy.rect.x += 24;
    copy.rect.y += 24;
    settings.zones.push(copy);
    selectedZoneIndex = settings.zones.length - 1;
    renderZonePills();
    renderInspector();
    await save();
  });

  document.getElementById("del-zone-btn")?.addEventListener("click", async () => {
    if (!settings?.zones[selectedZoneIndex]) return;
    settings.zones.splice(selectedZoneIndex, 1);
    selectedZoneIndex = Math.max(0, settings.zones.length - 1);
    renderZonePills();
    renderInspector();
    await save();
  });

  // Edit Mode Toggles
  const toggleEditOnScreen = async () => {
    try {
      const current = await invoke<boolean>("get_edit_mode");
      const next = !current;
      await invoke("set_edit_mode", { enabled: next });
      if (settings) {
        settings.edit_mode = next;
        renderHeader();
      }
    } catch {}
  };
  document.getElementById("header-edit-pill")?.addEventListener("click", toggleEditOnScreen);
  document.getElementById("z-drag-screen-btn")?.addEventListener("click", toggleEditOnScreen);

  // OSD Controls
  document.getElementById("g-osd")?.addEventListener("change", async (e) => {
    if (!settings) return;
    settings.osd.enabled = (e.target as HTMLInputElement).checked;
    renderQuickStart();
    await save();
  });
  document.getElementById("g-osd-hide-fullscreen")?.addEventListener("change", async (e) => {
    if (!settings) return;
    settings.osd.hide_in_fullscreen = (e.target as HTMLInputElement).checked;
    await save();
  });
  document.getElementById("g-osd-show-target")?.addEventListener("change", async (e) => {
    if (!settings) return;
    settings.osd.show_target = (e.target as HTMLInputElement).checked;
    renderOsdStudio();
    await save();
  });
  document.getElementById("g-osd-show-pct")?.addEventListener("change", async (e) => {
    if (!settings) return;
    settings.osd.show_percentage = (e.target as HTMLInputElement).checked;
    renderOsdStudio();
    await save();
  });
  document.getElementById("g-osd-dur")?.addEventListener("input", (e) => {
    if (!settings) return;
    const dur = parseInt((e.target as HTMLInputElement).value) || 1200;
    settings.osd.duration_ms = dur;
    document.getElementById("osd-dur-val")!.textContent = `${(dur / 1000).toFixed(1)} sec`;
  });
  document.getElementById("g-osd-dur")?.addEventListener("change", () => save());
  document.getElementById("g-osd-scale")?.addEventListener("change", async (e) => {
    if (!settings) return;
    settings.osd.scale = parseFloat((e.target as HTMLSelectElement).value) || 1.0;
    await save();
  });
  document.getElementById("pos-matrix")?.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest(".pos-btn") as HTMLButtonElement | null;
    if (!btn || !settings) return;
    const pos = btn.dataset.pos as OsdPosition;
    if (pos) {
      settings.osd.position = pos;
      renderOsdStudio();
      await save();
    }
  });

  const fireOsdPreview = async () => {
    if (!settings?.osd) return;
    try {
      await invoke("trigger_osd", {
        theme: settings.osd.theme,
        position: settings.osd.position,
        accentColor: settings.osd.accent_color || "#38bdf8",
        scale: settings.osd.scale || 1.0,
      });
    } catch {}
  };
  document.getElementById("test-osd-btn")?.addEventListener("click", fireOsdPreview);
  document.getElementById("quick-test-osd-btn")?.addEventListener("click", fireOsdPreview);

  // Sound Mixer Controls
  document.getElementById("refresh-mixer-btn")?.addEventListener("click", refreshMixer);

  document.getElementById("mixer-master-slider")?.addEventListener("input", async (e) => {
    const val = parseInt((e.target as HTMLInputElement).value);
    document.getElementById("mixer-master-pct")!.textContent = `${val}%`;
    try {
      await invoke("set_master_volume", { level: val / 100 });
      updateVolumePreview();
    } catch {}
  });
  document.getElementById("mixer-master-mute")?.addEventListener("click", async () => {
    try {
      const m = await invoke<boolean>("toggle_master_mute");
      document.getElementById("mixer-master-mute")!.textContent = m ? "Unmute" : "Mute";
      updateVolumePreview();
    } catch {}
  });

  document.getElementById("mixer-mic-slider")?.addEventListener("input", async (e) => {
    const val = parseInt((e.target as HTMLInputElement).value);
    document.getElementById("mixer-mic-pct")!.textContent = `${val}%`;
    try { await invoke("set_mic_volume", { level: val / 100 }); } catch {}
  });
  document.getElementById("mixer-mic-mute")?.addEventListener("click", async () => {
    try {
      const cur = await invoke<boolean>("get_mic_mute");
      await invoke("set_mic_mute", { muted: !cur });
      document.getElementById("mixer-mic-mute")!.textContent = !cur ? "Unmute" : "Mute";
    } catch {}
  });

  // Top Header Volume Slider & Mute
  document.getElementById("live-vol-slider")?.addEventListener("input", async (e) => {
    const val = parseInt((e.target as HTMLInputElement).value);
    document.getElementById("live-vol-label")!.textContent = `${val}%`;
    try {
      await invoke("set_master_volume", { level: val / 100 });
      updateVolumePreview();
    } catch {}
  });
  document.getElementById("live-mute-btn")?.addEventListener("click", async () => {
    try {
      await invoke("toggle_master_mute");
      updateVolumePreview();
    } catch {}
  });

  // Night Mode
  document.getElementById("night-enable")?.addEventListener("change", async (e) => {
    if (!settings) return;
    settings.time_profile.enabled = (e.target as HTMLInputElement).checked;
    await save();
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
  document.getElementById("night-cap")?.addEventListener("input", (e) => {
    if (settings?.time_profile) {
      const val = parseInt((e.target as HTMLInputElement).value) || 30;
      settings.time_profile.max_volume = val / 100;
      document.getElementById("night-cap-val")!.textContent = `${val}%`;
    }
  });
  document.getElementById("night-cap")?.addEventListener("change", () => save());

  // Profiles
  document.getElementById("profile-select")?.addEventListener("change", async (e) => {
    try {
      settings = await invoke<Settings>("switch_profile", { profileId: (e.target as HTMLSelectElement).value });
      selectedZoneIndex = 0;
      renderZonePills();
      renderInspector();
      renderQuickStart();
    } catch {}
  });
  document.getElementById("save-new-profile-btn")?.addEventListener("click", async () => {
    if (!settings) return;
    const name = prompt("Name this layout setup:");
    if (!name?.trim()) return;
    const newId = `profile-${Date.now()}`;
    settings.profiles.push({
      id: newId,
      name: name.trim(),
      zones: JSON.parse(JSON.stringify(settings.zones)),
    });
    settings.active_profile_id = newId;
    renderProfiles();
    await save();
  });
  document.getElementById("delete-profile-btn")?.addEventListener("click", async () => {
    if (!settings || settings.profiles.length <= 1) {
      alert("You need at least one saved layout.");
      return;
    }
    const idx = settings.profiles.findIndex((p) => p.id === settings!.active_profile_id);
    if (idx !== -1) {
      settings.profiles.splice(idx, 1);
      settings.active_profile_id = settings.profiles[0].id;
      settings.zones = JSON.parse(JSON.stringify(settings.profiles[0].zones));
      selectedZoneIndex = 0;
      renderProfiles();
      renderZonePills();
      renderInspector();
      await save();
    }
  });

  // Rules, Theme, Backup & Safety
  document.getElementById("g-fullscreen-disable")?.addEventListener("change", async (e) => {
    if (!settings) return;
    settings.fullscreen_rule.disable_in_fullscreen = (e.target as HTMLInputElement).checked;
    renderQuickStart();
    await save();
  });

  const themeBtn = document.getElementById("theme-btn")!;
  themeBtn.addEventListener("click", () => {
    const isLight = document.body.getAttribute("data-theme") === "light";
    if (isLight) {
      document.body.removeAttribute("data-theme");
      themeBtn.textContent = "☀️";
    } else {
      document.body.setAttribute("data-theme", "light");
      themeBtn.textContent = "🌙";
    }
  });

  const modalBackdrop = document.getElementById("modal-backdrop")!;
  const modalText = document.getElementById("modal-text") as HTMLTextAreaElement;
  const modalActionBtn = document.getElementById("modal-action-btn")!;
  let modalMode: "export" | "import" = "export";

  document.getElementById("export-btn")?.addEventListener("click", () => {
    if (!settings) return;
    modalMode = "export";
    document.getElementById("modal-title")!.textContent = "Backup Your Settings";
    modalText.value = JSON.stringify(settings, null, 2);
    modalText.readOnly = true;
    modalActionBtn.textContent = "Copy Backup";
    modalBackdrop.style.display = "flex";
  });
  document.getElementById("import-btn")?.addEventListener("click", () => {
    modalMode = "import";
    document.getElementById("modal-title")!.textContent = "Restore Backup JSON";
    modalText.value = "";
    modalText.readOnly = false;
    modalActionBtn.textContent = "Restore & Save";
    modalBackdrop.style.display = "flex";
  });
  document.getElementById("modal-close-btn")?.addEventListener("click", () => {
    modalBackdrop.style.display = "none";
  });
  modalActionBtn.addEventListener("click", async () => {
    if (modalMode === "export") {
      await navigator.clipboard.writeText(modalText.value);
      modalBackdrop.style.display = "none";
      alert("Backup copied to clipboard!");
    } else {
      try {
        settings = JSON.parse(modalText.value) as Settings;
        await save();
        modalBackdrop.style.display = "none";
        await loadSettings();
      } catch (e) {
        alert(`Invalid backup JSON: ${e}`);
      }
    }
  });

  document.getElementById("open-logs-btn")?.addEventListener("click", () => invoke("open_logs_folder").catch(() => {}));
  document.getElementById("panic-now-btn")?.addEventListener("click", async () => {
    await invoke("panic_shutdown").catch(() => {});
    refreshSystemCheck();
  });
  document.getElementById("unpanic-btn")?.addEventListener("click", async () => {
    await invoke("unpanic").catch(() => {});
    refreshSystemCheck();
  });
  document.getElementById("reset-btn")?.addEventListener("click", async () => {
    if (confirm("Reset all Volume 3 settings and areas back to default?")) {
      await invoke("reset_config").catch(() => {});
      await loadSettings();
    }
  });

  // Live backend event listeners
  listen<boolean>("edit-mode-changed", (evt) => {
    if (settings) {
      settings.edit_mode = evt.payload;
      renderHeader();
    }
  }).catch(() => {});

  listen("settings-updated", async () => {
    try {
      settings = await invoke<Settings>("get_settings");
      renderHeader();
      renderQuickStart();
      renderZonePills();
      if (!document.activeElement?.closest("#zone-inspector")) {
        renderInspector();
      }
    } catch {}
  }).catch(() => {});

  listen<[number, boolean]>("volume-synced", (evt) => {
    const [pct, muted] = evt.payload;
    const slider = document.getElementById("live-vol-slider") as HTMLInputElement | null;
    const label = document.getElementById("live-vol-label");
    const iconBtn = document.getElementById("live-mute-btn");
    if (slider) slider.value = `${pct}`;
    if (label) label.textContent = `${pct}%`;
    if (iconBtn) iconBtn.textContent = getSpeakerIcon(pct, muted);

    const testDisp = document.getElementById("test-vol-display");
    const testFill = document.getElementById("test-meter-fill");
    if (testDisp) testDisp.textContent = `${pct}%`;
    if (testFill) testFill.style.width = `${pct}%`;
  }).catch(() => {});

  listen("panic-triggered", () => refreshSystemCheck()).catch(() => {});
  listen("panic-cleared", () => refreshSystemCheck()).catch(() => {});

  await loadSettings();
}

/* ==================== INITIALIZATION ==================== */

window.addEventListener("DOMContentLoaded", async () => {
  let label = "settings";
  try {
    const curWin = getCurrentWebviewWindow();
    if (curWin?.label) label = curWin.label;
  } catch {
    try {
      label = await invoke<string>("get_current_window_label");
    } catch {}
  }

  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const zoneIdParam = params.get("zone_id");

  if (label === "volzone-osd" || label === "osd" || view === "osd") {
    initOsdView();
  } else if (label.startsWith("zone-") || zoneIdParam) {
    initZoneOverlay(zoneIdParam || label);
  } else {
    initSettingsView();
  }
});
