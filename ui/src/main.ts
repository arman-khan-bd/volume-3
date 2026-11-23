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

type OsdPosition = "center" | "top" | "bottom" | "near_cursor";

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
      osc.frequency.setValueAtTime(1100, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(320, audioCtx.currentTime + 0.018);
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

/* ==================== OSD OVERLAY VIEW ==================== */

function initOsdView() {
  document.body.classList.add("osd-view");
  const appEl = document.getElementById("app");
  if (!appEl) return;

  appEl.innerHTML = `
    <div class="osd-card" id="osd-card" style="opacity: 0;">
      <div class="osd-header">
        <span class="osd-target" id="osd-target">Master</span>
        <span class="osd-val" id="osd-val">0%</span>
        <span class="osd-mute-badge" id="osd-mute" style="display: none;">MUTED</span>
      </div>
      <div class="osd-bar-bg">
        <div class="osd-bar-fill" id="osd-bar" style="width: 0%;"></div>
      </div>
    </div>
  `;

  const card = document.getElementById("osd-card")!;
  const targetEl = document.getElementById("osd-target")!;
  const valEl = document.getElementById("osd-val")!;
  const muteEl = document.getElementById("osd-mute")!;
  const barEl = document.getElementById("osd-bar")!;

  let hideTimer: number | null = null;

  if (window.__TAURI__?.event) {
    window.__TAURI__.event.listen<OsdPayload>("osd-show", (evt) => {
      const payload = evt.payload;
      const pct = Math.round(payload.volume * 100);

      targetEl.textContent = payload.target || "Master";
      valEl.textContent = `${pct}%`;
      barEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;

      if (payload.muted) {
        muteEl.style.display = "inline-block";
        barEl.classList.add("muted");
      } else {
        muteEl.style.display = "none";
        barEl.classList.remove("muted");
      }

      card.style.opacity = "1";

      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
      }

      hideTimer = window.setTimeout(() => {
        card.style.opacity = "0";
      }, payload.duration_ms || 1000);
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
        <button class="lock-btn" id="lock-btn" title="Exit edit mode">Lock</button>
      </div>
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

    // Edge snapping threshold: 15px
    const snap = 15;
    let snX = x;
    let snY = y;
    if (Math.abs(snX) < snap) snX = 0;
    if (Math.abs(snY) < snap) snY = 0;

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
    const w = parseInt(inW.value) || 40;
    const h = parseInt(inH.value) || 20;
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
      case "ArrowUp":
        y -= delta;
        break;
      case "ArrowDown":
        y += delta;
        break;
      case "ArrowLeft":
        x -= delta;
        break;
      case "ArrowRight":
        x += delta;
        break;
      default:
        return;
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
        // Visual tint pulse
        container.classList.add("pulse-active");
        if (pulseTimer !== null) {
          window.clearTimeout(pulseTimer);
        }
        pulseTimer = window.setTimeout(() => {
          container.classList.remove("pulse-active");
        }, 220);

        // Optional mechanical tick sound
        if (currentZone?.tick_sound) {
          playTickSound();
        }
      }
    });
  }

  await loadConfig();
}

/* ==================== SETTINGS WINDOW VIEW ==================== */

