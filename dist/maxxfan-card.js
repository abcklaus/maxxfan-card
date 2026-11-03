/*
 * Maxxfan Card – Lovelace-Karte für Home Assistant
 * Steuert einen Maxxfan-Dachlüfter (Modi Aus / Manuell / Auto, Drehzahl,
 * Richtung, Dachhaube, Zieltemperatur) direkt über MQTT-Entitäten und
 * mqtt.publish – ohne Template-Switches oder Skripte.
 */

const CARD_VERSION = "1.0.0";

const DEFAULTS = {
  name: "Maxxfan",
  mode_entity: "sensor.maxxfan_modus",
  fan_entity: "fan.maxxfan",
  temperature_entity: "number.maxxfan_zieltemperatur",
  direction_entity: "sensor.maxxfan_richtung_status",
  vent_entity: "sensor.maxxfan_dachluke_status",
  auto_entity: "sensor.maxxfan_auto_status",
  show_diagram: true,
};

// Alle Kommandos sind Toggles: ein leeres Payload schaltet um
const DEFAULT_TOPICS = {
  power: "pkw/cmnd/maxxfan/power",
  auto: "pkw/cmnd/maxxfan/auto",
  direction: "pkw/cmnd/maxxfan/direction",
  vent: "pkw/cmnd/maxxfan/vent",
};

const MODES = ["off", "manual", "auto"];

// Moduswechsel als Folge von Toggle-Topics bzw. Wartezeiten (ms),
// übernommen aus den bisherigen Skripten
const TRANSITIONS = {
  "off>manual": ["power"],
  "off>auto": ["auto"],
  "manual>off": ["power"],
  "manual>auto": ["auto"],
  "auto>off": ["power"],
  "auto>manual": ["power", 1000, "power"],
};

// Sperre nach einem Kommando, bis der Status sich ändert
const PENDING_TIMEOUT = 5000;

const LABELS = {
  de: {
    off: "Aus",
    manual: "Manuell",
    auto: "Auto",
    speed: "Stufe",
    direction: "Richtung",
    dir_in: "Rein",
    dir_out: "Raus",
    vent: "Dachhaube",
    vent_open: "Offen",
    vent_closed: "Zu",
    target: "Ziel",
    outside: "außen",
    inside: "innen",
    unavailable: "nicht verfügbar",
  },
  en: {
    off: "Off",
    manual: "Manual",
    auto: "Auto",
    speed: "Speed",
    direction: "Direction",
    dir_in: "In",
    dir_out: "Out",
    vent: "Lid",
    vent_open: "Open",
    vent_closed: "Closed",
    target: "Target",
    outside: "outside",
    inside: "inside",
    unavailable: "unavailable",
  },
};

const MODE_ICONS = { off: "mdi:fan-off", manual: "mdi:fan", auto: "mdi:fan-auto" };

// Seitenansicht nach Foto: Haube mit Scharnier links (104/96), öffnet um 24°.
// Die Schürze ist so bemessen, dass ihre Unterkante bei 24° auf der
// Gehäuseoberkante (y = 96) liegt; der clipPath blendet sie darunter aus.
const DIAGRAM = `
  <svg class="diagram" viewBox="0 0 400 176" role="img" aria-hidden="true">
    <defs>
      <clipPath id="mf-above"><rect x="0" y="0" width="400" height="96"/></clipPath>
    </defs>
    <text x="16" y="24" class="caption">{outside}</text>
    <text x="16" y="164" class="caption">{inside}</text>

    <!-- Luftstrom (liegt hinter Haube, Gehäuse und Dach) -->
    <g class="flow">
      <path class="base" d="M176 172 V100 Q176 40 236 40 H370"/>
      <path class="base" d="M200 172 V100 Q200 60 240 60 H370"/>
      <path class="base" d="M224 172 V100 Q224 80 244 80 H370"/>
      <path class="dash" d="M176 172 V100 Q176 40 236 40 H370"/>
      <path class="dash" d="M200 172 V100 Q200 60 240 60 H370"/>
      <path class="dash" d="M224 172 V100 Q224 80 244 80 H370"/>
      <g class="heads out">
        <path d="M363 33 L372 40 L363 47"/>
        <path d="M363 53 L372 60 L363 67"/>
        <path d="M363 73 L372 80 L363 87"/>
      </g>
      <g class="heads in">
        <path d="M169 163 L176 172 L183 163"/>
        <path d="M193 163 L200 172 L207 163"/>
        <path d="M217 163 L224 172 L231 163"/>
      </g>
    </g>

    <!-- Haube mit Seitenschürze -->
    <g clip-path="url(#mf-above)">
      <g class="lid">
        <path class="skirt" d="M104 96 L270 96 L270 170 Z"/>
        <path class="lid-body" d="M100 96 L100 90 Q102 82 114 81 L288 78 Q301 78 302 88 L302 96 Z"/>
        <path class="lid-shine" d="M118 85 L286 82"/>
        <text x="200" y="93" class="logo"><tspan class="maxx">MAXX</tspan><tspan class="fan">FAN</tspan></text>
      </g>
    </g>

    <!-- Gehäuse, Grundplatte, Dach -->
    <rect class="housing" x="106" y="96" width="186" height="14" rx="2"/>
    <rect class="plate" x="92" y="110" width="216" height="6" rx="2"/>
    <rect class="roof" x="0" y="116" width="400" height="14"/>
    <rect class="lining" x="0" y="130" width="400" height="3"/>
  </svg>`;

class MaxxfanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = undefined;
    this._hass = undefined;
    // laufende Toggle-Kommandos: key → { value, timer }
    this._pending = {};
    // Zielwerte bei schnellem Tippen auf ±: key → { value, timer }
    this._targets = {};
  }

  static getConfigElement() {
    return document.createElement("maxxfan-card-editor");
  }

  static getStubConfig() {
    return { name: DEFAULTS.name };
  }

  setConfig(config) {
    if (!config) throw new Error("Ungültige Konfiguration");
    this._config = { ...DEFAULTS, ...config, topics: { ...DEFAULT_TOPICS, ...(config.topics || {}) } };
    this._build();
    if (this._hass) this._update();
  }

  set hass(hass) {
    const langChanged = this._lang && this._lang !== this._langOf(hass);
    this._hass = hass;
    if (!this._config) return;
    if (langChanged || !this._lang) this._build();
    this._update();
  }

  getCardSize() {
    return this._config?.show_diagram === false ? 3 : 6;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  // ---------------------------------------------------------------- helpers

  _langOf(hass) {
    return (hass?.locale?.language || hass?.language || "de").slice(0, 2);
  }

  _t(key) {
    return (LABELS[this._langOf(this._hass)] || LABELS.en)[key] ?? LABELS.en[key] ?? key;
  }

  _stateOf(key) {
    const entityId = this._config[key];
    const stateObj = entityId ? this._hass?.states?.[entityId] : undefined;
    if (!stateObj || ["unavailable", "unknown"].includes(stateObj.state)) return null;
    return stateObj;
  }

  _isTrue(state) {
    return ["on", "true", "1", "open", "out"].includes(String(state).toLowerCase());
  }

  // Modus aus dem Modus-Sensor, sonst aus Auto-Status und Lüfterzustand abgeleitet
  _mode() {
    const s = this._stateOf("mode_entity");
    if (s) {
      const v = s.state.toLowerCase();
      if (["aus", "off"].includes(v)) return "off";
      if (["manuell", "manual"].includes(v)) return "manual";
      if (v === "auto") return "auto";
    }
    const auto = this._stateOf("auto_entity");
    const fan = this._stateOf("fan_entity");
    if (!auto && !fan) return null;
    if (auto && this._isTrue(auto.state)) return "auto";
    return fan?.state === "on" ? "manual" : "off";
  }

  // "out"/"in" – sensor (in/out) oder binary_sensor (on = out)
  _direction() {
    const s = this._stateOf("direction_entity");
    if (!s) return null;
    return this._isTrue(s.state) ? "out" : "in";
  }

  // true = offen – sensor (open/close) oder binary_sensor (on = offen)
  _ventOpen() {
    const s = this._stateOf("vent_entity");
    return s ? this._isTrue(s.state) : null;
  }

  _speedInfo() {
    const fan = this._stateOf("fan_entity");
    if (!fan) return null;
    const step = Number(fan.attributes.percentage_step) || 10;
    const max = Math.round(100 / step);
    const pct = Number(fan.attributes.percentage);
    const level = Number.isFinite(pct) ? Math.round(pct / step) : null;
    return { step, max, level, on: fan.state === "on" };
  }

  _tempInfo() {
    const num = this._stateOf("temperature_entity");
    if (!num) return null;
    const value = parseFloat(num.state);
    return {
      value: Number.isFinite(value) ? value : null,
      min: Number(num.attributes.min ?? 15),
      max: Number(num.attributes.max ?? 37),
      step: Number(num.attributes.step ?? 1),
      unit: num.attributes.unit_of_measurement || "°C",
    };
  }

  _format(value, precision = 0) {
    if (value === null || value === undefined) return "—";
    const locale = this._hass?.locale?.language || this._hass?.language || "de";
    return value.toLocaleString(locale, { minimumFractionDigits: precision, maximumFractionDigits: precision });
  }

  _moreInfo(entityId) {
    if (!entityId) return;
    const ev = new Event("hass-more-info", { bubbles: true, composed: true });
    ev.detail = { entityId };
    this.dispatchEvent(ev);
  }

  // ---------------------------------------------------------------- actions

  _watched(key) {
    if (key === "mode") return this._mode();
    if (key === "direction") return this._direction();
    if (key === "vent") return this._ventOpen();
    return undefined;
  }

  // Toggle senden und Taste sperren, bis sich der Status ändert (oder Timeout)
  async _run(key, fn) {
    if (this._pending[key]) return;
    const timer = setTimeout(() => this._clearPending(key), PENDING_TIMEOUT);
    const entry = { value: this._watched(key), timer, running: true };
    this._pending[key] = entry;
    this._update();
    try {
      await fn();
      entry.running = false;
      if (this._hass) this._update();
    } catch (err) {
      console.error("maxxfan-card:", err);
      this._clearPending(key);
    }
  }

  _clearPending(key) {
    clearTimeout(this._pending[key]?.timer);
    delete this._pending[key];
    if (this._hass) this._update();
  }

  _publish(name) {
    return this._hass.callService("mqtt", "publish", { topic: this._config.topics[name], payload: "" });
  }

  _setMode(target) {
    const from = this._mode();
    const steps = TRANSITIONS[`${from}>${target}`];
    if (!steps) return;
    this._run("mode", async () => {
      for (const step of steps) {
        if (typeof step === "number") await new Promise((r) => setTimeout(r, step));
        else await this._publish(step);
      }
    });
  }

  _toggle(key) {
    this._run(key, () => this._publish(key));
  }

  // Zielwert merken, damit mehrere schnelle Tipps sich aufaddieren
  _target(key, current) {
    const t = this._targets[key];
    if (t && t.value !== current) return t.value;
    if (t) this._clearTarget(key);
    return current;
  }

  _setTarget(key, value) {
    clearTimeout(this._targets[key]?.timer);
    const timer = setTimeout(() => this._clearTarget(key), PENDING_TIMEOUT);
    this._targets[key] = { value, timer };
  }

  _clearTarget(key) {
    clearTimeout(this._targets[key]?.timer);
    delete this._targets[key];
  }

  _changeSpeed(delta) {
    const info = this._speedInfo();
    if (!info || info.level === null) return;
    const level = Math.min(Math.max(this._target("speed", info.level) + delta, 1), info.max);
    this._setTarget("speed", level);
    this._hass
      .callService("fan", "set_percentage", { percentage: level * info.step }, { entity_id: this._config.fan_entity })
      .catch((err) => console.error("maxxfan-card:", err));
    this._update();
  }

  _changeTemp(delta) {
    const info = this._tempInfo();
    if (!info || info.value === null) return;
    const value = Math.min(Math.max(this._target("temp", info.value) + delta * info.step, info.min), info.max);
    this._setTarget("temp", value);
    this._hass
      .callService("number", "set_value", { value }, { entity_id: this._config.temperature_entity })
      .catch((err) => console.error("maxxfan-card:", err));
    this._update();
  }

  // ---------------------------------------------------------------- render

  _build() {
    const c = this._config;
    this._lang = this._langOf(this._hass);
    const modeBtn = (m) => `
      <button class="mode-btn" data-mode="${m}">
        <ha-icon icon="${MODE_ICONS[m]}"></ha-icon><span>${this._t(m)}</span>
      </button>`;
    const stepper = (cls, icon) => `
      <div class="stepper ${cls}">
        <button class="round minus" aria-label="−"><ha-icon icon="mdi:minus"></ha-icon></button>
        <div class="stepper-value">
          <div class="big"><ha-icon icon="${icon}"></ha-icon><span class="num">—</span></div>
          ${cls === "speed" ? `<div class="segments"></div>` : ""}
        </div>
        <button class="round plus" aria-label="+"><ha-icon icon="mdi:plus"></ha-icon></button>
      </div>`;
    const tile = (key) => `
      <button class="tile" data-tile="${key}">
        <ha-icon></ha-icon>
        <span class="tile-text"><span class="tile-label">${this._t(key)}</span><span class="tile-state">—</span></span>
      </button>`;
    const diagram = DIAGRAM.replace(/\{(\w+)\}/g, (_, k) => escapeHtml(this._t(k)));

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <div class="header">
          <ha-icon class="head-icon" icon="mdi:fan"></ha-icon>
          <span class="title">${escapeHtml(c.name || "")}</span>
          <span class="badge"><span class="dot"></span><span class="badge-text">—</span></span>
        </div>
        ${c.show_diagram !== false ? diagram : ""}
        <div class="status"></div>
        <div class="modes">${MODES.map(modeBtn).join("")}</div>
        <div class="controls">
          ${stepper("speed", "mdi:speedometer")}
          ${stepper("temp", "mdi:thermometer")}
          <div class="tiles">${tile("direction")}${tile("vent")}</div>
        </div>
      </ha-card>`;

    const root = this.shadowRoot;
    root.querySelectorAll(".mode-btn").forEach((b) => b.addEventListener("click", () => this._setMode(b.dataset.mode)));
    root.querySelector(".speed .minus").addEventListener("click", () => this._changeSpeed(-1));
    root.querySelector(".speed .plus").addEventListener("click", () => this._changeSpeed(1));
    root.querySelector(".temp .minus").addEventListener("click", () => this._changeTemp(-1));
    root.querySelector(".temp .plus").addEventListener("click", () => this._changeTemp(1));
    root.querySelectorAll(".tile").forEach((b) => b.addEventListener("click", () => this._toggle(b.dataset.tile)));
    root.querySelector(".diagram")?.addEventListener("click", () => this._moreInfo(c.fan_entity));
  }

  _update() {
    const root = this.shadowRoot;
    const card = root.querySelector("ha-card");
    if (!card) return;

    // erledigte Kommandos freigeben (Sequenz fertig und Status geändert)
    Object.entries(this._pending).forEach(([key, p]) => {
      if (p.running || this._watched(key) === p.value) return;
      clearTimeout(p.timer);
      delete this._pending[key];
    });

    const mode = this._mode();
    const dir = this._direction();
    const vent = this._ventOpen();
    const speed = this._speedInfo();
    const temp = this._tempInfo();
    card.dataset.mode = mode || "unavailable";

    // Kopf
    root.querySelector(".badge-text").textContent = mode ? this._t(mode) : this._t("unavailable");
    root.querySelector(".head-icon").setAttribute("icon", MODE_ICONS[mode] || "mdi:fan-alert");

    // Modus-Leiste
    const modeBusy = !!this._pending.mode;
    root.querySelectorAll(".mode-btn").forEach((b) => {
      const active = b.dataset.mode === mode;
      b.classList.toggle("active", active);
      b.classList.toggle("busy", modeBusy && !active);
      b.disabled = !mode || modeBusy || active;
    });

    // Bedienelemente je Modus
    const show = (sel, visible) => root.querySelector(sel).classList.toggle("hidden", !visible);
    show(".speed", mode === "manual");
    show(".temp", mode === "auto");
    show('[data-tile="direction"]', mode === "manual");
    show('[data-tile="vent"]', mode === "manual" || mode === "off");
    show(".tiles", mode === "manual" || mode === "off");

    // Drehzahl
    const level = speed?.level == null ? null : this._target("speed", speed.level);
    root.querySelector(".speed .num").textContent =
      level === null ? "—" : `${this._t("speed")} ${level} / ${speed.max}`;
    const segs = root.querySelector(".segments");
    if (speed && segs.childElementCount !== speed.max) {
      segs.innerHTML = Array.from({ length: speed.max }, () => "<i></i>").join("");
    }
    [...segs.children].forEach((s, i) => s.classList.toggle("on", level !== null && i < level));
    root.querySelector(".speed .minus").disabled = level === null || level <= 1;
    root.querySelector(".speed .plus").disabled = level === null || level >= (speed?.max ?? 0);

    // Zieltemperatur
    const t = temp?.value == null ? null : this._target("temp", temp.value);
    root.querySelector(".temp .num").textContent =
      t === null ? "—" : `${this._format(t, temp.step < 1 ? 1 : 0)} ${temp.unit} ${this._t("target")}`;
    root.querySelector(".temp .minus").disabled = t === null || t <= temp.min;
    root.querySelector(".temp .plus").disabled = t === null || t >= temp.max;

    // Kacheln Richtung / Dachhaube
    const setTile = (key, icon, text, flag) => {
      const el = root.querySelector(`[data-tile="${key}"]`);
      el.querySelector("ha-icon").setAttribute("icon", icon);
      el.querySelector(".tile-state").textContent = text;
      el.dataset.state = flag;
      el.classList.toggle("busy", !!this._pending[key]);
      el.disabled = flag === "unknown" || !!this._pending[key];
    };
    setTile(
      "direction",
      dir === "in" ? "mdi:import" : "mdi:export",
      dir ? this._t(`dir_${dir}`) : "—",
      dir || "unknown"
    );
    setTile(
      "vent",
      vent ? "mdi:window-shutter-open" : "mdi:window-shutter",
      vent === null ? "—" : this._t(vent ? "vent_open" : "vent_closed"),
      vent === null ? "unknown" : vent ? "open" : "closed"
    );

    // Statuszeile im Auto-Modus (nur Anzeige, keine Stufe)
    const status = root.querySelector(".status");
    status.textContent =
      mode === "auto"
        ? [dir && this._t(`dir_${dir}`), vent !== null && `${this._t("vent")} ${this._t(vent ? "vent_open" : "vent_closed").toLowerCase()}`]
            .filter(Boolean)
            .join(" · ")
        : "";

    // Grafik
    const svg = root.querySelector(".diagram");
    if (!svg) return;
    const running = !!speed?.on && mode !== "off";
    // Manuell: Tempo nach Stufe; Auto: festes Tempo
    const ratio = mode === "manual" && level ? level / speed.max : 0.5;
    svg.style.setProperty("--flow", `${(2.4 - ratio * 1.8).toFixed(2)}s`);
    svg.classList.toggle("open", !!vent);
    svg.classList.toggle("flowing", running && !!vent);
    svg.dataset.dir = dir || "out";
  }
}

// -------------------------------------------------------------------- editor

const EDITOR_SCHEMA = [
  { name: "name", selector: { text: {} } },
  { name: "mode_entity", selector: { entity: { domain: "sensor" } } },
  { name: "fan_entity", selector: { entity: { domain: "fan" } } },
  { name: "temperature_entity", selector: { entity: { domain: "number" } } },
  { name: "direction_entity", selector: { entity: { domain: ["sensor", "binary_sensor"] } } },
  { name: "vent_entity", selector: { entity: { domain: ["sensor", "binary_sensor"] } } },
  { name: "auto_entity", selector: { entity: { domain: ["sensor", "binary_sensor"] } } },
  {
    type: "expandable",
    name: "topics",
    title: "MQTT-Topics (Toggle, leeres Payload)",
    schema: [
      { name: "power", selector: { text: {} } },
      { name: "auto", selector: { text: {} } },
      { name: "direction", selector: { text: {} } },
      { name: "vent", selector: { text: {} } },
    ],
  },
  { name: "show_diagram", selector: { boolean: {} } },
];

const EDITOR_LABELS = {
  name: "Titel",
  mode_entity: "Modus (Aus / Manuell / Auto)",
  fan_entity: "Lüfter (Drehzahl)",
  temperature_entity: "Zieltemperatur",
  direction_entity: "Richtung (in / out)",
  vent_entity: "Dachhaube (open / close)",
  auto_entity: "Auto-Status (Fallback ohne Modus-Sensor)",
  power: "Ein/Aus",
  auto: "Auto",
  direction: "Richtung",
  vent: "Dachhaube",
  show_diagram: "Grafik anzeigen",
};

class MaxxfanCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...DEFAULTS, ...config, topics: { ...DEFAULT_TOPICS, ...(config.topics || {}) } };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] ?? s.title ?? s.name;
      this._form.addEventListener("value-changed", (ev) => {
        const config = { ...ev.detail.value };
        // leere Felder und Standard-Topics nicht in die YAML schreiben
        Object.keys(config).forEach((k) => {
          if (config[k] === "" || config[k] === undefined) delete config[k];
        });
        if (config.topics) {
          const topics = { ...config.topics };
          Object.keys(topics).forEach((k) => {
            if (!topics[k] || topics[k] === DEFAULT_TOPICS[k]) delete topics[k];
          });
          if (Object.keys(topics).length) config.topics = topics;
          else delete config.topics;
        }
        this.dispatchEvent(
          new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true })
        );
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = this._config;
  }
}

// -------------------------------------------------------------------- styles

const STYLES = `
  :host {
    /* per card-mod überschreibbar */
    --maxxfan-active: #e8821e;
    --maxxfan-off: #8a8a8a;
    --maxxfan-out: #e8821e;
    --maxxfan-in: #2f8fdd;
    --maxxfan-open: #43a047;
    --maxxfan-muted: var(--divider-color, rgba(127,127,127,0.3));
  }
  ha-card { display: block; overflow: hidden; padding: 0 0 16px; }
  ha-card[data-mode="off"] { --mode-c: var(--maxxfan-off); }
  ha-card[data-mode="manual"], ha-card[data-mode="auto"] { --mode-c: var(--maxxfan-active); }
  ha-card[data-mode="unavailable"] { --mode-c: var(--disabled-text-color, #999); }
  .hidden { display: none !important; }
  button { font: inherit; color: inherit; }

  .header {
    display: flex; align-items: center; gap: 8px;
    padding: 16px 16px 0; font-size: 1.25em; font-weight: 500;
    color: var(--primary-text-color);
  }
  .head-icon { color: var(--mode-c); }
  .title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px; border-radius: 999px; font-size: 0.6em; font-weight: 600;
    background: color-mix(in srgb, var(--mode-c) 18%, transparent); color: var(--mode-c);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--mode-c); }

  /* ---- Grafik ---- */
  .diagram { display: block; width: 100%; max-width: 420px; margin: 4px auto 0; padding: 0 12px; box-sizing: border-box; cursor: pointer; }
  .caption { font-size: 12px; font-weight: 600; fill: var(--secondary-text-color); }
  .roof { fill: #9aa0a6; }
  .lining { fill: var(--maxxfan-muted); }
  .plate { fill: #d5d8db; stroke: #a9aeb3; stroke-width: 1; }
  .housing, .skirt { fill: #f3f4f5; stroke: #b0b5ba; stroke-width: 1.5; stroke-linejoin: round; }
  .skirt { fill: #e6e8ea; }

  .lid { transform-box: view-box; transform-origin: 104px 96px; transition: transform .9s ease-in-out; }
  .open .lid { transform: rotate(-24deg); }
  .lid-body { fill: #202428; stroke: #555c63; stroke-width: 1.5; stroke-linejoin: round; }
  .lid-shine { fill: none; stroke: rgba(255,255,255,.35); stroke-width: 2; stroke-linecap: round; }
  .logo { font-size: 9px; font-weight: 800; font-style: italic; text-anchor: middle; }
  .maxx { fill: #e53935; }
  .fan { fill: #4f7cff; }

  .flow { --c: var(--maxxfan-out); opacity: 0; transition: opacity .4s; }
  .diagram[data-dir="in"] .flow { --c: var(--maxxfan-in); }
  .flowing .flow { opacity: 1; }
  .flow path { fill: none; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
  .flow .base { stroke: color-mix(in srgb, var(--c) 30%, transparent); }
  .flow .dash { stroke: var(--c); stroke-dasharray: 3 11; animation: flow var(--flow, 1.5s) linear infinite; }
  .diagram[data-dir="in"] .flow .dash { animation-direction: reverse; }
  .heads path { stroke: var(--c); }
  .heads { display: none; }
  .diagram[data-dir="out"] .heads.out, .diagram[data-dir="in"] .heads.in { display: inline; }

  ha-card[data-mode="off"] .diagram, ha-card[data-mode="unavailable"] .diagram { opacity: .6; }
  @keyframes flow { to { stroke-dashoffset: -14; } }
  @keyframes pulse { 50% { opacity: .45; } }
  @media (prefers-reduced-motion: reduce) {
    .flow .dash { animation: none; stroke-dasharray: none; }
    .lid { transition: none; }
  }

  .status {
    text-align: center; font-size: 0.9em; font-weight: 600; margin-top: 2px;
    color: var(--secondary-text-color);
  }
  .status:empty { display: none; }

  /* ---- Modus-Leiste ---- */
  .modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 12px 16px 0; }
  .mode-btn {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 48px; padding: 0 8px; border: none; cursor: pointer;
    border-radius: var(--ha-card-border-radius, 12px);
    background: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
    color: var(--secondary-text-color); font-weight: 600;
    transition: background .3s, color .3s;
  }
  .mode-btn ha-icon { --mdc-icon-size: 22px; }
  .mode-btn.active { background: var(--mode-c); color: #fff; cursor: default; }
  .mode-btn:disabled:not(.active) { cursor: default; }
  .mode-btn.busy { animation: pulse 1s ease-in-out infinite; }
  .mode-btn:focus-visible, .tile:focus-visible, .round:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }

  /* ---- Bedienelemente ---- */
  .controls { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px 0; }
  .stepper { display: flex; align-items: center; gap: 12px; }
  .round {
    flex: none; width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
    background: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
    display: flex; align-items: center; justify-content: center;
  }
  .round ha-icon { --mdc-icon-size: 28px; }
  .minus ha-icon { color: var(--error-color, #db4437); }
  .plus ha-icon { color: var(--success-color, #43a047); }
  .round:disabled { opacity: .35; cursor: default; }
  .stepper-value { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .big {
    display: flex; align-items: center; gap: 6px; white-space: nowrap;
    font-size: 1.3em; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--primary-text-color);
  }
  .big ha-icon { color: var(--secondary-text-color); }
  .segments { display: flex; gap: 3px; width: 100%; max-width: 180px; }
  .segments i { flex: 1; height: 8px; border-radius: 2px; background: var(--maxxfan-muted); transition: background .3s; }
  .segments i.on { background: var(--maxxfan-active); }

  .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .tile {
    --c: var(--secondary-text-color);
    display: flex; align-items: center; gap: 10px; min-width: 0;
    padding: 10px 12px; border: none; cursor: pointer; text-align: left;
    border-radius: var(--ha-card-border-radius, 12px);
    background: color-mix(in srgb, var(--c) 12%, transparent);
  }
  .tile ha-icon {
    flex: none; color: var(--c); padding: 8px; border-radius: 50%;
    background: color-mix(in srgb, var(--c) 20%, transparent);
  }
  .tile[data-state="out"] { --c: var(--maxxfan-out); }
  .tile[data-state="in"] { --c: var(--maxxfan-in); }
  .tile[data-state="open"] { --c: var(--maxxfan-open); }
  .tile:disabled { cursor: default; }
  .tile.busy { animation: pulse 1s ease-in-out infinite; }
  .tile-text { display: flex; flex-direction: column; min-width: 0; }
  .tile-label { font-weight: 600; color: var(--primary-text-color); }
  .tile-state { font-size: 0.85em; color: var(--secondary-text-color); }
  .tile-label, .tile-state { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// -------------------------------------------------------------------- register

if (!customElements.get("maxxfan-card")) {
  customElements.define("maxxfan-card", MaxxfanCard);
}
if (!customElements.get("maxxfan-card-editor")) {
  customElements.define("maxxfan-card-editor", MaxxfanCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "maxxfan-card")) {
  window.customCards.push({
    type: "maxxfan-card",
    name: "Maxxfan Card",
    description: "Steuerung eines Maxxfan-Dachlüfters (Aus / Manuell / Auto) direkt über MQTT.",
    preview: true,
    documentationURL: "https://github.com/abcklaus/maxxfan-card",
  });
}

console.info(
  `%c MAXXFAN-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#e8821e;font-weight:700;",
  "color:#e8821e;background:#fff;font-weight:700;"
);