async function initSettingsView() {
  document.body.classList.add("settings-view");
  const appEl = document.getElementById("app");
  if (!appEl) return;

  appEl.innerHTML = `
    <div class="settings-container">
      <div class="settings-header">
        <h1>VolZone Settings</h1>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-primary" id="toggle-edit-btn">Toggle Edit Mode</button>
          <button class="theme-toggle-btn" id="theme-btn">Light Theme</button>
        </div>
      </div>

      <!-- Emergency Panic Alert Banner -->
      <div class="panic-banner" id="panic-banner" style="display: none;">
        <span id="panic-msg">⚠️ EMERGENCY PANIC ACTIVE: Wheel hooks disengaged for system safety.</span>
        <button class="btn btn-primary" id="unpanic-btn">Resume Wheel Hooks</button>
      </div>

      <!-- Profiles Manager -->
      <div class="card">
        <div class="card-title">
          <span>Active Profile</span>
          <button class="btn btn-icon" id="save-new-profile-btn">+ Save As Profile</button>
        </div>
        <div class="form-row">
          <div class="form-group" style="flex: 2;">
            <select class="form-control" id="profile-select"></select>
          </div>
          <div class="form-group" style="flex: 1;">
            <button class="btn btn-danger btn-icon" id="delete-profile-btn" style="width: 100%; height: 35px;">Delete Profile</button>
          </div>
        </div>
      </div>

      <!-- Live Volume & Quick Test -->
      <div class="card">
        <div class="card-title">Live Volume Preview & Test</div>
        <div class="slider-container form-group">
          <input type="range" id="live-vol-slider" min="0" max="100" value="50" />
          <span id="live-vol-label" style="font-size: 13px; font-weight: bold; width: 45px;">50%</span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn" id="test-up-btn">Step Up (+5%)</button>
          <button class="btn" id="test-down-btn">Step Down (-5%)</button>
          <button class="btn" id="test-mute-btn">Toggle Mute</button>
        </div>
      </div>

      <!-- Zones Manager -->
      <div class="card">
        <div class="card-title">
          <span>Screen Zones</span>
          <button class="btn btn-primary btn-icon" id="add-zone-btn">+ Add Zone</button>
        </div>
        <div id="zone-list-container"></div>
      </div>

      <!-- Selected Zone Inspector -->
      <div class="card" id="zone-inspector" style="display: none;">
        <div class="card-title">
          <span id="inspector-title">Zone Properties</span>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-icon" id="dup-zone-btn">Duplicate</button>
            <button class="btn btn-danger btn-icon" id="del-zone-btn">Delete</button>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Name</label>
            <input type="text" class="form-control" id="z-name" />
          </div>
          <div class="form-group">
            <label>Target Audio Device</label>
            <select class="form-control" id="z-target">
              <option value="master">Master Output</option>
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
            <input type="number" class="form-control" id="z-radius" min="2" max="100" value="8" />
          </div>
          <div class="form-group" id="strip-group" style="display: none;">
            <label>Screen Edge</label>
            <select class="form-control" id="z-edge">
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Visual Mode</label>
            <select class="form-control" id="z-mode">
              <option value="invisible">Invisible</option>
              <option value="faint_tint">Faint Tint</option>
              <option value="outline_on_hover">Outline on Hover</option>
              <option value="always_visible">Always Visible</option>
            </select>
          </div>
          <div class="form-group">
            <label>Opacity (<span id="opacity-val">25%</span>)</label>
            <input type="range" class="form-control" id="z-opacity" min="0" max="100" value="25" />
          </div>
        </div>

        <!-- Step & Tuning -->
        <div class="form-row">
          <div class="form-group">
            <label>Step Size (<span id="step-val">2%</span>)</label>
            <input type="range" class="form-control" id="z-step" min="1" max="15" value="2" />
          </div>
          <div class="form-group">
            <label>Horizontal Tilt Action</label>
            <select class="form-control" id="z-horiz-action">
              <option value="none">None / Default</option>
              <option value="media_track">Previous / Next Media Track</option>
              <option value="balance">Audio Balance</option>
            </select>
          </div>
        </div>

        <!-- Volume Limits & Soft Start -->
        <div class="form-row">
          <div class="form-group">
            <label>Min Volume Limit (<span id="min-vol-val">0%</span>)</label>
            <input type="range" class="form-control" id="z-min-vol" min="0" max="100" value="0" />
          </div>
          <div class="form-group">
            <label>Max Volume Limit (<span id="max-vol-val">100%</span>)</label>
            <input type="range" class="form-control" id="z-max-vol" min="0" max="100" value="100" />
          </div>
          <div class="form-group">
            <label>Soft Start Max Jump</label>
            <select class="form-control" id="z-soft-start">
              <option value="none">Disabled (No Limit)</option>
              <option value="0.05">5% max jump per event</option>
              <option value="0.08">8% max jump per event</option>
              <option value="0.10">10% max jump per event</option>
              <option value="0.15">15% max jump per event</option>
            </select>
          </div>
        </div>

        <!-- Modifiers Tuning -->
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

        <!-- Toggles -->
        <div class="switch-group" style="flex-wrap: wrap; gap: 12px; margin-top: 10px;">
          <label><input type="checkbox" id="z-accel" /> Wheel Acceleration</label>
          <label><input type="checkbox" id="z-invert" /> Invert Scroll</label>
          <label><input type="checkbox" id="z-middle-mute" /> Middle-Click Mute</label>
          <label><input type="checkbox" id="z-pulse-tint" /> Pulse Tint on Change</label>
          <label><input type="checkbox" id="z-tick-sound" /> Mechanical Tick Sound</label>
        </div>
      </div>

      <!-- Global Rules & Automation -->
      <div class="card">
        <div class="card-title">Rules & Auto-Suppression</div>
        <div class="switch-group">
          <span>Auto-disable zones when games / fullscreen apps are focused</span>
          <input type="checkbox" id="g-fullscreen-disable" />
        </div>
        <div class="switch-group" style="margin-top: 6px;">
          <span>Run with Administrator Privileges (Elevated UIPI hook)</span>
          <input type="checkbox" id="g-admin" />
        </div>
        <div class="switch-group" style="margin-top: 6px;">
          <span>Start VolZone automatically at system login</span>
          <input type="checkbox" id="g-autostart" />
        </div>
      </div>

      <!-- Time Profile (Night Mode) -->
      <div class="card">
        <div class="card-title">
          <span>Time-Based Profile (Night Max Volume)</span>
          <label style="font-size: 13px;"><input type="checkbox" id="night-enable" /> Enable</label>
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
            <label>Night Cap (<span id="night-cap-val">30%</span>)</label>
            <input type="range" class="form-control" id="night-cap" min="5" max="100" value="30" />
          </div>
        </div>
      </div>

      <!-- On-Screen Display (OSD) -->
      <div class="card">
        <div class="card-title">On-Screen Display (OSD)</div>
        <div class="switch-group">
          <span>Show On-Screen Display (OSD) Overlay</span>
          <input type="checkbox" id="g-osd" />
        </div>
        <div class="switch-group" style="margin-top: 4px;">
          <span>Hide OSD in Fullscreen Applications</span>
          <input type="checkbox" id="g-osd-hide-fullscreen" />
        </div>
        <div class="form-row" style="margin-top: 10px;">
          <div class="form-group">
            <label>OSD Position</label>
            <select class="form-control" id="g-osd-pos">
              <option value="center">Center</option>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
              <option value="near_cursor">Near Cursor</option>
            </select>
          </div>
          <div class="form-group">
            <label>OSD Duration (ms)</label>
            <input type="number" class="form-control" id="g-osd-dur" min="400" max="5000" step="100" />
          </div>
        </div>
      </div>

      <!-- Configuration Import / Export / Reset -->
      <div class="card">
        <div class="card-title">Configuration Management & Safety</div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn" id="export-btn">Export JSON</button>
          <button class="btn" id="import-btn">Import JSON</button>
          <button class="btn" id="open-logs-btn">Open Logs Folder</button>
          <button class="btn btn-danger" id="panic-now-btn">Emergency Panic (Unhook All)</button>
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
      renderProfiles();
      renderZoneList();
      renderGlobalPreferences();
      updateVolumePreview();

      try {
        const autostart = await window.__TAURI__.core.invoke<boolean>("is_autostart_enabled");
        const autoEl = document.getElementById("g-autostart") as HTMLInputElement;
        if (autoEl) autoEl.checked = autostart;
      } catch (e) {
        console.warn("Could not query autostart status:", e);
      }

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
    await window.__TAURI__.core.invoke("save_settings", { newSettings: settings });
  }

  async function updateVolumePreview() {
    if (!window.__TAURI__?.core) return;
    try {
      const vol = await window.__TAURI__.core.invoke<number>("get_master_volume");
      const pct = Math.round(vol * 100);
      const slider = document.getElementById("live-vol-slider") as HTMLInputElement;
      const label = document.getElementById("live-vol-label")!;
      if (slider) slider.value = `${pct}`;
      if (label) label.textContent = `${pct}%`;
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

  function renderZoneList() {
    const listEl = document.getElementById("zone-list-container")!;
    if (!settings) return;

    listEl.innerHTML = "";
    settings.zones.forEach((z, idx) => {
      const item = document.createElement("div");
      item.className = `zone-item ${selectedZoneIndex === idx ? "selected" : ""}`;
      item.innerHTML = `
        <div class="zone-item-title">${z.name} (${z.rect.width}x${z.rect.height})</div>
        <div class="zone-actions">
          <label style="font-size: 12px; margin-right: 8px;">
            <input type="checkbox" ${z.enabled ? "checked" : ""} data-idx="${idx}" class="zone-toggle" />
            Enabled
          </label>
        </div>
      `;

      item.querySelector(".zone-item-title")?.addEventListener("click", () => {
        selectedZoneIndex = idx;
        renderZoneList();
        renderInspector();
      });

      item.querySelector(".zone-toggle")?.addEventListener("change", async (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        settings!.zones[idx].enabled = checked;
        await save();
      });

      listEl.appendChild(item);
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

    (document.getElementById("inspector-title") as HTMLElement).textContent = `Edit Zone: ${z.name}`;
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
    if (z.soft_start_limit != null) {
      softStartSel.value = `${z.soft_start_limit}`;
    } else {
      softStartSel.value = "none";
    }

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

  function renderGlobalPreferences() {
    if (!settings) return;
    (document.getElementById("g-admin") as HTMLInputElement).checked = settings.run_as_admin;
    (document.getElementById("g-fullscreen-disable") as HTMLInputElement).checked =
      settings.fullscreen_rule?.disable_in_fullscreen ?? true;

    // Time Profile
    const tp = settings.time_profile || { enabled: false, start_hour: 22, end_hour: 7, max_volume: 0.3 };
    (document.getElementById("night-enable") as HTMLInputElement).checked = tp.enabled;
    (document.getElementById("night-start") as HTMLInputElement).value = `${tp.start_hour}`;
    (document.getElementById("night-end") as HTMLInputElement).value = `${tp.end_hour}`;
    (document.getElementById("night-cap") as HTMLInputElement).value = `${Math.round(tp.max_volume * 100)}`;
    document.getElementById("night-cap-val")!.textContent = `${Math.round(tp.max_volume * 100)}%`;

    // OSD
    const osd = settings.osd || {
      enabled: true,
      duration_ms: 1000,
      position: "center",
      hide_in_fullscreen: true,
      theme: "auto",
    };
    (document.getElementById("g-osd") as HTMLInputElement).checked = osd.enabled;
    (document.getElementById("g-osd-hide-fullscreen") as HTMLInputElement).checked = osd.hide_in_fullscreen;
    (document.getElementById("g-osd-pos") as HTMLSelectElement).value = osd.position || "center";
    (document.getElementById("g-osd-dur") as HTMLInputElement).value = `${osd.duration_ms || 1000}`;
  }

  // Profile management event listeners
  document.getElementById("profile-select")?.addEventListener("change", async (e) => {
    const profId = (e.target as HTMLSelectElement).value;
    if (window.__TAURI__?.core) {
      try {
        settings = await window.__TAURI__.core.invoke<Settings>("switch_profile", { profileId: profId });
        selectedZoneIndex = 0;
        renderZoneList();
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
      renderZoneList();
      await save();
    }
  });

  // Inspector Input Event Listeners
  document.getElementById("z-name")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      settings.zones[selectedZoneIndex].name = (e.target as HTMLInputElement).value;
      renderZoneList();
      await save();
    }
  });

  document.getElementById("z-target")?.addEventListener("change", async (e) => {
    if (selectedZoneIndex !== null && settings) {
      const val = (e.target as HTMLSelectElement).value;
      if (val === "master") {
        settings.zones[selectedZoneIndex].target = { kind: "master" };
      } else if (val === "mic") {
        settings.zones[selectedZoneIndex].target = { kind: "mic" };
      } else if (val === "app_under_cursor") {
        settings.zones[selectedZoneIndex].target = { kind: "app_under_cursor" };
      } else if (val === "app") {
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
        settings.zones[selectedZoneIndex].shape = { type, radius: 8 };
      } else if (type === "screen_edge_strip") {
        settings.zones[selectedZoneIndex].shape = { type, edge: "top", thickness: 24 };
      } else {
        settings.zones[selectedZoneIndex].shape = { type };
      }
      renderInspector();
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

  // Zone Management Actions
  document.getElementById("add-zone-btn")?.addEventListener("click", async () => {
    if (!settings) return;
    const newId = `zone-${Date.now()}`;
    const newZone: ZoneConfig = {
      id: newId,
      name: `Custom Zone ${settings.zones.length + 1}`,
      monitor_id: null,
      rect: { x: 100, y: 100, width: 300, height: 60 },
      shape: { type: "rectangle" },
      visual_mode: "faint_tint",
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
      pulse_tint: true,
      enabled: true,
    };
    settings.zones.push(newZone);
    selectedZoneIndex = settings.zones.length - 1;
    renderZoneList();
    await save();
  });

  document.getElementById("dup-zone-btn")?.addEventListener("click", async () => {
    if (selectedZoneIndex === null || !settings) return;
    const orig = settings.zones[selectedZoneIndex];
    const copy: ZoneConfig = JSON.parse(JSON.stringify(orig));
    copy.id = `zone-${Date.now()}`;
    copy.name = `${orig.name} (Copy)`;
    copy.rect.x += 40;
    copy.rect.y += 40;
    settings.zones.push(copy);
    selectedZoneIndex = settings.zones.length - 1;
    renderZoneList();
    await save();
  });

  document.getElementById("del-zone-btn")?.addEventListener("click", async () => {
    if (selectedZoneIndex === null || !settings) return;
    settings.zones.splice(selectedZoneIndex, 1);
    selectedZoneIndex = settings.zones.length > 0 ? 0 : null;
    renderZoneList();
    await save();
  });

  // Global preferences listeners
  document.getElementById("g-admin")?.addEventListener("change", async (e) => {
    if (settings) {
      settings.run_as_admin = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

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
    if (settings && settings.time_profile) {
      settings.time_profile.start_hour = parseInt((e.target as HTMLInputElement).value) || 22;
      await save();
    }
  });

  document.getElementById("night-end")?.addEventListener("change", async (e) => {
    if (settings && settings.time_profile) {
      settings.time_profile.end_hour = parseInt((e.target as HTMLInputElement).value) || 7;
      await save();
    }
  });

  document.getElementById("night-cap")?.addEventListener("input", async (e) => {
    if (settings && settings.time_profile) {
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
        settings.osd = { enabled: true, duration_ms: 1000, position: "center", hide_in_fullscreen: true, theme: "auto" };
      }
      settings.osd.enabled = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  document.getElementById("g-osd-hide-fullscreen")?.addEventListener("change", async (e) => {
    if (settings && settings.osd) {
      settings.osd.hide_in_fullscreen = (e.target as HTMLInputElement).checked;
      await save();
    }
  });

  document.getElementById("g-osd-pos")?.addEventListener("change", async (e) => {
    if (settings && settings.osd) {
      settings.osd.position = (e.target as HTMLSelectElement).value as OsdPosition;
      await save();
    }
  });

  document.getElementById("g-osd-dur")?.addEventListener("change", async (e) => {
    if (settings && settings.osd) {
      settings.osd.duration_ms = parseInt((e.target as HTMLInputElement).value) || 1000;
      await save();
    }
  });

  // Live volume slider & test buttons
  document.getElementById("live-vol-slider")?.addEventListener("input", async (e) => {
    const val = parseInt((e.target as HTMLInputElement).value);
    document.getElementById("live-vol-label")!.textContent = `${val}%`;
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("set_master_volume", { level: val / 100 });
    }
  });

  document.getElementById("test-up-btn")?.addEventListener("click", async () => {
    if (window.__TAURI__?.core) {
      const newVol = await window.__TAURI__.core.invoke<number>("test_volume", { action: "up" });
      const pct = Math.round(newVol * 100);
      (document.getElementById("live-vol-slider") as HTMLInputElement).value = `${pct}`;
      document.getElementById("live-vol-label")!.textContent = `${pct}%`;
    }
  });

  document.getElementById("test-down-btn")?.addEventListener("click", async () => {
    if (window.__TAURI__?.core) {
      const newVol = await window.__TAURI__.core.invoke<number>("test_volume", { action: "down" });
      const pct = Math.round(newVol * 100);
      (document.getElementById("live-vol-slider") as HTMLInputElement).value = `${pct}`;
      document.getElementById("live-vol-label")!.textContent = `${pct}%`;
    }
  });

  document.getElementById("test-mute-btn")?.addEventListener("click", async () => {
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("toggle_master_mute");
    }
  });

  // Edit Mode toggle button
  document.getElementById("toggle-edit-btn")?.addEventListener("click", async () => {
    if (!window.__TAURI__?.core) return;
    const current = await window.__TAURI__.core.invoke<boolean>("get_edit_mode");
    await window.__TAURI__.core.invoke("set_edit_mode", { enabled: !current });
  });

  // Theme toggle button
  const themeBtn = document.getElementById("theme-btn")!;
  themeBtn.addEventListener("click", () => {
    const isDark = document.body.getAttribute("data-theme") !== "light";
    if (isDark) {
      document.body.setAttribute("data-theme", "light");
      themeBtn.textContent = "Dark Theme";
    } else {
      document.body.removeAttribute("data-theme");
      themeBtn.textContent = "Light Theme";
    }
  });

  // Configuration JSON import/export modal
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
        renderProfiles();
        renderZoneList();
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

  // Autostart toggle listener
  document.getElementById("g-autostart")?.addEventListener("change", async (e) => {
    if (window.__TAURI__?.core) {
      const enabled = (e.target as HTMLInputElement).checked;
      await window.__TAURI__.core.invoke("set_autostart_enabled", { enabled });
    }
  });

  // Open Logs Folder button
  document.getElementById("open-logs-btn")?.addEventListener("click", async () => {
    if (window.__TAURI__?.core) {
      await window.__TAURI__.core.invoke("open_logs_folder");
    }
  });

  // Panic button and resume button
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

  // External audio synchronization listener
  if (window.__TAURI__?.event) {
    window.__TAURI__.event.listen<[number, boolean]>("volume-synced", (evt) => {
      const [pct] = evt.payload;
      const slider = document.getElementById("live-vol-slider") as HTMLInputElement;
      const label = document.getElementById("live-vol-label")!;
      if (slider) slider.value = `${pct}`;
      if (label) label.textContent = `${pct}%`;
    });

    window.__TAURI__.event.listen("panic-triggered", () => {
      const panicEl = document.getElementById("panic-banner");
      const msgEl = document.getElementById("panic-msg");
      if (panicEl) panicEl.style.display = "flex";
      if (msgEl) msgEl.textContent = "⚠️ EMERGENCY PANIC ACTIVE: Wheel hooks disengaged for system safety.";
    });

    window.__TAURI__.event.listen("panic-cleared", () => {
      const panicEl = document.getElementById("panic-banner");
      if (panicEl) panicEl.style.display = "none";
    });

    window.__TAURI__.event.listen<string>("watchdog-stall-detected", (evt) => {
      const panicEl = document.getElementById("panic-banner");
      const msgEl = document.getElementById("panic-msg");
      if (panicEl) panicEl.style.display = "flex";
      if (msgEl) {
        msgEl.textContent = `⚠️ WATCHDOG HOOK STALL: ${evt.payload || "Hooks automatically uninstalled for safety."}`;
      }
    });
  }

  await loadSettings();
}

/* ==================== INITIALIZATION ==================== */

window.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const zoneId = params.get("zone_id");
  const view = params.get("view");

  if (zoneId) {
    initZoneOverlay(zoneId);
  } else if (view === "osd") {
    initOsdView();
  } else {
    initSettingsView();
  }
});
