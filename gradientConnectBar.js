// NAME: Gradient Connect Bar
// VERSION: 0.4.0
// AUTHOR: VoidCrowned
// REPO: https://github.com/VoidCrowned/spicetify-gradient-connect-bar
// DESCRIPTION: Recolours Spotify's Connect bar ("Playing on …") with a solid colour or a multi-stop gradient.
// LICENSE: WTFPL v2, see LICENSE
//
// Compatibility rules (details in CLAUDE.md → Hard rules):
//  1. One injected stylesheet (<style id="gcb-style">), fully regenerated. No inline styles on Spotify
//     elements and no stored reference to the bar: Spotify removes and re-creates it.
//  2. Every rule targets the Connect bar through SELECTOR only. No hashed class names.
//  3. Paints background-image only, opaque colours only. --background-base is never changed.
//  4. No !important — rules win by specificity only.
//  5. Never reads or writes Gradient Progress Bar's storage key; both run side by side.

(async function gcb() {
  "use strict";

  const VERSION = "0.4.0";
  // Where this copy was loaded from: the Marketplace (jsDelivr) or the CLI (Extensions folder).
  // currentScript is only set before the first await, so capture it here.
  const SOURCE = document.currentScript?.src || null;

  // The Connect bar ("Playing on …" below the player), verified on Spotify 1.3.4.258 (CLAUDE.md →
  // Verified facts). Spotify only renders it while audio plays on another device and removes it when
  // playback comes back. Found by the aside's test id, Encore's readable set class and its icon +
  // text-link children; its hashed classes change with every Spotify build.
  const SELECTOR =
    '[data-testid="now-playing-bar"] > .encore-bright-accent-set:has(> svg[data-encore-id="icon"] + button[data-encore-id="textLink"])';
  const PARENT = '[data-testid="now-playing-bar"]'; // the aside the bar lives in
  const UNSCOPED = SELECTOR.slice(`${PARENT} > `.length); // the self-test counts this too ("parent changed")
  const BAR_ICON = ':scope > svg[data-encore-id="icon"]';
  const BAR_LINK = ':scope > button[data-encore-id="textLink"]';

  // ── Start-up status ─────────────────────────────────────────────────────────
  // window.__gcb exists from the first line, so a stuck or failed start-up is visible in devtools
  // (`__gcb.status()`) instead of failing silently.

  const startup = { phase: "waiting for Spicetify", waitingFor: [], entry: null, entryErrors: [], error: null, since: Date.now() };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = (name) => window.Spicetify?.[name];
  const notReady = (what) => () => console.warn(`[gcb] Not ready (${startup.phase}) — ${what} needs a started extension.`);
  // Entry-point state (#34, #35). Up here because status() can run while start-up still waits.
  let menuRegistered = false;
  let shared = null; // our handle on the shared top-bar entry: joinGradientBars()
  const menuItemVerdicts = new WeakMap(); // MenuItem component → usable?

  window.__gcb = {
    version: VERSION,
    status: () => statusReport(),
    selfTest: async () => {
      notReady("the self-test")();
      return statusReport();
    },
    openSettings: notReady("the settings"),
  };

  // Rendering only needs storage; the modal needs PopupModal and Player.
  const REQUIRED = ["LocalStorage", "PopupModal", "Player"];
  let warned = false;
  while (REQUIRED.some((name) => !api(name))) {
    startup.waitingFor = REQUIRED.filter((name) => !api(name));
    if (!warned && Date.now() - startup.since > 10000) {
      warned = true;
      console.warn(`[gcb] Still waiting for Spicetify APIs: ${startup.waitingFor.join(", ")}`);
    }
    await sleep(300);
  }
  startup.waitingFor = [];
  startup.phase = "starting";

  const STORAGE_KEY = "gcb:settings";
  const GPB_STORAGE_KEY = "gpb:settings"; // Gradient Progress Bar's: never read or written, only compared (#2)
  const SCHEMA_VERSION = 2; // 2: no transparency (MIGRATIONS[1])
  const MAX_STOPS = 8;
  const SAVE_DELAY = 250;
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const KINDS = ["theme", "custom"]; // opaque only, like GPB

  // Never resolved to a hex, so it follows runtime theme changes (e.g. Hazy's per-song accent).
  const THEME_COLOUR = "var(--spice-button, var(--spice-text, #1db954))";
  // Text colour (#11): Auto picks black or white by worst-case contrast; "default" overrides nothing.
  const TEXT_MODES = ["auto", "black", "white", "default"];
  const DEFAULT_TEXT = "auto";

  // ── Settings ────────────────────────────────────────────────────────────────

  function defaultSettings() {
    return { version: SCHEMA_VERSION, gradient: false, textColour: DEFAULT_TEXT, stops: [{ id: "s1", kind: "theme" }] };
  }

  // One step per schema version: MIGRATIONS[n] turns version-n data into version n + 1. A schema
  // change adds its step here instead of dropping older settings.
  const MIGRATIONS = {
    // 1 → 2: transparency is gone. Fully transparent stops (kind "transparent", or a #rrggbbaa with
    // alpha 00) are dropped, partly transparent ones (#rrggbbaa) keep their RGB. If that leaves no
    // stops, the defaults. Anything else is passed on as it was, for validateSettings() to judge.
    1: (data) => {
      if (!Array.isArray(data.stops) || !data.stops.length) return { ...data, version: 2 };
      const stops = data.stops.flatMap((stop) => {
        if (stop?.kind === "transparent") return [];
        const color = stop?.kind === "custom" && typeof stop.color === "string" ? stop.color : "";
        if (!/^#[0-9a-f]{8}$/i.test(color)) return [stop];
        return color.slice(7) === "00" ? [] : [{ ...stop, color: color.slice(0, 7) }];
      });
      return stops.length ? { ...data, version: 2, stops } : defaultSettings();
    },
  };

  function migrate(data) {
    let current = data;
    while (current && typeof current === "object" && Number.isInteger(current.version) &&
      current.version < SCHEMA_VERSION && typeof MIGRATIONS[current.version] === "function") {
      current = MIGRATIONS[current.version](structuredClone(current));
    }
    return current;
  }

  // Returns a clean copy of `data`, or null if it isn't valid settings.
  function validateSettings(data) {
    if (!data || typeof data !== "object" || data.version !== SCHEMA_VERSION) return null;
    if (typeof data.gradient !== "boolean" || !Array.isArray(data.stops)) return null;
    if (data.stops.length < 1 || data.stops.length > MAX_STOPS) return null;
    // Settings saved before the text colour option (#11) have none; anything else unknown is invalid.
    const textColour = data.textColour === undefined ? DEFAULT_TEXT : data.textColour;
    if (!TEXT_MODES.includes(textColour)) return null;

    const ids = new Set();
    const stops = [];
    for (const stop of data.stops) {
      if (!stop || typeof stop.id !== "string" || !stop.id || ids.has(stop.id) || !KINDS.includes(stop.kind)) return null;
      ids.add(stop.id);
      if (stop.kind === "theme") stops.push({ id: stop.id, kind: "theme" });
      else if (HEX_RE.test(stop.color)) stops.push({ id: stop.id, kind: "custom", color: stop.color.toLowerCase() });
      else return null;
    }
    // A gradient needs at least two stops.
    return { version: SCHEMA_VERSION, gradient: data.gradient && stops.length > 1, textColour, stops };
  }

  // Invalid data → defaults (written back) and one [gcb] warning. Settings from a newer version of
  // this extension → defaults too, but the stored value is left alone until the next save.
  function loadSettings(raw = Spicetify.LocalStorage.get(STORAGE_KEY)) {
    if (raw == null) return defaultSettings();

    let data = null;
    try {
      data = migrate(JSON.parse(raw));
    } catch {}
    const valid = validateSettings(data);
    if (valid) return valid;

    if (Number.isInteger(data?.version) && data.version > SCHEMA_VERSION) {
      console.warn("[gcb] Saved settings are from a newer version of the extension; using defaults.");
      return defaultSettings();
    }
    console.warn("[gcb] Saved settings were invalid and have been reset to defaults.");
    const defaults = defaultSettings();
    Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(defaults));
    return defaults;
  }

  let saveTimer = 0;

  // Debounced: colour pickers fire many input events per second.
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSettings, SAVE_DELAY);
  }

  function flushSettings() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(settings));
  }

  // ── Presets and share codes (#29, #36) ──────────────────────────────────────
  // Ported from GPB (GPB #21, #51, #53), without Spread and with the text colour. Own presets
  // live in their own key with their own version, so gcb:settings never changes; GPB's
  // gpb:presets is never read. Every stored preset and every imported code goes through
  // validateSettings().

  const PRESETS_KEY = "gcb:presets";
  const PRESETS_VERSION = 1;
  const MAX_PRESETS = 12;
  const PRESET_NAME_MAX = 24;
  const CODE_PREFIX = "gcb1:"; // the code's format version; a future schema bumps it
  const GPB_CODE_PREFIX = "gpb1:"; // Gradient Progress Bar's codes import too (#36)
  const TEXT_CODES = { auto: "a", black: "b", white: "w", default: "d" };
  const GPB_MODE_CODES = ["c", "a", "s"]; // GPB's Spread modes: checked as GPB checks them, then dropped

  // Colours only, all fixed, the same five as GPB (#53 there): applying one keeps the current
  // text colour. They can't be renamed or deleted, and they have their own chip row.
  const BUILT_IN_PRESETS = [
    { id: "b:void", name: "Void", colours: ["#8372fd", "#5a82ff", "#8372fd"] },
    { id: "b:sunset", name: "Sunset", colours: ["#6e33ff", "#ff5f6d", "#ffc371"] },
    { id: "b:aurora", name: "Aurora", colours: ["#00f5a0", "#00d9f5", "#7f5af0"] },
    { id: "b:neon", name: "Neon", colours: ["#ff00cc", "#3333ff", "#33f7ff"] },
    { id: "b:fairy", name: "Fairy", colours: ["#ff59d1", "#ffb800", "#77bc00"] },
  ].map((preset) => ({ ...preset, builtIn: true }));

  let presets = []; // own presets: [{ id, name, settings: { gradient, textColour, stops } }]

  // What a preset stores: the settings without the schema version.
  function snapshot(s) {
    return { gradient: s.gradient, textColour: s.textColour, stops: s.stops.map((stop) => ({ ...stop })) };
  }

  // The settings a preset applies. A built-in keeps the current text colour.
  function presetSettings(preset, current = settings) {
    if (!preset.builtIn) return { version: SCHEMA_VERSION, ...structuredClone(preset.settings) };
    const stops = preset.colours.map((color, i) => ({ id: `s${i + 1}`, kind: "custom", color }));
    return { version: SCHEMA_VERSION, gradient: true, textColour: current.textColour, stops };
  }

  // Equal settings, ignoring stop ids. Built-ins therefore compare colours only (their text
  // colour is the current one).
  function sameSettings(a, b) {
    return a.gradient === b.gradient && a.textColour === b.textColour && a.stops.length === b.stops.length &&
      a.stops.every((stop, i) => stop.kind === b.stops[i].kind && stop.color === b.stops[i].color);
  }

  const matchesPreset = (preset, s = settings) => sameSettings(s, presetSettings(preset, s));

  const presetById = (id) => BUILT_IN_PRESETS.find((p) => p.id === id) ?? presets.find((p) => p.id === id) ?? null;

  // A clean own preset, or null. Names are trimmed and 1–24 characters long.
  function validatePreset(entry) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id || typeof entry.name !== "string")
      return null;
    const name = entry.name.trim();
    if (!name || name.length > PRESET_NAME_MAX) return null;
    const valid = validateSettings({ ...entry.settings, version: SCHEMA_VERSION });
    return valid && { id: entry.id, name, settings: snapshot(valid) };
  }

  // Invalid entries (and any beyond 12) are dropped with one warning; an unreadable key gives
  // an empty list and one warning. Storage is only rewritten by the next change.
  function loadPresets(raw = Spicetify.LocalStorage.get(PRESETS_KEY)) {
    if (raw == null) return [];
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {}
    if (!data || data.version !== PRESETS_VERSION || !Array.isArray(data.presets)) {
      console.warn("[gcb] Saved presets were unreadable and have been ignored.");
      return [];
    }
    const list = [];
    for (const entry of data.presets) {
      const preset = validatePreset(entry);
      if (!preset || list.length >= MAX_PRESETS || list.some((p) => p.id === preset.id)) continue;
      preset.name = uniqueName(preset.name, list);
      list.push(preset);
    }
    const dropped = data.presets.length - list.length;
    if (dropped) console.warn(`[gcb] ${dropped} saved preset${dropped === 1 ? " was" : "s were"} invalid and dropped.`);
    return list;
  }

  function savePresets() {
    Spicetify.LocalStorage.set(PRESETS_KEY, JSON.stringify({ version: PRESETS_VERSION, presets }));
  }

  // Trimmed, at most 24 characters, and unique among the built-ins and `list` (case-insensitive,
  // `exceptId` aside): a clash gets " (2)", " (3)" and so on.
  function uniqueName(name, list = presets, exceptId = null) {
    const base = name.trim().slice(0, PRESET_NAME_MAX);
    const taken = new Set([...BUILT_IN_PRESETS, ...list].filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const suffix = ` (${n})`;
      const candidate = base.slice(0, PRESET_NAME_MAX - suffix.length).trimEnd() + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  const defaultPresetName = () => uniqueName(`Preset ${presets.length + 1}`);

  function nextPresetId() {
    const ids = new Set(presets.map((p) => p.id));
    let n = 1;
    while (ids.has(`p${n}`)) n++;
    return `p${n}`;
  }

  // Saves the current settings as a new own preset. Returns it, or null at the limit.
  function addPreset(name) {
    if (presets.length >= MAX_PRESETS) return null;
    const preset = { id: nextPresetId(), name: uniqueName(name.trim() || defaultPresetName()), settings: snapshot(settings) };
    presets.push(preset);
    savePresets();
    return preset;
  }

  function renamePreset(id, name) {
    const preset = presets.find((p) => p.id === id);
    if (!preset || !name.trim()) return false;
    preset.name = uniqueName(name, presets, id);
    savePresets();
    return true;
  }

  function updatePreset(id) {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return false;
    preset.settings = snapshot(settings);
    savePresets();
    return true;
  }

  // Own presets only: a built-in id finds nothing. Returns { preset, index } for Undo, or null.
  function deletePreset(id) {
    const index = presets.findIndex((p) => p.id === id);
    if (index === -1) return null;
    const [preset] = presets.splice(index, 1);
    savePresets();
    return { preset, index };
  }

  function restorePreset({ preset, index }) {
    presets.splice(Math.min(index, presets.length), 0, preset);
    savePresets();
  }

  const toBase64Url = (data) => btoa(JSON.stringify(data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // gcb1: + base64url(JSON) of { g: 0|1, x: "a"|"b"|"w"|"d", s: ["t" | "rrggbb", …] }, t = theme,
  // x = the text colour.
  function encodeCode(s) {
    return CODE_PREFIX + toBase64Url({
      g: s.gradient ? 1 : 0,
      x: TEXT_CODES[s.textColour],
      s: s.stops.map((stop) => (stop.kind === "theme" ? "t" : stop.color.slice(1))),
    });
  }

  // { settings, from: "gcb" | "gpb" } from a share code, checked by validateSettings(), or null.
  // gpb1: is decoded exactly as GPB's decodeCode() does (its Spread mode must be valid), then the
  // mode is dropped and `current`'s text colour kept. Surrounding whitespace is fine; an unknown
  // prefix or version isn't.
  function decodeCode(text, current = settings) {
    const code = String(text ?? "").trim();
    const prefix = [CODE_PREFIX, GPB_CODE_PREFIX].find((candidate) => code.startsWith(candidate));
    const body = prefix ? code.slice(prefix.length) : "";
    if (!prefix || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
    let data = null;
    try {
      data = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      return null;
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.s)) return null;
    const fromGpb = prefix === GPB_CODE_PREFIX;
    if (fromGpb && !GPB_MODE_CODES.includes(data.m)) return null;
    // Anything unexpected is passed on as a value validateSettings() rejects.
    const textColour = fromGpb ? current.textColour : Object.keys(TEXT_CODES).find((key) => TEXT_CODES[key] === data.x) ?? null;
    const valid = validateSettings({
      version: SCHEMA_VERSION,
      gradient: data.g === 1 ? true : data.g === 0 ? false : null,
      textColour,
      stops: data.s.map((value, i) =>
        value === "t"
          ? { id: `s${i + 1}`, kind: "theme" }
          : { id: `s${i + 1}`, kind: "custom", color: typeof value === "string" ? `#${value}` : null }
      ),
    });
    return valid && { settings: valid, from: fromGpb ? "gpb" : "gcb" };
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  function stopColour(stop) {
    return stop.kind === "theme" ? THEME_COLOUR : stop.color;
  }

  // A solid theme colour leaves the bar its own colour: no background rule.
  function isInert(s) {
    return !s.gradient && s.stops[0].kind === "theme";
  }

  // The stops actually drawn: all of them for a gradient, otherwise just the first.
  function activeStops(s) {
    return s.gradient ? s.stops : [s.stops[0]];
  }

  // The bar's background image — also used by the modal preview so the two can't drift. Stops are
  // evenly spaced across the bar's full width; nothing follows playback (#6).
  function barImage(s) {
    const colours = activeStops(s).map(stopColour);
    if (colours.length === 1) colours.push(colours[0]);
    return `linear-gradient(to right, ${colours.join(", ")})`;
  }

  // One rule on the bar. The selector is 0,4,2, so it beats any theme's rules without !important.
  // background-image only: Spotify's background-color (var(--background-base)) stays underneath.
  // `textColour` (#14) is a literal colour for the text and the icon, or null to leave them to
  // Spotify; --text-base and --essential-base change inside this rule only, never globally.
  function buildCss(s, textColour = null) {
    const declarations = [];
    if (!isInert(s)) declarations.push(`background-image: ${barImage(s)};`);
    if (textColour) declarations.push(`--text-base: ${textColour};`, `--essential-base: ${textColour};`);
    if (!declarations.length) return "";
    return [`${SELECTOR} {`, ...declarations.map((line) => `  ${line}`), `}`, ``].join("\n");
  }

  function applyCss() {
    let style = document.getElementById("gcb-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "gcb-style";
      document.head.appendChild(style);
    }
    const css = buildCss(settings, appliedTextColour());
    if (style.textContent !== css) style.textContent = css;
  }

  // Called after every settings change: bar first, then the open modal, then storage.
  // `rerender: false` for picker edits — the dots are updated in place instead. The text colour
  // follows, debounced (#15).
  function update({ rerender = true } = {}) {
    applyCss();
    if (modal) {
      rerender ? renderModal() : renderPreview();
      renderPresetStates();
    }
    // An Undo for applied settings would throw away later edits, so any other change drops it.
    if (pendingUndo?.after && pendingUndo.after !== JSON.stringify(settings)) clearUndo();
    scheduleTextColour();
    saveSettings();
  }

  // The bar, queried on demand. Never stored: Spotify removes and re-creates it.
  const findBar = () => document.querySelector(SELECTOR);

  // ── Colours ─────────────────────────────────────────────────────────────────

  let colourCtx = null;

  // Any opaque CSS colour → #rrggbb, or null if it isn't one. Colours are opaque only, like GPB's:
  // the canvas serialises anything translucent as rgba(), which counts as no colour.
  function toHex(value) {
    if (!value || !CSS.supports("color", value)) return null;
    colourCtx ??= document.createElement("canvas").getContext("2d");
    colourCtx.fillStyle = "#000000";
    colourCtx.fillStyle = value;
    const out = colourCtx.fillStyle;
    return out.startsWith("#") ? out : null;
  }

  const rootColour = (name) => toHex(getComputedStyle(document.documentElement).getPropertyValue(name).trim());

  // The live theme colour a theme stop draws, as #rrggbb (the CSS itself uses THEME_COLOUR).
  const themeHex = () => rootColour("--spice-button") || rootColour("--spice-text") || "#1db954";

  // The bar's own colour, kept under a solid theme colour and shown under the preview: the live
  // bar's computed background-color (Spotify paints it with var(--background-base)), else the last
  // one seen, else what Spicetify maps --background-base to for .encore-bright-accent-set:
  // --spice-button-active.
  let lastBarBase = null;

  function barBase() {
    const bar = findBar();
    if (bar) {
      const rgb = parseRgb(getComputedStyle(bar).backgroundColor);
      if (rgb) lastBarBase = rgbToHex(rgb.map(Math.round));
    }
    return lastBarBase || rootColour("--spice-button-active") || themeHex();
  }

  // A stop's current colour as #rrggbb — for UI swatches and the picker only.
  function resolveStop(stop) {
    return stop.kind === "theme" ? themeHex() : stop.color;
  }

  const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const rgbToHex = (rgb) => "#" + rgb.map((n) => n.toString(16).padStart(2, "0")).join("");

  // Computed colours come back as rgb() or color(srgb …), with commas or spaces → [r, g, b] (0–255).
  // Opaque only: anything with an alpha below 1 (rgba(), "transparent") gives null.
  function parseRgb(colour) {
    const srgb = /^color\(srgb\s/.test(colour);
    if (!srgb && !/^rgba?\(/.test(colour)) return null;
    const n = colour.match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) ?? [];
    if (n.length < 3 || n.some(Number.isNaN) || (n.length > 3 && n[3] < 1)) return null;
    return n.slice(0, 3).map((v) => Math.min(255, Math.max(0, srgb ? v * 255 : v)));
  }

  // The computed sRGB value of a CSS colour, as [r, g, b], read through caret-color on one of
  // OUR elements (never Spotify's: no inline styles there). color-mix() converts to sRGB first.
  function computedRgb(el, colour) {
    el.style.setProperty("caret-color", `color-mix(in srgb, ${colour}, ${colour})`);
    const rgb = parseRgb(getComputedStyle(el).caretColor);
    el.style.removeProperty("caret-color");
    return rgb;
  }

  // WCAG 2 relative luminance and contrast ratio.
  function luminance([r, g, b]) {
    const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  // ── Text colour (#11–#17) ───────────────────────────────────────────────────
  // Auto puts black or white text on the bar, whichever has the higher WORST-CASE contrast over the
  // colours behind the text — not an average, so a dark stop under light text (or the reverse) is
  // never hidden by the rest of the gradient. The result is written into the bar's rule as a
  // literal colour by regenerating the stylesheet.

  const BLACK = "#000000";
  const WHITE = "#ffffff";
  const TEXT_DELAY = 100; // debounce for recalculations (#15)
  const SAMPLES_BETWEEN = 8; // evenly spaced samples between the text region's edges (#13)

  let textRegion = null; // { from, to }: the text's span as fractions of the bar's width, last measured
  let textResult = null; // the last calculation; kept while the bar is gone (#15)
  let textTimer = 0;
  let textRuns = 0; // counted for the self-test

  // The colour written into the bar's rule now, or null to leave the text to Spotify. Black and
  // White are literal; Auto is the last calculated choice.
  function appliedTextColour(s = settings) {
    if (s.textColour === "black") return BLACK;
    if (s.textColour === "white") return WHITE;
    if (s.textColour === "auto") return textResult?.colour ?? null;
    return null;
  }

  // The text's span (#12): from the icon's left edge to the text button's right edge, as fractions
  // of the bar's background area (its padding box). Null if the bar has no size or children.
  function measureTextRegion(bar) {
    const icon = bar.querySelector(BAR_ICON);
    const link = bar.querySelector(BAR_LINK);
    const box = bar.getBoundingClientRect();
    const width = bar.clientWidth || box.width;
    if (!icon || !link || !width) return null;
    const left = box.left + bar.clientLeft;
    const from = clamp((icon.getBoundingClientRect().left - left) / width, 0, 1);
    const to = clamp((link.getBoundingClientRect().right - left) / width, 0, 1);
    return from <= to ? { from, to } : null;
  }

  // What the stops resolve to: the live theme colour from :root and the bar's own colour, as RGB.
  const textContext = () => ({ theme: hexToRgb(themeHex()), base: hexToRgb(barBase()) });

  const stopRgb = (stop, { theme }) => (stop.kind === "theme" ? theme : hexToRgb(stop.color));

  // The colours behind the text (#13): both edges of the region, every stop inside it and 8 evenly
  // spaced points in between, interpolated in sRGB between the opaque stop colours, as the
  // browser draws the gradient. An inert background is just the bar's own colour (`base`).
  function gradientSamples(s, { from, to }, ctx) {
    const colours = isInert(s) ? [ctx.base] : activeStops(s).map((stop) => stopRgb(stop, ctx));
    const last = colours.length - 1;
    const positions = colours.map((_, i) => (last ? i / last : 0));
    const colourAt = (t) => {
      if (!last) return colours[0];
      const x = clamp(t, 0, 1) * last;
      const k = Math.min(Math.floor(x), last - 1);
      const u = x - k;
      return [0, 1, 2].map((i) => colours[k][i] + (colours[k + 1][i] - colours[k][i]) * u);
    };
    const between = Array.from({ length: SAMPLES_BETWEEN }, (_, k) => from + ((to - from) * (k + 1)) / (SAMPLES_BETWEEN + 1));
    const inside = positions.filter((p) => p > from && p < to);
    return [from, to, ...inside, ...between].sort((a, b) => a - b).map((t) => ({ t, rgb: colourAt(t) }));
  }

  // Black or white, whichever has the higher worst contrast over all samples (ties: black, as
  // Spotify draws it). No warning when both are low: the user picks and judges the result.
  function pickTextColour(samples) {
    const worst = (rgb) => Math.min(...samples.map((sample) => contrast(rgb, sample.rgb)));
    const black = worst([0, 0, 0]);
    const white = worst([255, 255, 255]);
    return { colour: white > black ? WHITE : BLACK, black, white };
  }

  // Measures the bar if it's there (otherwise the last region is kept, or the whole width before
  // the bar has ever been seen), samples, picks, and regenerates the stylesheet. `region` overrides
  // the measurement (self-test only).
  function recalcTextColour({ region = null } = {}) {
    clearTimeout(textTimer);
    textTimer = 0;
    const bar = findBar();
    if (bar) textRegion = measureTextRegion(bar) ?? textRegion;
    const used = region ?? textRegion ?? { from: 0, to: 1 };
    const samples = gradientSamples(settings, used, textContext());
    const pick = pickTextColour(samples);
    const mode = settings.textColour;
    const colour = mode === "auto" ? pick.colour : appliedTextColour();
    textResult = {
      mode,
      colour,
      contrast: colour === BLACK ? pick.black : colour === WHITE ? pick.white : null,
      black: pick.black,
      white: pick.white,
      region: used,
      measured: !region && !!textRegion,
      barPresent: !!bar,
      samples: samples.length,
    };
    textRuns++;
    applyCss();
    if (modal) {
      renderTextColour();
      renderPreview();
    }
    return textResult;
  }

  function scheduleTextColour() {
    clearTimeout(textTimer);
    textTimer = setTimeout(recalcTextColour, TEXT_DELAY);
  }

  // Theme colours (and the bar's own colour under a solid theme colour) change at runtime: Hazy
  // rewrites them on :root after every song change.
  const followsTheme = (s = settings) =>
    s.textColour !== "default" && (isInert(s) || activeStops(s).some((stop) => stop.kind === "theme"));

  // Recalculation triggers (#15): the bar appearing or changing (an observer on the now-playing
  // aside), the window resizing, and — while a theme-colour stop is used — song changes and
  // :root style changes (Hazy sets its colour after the song change, not with it). Settings
  // changes come through update(). The aside is re-found if Spotify replaces it; before it
  // exists, one body observer waits for it and then disconnects.
  let asideObserver = null;
  let watchedAside = null;
  let bodyObserver = null;

  function watchBar() {
    const aside = document.querySelector(PARENT);
    if (aside && aside === watchedAside) return;
    asideObserver?.disconnect();
    asideObserver = null;
    watchedAside = aside;
    if (!aside) {
      if (bodyObserver) return;
      bodyObserver = new MutationObserver(() => {
        if (!document.querySelector(PARENT)) return;
        bodyObserver.disconnect();
        bodyObserver = null;
        watchBar();
        scheduleTextColour();
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
      return;
    }
    asideObserver = new MutationObserver(onAsideMutation);
    // The bar is a direct child; its own subtree changes when the device name does. The aside's
    // parent tells us when the aside itself is replaced.
    asideObserver.observe(aside, { childList: true, subtree: true, characterData: true });
    if (aside.parentElement) asideObserver.observe(aside.parentElement, { childList: true });
  }

  // Most mutations in the aside are the player's own (the time label every second): only ones
  // that add or remove a direct child, or happen inside the bar, schedule a recalculation.
  function onAsideMutation(records) {
    if (!watchedAside?.isConnected) {
      watchBar();
      return scheduleTextColour();
    }
    const insideBar = (node) => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.(SELECTOR);
    if (records.some((r) => (r.target === watchedAside && r.type === "childList") || insideBar(r.target))) scheduleTextColour();
  }

  const onThemeChange = () => followsTheme() && scheduleTextColour();

  function watchTextTriggers() {
    watchBar();
    window.addEventListener("resize", scheduleTextColour);
    Spicetify.Player.addEventListener("songchange", onThemeChange);
    new MutationObserver(onThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  }

  // ── Stops ───────────────────────────────────────────────────────────────────

  function findStop(id) {
    return settings.stops.find((s) => s.id === id);
  }

  function nextStopId() {
    const ids = new Set(settings.stops.map((s) => s.id));
    let n = 1;
    while (ids.has(`s${n}`)) n++;
    return `s${n}`;
  }

  // A copy of the last stop at the end, selected: Duplicate on the last stop. With one colour
  // the Gradient switch does the same.
  function addStop() {
    duplicateStop(settings.stops[settings.stops.length - 1].id);
  }

  // Inserts a copy directly after the stop (a theme stop stays a theme stop) and selects it.
  // Returns the copy's id.
  function duplicateStop(id) {
    const index = settings.stops.findIndex((s) => s.id === id);
    if (index === -1 || settings.stops.length >= MAX_STOPS) return id;
    const copy = { ...settings.stops[index], id: nextStopId() };
    settings.stops.splice(index + 1, 0, copy);
    if (settings.stops.length === 2) settings.gradient = true; // a second colour implies a gradient
    selectedId = copy.id;
    update();
    return copy.id;
  }

  // Removing the selected stop selects the one now at its position (or the new last one).
  // Returns that stop's id.
  function removeStop(id) {
    const index = settings.stops.findIndex((s) => s.id === id);
    if (index === -1 || settings.stops.length <= 1) return id;
    settings.stops.splice(index, 1);
    if (settings.stops.length === 1) settings.gradient = false;
    const neighbour = settings.stops[Math.min(index, settings.stops.length - 1)].id;
    if (selectedId === id) selectedId = neighbour;
    update();
    return neighbour;
  }

  // The button asks for a second click first (enableReset).
  function resetSettings() {
    settings = defaultSettings();
    selectedId = settings.stops[0].id;
    update();
  }

  // With one colour there's nothing to switch on, so the switch adds a second one, exactly like
  // adding a colour; that turns the gradient on. The switch is never disabled.
  function toggleGradient() {
    if (settings.stops.length < 2) return addStop();
    settings.gradient = !settings.gradient;
    update();
  }

  // Editing a theme stop's colour turns it into a custom stop.
  function setStopColour(id, colour) {
    const stop = findStop(id);
    stop.kind = "custom";
    stop.color = colour;
    update({ rerender: false });
  }

  // `index` is an insertion point in the current order (0 … length).
  function moveStop(id, index) {
    const from = settings.stops.findIndex((s) => s.id === id);
    if (from === -1 || index === from || index === from + 1) return;
    const [stop] = settings.stops.splice(from, 1);
    settings.stops.splice(index > from ? index - 1 : index, 0, stop);
    update();
  }

  // Called from the picker ("Use theme colour"), so the dots are updated in place, not re-rendered.
  function linkStopToTheme(id) {
    const stop = findStop(id);
    stop.kind = "theme";
    delete stop.color;
    update({ rerender: false });
  }

  // ── Settings modal ──────────────────────────────────────────────────────────
  // Colours come only from Spicetify variables so the modal follows any theme. Never use the id
  // "color-input" or the classes .slider/.toggle/.toggleWrapper, or a <select>: Hazy looks them up
  // and styles them globally.
  //
  // Dots are plain buttons: click to select one and edit it in the inline colour picker below,
  // right-click for Duplicate / Remove, drag or Alt+arrows to reorder, Delete/Backspace to remove.
  // Exactly one dot is selected whenever the modal is open. The −|+ stepper after them removes the
  // selected dot and adds one.
  //
  // Tints use color-mix() on var(--spice-button), never --spice-rgb-button: Hazy rewrites
  // --spice-button at runtime but leaves --spice-rgb-button at the colour scheme's value.
  const MODAL_CSS = `
.gcb-modal { display: flex; flex-direction: column; gap: 20px; padding-top: 20px; color: var(--spice-text); }
.gcb-modal [hidden] { display: none; }
.gcb-gradient-row { display: flex; align-items: center; justify-content: space-between; }
.gcb-label { font-weight: 700; }
.gcb-switch { position: relative; flex: none; width: 40px; height: 22px; padding: 0; border: 0; border-radius: 11px; background-color: rgba(var(--spice-rgb-text), .3); cursor: pointer; transition: background-color .15s; }
.gcb-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background-color: var(--spice-text); transition: transform .15s; }
.gcb-switch[aria-checked="true"] { background-color: var(--spice-button); }
.gcb-switch[aria-checked="true"]::after { transform: translateX(18px); }
.gcb-switch:focus-visible { outline: 2px solid var(--spice-text); outline-offset: 2px; }
.gcb-text { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.gcb-modes { display: flex; gap: 2px; padding: 2px; border-radius: 500px; background-color: rgba(var(--spice-rgb-text), .1); }
.gcb-mode { padding: 4px 12px; border: 1px solid transparent; border-radius: 500px; background: none; color: var(--spice-text); font: inherit; font-size: .875rem; font-weight: 700; white-space: nowrap; cursor: pointer; transition: background-color .15s; }
.gcb-mode[aria-checked="true"] { background-color: var(--spice-button); }
.gcb-mode.gcb-on-light { color: var(--spice-main); }
.gcb-mode:hover:not([aria-checked="true"]) { background-color: rgba(var(--spice-rgb-text), .1); }
.gcb-mode:focus-visible { outline: 2px solid var(--spice-text); outline-offset: 2px; }
.gcb-preview { display: flex; align-items: center; justify-content: flex-end; gap: 8px; box-sizing: border-box; height: 24px; padding: 0 12px; border-radius: 4px; overflow: hidden; font-size: .875rem; white-space: nowrap; }
.gcb-preview-icon { flex: none; }
.gcb-dots { display: flex; align-items: flex-end; gap: 10px; }
.gcb-stops { position: relative; display: flex; flex-wrap: wrap; gap: 14px; padding: 4px; }
.gcb-stop { position: relative; width: 32px; height: 32px; padding: 0; border: 2px solid rgba(var(--spice-rgb-text), .25); border-radius: 50%; cursor: pointer; }
.gcb-stop.gcb-selected, .gcb-stop:focus-visible { outline: 2px solid var(--spice-text); outline-offset: 3px; }
.gcb-stop.gcb-unused { opacity: .5; }
.gcb-stop.gcb-dragging { opacity: .3; }
.gcb-announce { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.gcb-stepper { flex: none; display: flex; height: 32px; margin: 4px 0; }
.gcb-step { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 36px; height: 100%; margin: 0; padding: 0; border: 1px solid rgba(var(--spice-rgb-text), .3); background: none; color: var(--spice-subtext); cursor: pointer; }
.gcb-minus { border-radius: 16px 0 0 16px; }
.gcb-plus { margin-left: -1px; border-left-color: transparent; border-radius: 0 16px 16px 0; }
.gcb-step:hover:not(:disabled) { border-color: var(--spice-text); color: var(--spice-text); }
.gcb-plus:hover:not(:disabled) { position: relative; z-index: 1; }
.gcb-step:disabled { cursor: not-allowed; }
.gcb-step:disabled > svg { opacity: .5; }
.gcb-step:focus-visible { outline: 2px solid var(--spice-text); outline-offset: -3px; }
.gcb-marker { position: absolute; width: 2px; height: 32px; border-radius: 1px; background-color: var(--spice-button); pointer-events: none; }
.gcb-button { align-self: flex-start; padding: 8px 16px; border: 1px solid rgba(var(--spice-rgb-text), .3); border-radius: 500px; background: none; color: var(--spice-text); font: inherit; font-weight: 700; cursor: pointer; }
.gcb-button:hover:not(:disabled) { border-color: var(--spice-text); }
.gcb-button:disabled { opacity: .5; cursor: not-allowed; }
.gcb-button:focus-visible { outline: 2px solid var(--spice-text); outline-offset: 2px; }
.gcb-actions { display: flex; justify-content: center; align-items: center; }
.gcb-actions > .gcb-button { align-self: center; }
.gcb-reset { display: inline-grid; justify-items: center; }
.gcb-reset > span { grid-area: 1 / 1; }
.gcb-reset-sizer { visibility: hidden; }
.gcb-reset.gcb-armed, .gcb-reset.gcb-armed:hover:not(:disabled) { border-color: var(--spice-notification-error, #e91429); color: var(--spice-notification-error, #e91429); }
.gcb-help { margin: 8px 0 0; font-size: .875rem; line-height: 1.5; color: var(--spice-subtext); }
.gcb-popover { position: fixed; z-index: 10; box-sizing: border-box; border-radius: 8px; background-color: var(--spice-card); box-shadow: 0 8px 24px rgba(0, 0, 0, .5); color: var(--spice-text); }
.gcb-popover[hidden] { display: none; }
.gcb-menu { display: flex; flex-direction: column; min-width: 140px; padding: 4px; }
.gcb-menu-item { padding: 8px 12px; border: 0; border-radius: 4px; background: none; color: var(--spice-text); font: inherit; font-size: .875rem; text-align: left; cursor: pointer; }
.gcb-menu-item:hover:not(:disabled), .gcb-menu-item:focus-visible { outline: none; background-color: rgba(var(--spice-rgb-text), .1); }
.gcb-menu-item:disabled { opacity: .5; cursor: default; }
.gcb-colour-picker { display: flex; flex-wrap: wrap; gap: 16px; }
.gcb-sv { position: relative; flex: 1 1 202px; min-height: 150px; border-radius: 4px; background-image: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent); cursor: crosshair; touch-action: none; }
.gcb-sv-handle, .gcb-hue-handle { position: absolute; box-sizing: border-box; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px rgba(0, 0, 0, .6); pointer-events: none; }
.gcb-sv-handle { width: 14px; height: 14px; margin: -7px 0 0 -7px; }
.gcb-controls { flex: 1 1 202px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.gcb-tools { display: flex; align-items: center; gap: 10px; }
.gcb-eyedropper { flex: none; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%; background: none; color: var(--spice-text); cursor: pointer; }
.gcb-eyedropper:hover { background-color: rgba(var(--spice-rgb-text), .1); }
.gcb-swatch { flex: none; box-sizing: border-box; width: 24px; height: 24px; border: 1px solid rgba(var(--spice-rgb-text), .3); border-radius: 50%; }
.gcb-hue { position: relative; flex: 1; height: 12px; border-radius: 6px; background-image: linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); cursor: pointer; touch-action: none; }
.gcb-hue-handle { top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; }
.gcb-sv:focus-visible, .gcb-hue:focus-visible, .gcb-eyedropper:focus-visible { outline: 2px solid var(--spice-text); outline-offset: 2px; }
.gcb-rgb { display: flex; gap: 8px; }
.gcb-channel { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: .75rem; color: var(--spice-subtext); }
.gcb-hex-row { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: .75rem; color: var(--spice-subtext); }
.gcb-field { width: 100%; min-width: 0; height: 28px; box-sizing: border-box; padding: 0 6px; border: 1px solid rgba(var(--spice-rgb-text), .3); border-radius: 4px; background-color: rgba(var(--spice-rgb-text), .08); color: var(--spice-text); font: inherit; font-size: .875rem; text-align: center; }
.gcb-field:focus { outline: none; border-color: var(--spice-text); }
.gcb-field[aria-invalid="true"] { border-color: var(--spice-notification-error, #e91429); }
.gcb-hex-wrap { position: relative; flex: none; display: flex; }
.gcb-hex { flex: none; width: calc(10ch + 24px); padding-right: 28px; font-family: ui-monospace, Consolas, monospace; text-align: left; }
.gcb-hex-copy { position: absolute; top: 50%; right: 2px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 24px; height: 24px; margin: -12px 0 0; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--spice-subtext); cursor: pointer; }
.gcb-hex-copy:hover { color: var(--spice-text); }
.gcb-hex-copy:focus-visible { outline: 2px solid var(--spice-text); outline-offset: -1px; }
.gcb-colour-picker .gcb-button { align-self: stretch; padding: 6px 12px; font-size: .875rem; }
.gcb-share-button { display: inline-flex; align-items: center; align-self: center; gap: 6px; padding: 4px 12px 4px 10px; font-size: .8125rem; }
.gcb-share-button > svg { flex: none; }
.gcb-share-text { display: inline-grid; justify-items: center; }
.gcb-share-text > span { grid-area: 1 / 1; }
.gcb-share-button[aria-expanded="true"] { border-color: var(--spice-text); }
.gcb-presets > * { margin: 0; }
.gcb-presets > * + * { margin-top: 8px; }
.gcb-presets > .gcb-undo:not(.gcb-has-status) { margin-top: 0; }
.gcb-presets-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.gcb-text-button { display: inline-grid; padding: 2px 8px; border: 0; border-radius: 500px; background: none; color: var(--spice-subtext); font: inherit; font-size: .8125rem; font-weight: 700; cursor: pointer; }
.gcb-text-button > span { grid-area: 1 / 1; }
.gcb-text-button:hover:not(:disabled) { background-color: rgba(var(--spice-rgb-text), .1); color: var(--spice-text); }
.gcb-text-button:focus-visible { outline: 2px solid var(--spice-text); outline-offset: 1px; }
.gcb-sizer { visibility: hidden; }
.gcb-chips { display: flex; flex-direction: column; gap: 8px; }
.gcb-chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.gcb-chip { display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; height: 28px; padding: 0 12px 0 7px; border: 1px solid rgba(var(--spice-rgb-text), .3); border-radius: 500px; background: none; color: var(--spice-text); font: inherit; font-size: .8125rem; cursor: pointer; }
.gcb-chip:hover:not(:disabled) { border-color: var(--spice-text); }
.gcb-chip[aria-pressed="true"], .gcb-chip[aria-pressed="true"]:hover:not(:disabled), .gcb-chip.gcb-armed, .gcb-chip.gcb-armed:hover:not(:disabled) { border-color: var(--spice-button); }
.gcb-chip.gcb-armed { background-color: color-mix(in srgb, var(--spice-button) 20%, transparent); }
.gcb-chip:disabled { opacity: .5; cursor: not-allowed; }
.gcb-chip:focus-visible { outline: 2px solid var(--spice-text); outline-offset: 2px; }
.gcb-save-chip { padding: 0 12px; color: var(--spice-subtext); }
.gcb-save-chip:hover:not(:disabled) { color: var(--spice-text); }
.gcb-chip-swatch { flex: none; width: 12px; height: 12px; border-radius: 50%; }
.gcb-chip-text { display: inline-grid; justify-items: center; }
.gcb-chip-text > span { grid-area: 1 / 1; white-space: nowrap; }
.gcb-name-field { flex: none; width: 18ch; height: 28px; padding: 0 12px; border-radius: 500px; text-align: left; }
.gcb-undo { font-size: .8125rem; color: var(--spice-subtext); }
.gcb-presets-tools { display: flex; align-items: center; gap: 8px; }
.gcb-code-hint { margin: 6px 0 0; font-size: .75rem; color: var(--spice-subtext); }
.gcb-code-output, .gcb-code-input { font-family: ui-monospace, Consolas, monospace; font-size: .8125rem; text-align: left; }
.gcb-import-row { display: flex; align-items: center; gap: 8px; }
.gcb-import-row > .gcb-code-input { flex: 1; }
.gcb-import-row > .gcb-button { flex: none; align-self: center; padding: 4px 14px; font-size: .875rem; }
.gcb-import-error { margin: 0; font-size: .75rem; color: var(--spice-notification-error, #e91429); }
.gcb-import-error:not(:empty) { margin-top: 6px; }
.gcb-undo-button { padding: 2px 4px; color: var(--spice-text); text-decoration: underline; }
`;
  // Two columns from 420 px of content (202 + 16 + 202), stacked below that. Flex-wrap rather
  // than a container query: inline-size containment could collapse a shrink-to-fit modal.
  const PICKER_COLUMNS_MIN = 420;

  const TITLE = "Gradient Connect Bar";
  const REORDER_HINT = "Drag or Alt+←/→ to reorder"; // second line of the dot tooltip
  const HELP_LINES = [ // one line each, joined with <br>
    "Click a colour to edit it, drag to reorder, right-click to duplicate.",
    "+ adds a colour, − removes the selected one.",
    "Reset goes back to the bar's own colour.",
  ];
  const PREVIEW_LABEL = "Playing on Device";
  const ADD_LABEL = "Add colour";
  const ADD_FULL_LABEL = `Up to ${MAX_STOPS} colours`;
  const REMOVE_LABEL = "Remove selected colour"; // the stepper's −
  const REMOVE_LAST_LABEL = "At least one colour";
  const THEME_LABELS = { off: "Use theme colour", on: "Following theme colour" };
  const MINUS_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 7.25h12v1.5H2z"/></svg>';
  const PLUS_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25z"/></svg>';
  const COPY_ICON = // two overlapping rounded squares: the hex field's copy button
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M5 1.75A1.75 1.75 0 0 1 6.75 0h6.5A1.75 1.75 0 0 1 15 1.75v6.5A1.75 1.75 0 0 1 13.25 10H11V8.5h2.25a.25.25 0 0 0 .25-.25v-6.5a.25.25 0 0 0-.25-.25h-6.5a.25.25 0 0 0-.25.25V4H5z"/><path d="M1 6.75C1 5.784 1.784 5 2.75 5h6.5c.966 0 1.75.784 1.75 1.75v6.5A1.75 1.75 0 0 1 9.25 15h-6.5A1.75 1.75 0 0 1 1 13.25zm1.75-.25a.25.25 0 0 0-.25.25v6.5c0 .138.112.25.25.25h6.5a.25.25 0 0 0 .25-.25v-6.5a.25.25 0 0 0-.25-.25z"/></svg>';
  const CHECK_ICON = // shown in place of the copy icon after copying
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M13.53 3.47a.75.75 0 0 1 0 1.06l-7 7a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06L6 9.94l6.47-6.47a.75.75 0 0 1 1.06 0z"/></svg>';
  // A speaker: the preview strip's stand-in for the bar's device icon. No data-encore-id, so the
  // preview never matches SELECTOR or UNSCOPED.
  const DEVICE_ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="M4 1.5A1.5 1.5 0 0 1 5.5 0h5A1.5 1.5 0 0 1 12 1.5v13a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 14.5zm1.5 0v13h5v-13zM8 3.25a.75.75 0 1 0 0 1.5a.75.75 0 1 0 0-1.5zM8 7a2.25 2.25 0 1 0 0 4.5A2.25 2.25 0 1 0 8 7zm0 1.5a.75.75 0 1 0 0 1.5a.75.75 0 1 0 0-1.5z"/></svg>';
  // Both icons are in the markup and swapped with `hidden`, so no node is replaced.
  const withClass = (svg, className, hidden = false) => svg.replace("<svg ", `<svg class="${className}"${hidden ? " hidden" : ""} `);

  const EXPORT_ICON = // arrow up out of a tray (GPB #52)
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.5 4.5 5h2.75v5.5h1.5V5h2.75z"/><path d="M1 9.5h1.5v4h11v-4H15V15H1z"/></svg>';
  const IMPORT_ICON = // arrow down into a tray (GPB #52)
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7.25 1.5h1.5V7h2.75L8 10.5 4.5 7h2.75z"/><path d="M1 9.5h1.5v4h11v-4H15V15H1z"/></svg>';

  const EYEDROPPER_ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.35 2.65a2 2 0 0 0-2.83 0L8.9 4.27l-.7-.71-1.06 1.06.7.71-5.3 5.3a1.5 1.5 0 0 0-.44 1.07L2 14l2.3-.1a1.5 1.5 0 0 0 1.07-.44l5.3-5.3.71.7 1.06-1.06-.7-.71 1.61-1.61a2 2 0 0 0 0-2.83zM4.3 12.4l-.8.04.04-.8 5.37-5.37.76.76z"/></svg>';

  let modal = null; // the open modal's elements, or null

  // "#rrggbb", "rrggbb", "#rgb" or "rgb" → "#rrggbb", otherwise null.
  function parseHex(value) {
    let hex = value.trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join("");
    return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
  }

  function openModal() {
    const root = document.createElement("div");
    root.className = "gcb-modal";
    root.innerHTML = `
      <style>${MODAL_CSS}</style>
      <div class="gcb-popover gcb-menu" role="menu" aria-label="Colour actions" hidden>
        <button type="button" role="menuitem" class="gcb-menu-item gcb-duplicate">Duplicate</button>
        <button type="button" role="menuitem" class="gcb-menu-item gcb-remove">Remove</button>
        <button type="button" role="menuitem" class="gcb-menu-item gcb-rename" hidden>Rename</button>
        <button type="button" role="menuitem" class="gcb-menu-item gcb-update-preset" hidden>Update to current colours</button>
        <button type="button" role="menuitem" class="gcb-menu-item gcb-delete-preset" hidden>Delete</button>
      </div>
      <span class="gcb-announce" aria-live="polite"></span>
      <div class="gcb-gradient-row">
        <span class="gcb-label" id="gcb-gradient-label">Gradient</span>
        <button type="button" class="gcb-switch" role="switch" aria-labelledby="gcb-gradient-label"></button>
      </div>
      <div class="gcb-text">
        <span class="gcb-label" id="gcb-text-label">Text colour</span>
        <div class="gcb-modes" role="radiogroup" aria-labelledby="gcb-text-label">
          ${TEXT_MODES.map((mode) => `<button type="button" class="gcb-mode" role="radio" data-mode="${mode}">${TEXT_LABELS[mode]}</button>`).join("")}
        </div>
      </div>
      <div class="gcb-presets">
        <div class="gcb-presets-row">
          <span class="gcb-label" id="gcb-presets-label">Presets</span>
          <div class="gcb-presets-tools">
            <button type="button" class="gcb-button gcb-share-button gcb-export" title="${EXPORT_TITLE}">${withClass(EXPORT_ICON, "gcb-export-icon")}${withClass(CHECK_ICON, "gcb-export-check", true)}<span class="gcb-share-text"><span class="gcb-share-label gcb-export-label">${EXPORT_LABEL}</span><span class="gcb-sizer" aria-hidden="true">${EXPORT_LABEL}</span><span class="gcb-sizer" aria-hidden="true">${COPIED_LABEL}</span></span></button>
            <button type="button" class="gcb-button gcb-share-button gcb-import" title="${IMPORT_TITLE}" aria-expanded="false" aria-controls="gcb-import-panel">${IMPORT_ICON}<span class="gcb-share-label">Import</span></button>
          </div>
        </div>
        <div class="gcb-chips" role="group" aria-labelledby="gcb-presets-label">
          <div class="gcb-chip-row gcb-built-in-row"></div>
          <div class="gcb-chip-row gcb-own-row">
            <button type="button" class="gcb-chip gcb-save-chip">+ Save</button>
            <input type="text" class="gcb-field gcb-name-field" maxlength="${PRESET_NAME_MAX}" spellcheck="false" autocomplete="off" aria-label="Preset name" hidden>
          </div>
        </div>
        <div class="gcb-code-fallback" hidden>
          <input type="text" class="gcb-field gcb-code-output" readonly spellcheck="false" aria-label="Share code (copy it from here)" aria-describedby="gcb-code-hint">
          <p class="gcb-code-hint" id="gcb-code-hint">${COPY_HINT}</p>
        </div>
        <div class="gcb-import-panel" id="gcb-import-panel" hidden>
          <div class="gcb-import-row">
            <input type="text" class="gcb-field gcb-code-input" spellcheck="false" autocomplete="off" placeholder="gcb1:… or gpb1:…" aria-label="Paste a share code" aria-describedby="gcb-import-error">
            <button type="button" class="gcb-button gcb-import-apply">Apply</button>
          </div>
          <p class="gcb-import-error" id="gcb-import-error" aria-live="polite"></p>
        </div>
        <p class="gcb-undo" aria-live="polite"><span class="gcb-undo-text"></span><button type="button" class="gcb-text-button gcb-undo-button" hidden>Undo</button></p>
      </div>
      <div class="gcb-preview" role="img" aria-label="Preview of the Connect bar">${withClass(DEVICE_ICON, "gcb-preview-icon")}<span class="gcb-preview-label">${PREVIEW_LABEL}</span></div>
      <div class="gcb-dots">
        <div class="gcb-stops"></div>
        <div class="gcb-stepper" role="group" aria-label="Colours">
          <button type="button" class="gcb-step gcb-minus" aria-label="${REMOVE_LABEL}" title="${REMOVE_LABEL}">${MINUS_ICON}</button>
          <button type="button" class="gcb-step gcb-plus" aria-label="${ADD_LABEL}" title="${ADD_LABEL}">${PLUS_ICON}</button>
        </div>
      </div>
      <div class="gcb-colour-picker" role="group" aria-label="Selected colour">
        <div class="gcb-sv" role="slider" tabindex="0" aria-label="Saturation and brightness"><div class="gcb-sv-handle"></div></div>
        <div class="gcb-controls">
          <div class="gcb-tools">
            ${window.EyeDropper ? `<button type="button" class="gcb-eyedropper" aria-label="Pick a colour from the screen" title="Pick a colour from the screen">${EYEDROPPER_ICON}</button>` : ""}
            <div class="gcb-swatch"></div>
            <div class="gcb-hue" role="slider" tabindex="0" aria-label="Hue" aria-valuemin="0" aria-valuemax="360"><div class="gcb-hue-handle"></div></div>
          </div>
          <div class="gcb-rgb">
            ${["Red", "Green", "Blue"].map((name) =>
              `<label class="gcb-channel"><input type="text" class="gcb-field gcb-channel-input" inputmode="numeric" maxlength="3" spellcheck="false" autocomplete="off" aria-label="${name}"><span>${name[0]}</span></label>`
            ).join("")}
          </div>
          <div class="gcb-hex-row">
            <label for="gcb-hex-input">HEX:</label>
            <span class="gcb-hex-wrap">
              <input type="text" class="gcb-field gcb-hex" id="gcb-hex-input" spellcheck="false" autocomplete="off" maxlength="7" aria-label="Hex code">
              <button type="button" class="gcb-hex-copy" aria-label="${HEX_COPY_LABEL}" title="${HEX_COPY_LABEL}">${withClass(COPY_ICON, "gcb-hex-copy-icon")}${withClass(CHECK_ICON, "gcb-hex-copy-check", true)}</button>
            </span>
          </div>
          <button type="button" class="gcb-button gcb-use-theme">${THEME_LABELS.off}</button>
        </div>
      </div>
      <div class="gcb-actions">
        <button type="button" class="gcb-button gcb-reset"><span class="gcb-reset-label" aria-live="polite">Reset</span><span class="gcb-reset-sizer" aria-hidden="true">${RESET_CONFIRM_LABEL}</span></button>
      </div>
      <p class="gcb-help">${HELP_LINES.join("<br>")}</p>`;

    const m = {
      root,
      gradientRow: root.querySelector(".gcb-gradient-row"),
      switchButton: root.querySelector(".gcb-switch"),
      text: root.querySelector(".gcb-text"),
      textLabel: root.querySelector("#gcb-text-label"),
      textModes: root.querySelector(".gcb-modes"),
      textButtons: [...root.querySelectorAll(".gcb-mode")],
      presets: root.querySelector(".gcb-presets"),
      presetsRow: root.querySelector(".gcb-presets-row"),
      chips: root.querySelector(".gcb-chips"),
      builtInRow: root.querySelector(".gcb-built-in-row"),
      ownRow: root.querySelector(".gcb-own-row"),
      saveChip: root.querySelector(".gcb-save-chip"),
      nameField: root.querySelector(".gcb-name-field"),
      exportButton: root.querySelector(".gcb-export"),
      exportLabel: root.querySelector(".gcb-export-label"),
      exportIcon: root.querySelector(".gcb-export-icon"),
      exportCheck: root.querySelector(".gcb-export-check"),
      codeFallback: root.querySelector(".gcb-code-fallback"),
      importButton: root.querySelector(".gcb-import"),
      codeOutput: root.querySelector(".gcb-code-output"),
      importPanel: root.querySelector(".gcb-import-panel"),
      codeInput: root.querySelector(".gcb-code-input"),
      importApply: root.querySelector(".gcb-import-apply"),
      importError: root.querySelector(".gcb-import-error"),
      undoLine: root.querySelector(".gcb-undo"),
      undoText: root.querySelector(".gcb-undo-text"),
      undoButton: root.querySelector(".gcb-undo-button"),
      preview: root.querySelector(".gcb-preview"),
      previewIcon: root.querySelector(".gcb-preview-icon"),
      previewLabel: root.querySelector(".gcb-preview-label"),
      dotsLine: root.querySelector(".gcb-dots"),
      stopsRow: root.querySelector(".gcb-stops"),
      stepper: root.querySelector(".gcb-stepper"),
      minusButton: root.querySelector(".gcb-minus"),
      plusButton: root.querySelector(".gcb-plus"),
      actions: root.querySelector(".gcb-actions"),
      resetButton: root.querySelector(".gcb-reset"),
      resetLabel: root.querySelector(".gcb-reset-label"),
      help: root.querySelector(".gcb-help"),
      menu: root.querySelector(".gcb-menu"),
      announce: root.querySelector(".gcb-announce"),
      duplicateItem: root.querySelector(".gcb-duplicate"),
      removeItem: root.querySelector(".gcb-remove"),
      renameItem: root.querySelector(".gcb-rename"),
      updatePresetItem: root.querySelector(".gcb-update-preset"),
      deletePresetItem: root.querySelector(".gcb-delete-preset"),
      picker: root.querySelector(".gcb-colour-picker"),
      sv: root.querySelector(".gcb-sv"),
      svHandle: root.querySelector(".gcb-sv-handle"),
      hue: root.querySelector(".gcb-hue"),
      hueHandle: root.querySelector(".gcb-hue-handle"),
      swatch: root.querySelector(".gcb-swatch"),
      eyedropper: root.querySelector(".gcb-eyedropper"),
      rgb: [...root.querySelectorAll(".gcb-channel-input")],
      hex: root.querySelector(".gcb-hex"),
      hexWrap: root.querySelector(".gcb-hex-wrap"),
      hexCopy: root.querySelector(".gcb-hex-copy"),
      hexCopyIcon: root.querySelector(".gcb-hex-copy-icon"),
      hexCopyCheck: root.querySelector(".gcb-hex-copy-check"),
      useThemeButton: root.querySelector(".gcb-use-theme"),
      cleanups: [],
    };

    m.switchButton.addEventListener("click", toggleGradient);
    enableTextColour(m);
    // The −|+ stepper sits outside .gcb-stops, which renderStops() empties, so a clicked half is
    // never detached. − is the dot menu's Remove on the selected dot. Focus stays on the clicked
    // half; once that half is disabled (− at one colour, + at eight), it goes to the selected dot.
    const stepper = (button, action) =>
      button.addEventListener("click", () => {
        const hadFocus = document.activeElement === button;
        action();
        if (hadFocus && button.disabled) dotEl(selectedId)?.focus({ preventScroll: true });
      });
    stepper(m.minusButton, () => removeStop(selectedId));
    stepper(m.plusButton, addStop);
    m.stopsRow.addEventListener("click", (e) => {
      const el = e.target.closest(".gcb-stop");
      if (!el || performance.now() - lastDragEnd < 300) return; // a drag never changes the selection
      selectStop(el.dataset.id, { focusHex: e.detail === 0 }); // detail 0: Enter/Space
    });
    enableDotMenu(m);
    enableColourPicker(m);
    enableReset(m);
    enablePresets(m);

    Spicetify.PopupModal.display({ title: TITLE, content: root });
    evenPopupBottom(root);
    modal = m;
    selectedId = settings.stops[0].id; // the first dot is selected on open
    renderModal();
    renderChips(m);
    watchModalClose(m);
    watchThemeColour(m);
    watchPopovers(m);
    enableDragAndDrop(m);
    enableKeyboardReorder(m);
    enableKeyboardRemove(m);
  }

  // Spicetify pads the popup's content 0 24px 24px, but the popup also carries Spotify's
  // track-credits classes, and themes style those: Hazy gives .main-trackCreditsModal-container
  // padding-bottom: 32px, so there were 56 px below the help text against 24 px at the sides
  // (GPB #48). Inline, on this display()'s elements only: PopupModal rebuilds its markup on every
  // display(), so no other extension's popup is affected. Never a global rule.
  function evenPopupBottom(root) {
    const content = root.closest(".spicetify-popup-content");
    const container = root.closest(".spicetify-popup-container");
    if (!content || !container) return;
    container.style.paddingBottom = "0px";
    content.style.paddingBottom = getComputedStyle(content).paddingLeft;
  }

  // ── Text colour row (#11) ──
  // A radiogroup of plain buttons (no <select>: Hazy styles select globally), ported from GPB's
  // Spread row. Built once per open and only updated in place, so a click never detaches its
  // target. Roving tabindex; ←/→ (wrapping), Home and End move the choice, without modifier keys.
  // No hint and no warning under it: the user picks the text colour and judges the result.

  const TEXT_LABELS = { auto: "Auto", black: "Black", white: "White", default: "Spotify default" };

  function setTextColour(mode) {
    if (!TEXT_MODES.includes(mode) || mode === settings.textColour) return;
    settings.textColour = mode;
    recalcTextColour(); // at once: the bar and the preview show the new colour straight away
    update({ rerender: false });
  }

  function enableTextColour(m) {
    m.textModes.addEventListener("click", (e) => {
      const button = e.target.closest(".gcb-mode");
      if (button) setTextColour(button.dataset.mode);
    });
    m.textModes.addEventListener("keydown", (e) => {
      const button = e.target.closest(".gcb-mode");
      if (!button || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const i = m.textButtons.indexOf(button);
      const last = m.textButtons.length - 1;
      const next = { ArrowLeft: i ? i - 1 : last, ArrowRight: i === last ? 0 : i + 1, Home: 0, End: last }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      setTextColour(m.textButtons[next].dataset.mode);
      m.textButtons[next].focus();
    });
  }

  // In place: aria-checked, tabindex, the label colour on the filled button.
  function renderTextColour() {
    const onLight = labelOnLight(modal.textModes);
    for (const button of modal.textButtons) {
      const checked = button.dataset.mode === settings.textColour;
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
      button.classList.toggle("gcb-on-light", checked && onLight);
    }
  }

  // True when --spice-main contrasts more with the live --spice-button than --spice-text (GPB #43):
  // the checked button is filled with --spice-button.
  function labelOnLight(el) {
    const fill = computedRgb(el, "var(--spice-button)");
    const text = computedRgb(el, "var(--spice-text)");
    const main = computedRgb(el, "var(--spice-main)");
    return !!(fill && text && main) && contrast(main, fill) > contrast(text, fill);
  }

  // ── Presets row (#29) ──
  // Ported from GPB 1.6.1. Two chip rows: the built-ins, then own presets and + Save. Applying is
  // always two-step: the first click arms the chip ("Apply?"; hidden sizers keep its width) and
  // previews it in the strip, text colour included; the second applies. Themes often hide the
  // player behind the popup, and the bar only exists during remote playback, so the strip is the
  // preview. No timeout while armed; the active chip does nothing. Undo for 10 s after applying,
  // importing or deleting. Arming changes only a label and a class, in place; re-rendering the
  // chip row (Save, Rename, Update, Delete) is deferred and closes the menu first, so a clicked
  // chip or menu item is never detached during its own click.

  const UNDO_MS = 10000;
  const APPLY_LABEL = "Apply?";
  const SAVE_LABEL = "Save the current settings as a preset";
  const SAVE_FULL_LABEL = `Up to ${MAX_PRESETS} presets`;
  const OWN_PRESET_HINT = "Right-click to rename, update or delete";

  const chipEl = (id) => modal?.chips.querySelector(`.gcb-preset-chip[data-preset="${CSS.escape(id)}"]`) ?? null;
  const isOwnPreset = (id) => presets.some((p) => p.id === id);

  function enablePresets(m) {
    m.chips.addEventListener("click", (e) => {
      const chip = e.target.closest(".gcb-chip");
      if (!chip || chip.disabled) return;
      if (chip === m.saveChip) startNaming(m, "save");
      else clickChip(m, chip);
    });
    // Own chips only: built-ins can't be renamed, updated or deleted, so they have no menu.
    m.chips.addEventListener("contextmenu", (e) => {
      const chip = e.target.closest(".gcb-preset-chip");
      if (!chip || !isOwnPreset(chip.dataset.preset)) return;
      e.preventDefault();
      e.stopPropagation();
      const id = chip.dataset.preset;
      if (popover?.id === id && performance.now() - popover.openedAt < 500) return; // opened from keydown
      const r = chip.getBoundingClientRect();
      const onChip = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      openChipMenu(id, onChip ? { at: { x: e.clientX, y: e.clientY } } : { keyboard: true });
    });
    m.chips.addEventListener("keydown", (e) => {
      const chip = e.target.closest(".gcb-preset-chip");
      if (!chip || !isOwnPreset(chip.dataset.preset) || !(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
      e.preventDefault();
      openChipMenu(chip.dataset.preset, { keyboard: true });
    });
    m.chips.addEventListener("focusout", (e) => m.armed?.chip === e.target && disarmChip(m));
    disarmOnOutsideInput(m, () => m.armed?.chip ?? null, () => disarmChip(m));

    m.nameField.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        stopNaming(m, { commit: true });
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // the field closes, not the modal
        stopNaming(m, { refocus: true });
      }
    });
    m.nameField.addEventListener("blur", () => stopNaming(m));

    m.renameItem.addEventListener("click", () => runChipAction((id) => startNaming(m, "rename", id)));
    m.updatePresetItem.addEventListener("click", () =>
      runChipAction((id) => {
        if (pendingUndo?.kind === "preset") clearUndo(); // a restored preset could clash with this change
        if (updatePreset(id)) renderChipsLater(m, id);
      })
    );
    m.deletePresetItem.addEventListener("click", () => runChipAction((id) => deleteWithUndo(m, id)));
    m.undoButton.addEventListener("click", runUndo);
    enableSharing(m);
    m.cleanups.push(() => {
      disarmChip(m);
      clearUndo();
    });
  }

  // ── Sharing (#36) ──
  // Export puts a gcb1: code on the clipboard (writeClipboard()) and confirms on the button itself;
  // only if every tier fails does the code show in a selected read-only field. Import is an inline
  // paste field, never navigator.clipboard.readText() (that asks for a permission), and takes
  // gcb1: and GPB's gpb1: codes. While the field holds a valid code the strip previews it; Apply
  // is the deliberate step, with Undo.

  const EXPORT_TITLE = "Copy a share code to the clipboard";
  const IMPORT_TITLE = "Paste a share code (Gradient Connect Bar or Gradient Progress Bar)";
  const EXPORT_LABEL = "Export";
  const COPIED_LABEL = "Copied"; // on the button for COPIED_MS; hidden sizers keep its width
  const COPIED_MS = 2000;
  const COPY_HINT = /Mac/i.test(navigator.platform) ? "Press ⌘C to copy" : "Press Ctrl+C to copy";
  const IMPORT_ERROR = "Not a valid code";
  const PREVIEW_CODE_MESSAGE = "Previewing code — Apply to use it";
  const IMPORTED = { gcb: "Imported code", gpb: "Imported code from Gradient Progress Bar" };

  function enableSharing(m) {
    m.exportButton.addEventListener("click", () => copyCode(m));
    m.codeOutput.addEventListener("blur", () => (m.codeFallback.hidden = true));
    m.importButton.addEventListener("click", () => toggleImport(m));
    m.importApply.addEventListener("click", () => importCode(m));
    m.codeInput.addEventListener("input", () => {
      setImportError(m, false);
      renderPreview(); // a valid code previews in the strip
      renderStatus();
    });
    m.codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        importCode(m);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // the field closes, not the modal
        toggleImport(m, false);
        m.importButton.focus({ preventScroll: true });
      }
    });
    m.cleanups.push(() => clearTimeout(m.copiedTimer));
  }

  // Resolves to the tier that copied the code, or null when the fallback field shows instead.
  async function copyCode(m) {
    const code = encodeCode(settings);
    const tier = await writeClipboard(code);
    if (modal !== m) return tier;
    showExportCopied(m, !!tier);
    if (!tier) {
      m.codeOutput.value = code;
      m.codeFallback.hidden = false;
      m.codeOutput.focus({ preventScroll: true });
      m.codeOutput.select();
      return null;
    }
    m.codeFallback.hidden = true;
    m.announce.textContent = "Share code copied";
    return tier;
  }

  // In place: only the label's text and which icon is hidden change, never the button.
  function showExportCopied(m, copied) {
    clearTimeout(m.copiedTimer);
    m.exportLabel.textContent = copied ? COPIED_LABEL : EXPORT_LABEL;
    m.exportIcon.toggleAttribute("hidden", copied);
    m.exportCheck.toggleAttribute("hidden", !copied);
    if (copied) m.copiedTimer = setTimeout(() => showExportCopied(m, false), COPIED_MS);
  }

  // Opening empties the field and closing ends its preview, so the strip shows the current
  // settings either way.
  function toggleImport(m, open = m.importPanel.hidden) {
    m.importPanel.hidden = !open;
    m.importButton.setAttribute("aria-expanded", String(open));
    if (open) {
      m.codeInput.value = "";
      setImportError(m, false);
      m.codeInput.focus({ preventScroll: true });
    }
    if (modal !== m) return;
    renderPreview();
    renderStatus();
  }

  function setImportError(m, invalid) {
    if (invalid) m.codeInput.setAttribute("aria-invalid", "true");
    else m.codeInput.removeAttribute("aria-invalid");
    m.importError.textContent = invalid ? IMPORT_ERROR : "";
  }

  // An invalid code changes nothing. A valid one applies; the panel (with the clicked Apply in
  // it) is hidden, not removed.
  function importCode(m) {
    const decoded = decodeCode(m.codeInput.value);
    if (!decoded) {
      setImportError(m, true);
      return false;
    }
    toggleImport(m, false);
    m.importButton.focus({ preventScroll: true });
    applySettings(decoded.settings, IMPORTED[decoded.from], m.importButton);
    return true;
  }

  // The active chip does nothing; any other is armed (and previewed) by the first click and
  // applied by the second. A click on another chip disarms this one first (outside input), so
  // browsing moves the arm and the preview chip by chip.
  function clickChip(m, chip) {
    const preset = presetById(chip.dataset.preset);
    if (!preset || matchesPreset(preset)) return;
    if (m.armed?.chip !== chip) return armChip(m, chip, preset);
    disarmChip(m);
    applySettings(presetSettings(preset), `Applied "${preset.name}"`, chip);
  }

  function armChip(m, chip, preset) {
    disarmChip(m);
    chip.classList.add("gcb-armed");
    chip.querySelector(".gcb-chip-label").textContent = APPLY_LABEL;
    chip.setAttribute("aria-label", `Apply "${preset.name}"?`);
    m.armed = { chip, name: preset.name, settings: presetSettings(preset) };
    renderPreview();
    renderStatus();
  }

  function disarmChip(m) {
    if (!m.armed) return;
    const { chip } = m.armed;
    m.armed = null;
    const name = presetById(chip.dataset.preset)?.name ?? "";
    chip.classList.remove("gcb-armed");
    chip.querySelector(".gcb-chip-label").textContent = name;
    chip.setAttribute("aria-label", name);
    if (modal !== m) return;
    renderPreview();
    renderStatus();
  }

  // What the strip shows instead of the current settings: the armed chip's preset, or a valid
  // code in the open Import field. Null when nothing is being previewed.
  function previewing(m) {
    if (m.armed) return { settings: m.armed.settings, message: `Previewing "${m.armed.name}" — click it again to apply, Esc to cancel` };
    const code = m.importPanel.hidden ? null : decodeCode(m.codeInput.value);
    return code && { settings: code.settings, message: PREVIEW_CODE_MESSAGE };
  }

  // Replaces the settings (selection back on the first dot) and offers Undo for the old ones.
  // The text colour is recalculated at once, so the bar and the strip agree straight away.
  function applySettings(next, message, focusAfterUndo = null) {
    const previous = structuredClone(settings);
    settings = next;
    selectedId = settings.stops[0].id;
    recalcTextColour();
    update();
    offerUndo(message, (hadFocus) => {
      settings = previous;
      selectedId = previous.stops[0].id;
      recalcTextColour();
      update();
      if (hadFocus && focusAfterUndo?.isConnected) focusAfterUndo.focus({ preventScroll: true });
    }, { trackSettings: true });
  }

  function deleteWithUndo(m, id) {
    const removed = deletePreset(id);
    if (!removed) return;
    renderChipsLater(m, (presets[removed.index] ?? presets[removed.index - 1])?.id ?? "save");
    offerUndo(`Deleted "${removed.preset.name}"`, (hadFocus) => {
      restorePreset(removed);
      renderChipsLater(m, hadFocus ? removed.preset.id : null);
    }, { kind: "preset" });
  }

  // ── Undo ──
  // One pending undo at a time: a new action replaces it. It lasts UNDO_MS, ends when the modal
  // closes, and a settings undo also ends when the settings change some other way (update()).

  let pendingUndo = null; // { message, kind, restore(hadFocus), after, timer }

  function offerUndo(message, restore, { trackSettings = false, kind = "settings" } = {}) {
    clearUndo();
    const after = trackSettings ? JSON.stringify(settings) : null;
    pendingUndo = { message, kind, restore, after, timer: setTimeout(clearUndo, UNDO_MS) };
    renderStatus();
  }

  function clearUndo() {
    if (!pendingUndo) return;
    clearTimeout(pendingUndo.timer);
    pendingUndo = null;
    renderStatus();
  }

  // The Undo button is hidden, not removed, in its own click.
  function runUndo() {
    const undo = pendingUndo;
    if (!undo) return;
    const hadFocus = !!modal && document.activeElement === modal.undoButton;
    clearUndo();
    undo.restore(hadFocus);
  }

  // The status line under the chips: a preview's message wins; when the preview ends, a
  // still-running Undo shows again.
  function renderStatus() {
    if (!modal) return;
    const preview = previewing(modal);
    const undo = !preview && pendingUndo;
    modal.undoLine.classList.toggle("gcb-has-status", !!(preview || undo));
    modal.undoText.textContent = preview ? preview.message : undo ? `${undo.message} · ` : "";
    modal.undoButton.hidden = !undo;
  }

  // ── Chip row rendering ──

  function renderChips(m) {
    disarmChip(m);
    if (!m.naming) m.saveChip.after(m.nameField);
    for (const chip of m.chips.querySelectorAll(".gcb-preset-chip")) chip.remove();
    m.builtInRow.append(...BUILT_IN_PRESETS.map(presetChip)); // row 1: the built-ins only
    for (const preset of presets) m.saveChip.before(presetChip(preset)); // row 2: own presets, then + Save
    const full = presets.length >= MAX_PRESETS;
    m.saveChip.disabled = full;
    m.saveChip.title = full ? SAVE_FULL_LABEL : SAVE_LABEL;
    renderPresetStates();
  }

  // After Save, Rename, Update and Delete: deferred, with the menu closed first.
  function renderChipsLater(m, focusId = null) {
    closePopover();
    disarmChip(m);
    setTimeout(() => {
      if (modal !== m) return;
      renderChips(m);
      const target = focusId === "save" ? m.saveChip : focusId ? chipEl(focusId) : null;
      target?.focus({ preventScroll: true });
    }, 0);
  }

  // A pill: a 12 px swatch painted with the preset's barImage(), and the name. Names are user
  // text, so they only ever go in through textContent.
  function presetChip(preset) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "gcb-chip gcb-preset-chip";
    chip.dataset.preset = preset.id;
    chip.setAttribute("aria-pressed", "false");
    chip.setAttribute("aria-label", preset.name);
    chip.title = preset.builtIn ? preset.name : `${preset.name}\n${OWN_PRESET_HINT}`;
    chip.innerHTML =
      '<span class="gcb-chip-swatch" aria-hidden="true"></span><span class="gcb-chip-text">' +
      '<span class="gcb-chip-label" aria-live="polite"></span><span class="gcb-sizer" aria-hidden="true"></span>' +
      `<span class="gcb-sizer" aria-hidden="true">${APPLY_LABEL}</span></span>`;
    chip.querySelector(".gcb-chip-swatch").style.backgroundImage = barImage(presetSettings(preset));
    chip.querySelector(".gcb-chip-label").textContent = preset.name;
    chip.querySelector(".gcb-sizer").textContent = preset.name;
    return chip;
  }

  // The chip whose settings equal the current ones is marked active.
  function renderPresetStates() {
    if (!modal) return;
    for (const chip of modal.chips.querySelectorAll(".gcb-preset-chip")) {
      const preset = presetById(chip.dataset.preset);
      chip.setAttribute("aria-pressed", String(!!preset && matchesPreset(preset)));
    }
  }

  // ── Naming (+ Save, Rename) ──
  // One inline name field (not a popover) takes the place of the + Save chip or of the chip
  // being renamed. Enter saves, Escape cancels, and so does leaving the field.

  function startNaming(m, mode, id = null) {
    if (m.naming) return;
    const preset = mode === "rename" ? presets.find((p) => p.id === id) : null;
    const chip = mode === "rename" ? chipEl(id) : m.saveChip;
    if (!chip || (mode === "rename" && !preset)) return;
    disarmChip(m);
    m.naming = { mode, id, chip };
    chip.before(m.nameField);
    chip.hidden = true; // hidden, not removed: it may be the element being clicked
    m.nameField.value = preset ? preset.name : defaultPresetName();
    m.nameField.setAttribute("aria-label", preset ? `New name for "${preset.name}"` : "Preset name");
    m.nameField.hidden = false;
    m.nameField.focus({ preventScroll: true });
    m.nameField.select();
  }

  function stopNaming(m, { commit = false, refocus = false } = {}) {
    const naming = m.naming;
    if (!naming) return;
    m.naming = null;
    m.nameField.hidden = true;
    m.saveChip.after(m.nameField);
    naming.chip.hidden = false;
    if (!commit) {
      if (refocus) naming.chip.focus({ preventScroll: true });
      return;
    }
    if (pendingUndo?.kind === "preset") clearUndo(); // a restored preset could clash with this change
    if (naming.mode === "save") renderChipsLater(m, addPreset(m.nameField.value)?.id ?? "save");
    else {
      renamePreset(naming.id, m.nameField.value); // an empty name keeps the old one
      renderChipsLater(m, naming.id);
    }
  }

  // ── Chip menu ──
  // The dot menu's popover with the preset items instead: inside the modal root, hidden, never
  // removed.

  function openChipMenu(id, { at = null, keyboard = false } = {}) {
    const anchor = chipEl(id);
    if (!anchor || !isOwnPreset(id)) return;
    disarmChip(modal);
    setMenuKind("chip");
    if (showPopover(id, modal.menu, at, anchor) && keyboard) menuItems()[0]?.focus({ preventScroll: true });
  }

  function runChipAction(action) {
    if (!popover) return;
    const { id } = popover;
    closePopover();
    action(id);
  }

  // ── Two-step Reset ──
  // Reset can't be undone, so the first click only arms it ("Confirm reset?" in red); a second
  // click within RESET_CONFIRM_MS resets. Only the label and a class change — the button node is
  // never replaced, so its click target stays connected. A hidden copy of the longer label keeps
  // the button's width fixed.

  const RESET_CONFIRM_MS = 3000;
  const RESET_CONFIRM_LABEL = "Confirm reset?";

  function enableReset(m) {
    const button = m.resetButton;
    let timer = 0;
    const armed = () => button.classList.contains("gcb-armed");
    const disarm = () => {
      clearTimeout(timer);
      timer = 0;
      button.classList.remove("gcb-armed");
      m.resetLabel.textContent = "Reset";
    };
    button.addEventListener("click", () => {
      if (armed()) {
        disarm();
        resetSettings();
        return;
      }
      button.classList.add("gcb-armed");
      m.resetLabel.textContent = RESET_CONFIRM_LABEL;
      timer = setTimeout(disarm, RESET_CONFIRM_MS);
    });
    button.addEventListener("blur", () => armed() && disarm());
    disarmOnOutsideInput(m, () => (armed() ? button : null), disarm);
    m.cleanups.push(disarm); // clears the timer when the modal closes
  }

  // An armed two-step button (Reset, a preset chip) disarms on Escape — stopped there, so the modal stays — and on any
  // pointerdown, click or keydown elsewhere. Enter/Space on the button itself is the confirmation.
  // `armedEl()` returns the armed element or null.
  function disarmOnOutsideInput(m, armedEl, disarm) {
    const listen = (type, handler) => {
      document.addEventListener(type, handler, true);
      m.cleanups.push(() => document.removeEventListener(type, handler, true));
    };
    const elsewhere = (e) => {
      const el = armedEl();
      if (el && !el.contains(e.target)) disarm();
    };
    listen("pointerdown", elsewhere);
    listen("click", elsewhere);
    listen("keydown", (e) => {
      const el = armedEl();
      if (!el) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        disarm();
      } else if (!el.contains(e.target)) disarm();
    });
  }

  // ── Clipboard ──
  // One helper for every copy: the hex field's copy button and the self-test report. Spotify's
  // client refuses navigator.clipboard.writeText, so Spicetify's ClipboardAPI goes first, then
  // writeText, then execCommand("copy") from a hidden, selected textarea. An async tier that hasn't
  // settled after CLIPBOARD_TIMEOUT_MS counts as failed. execCommand needs the click's user
  // activation, which Chromium keeps for 5 s, so it still works after the other two have failed.

  const CLIPBOARD_TIMEOUT_MS = 1500;
  const clipboardSources = { // where the tiers come from; the self-test swaps these for stubs
    api: () => window.Spicetify?.Platform?.ClipboardAPI,
    clipboard: () => navigator.clipboard,
    execCommand: (command) => document.execCommand(command),
  };

  // Resolves to the tier that worked ("ClipboardAPI", "writeText" or "execCommand"), or null.
  async function writeClipboard(text) {
    const settle = (promise) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), CLIPBOARD_TIMEOUT_MS)),
    ]);
    const asyncTiers = [
      ["ClipboardAPI", () => {
        const clipboardApi = clipboardSources.api();
        if (typeof clipboardApi?.copy !== "function") throw new Error("no ClipboardAPI");
        return clipboardApi.copy(text);
      }],
      ["writeText", () => {
        const clipboard = clipboardSources.clipboard();
        if (typeof clipboard?.writeText !== "function") throw new Error("no clipboard");
        return clipboard.writeText(text);
      }],
    ];
    for (const [name, write] of asyncTiers) {
      try {
        await settle(Promise.resolve().then(write));
        return name;
      } catch {}
    }
    return execCommandCopy(text) ? "execCommand" : null;
  }

  // The textarea goes inside the modal root while it's open (never into Spotify's DOM around it)
  // and is removed straight away; focus goes back to where it was.
  function execCommandCopy(text) {
    const buffer = document.createElement("textarea");
    buffer.className = "gcb-copy-buffer";
    buffer.value = text;
    buffer.readOnly = true;
    buffer.tabIndex = -1;
    buffer.setAttribute("aria-hidden", "true");
    Object.assign(buffer.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", padding: "0", border: "0", opacity: "0", pointerEvents: "none" });
    const focused = document.activeElement;
    (modal?.root ?? document.body).append(buffer);
    buffer.focus({ preventScroll: true });
    buffer.select();
    let copied = false;
    try {
      copied = clipboardSources.execCommand("copy") === true;
    } catch {}
    buffer.remove();
    if (focused?.isConnected && focused !== document.body) focused.focus({ preventScroll: true });
    return copied;
  }

  // ── Selection ──
  // Exactly one dot is selected (it has the ring); the inline picker always edits it.

  let selectedId = null;

  function dotEl(id) {
    return modal?.stopsRow.querySelector(`.gcb-stop[data-id="${CSS.escape(id)}"]`) ?? null;
  }

  // Moves the ring in place — the dots row is not re-rendered.
  function selectStop(id, { focusHex = false } = {}) {
    const stop = findStop(id);
    if (!stop || !modal) return;
    if (id !== selectedId) {
      dotEl(selectedId)?.classList.remove("gcb-selected");
      dotEl(selectedId)?.setAttribute("aria-current", "false");
      selectedId = id;
      dotEl(id).classList.add("gcb-selected");
      dotEl(id).setAttribute("aria-current", "true");
      showInPicker(stop);
    }
    if (focusHex) modal.hex.focus({ preventScroll: true });
  }

  // ── Dot menu popover ──
  // Rendered inside the modal root: Spicetify's PopupModal hides itself when a click lands outside
  // .GenericModal. Shown and hidden, never removed while the modal is open, so a click is never
  // dispatched to a detached element. Only the small menu is a popover: a theme can trap
  // position: fixed inside the dialog (Hazy's backdrop-filter), so the picker is inline.

  let popover = null; // { id, el, anchor, at, openedAt } or null
  const POPOVER_EDGE = 8; // min distance from the window edge
  const POPOVER_GAP = 8; // between a dot and a popover anchored to it

  // `at` is a viewport point (menu at the cursor); without it the popover sits under the dot.
  function showPopover(id, el, at = null, anchor = dotEl(id)) {
    closePopover();
    if (!anchor) return false;
    popover = { id, el, anchor, at, openedAt: performance.now() };
    el.hidden = false;
    placePopover();
    return true;
  }

  function closePopover({ focusDot = false } = {}) {
    if (!popover) return;
    const { el, anchor } = popover;
    popover = null;
    el.hidden = true; // hidden, not removed: it may contain the element being clicked
    if (focusDot && anchor.isConnected) anchor.focus({ preventScroll: true });
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  // position: fixed escapes the modal's overflow clipping. A transformed ancestor would make
  // it relative to that ancestor instead of the window; measuring at 0,0 finds the offset.
  function placePopover() {
    const { el, anchor, at } = popover;
    el.style.left = el.style.top = "0px";
    const origin = el.getBoundingClientRect();
    const { width, height } = origin;
    let left, top;
    if (at) {
      left = at.x + width > innerWidth - POPOVER_EDGE ? at.x - width : at.x;
      top = at.y + height > innerHeight - POPOVER_EDGE ? at.y - height : at.y;
    } else {
      const r = anchor.getBoundingClientRect();
      left = r.left + r.width / 2 - width / 2;
      top = r.bottom + POPOVER_GAP;
      // Flip above the dot if it doesn't fit below but does above.
      if (top + height > innerHeight - POPOVER_EDGE && r.top - POPOVER_GAP - height >= POPOVER_EDGE)
        top = r.top - POPOVER_GAP - height;
    }
    left = clamp(left, POPOVER_EDGE, innerWidth - POPOVER_EDGE - width);
    top = clamp(top, POPOVER_EDGE, innerHeight - POPOVER_EDGE - height);
    el.style.left = `${left - origin.left}px`;
    el.style.top = `${top - origin.top}px`;
  }

  // Escape, or a click or focus anywhere outside the open menu, closes it. Listeners live
  // only while the modal is open.
  function watchPopovers(m) {
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler, true);
      m.cleanups.push(() => target.removeEventListener(type, handler, true));
    };
    const outside = (target) => popover && !popover.el.contains(target);
    listen(document, "pointerdown", (e) => outside(e.target) && closePopover());
    listen(document, "focusin", (e) => outside(e.target) && closePopover());
    listen(document, "keydown", (e) => {
      if (!popover || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation(); // the menu closes, not the modal
      closePopover({ focusDot: true });
    });
    listen(window, "resize", () => closePopover());
    listen(document, "scroll", () => closePopover());
  }

  // Right-click (or the context-menu key / Shift+F10) on a dot: Duplicate, Remove.
  function enableDotMenu(m) {
    m.stopsRow.addEventListener("contextmenu", (e) => {
      const el = e.target.closest(".gcb-stop");
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const id = el.dataset.id;
      // Shift+F10 / the menu key already opened it from keydown.
      if (popover?.id === id && performance.now() - popover.openedAt < 500) return;
      // A keyboard-triggered contextmenu has no pointer position on the dot.
      const r = el.getBoundingClientRect();
      const onDot = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      openMenu(id, onDot ? { at: { x: e.clientX, y: e.clientY } } : { keyboard: true });
    });
    m.stopsRow.addEventListener("keydown", (e) => {
      const el = e.target.closest(".gcb-stop");
      if (!el || !(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
      e.preventDefault();
      openMenu(el.dataset.id, { keyboard: true });
    });
    m.menu.addEventListener("keydown", (e) => {
      const items = menuItems();
      const i = items.indexOf(document.activeElement);
      const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
      if (next !== undefined) {
        e.preventDefault();
        items[(next + items.length) % items.length]?.focus();
      } else if (e.key === "Tab") {
        e.preventDefault();
        closePopover({ focusDot: true });
      }
    });
    m.duplicateItem.addEventListener("click", () => runMenuAction(duplicateStop));
    m.removeItem.addEventListener("click", () => runMenuAction(removeStop));
  }

  const menuItems = () => [...modal.menu.querySelectorAll(".gcb-menu-item:not(:disabled):not([hidden])")];

  // One menu element for dots (Duplicate, Remove) and own preset chips (Rename, Update, Delete).
  function setMenuKind(kind) {
    for (const item of [modal.duplicateItem, modal.removeItem]) item.hidden = kind !== "dot";
    for (const item of [modal.renameItem, modal.updatePresetItem, modal.deletePresetItem]) item.hidden = kind !== "chip";
    modal.menu.setAttribute("aria-label", kind === "dot" ? "Colour actions" : "Preset actions");
  }

  function openMenu(id, { at = null, keyboard = false } = {}) {
    setMenuKind("dot");
    modal.duplicateItem.disabled = settings.stops.length >= MAX_STOPS;
    modal.removeItem.disabled = settings.stops.length <= 1;
    if (showPopover(id, modal.menu, at) && keyboard) menuItems()[0]?.focus({ preventScroll: true });
  }

  // Hides the menu first, then acts: the clicked item stays connected, so the modal stays
  // open. `action(id)` returns the id of the dot that should get focus afterwards.
  function runMenuAction(action) {
    if (!popover) return;
    const { id } = popover;
    closePopover();
    const focusId = action(id);
    dotEl(focusId)?.focus({ preventScroll: true });
  }

  // ── Colour picker ──
  // Chromium's native picker popup is browser chrome and can't be extended, so this mirrors its
  // layout — saturation/value square, eyedropper, swatch, hue bar, R/G/B — and adds a hex field,
  // "Use theme colour". It's an inline panel that always edits the selected dot. Edits apply live and update the dot in place: the dots row is never re-rendered by them.

  let pickerHsv = { h: 0, s: 0, v: 0 }; // kept apart from the hex so hue survives greys and black
  let lastDragEnd = -Infinity; // set by drag-and-drop; a click right after a drag is ignored

  // `hue` is kept when the colour has none (greys).
  function hexToHsv(hex, hue = 0) {
    const [r, g, b] = hexToRgb(hex).map((n) => n / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let h = hue;
    if (d) h = 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
    return { h, s: max ? d / max : 0, v: max };
  }

  function hsvToHex({ h, s, v }) {
    const channel = (n) => {
      const k = (n + h / 60) % 6;
      return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
    };
    return rgbToHex([channel(5), channel(3), channel(1)]);
  }

  const pickerStop = () => (modal ? findStop(selectedId) : null);

  // ── Hex copy button ──
  // Copies the selected stop's colour as #rrggbb (a theme stop's resolved colour),
  // never the field's text, so half-typed or invalid input can't be copied. Through
  // writeClipboard(); the icon turns into a check for HEX_COPIED_MS. Nothing else changes.

  const HEX_COPY_LABEL = "Copy hex code";
  const HEX_COPIED_MS = 1500;

  async function copyHex(m) {
    const stop = pickerStop();
    if (!stop) return null;
    const tier = await writeClipboard(resolveStop(stop));
    if (modal !== m) return tier;
    if (!tier) {
      m.hex.focus({ preventScroll: true }); // every tier failed: Ctrl+C on the selected field works
      m.hex.select();
      return null;
    }
    clearTimeout(m.hexCopiedTimer);
    showHexCopied(m, true);
    m.hexCopiedTimer = setTimeout(() => showHexCopied(m, false), HEX_COPIED_MS);
    m.announce.textContent = "Hex code copied";
    return tier;
  }

  // In place: only which icon is hidden changes, never the button.
  function showHexCopied(m, copied) {
    m.hexCopyIcon.toggleAttribute("hidden", copied);
    m.hexCopyCheck.toggleAttribute("hidden", !copied);
  }

  // Loads a stop's current colour into the picker. The previous hue is kept for greys.
  function showInPicker(stop, from = null) {
    pickerHsv = hexToHsv(resolveStop(stop), pickerHsv.h);
    renderPicker(stop, from);
  }

  // `from` is the control being edited; it keeps its own text while you type.
  function renderPicker(stop, from = null) {
    const m = modal;
    const hex = resolveStop(stop);
    const { h, s, v } = pickerHsv;
    m.sv.style.backgroundColor = `hsl(${h}, 100%, 50%)`;
    m.svHandle.style.left = `${s * 100}%`;
    m.svHandle.style.top = `${(1 - v) * 100}%`;
    m.sv.setAttribute("aria-valuetext", `Saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`);
    m.hueHandle.style.left = `${(h / 360) * 100}%`;
    m.hue.setAttribute("aria-valuenow", String(Math.round(h)));
    m.swatch.style.backgroundColor = hex;
    if (from !== "rgb")
      hexToRgb(hex).forEach((n, i) => {
        m.rgb[i].value = String(n);
        m.rgb[i].setAttribute("aria-invalid", "false");
      });
    if (from !== "hex") {
      m.hex.value = hex;
      m.hex.setAttribute("aria-invalid", "false");
    }
    const isTheme = stop.kind === "theme";
    m.useThemeButton.disabled = isTheme;
    m.useThemeButton.textContent = isTheme ? THEME_LABELS.on : THEME_LABELS.off;
  }

  // Applies a colour to the picker's stop: bar, preview and dot update in place; a theme stop
  // becomes custom. Colours from the square or hue bar keep their exact HSV.
  function commitPickerColour(hex, from = null) {
    const stop = pickerStop();
    if (!stop) return;
    if (from !== "hsv") pickerHsv = hexToHsv(hex, pickerHsv.h);
    if (stop.kind !== "custom" || stop.color !== hex) {
      setStopColour(stop.id, hex);
      renderStop(stop);
    }
    renderPicker(stop, from);
  }

  // Pointer drag on a picker area → apply({ x, y }) as fractions 0–1. Pointer capture keeps
  // the drag (and its click) on the area even outside the modal; moves are coalesced to one
  // update per frame, and the final position is applied on release.
  function enablePointerDrag(el, apply) {
    let active = false;
    let pending = null;
    let frame = 0;
    const at = (e) => {
      const r = el.getBoundingClientRect();
      return { x: clamp((e.clientX - r.left) / (r.width || 1), 0, 1), y: clamp((e.clientY - r.top) / (r.height || 1), 0, 1) };
    };
    const flush = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!pending) return;
      const p = pending;
      pending = null;
      apply(p);
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // no text selection or native drag
      el.focus({ preventScroll: true });
      try {
        el.setPointerCapture(e.pointerId);
      } catch {} // synthetic events (self-test) have no active pointer
      active = true;
      apply(at(e));
    });
    el.addEventListener("pointermove", (e) => {
      if (!active) return;
      pending = at(e);
      frame ||= requestAnimationFrame(flush);
    });
    const end = (e) => {
      if (!active) return;
      active = false;
      if (e.type === "pointerup") pending = at(e);
      flush();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  function enableColourPicker(m) {
    const setHsv = (change) => {
      pickerHsv = { ...pickerHsv, ...change };
      commitPickerColour(hsvToHex(pickerHsv), "hsv");
    };
    enablePointerDrag(m.sv, ({ x, y }) => setHsv({ s: x, v: 1 - y }));
    enablePointerDrag(m.hue, ({ x }) => setHsv({ h: x * 360 }));

    // Arrow keys: 1 % (hue: 1°), with Shift 10 % (10°).
    m.sv.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.1 : 0.01;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowDown: [0, -step], ArrowUp: [0, step] }[e.key];
      if (!delta) return;
      e.preventDefault();
      setHsv({ s: clamp(pickerHsv.s + delta[0], 0, 1), v: clamp(pickerHsv.v + delta[1], 0, 1) });
    });
    m.hue.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 10 : 1;
      const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
      if (!delta) return;
      e.preventDefault();
      setHsv({ h: clamp(pickerHsv.h + delta, 0, 360) });
    });

    for (const field of m.rgb)
      field.addEventListener("input", () => {
        const texts = m.rgb.map((f) => f.value.trim());
        const values = texts.map((t) => (/^\d{1,3}$/.test(t) && +t <= 255 ? +t : null));
        m.rgb.forEach((f, i) => f.setAttribute("aria-invalid", String(values[i] === null && texts[i] !== "")));
        if (values.every((n) => n !== null)) commitPickerColour(rgbToHex(values), "rgb");
      });
    m.hex.addEventListener("input", () => {
      const hex = parseHex(m.hex.value);
      m.hex.setAttribute("aria-invalid", String(!hex && m.hex.value.trim() !== ""));
      if (hex) commitPickerColour(hex, "hex");
    });
    // Leaving a field (or Enter) shows the normalised value.
    for (const field of [...m.rgb, m.hex]) {
      field.addEventListener("change", () => pickerStop() && renderPicker(pickerStop()));
      field.addEventListener("keydown", (e) => e.key === "Enter" && field.blur());
    }

    // A mouse click leaves focus (and any half-typed text) in the field.
    m.hexCopy.addEventListener("mousedown", (e) => e.preventDefault());
    m.hexCopy.addEventListener("click", () => copyHex(m));
    m.cleanups.push(() => clearTimeout(m.hexCopiedTimer));

    m.useThemeButton.addEventListener("click", () => {
      const stop = pickerStop();
      if (!stop || stop.kind === "theme") return;
      const hadFocus = document.activeElement === m.useThemeButton; // it's about to be disabled
      linkStopToTheme(stop.id);
      renderStop(stop);
      showInPicker(stop);
      if (hadFocus) m.hex.focus({ preventScroll: true });
    });

    m.eyedropper?.addEventListener("click", async () => {
      const id = selectedId;
      try {
        const hex = toHex((await new window.EyeDropper().open()).sRGBHex);
        if (hex && modal === m && pickerStop()?.id === id) commitPickerColour(hex);
      } catch {} // cancelled with Escape
    });
  }

  const STOP_GAP = 14; // matches .gcb-stops gap; .gcb-dots' 10 px gap + its 4 px padding put the stepper as far away

  // The dots are buttons, so dragging never fights a native colour input.
  function enableDragAndDrop(m) {
    const row = m.stopsRow;
    let dragId = null;
    let dropIndex = -1;

    const endDrag = () => {
      dragId = null;
      lastDragEnd = performance.now();
      row.querySelector(".gcb-dragging")?.classList.remove("gcb-dragging");
      row.querySelector(".gcb-marker").hidden = true;
    };

    row.addEventListener("dragstart", (e) => {
      const el = e.target.closest?.(".gcb-stop");
      if (!el || settings.stops.length < 2) return e.preventDefault();
      closePopover();
      dragId = el.dataset.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragId);
      e.dataTransfer.setDragImage(el, el.offsetWidth / 2, el.offsetHeight / 2);
      el.classList.add("gcb-dragging");
    });
    row.addEventListener("dragover", (e) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      dropIndex = dropIndexAt(row, e.clientX, e.clientY);
      showDropMarker(row, dropIndex);
    });
    row.addEventListener("dragleave", (e) => {
      if (!row.contains(e.relatedTarget)) row.querySelector(".gcb-marker").hidden = true;
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const id = dragId;
      endDrag(); // before moveStop: re-rendering detaches the source, so its dragend never reaches us
      if (id) moveStop(id, dropIndex);
    });
    row.addEventListener("dragend", endDrag);
  }

  // Alt + ←/→ moves the focused dot one place, Alt + Home/End to the first or last place, through
  // the same moveStop() as drag-and-drop. The row is re-rendered, so focus goes to the new node
  // with the same id; the selection doesn't change. Plain arrows, Enter/Space and Shift+F10 are
  // left alone.
  function enableKeyboardReorder(m) {
    m.stopsRow.addEventListener("keydown", (e) => {
      const el = e.target.closest(".gcb-stop");
      if (!el || !e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
      const id = el.dataset.id;
      const from = settings.stops.findIndex((s) => s.id === id);
      const last = settings.stops.length - 1;
      const to = { ArrowLeft: from - 1, ArrowRight: from + 1, Home: 0, End: last }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      e.stopPropagation(); // Alt+←/→ is also Spotify's Back/Forward, even at the edges
      if (from === -1 || to < 0 || to > last || to === from) return;
      moveStop(id, to > from ? to + 1 : to); // moveStop takes an insertion point
      dotEl(id)?.focus();
      m.announce.textContent = `Moved to position ${to + 1} of ${last + 1}`;
    });
  }

  // Delete or Backspace on a focused dot removes that dot through the same removeStop() as the dot
  // menu and −, so the selection rule applies. Focus goes to the dot now at its index. With one
  // colour nothing is removed, but the key is still consumed. On .gcb-stops, so Backspace in the
  // picker's text fields keeps editing text.
  function enableKeyboardRemove(m) {
    m.stopsRow.addEventListener("keydown", (e) => {
      const el = e.target.closest(".gcb-stop");
      if (!el || (e.key !== "Delete" && e.key !== "Backspace") || e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const index = settings.stops.findIndex((s) => s.id === el.dataset.id);
      if (index === -1 || settings.stops.length <= 1) return;
      removeStop(el.dataset.id);
      dotEl(settings.stops[Math.min(index, settings.stops.length - 1)].id)?.focus();
      m.announce.textContent = `Colour removed, ${settings.stops.length} left`;
    });
  }

  // Insertion index under the pointer; the row wraps, so compare line first, then x.
  function dropIndexAt(row, x, y) {
    const stops = [...row.querySelectorAll(".gcb-stop")];
    const i = stops.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top || (y <= r.bottom && x < r.left + r.width / 2);
    });
    return i === -1 ? stops.length : i;
  }

  // Absolutely positioned so showing it never reflows the row.
  function showDropMarker(row, index) {
    const stops = row.querySelectorAll(".gcb-stop");
    const marker = row.querySelector(".gcb-marker");
    const rowRect = row.getBoundingClientRect();
    const ref = stops[Math.min(index, stops.length - 1)].getBoundingClientRect();
    const x = index < stops.length ? ref.left - STOP_GAP / 2 : ref.right + STOP_GAP / 2;
    marker.style.left = `${x - rowRect.left - 1}px`;
    marker.style.top = `${ref.top - rowRect.top}px`;
    marker.hidden = false;
  }

  // Themes like Hazy rewrite --spice-button inline on :root (e.g. on every songchange), so keep
  // the theme swatches and the preview current while the modal is open.
  function watchThemeColour(m) {
    const sync = () => {
      if (modal !== m) return;
      renderTextColour(); // the checked button's label colour depends on the live --spice-button
      renderPreview();
      for (const stop of settings.stops) if (stop.kind === "theme") renderStop(stop);
      const stop = pickerStop();
      if (stop?.kind === "theme") showInPicker(stop, document.activeElement === m.hex ? "hex" : null);
    };
    modalObserver(m, sync).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    Spicetify.Player.addEventListener("songchange", sync);
    m.cleanups.push(() => Spicetify.Player.removeEventListener("songchange", sync));
  }

  // PopupModal has no close callback: hide() removes it from <body>, and another
  // extension's display() replaces its contents. Either way our root is detached.
  function watchModalClose(m) {
    const observer = modalObserver(m, () => {
      if (!m.root.isConnected) closeModal(m);
    });
    observer.observe(document.body, { childList: true });
    observer.observe(Spicetify.PopupModal, { childList: true });
  }

  let liveObservers = 0; // checked by the self-test

  // A MutationObserver that is disconnected when the modal closes.
  function modalObserver(m, callback) {
    const observer = new MutationObserver(callback);
    liveObservers++;
    m.cleanups.push(() => {
      observer.disconnect();
      liveObservers--;
    });
    return observer;
  }

  function closeModal(m) {
    if (m.closed) return;
    m.closed = true;
    for (const cleanup of m.cleanups) cleanup();
    if (modal === m) modal = null;
    flushSettings();
  }

  function renderModal() {
    closePopover(); // the dots are rebuilt, so the menu would lose its anchor
    if (!findStop(selectedId)) selectedId = settings.stops[0].id; // never nothing selected
    renderSwitch();
    renderTextColour(); // in place: the row is never rebuilt
    renderPreview();
    renderStops();
    showInPicker(findStop(selectedId));
    const count = settings.stops.length;
    modal.plusButton.disabled = count >= MAX_STOPS;
    modal.plusButton.title = count >= MAX_STOPS ? ADD_FULL_LABEL : ADD_LABEL;
    modal.minusButton.disabled = count <= 1;
    modal.minusButton.title = count <= 1 ? REMOVE_LAST_LABEL : REMOVE_LABEL;
  }

  // In place, never replaced: focus stays on the switch when it adds a colour.
  function renderSwitch() {
    modal.switchButton.setAttribute("aria-checked", String(settings.gradient));
  }

  // The bar as it would look (#7): the bar's own colour underneath, the same background-image
  // string as the stylesheet on top, and the text colour the settings give. It shows the current
  // settings, or the preset or code being previewed (#29, #36). Only inline styles of our own
  // element change, in place.
  function renderPreview() {
    const { preview } = modal;
    const shown = previewing(modal)?.settings ?? settings;
    preview.style.backgroundColor = barBase();
    preview.style.backgroundImage = isInert(shown) ? "none" : barImage(shown);
    preview.style.color = textColourFor(shown);
  }

  // What Spotify draws the text in: the live bar's text colour, read only while our rule doesn't
  // set it (otherwise it's ours), else the last one read, else Spicetify's mapping for
  // .encore-bright-accent-set (--text-base: var(--spice-sidebar)).
  let lastBarText = null;

  function spotifyTextColour() {
    const link = findBar()?.querySelector(BAR_LINK);
    const ours = document.getElementById("gcb-style")?.textContent.includes("--text-base");
    if (link && !ours) {
      const span = link.querySelector("span") ?? link;
      const rgb = parseRgb(getComputedStyle(span).color);
      if (rgb) lastBarText = rgbToHex(rgb.map(Math.round));
    }
    return lastBarText || rootColour("--spice-sidebar") || "#000000";
  }

  // The text colour settings `s` give the bar: Black and White literally, Spotify's own for
  // Spotify default, and for Auto the current choice or, for other settings (a previewed preset or
  // code), Auto computed for their colours over the last text region.
  function textColourFor(s) {
    if (s.textColour === "default") return spotifyTextColour();
    if (s.textColour !== "auto") return appliedTextColour(s);
    if (s === settings && textResult?.colour) return textResult.colour;
    return pickTextColour(gradientSamples(s, textRegion ?? { from: 0, to: 1 }, textContext())).colour;
  }

  function renderStops() {
    const row = modal.stopsRow;
    row.textContent = "";
    settings.stops.forEach((stop, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "gcb-stop";
      el.draggable = true;
      el.dataset.id = stop.id;
      el.dataset.index = String(i + 1);
      el.classList.toggle("gcb-selected", stop.id === selectedId);
      el.setAttribute("aria-current", String(stop.id === selectedId));
      // Kept but unused while the gradient is off.
      el.classList.toggle("gcb-unused", !settings.gradient && i > 0);
      row.appendChild(el);
      renderStop(stop);
    });
    const marker = document.createElement("div");
    marker.className = "gcb-marker";
    marker.hidden = true;
    row.appendChild(marker);
  }

  // Updates one dot in place.
  function renderStop(stop) {
    const el = modal?.stopsRow.querySelector(`.gcb-stop[data-id="${stop.id}"]`);
    if (!el) return;
    const colour = resolveStop(stop);
    const isTheme = stop.kind === "theme";
    el.style.backgroundColor = colour;
    el.classList.toggle("gcb-theme", isTheme);
    const count = settings.stops.length;
    el.title = (isTheme ? "Theme colour" : colour) + (count > 1 ? `\n${REORDER_HINT}` : "");
    el.setAttribute("aria-label", `Colour ${el.dataset.index} of ${count}: ${isTheme ? "theme colour" : colour}`);
  }

  // ── Self-test ───────────────────────────────────────────────────────────────
  // `await __gcb.selfTest()` in devtools. Drives the same functions and modal DOM the UI uses,
  // checks computed styles on the live bar, then restores everything it touched. Checks that need
  // the bar are skipped while it isn't there.

  const NO_BAR = "bar not present — play on another device";
  const RED = "#ff0000";
  const GREEN = "#00ff00";
  const BLUE = "#0000ff";
  const PROBE = "#123456"; // stand-in theme colour
  // A hashed class from the verified markup; the lint must flag it.
  const HASHED_SAMPLE = ".alQyi9QVSuY6ma3oYVy6";

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const custom = (id, color) => ({ id, kind: "custom", color });
  const theme = (id) => ({ id, kind: "theme" });
  const styleText = () => document.getElementById("gcb-style")?.textContent ?? null;
  const songchangeCount = () => Spicetify.Player.eventListeners?.songchange?.length ?? 0;
  const computedHex = (el, prop) => (el ? toHex(getComputedStyle(el)[prop]) : null);

  // Applies settings the way the UI does, then recalculates the text colour at once (no debounce).
  function setTestSettings(gradient, stops, textColour = DEFAULT_TEXT) {
    settings = { version: SCHEMA_VERSION, gradient, textColour, stops: stops.map((s) => ({ ...s })) };
    update();
    recalcTextColour();
  }

  // Properties our stylesheet may set, all inside the bar's rule.
  const ALLOWED_PROPS = ["background-image", "--text-base", "--essential-base"];
  // A hashed class name: a 16–20 character token with upper- and lower-case letters.
  const HASH_LIKE = /(?<![\w-])[\w-]{16,20}(?![\w-])/g;
  const hashLike = (selector) => (selector.match(HASH_LIKE) ?? []).filter((t) => /[a-z]/.test(t) && /[A-Z]/.test(t));

  // Anything translucent in the bar's CSS: colours are opaque only.
  const OPACITY_RE = /rgba\(|\btransparent\b|#[0-9a-f]{8}\b/gi;
  const opacityIn = (css) => css.match(OPACITY_RE) ?? [];

  // Everything our bar stylesheet must never do (CLAUDE.md → Hard rules).
  function cssProblems(css) {
    const problems = [];
    if (/!important/i.test(css)) problems.push("!important");
    for (const found of opacityIn(css)) problems.push(`translucent colour ${found}`);
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = selector.trim();
      if (sel !== SELECTOR) problems.push(`rule not on the Connect bar: ${sel}`);
      for (const token of hashLike(sel)) problems.push(`hash-like class name ${token}`);
      for (const decl of body.split(";")) {
        const name = decl.split(":")[0].trim();
        if (!name) continue;
        if (name === "--background-base") problems.push("sets --background-base");
        else if (!ALLOWED_PROPS.includes(name)) problems.push(`sets ${name}`);
      }
    }
    return problems;
  }

  // The CSS through the browser's own parser: every rule and every declaration must survive.
  function parseProblems(css) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const rules = [...sheet.cssRules];
    const written = [...css.matchAll(/\{([^}]*)\}/g)].map(([, body]) => body.split(";").filter((d) => d.trim()).length);
    const problems = [];
    if (rules.length !== written.length) problems.push(`${rules.length} of ${written.length} rules parsed`);
    rules.forEach((rule, i) => {
      if (rule.style?.length !== written[i]) problems.push(`rule ${i + 1}: ${rule.style?.length} of ${written[i]} declarations parsed`);
      if (rule.selectorText?.replace(/\s+/g, " ") !== SELECTOR) problems.push(`rule ${i + 1}: selector parsed as ${rule.selectorText}`);
    });
    return problems;
  }

  // A computed background-image as the browser serialises it, from one of our own elements.
  let probeEl = null;
  function computedImage(image) {
    probeEl ??= Object.assign(document.createElement("span"), { className: "gcb-probe", hidden: true });
    if (!probeEl.isConnected) document.body.append(probeEl);
    probeEl.style.backgroundImage = image;
    const out = getComputedStyle(probeEl).backgroundImage;
    probeEl.remove();
    return out;
  }

  // The bar's computed state with our stylesheet on and off, read in the same task.
  function barWithAndWithout(bar, read) {
    const sheet = document.getElementById("gcb-style")?.sheet;
    if (sheet) sheet.disabled = true;
    const spotify = read(bar);
    if (sheet) sheet.disabled = false;
    return { ours: read(bar), spotify };
  }

  const barGeometry = (bar) => {
    const cs = getComputedStyle(bar);
    const r = bar.getBoundingClientRect();
    return `${r.width.toFixed(1)}×${r.height.toFixed(1)}, radius ${cs.borderRadius}, background-color ${cs.backgroundColor}`;
  };

  // Every <script> that loads this extension. More than one means a Marketplace install and a
  // local CLI install are both active, and the second copy fights the first.
  const loadedCopies = () =>
    [...document.querySelectorAll("script[src]")].map((el) => el.src).filter((src) => /gradientConnectBar\.js/i.test(src));

  // A function declaration, so status() can use it from the first line on.
  function spicetifyVersion() {
    return window.Spicetify?.Config?.version ?? "unknown";
  }

  function environment() {
    return {
      extension: VERSION,
      source: SOURCE,
      copies: loadedCopies(),
      spotify: Spicetify.Platform?.version ?? null,
      spicetify: spicetifyVersion(),
      theme: Spicetify.Config?.current_theme ?? null,
      colourScheme: Spicetify.Config?.color_scheme ?? null,
      extensions: Spicetify.Config?.extensions ?? null,
      gpb: window.__gpb?.version ?? null, // Gradient Progress Bar, if it runs alongside
      eyedropper: !!window.EyeDropper, // the picker's eyedropper button exists only with it
      spiceButton: getComputedStyle(document.documentElement).getPropertyValue("--spice-button").trim() || null,
      barBase: barBase(),
      textColour: textStatus(),
      entry: startup.entry,
      phase: startup.phase,
      entryErrors: startup.entryErrors,
      menu: { registered: menuRegistered, menuItemUsable: menuItemUsable() }, // info only, never a check
      topbar: { created: !!shared?.button, connected: !!shared?.button?.element?.isConnected },
      shared: shared?.status() ?? null,
      spicetifyFixes: otherFixes(), // whether the separate spicetify-fixes extension is what makes the entries work
      startupError: startup.error,
      dom: domProbe(), // includes an outline of the bar and the aside, for selector fixes after Spotify updates
    };
  }

  let selfTestRunning = false;

  async function selfTest() {
    if (selfTestRunning) return console.warn("[gcb] The self-test is already running.");
    selfTestRunning = true;

    const results = [];
    const check = (issue, name, pass, detail = "") =>
      results.push({ id: results.length + 1, issue: `#${issue}`, check: name, pass: !!pass, detail: String(detail) });
    const skip = (issue, name, reason = NO_BAR) =>
      results.push({ id: results.length + 1, issue: `#${issue}`, check: name, pass: null, skipped: reason, detail: "" });

    // The entries can take up to 15 s to register (the profile menu waits for ReactJSX).
    for (let waited = 0; startup.phase === "registering entry point" && waited < 21000; waited += 300) await sleep(300);
    const env = environment();
    const savedSettings = structuredClone(settings);
    const savedRaw = Spicetify.LocalStorage.get(STORAGE_KEY);
    const savedPresets = structuredClone(presets); // #29
    const savedPresetsRaw = Spicetify.LocalStorage.get(PRESETS_KEY);
    const rootStyle = document.documentElement.style;
    const savedButton = [rootStyle.getPropertyValue("--spice-button"), rootStyle.getPropertyPriority("--spice-button")];
    const restoreButton = () =>
      savedButton[0]
        ? rootStyle.setProperty("--spice-button", savedButton[0], savedButton[1])
        : rootStyle.removeProperty("--spice-button");

    if (modal) {
      Spicetify.PopupModal.hide();
      closeModal(modal);
    }

    try {
      check(1, "Exactly one copy of the extension is loaded", env.copies.length === 1,
        env.copies.length === 1
          ? env.copies[0]
          : `${env.copies.length} copies: ${env.copies.join(", ") || "none found"} (running: ${SOURCE ?? "unknown"}). Keep either the Marketplace install or the local CLI install (spicetify config extensions gradientConnectBar.js-), not both.`);
      await checkEntries(check, skip);
      await runChecks(check, skip, rootStyle, restoreButton);
    } catch (e) {
      check(9, "Self-test ran to completion", false, e?.stack || e);
    } finally {
      if (modal) {
        Spicetify.PopupModal.hide();
        closeModal(modal);
      }
      restoreButton();
      clearTimeout(saveTimer);
      saveTimer = 0;
      settings = savedSettings;
      recalcTextColour(); // the stylesheet and the text colour for the restored settings
      if (savedRaw == null) Spicetify.LocalStorage.remove(STORAGE_KEY);
      else Spicetify.LocalStorage.set(STORAGE_KEY, savedRaw);
      presets = savedPresets;
      if (savedPresetsRaw == null) Spicetify.LocalStorage.remove(PRESETS_KEY);
      else Spicetify.LocalStorage.set(PRESETS_KEY, savedPresetsRaw);
      selfTestRunning = false;
    }

    const failed = results.filter((r) => r.pass === false).length;
    const skipped = results.filter((r) => r.pass === null).length;
    const passed = results.length - failed - skipped;
    const report = {
      summary: `${passed}/${results.length - skipped} passed${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${failed} FAILED` : ""}`,
      environment: env,
      results,
    };
    console.table(results);
    console.log(`[gcb] self-test: ${report.summary}`);
    const copied = !!(await writeClipboard(JSON.stringify(report, null, 2)));
    console.log(copied ? "[gcb] Full report copied to the clipboard." : "[gcb] Couldn't copy the report — it's the return value.");
    return report;
  }

  // ── Entry points (#34, #35) ──
  async function checkEntries(check, skip) {
    const st = statusReport();
    const menuApplicable = !!(api("Menu")?.Item && api("ReactJSX"));
    check(35, "Profile-menu entry registered without throwing (its own entry, guarded by menuItemUsable())", !menuApplicable || menuRegistered,
      menuApplicable
        ? startup.entryErrors.filter((e) => e.startsWith("Menu:")).join("; ") || `registered${menuItemUsable() ? "" : ", hidden while Spicetify's MenuItem is broken (spicetify/cli#4012)"}`
        : `not applicable: Spicetify.Menu.Item ${api("Menu")?.Item ? "exists" : "missing"}, Spicetify.ReactJSX ${api("ReactJSX") ? "exists" : "missing"}`);
    // Product names are written with every word capitalised (CLAUDE.md → Conventions): the profile-menu
    // label, the settings window's title and the shared button's entry all match manifest.json's "name".
    const MANIFEST_NAME = "Gradient Connect Bar";
    const shownNames = { ENTRY_LABEL, "settings title": TITLE, "SELF.name": SELF.name };
    const misnamed = Object.entries(shownNames).filter(([, value]) => value !== MANIFEST_NAME);
    check(1, `Product name: ENTRY_LABEL, the settings window title and SELF.name all read "${MANIFEST_NAME}", the manifest name`,
      !misnamed.length, misnamed.map(([key, value]) => `${key} "${value}"`).join(", ") || JSON.stringify(shownNames));
    check(34, "Entry icon is GPB's: currentColor, 16 × 16 viewBox, no id= and no <defs>",
      ENTRY_ICON.includes("currentColor") && ENTRY_ICON.includes('viewBox="0 0 16 16"') && !ENTRY_ICON.includes("id=") && !ENTRY_ICON.includes("<defs"),
      `${ENTRY_ICON.length} characters`);
    check(34, "status() reports topbar, shared, entryErrors, menu and apis.ReactJSX",
      !!st.topbar && "created" in st.topbar && "connected" in st.topbar && !!st.shared && Array.isArray(st.entryErrors) &&
        !!st.menu && "menuItemUsable" in st.menu && "ReactJSX" in st.apis,
      JSON.stringify({ topbar: st.topbar, shared: st.shared, menu: st.menu }));
    const role = shared?.role ?? "none";
    check(34, "Top-bar entry: our own button (owner, or next to another protocol) or the owner's shared one (member)",
      !api("Topbar")?.Button || (role === "member" ? !shared.button && !!shared.registry?.entries.some((e) => e.id === SELF.id) : !!shared?.button),
      !api("Topbar")?.Button
        ? "not applicable: Spicetify.Topbar.Button missing"
        : `${role}${shared?.button ? `, button "${shared.button.label}" ${shared.button.element?.isConnected ? "on screen" : "not on screen yet"}` : ", no button of ours"}`);

    // The live registry: never touched by the self-test.
    const reg = window.__gradientBars;
    if (role.startsWith("own button")) check(34, "Live registry: protocol 1, our entry exactly once, sorted by name", true, `not ours to check: ${role}`);
    else {
      const names = reg?.entries.map((e) => e.name) ?? [];
      check(34, "Live registry: protocol 1, our entry exactly once, sorted by name",
        reg?.protocol === 1 && reg.entries.filter((e) => e.id === SELF.id).length === 1 &&
          names.join("|") === [...names].sort((a, b) => a.localeCompare(b)).join("|") && shared.registry === reg,
        `owner ${reg?.owner}, entries ${reg?.entries.map((e) => e.id).join(", ")}`);
    }
    const gpb = window.__gpb;
    if (!gpb) skip(34, "With Gradient Progress Bar: exactly one top-bar button, the owner's", "Gradient Progress Bar isn't running");
    else if (!reg?.entries.some((e) => e.id === "gpb"))
      skip(34, "With Gradient Progress Bar: exactly one top-bar button, the owner's",
        `Gradient Progress Bar ${gpb.version} doesn't share the button yet: two buttons are expected until it does`);
    else {
      const created = { gcb: !!window.__gcb.status().topbar?.created, gpb: !!gpb.status?.().topbar?.created };
      check(34, "With Gradient Progress Bar: exactly one top-bar button, the owner's",
        Object.values(created).filter(Boolean).length === 1 && created[reg.owner], `owner ${reg.owner}; created ${JSON.stringify(created)}`);
    }

    // A separate instance from the same factory: its own key and prefix, fake buttons, stub
    // opens; removed afterwards.
    const KEY = "__gradientBarsSelfTest";
    const OTHER_KEY = "__gradientBarsSelfTestOther";
    const PREFIX = "gradient-bars-selftest";
    const liveBefore = window.__gradientBars;
    const liveEntries = liveBefore?.entries.map((e) => e.id).join();
    const opened = [];
    const buttons = [];
    const fakeButton = (label, icon, onClick) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `${PREFIX}-anchor`;
      el.textContent = "♪";
      Object.assign(el.style, { position: "fixed", top: "12px", right: "60px", width: "32px", height: "32px", zIndex: "99999" });
      el.addEventListener("click", () => onClick());
      document.body.append(el);
      const fake = { element: el, label, icon };
      buttons.push(fake);
      return fake;
    };
    const entry = (id, name) => ({ id: `${id}-selftest`, name, open: () => opened.push(id) });
    const clickAt = (el, keyboard = false) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: keyboard ? 0 : 1 }));
    const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    const menuEl = () => document.getElementById(`${PREFIX}-menu`);
    const shown = () => !!menuEl() && !menuEl().hidden;
    const menuItems = () => [...(menuEl()?.querySelectorAll(`.${PREFIX}-item`) ?? [])];
    let a, b, c;
    try {
      a = joinGradientBars({ self: entry("gcb", "Gradient Connect Bar"), key: KEY, prefix: PREFIX, createButton: fakeButton });
      a.ensureButton();
      const anchor = a.button?.element;
      clickAt(anchor);
      check(34, "Protocol test instance, one entry: the owner's button opens it directly (no menu), labelled with its name",
        a.role === "owner" && window[KEY]?.protocol === 1 && opened.join() === "gcb" && !shown() && a.button.label === "Gradient Connect Bar",
        `role ${a.role}, opened ${opened.join() || "nothing"}, menu ${shown() ? "shown" : "none"}, label "${a.button?.label}"`);

      b = joinGradientBars({ self: entry("gpb", "Gradient Progress Bar"), key: KEY, prefix: PREFIX, createButton: fakeButton });
      const memberButton = b.ensureButton();
      opened.length = 0;
      clickAt(anchor);
      const names = menuItems().map((el) => el.textContent).join(", ");
      const r = anchor.getBoundingClientRect();
      const mr = menuEl()?.getBoundingClientRect();
      const roles = menuEl()?.getAttribute("role") === "menu" && menuItems().every((el) => el.getAttribute("role") === "menuitem");
      check(34, "Two entries: one button only ('Gradient bars'); a click shows the menu with both, in name order, 8 px below the button, right edges aligned",
        b.role === "member" && !memberButton && buttons.length === 1 && a.button.label === "Gradient bars" && shown() && roles &&
          names === "Gradient Connect Bar, Gradient Progress Bar" && !opened.length && document.activeElement !== menuItems()[0] &&
          Math.abs(mr.top - (r.bottom + 8)) <= 1 && Math.abs(mr.right - r.right) <= 1 && menuEl().parentElement === document.body,
        `member ${b.role}, buttons ${buttons.length}, label "${a.button.label}", items ${names}; menu ${mr ? `${mr.left.toFixed(0)},${mr.top.toFixed(0)}–${mr.right.toFixed(0)}` : "none"}, button bottom ${r.bottom.toFixed(0)}, right ${r.right.toFixed(0)}`);

      const steps = [];
      const step = (label, ok) => steps.push(`${label}${ok ? "" : " ✗"}`);
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      step("outside pointerdown closes", !shown());
      anchor.focus();
      clickAt(anchor, true);
      const items = menuItems();
      step("keyboard open focuses the first item", shown() && document.activeElement === items[0]);
      key(document.activeElement, "ArrowDown");
      step("↓", document.activeElement === items[1]);
      key(document.activeElement, "ArrowDown");
      step("↓ wraps", document.activeElement === items[0]);
      key(document.activeElement, "ArrowUp");
      step("↑ wraps", document.activeElement === items[1]);
      key(document.activeElement, "Home");
      step("Home", document.activeElement === items[0]);
      key(document.activeElement, "End");
      step("End", document.activeElement === items[1]);
      key(document.activeElement, "Escape");
      step("Escape closes and refocuses the button", !shown() && document.activeElement === anchor);
      clickAt(anchor, true);
      key(document.activeElement, "Tab");
      step("Tab closes", !shown());
      clickAt(anchor);
      window.dispatchEvent(new Event("blur"));
      step("window blur closes", !shown());
      clickAt(anchor);
      window.dispatchEvent(new Event("resize"));
      step("resize closes", !shown());
      clickAt(anchor);
      clickAt(anchor);
      step("a second click on the button closes", !shown());
      check(34, "Menu keyboard and closing: first item focused from the keyboard, ↑/↓ wrap, Home/End, Escape, Tab, outside pointerdown, blur, resize",
        !steps.some((x) => x.endsWith("✗")), steps.join("; "));

      opened.length = 0;
      clickAt(anchor);
      const second = menuItems()[1];
      second.click();
      const hiddenFirst = !shown() && !opened.length && second.isConnected;
      await tick();
      const thenOpened = opened.join();
      anchor.focus();
      clickAt(anchor, true);
      key(document.activeElement, "Enter");
      const enterHidden = !shown() && opened.length === 1;
      await tick();
      check(34, "Activating an item hides the menu first, then opens that entry in the next task (click and Enter)",
        hiddenFirst && thenOpened === "gpb" && enterHidden && opened.join() === "gpb,gcb",
        `hidden first ${hiddenFirst}, then opened ${thenOpened}; Enter: hidden first ${enterHidden}, opened ${opened.join()}`);

      window[OTHER_KEY] = { protocol: 2, entries: [] };
      c = joinGradientBars({ self: entry("gcb", "Gradient Connect Bar"), key: OTHER_KEY, prefix: `${PREFIX}-other`, createButton: fakeButton });
      c.ensureButton();
      opened.length = 0;
      clickAt(c.button.element);
      check(34, "Another protocol: own button path, its own label, opens directly, the foreign registry untouched",
        c.role === "own button (protocol 2)" && !c.registry && c.button?.label === "Gradient Connect Bar" && opened.join() === "gcb" &&
          JSON.stringify(window[OTHER_KEY]) === JSON.stringify({ protocol: 2, entries: [] }) && c.status().role === "own button (protocol 2)",
        `role ${c.role}, label "${c.button?.label}", opened ${opened.join()}, registry ${JSON.stringify(window[OTHER_KEY])}`);
    } catch (e) {
      check(34, "Protocol test instance ran", false, e?.stack || e);
    } finally {
      a?.dispose();
      b?.dispose();
      c?.dispose();
      delete window[KEY];
      delete window[OTHER_KEY];
      for (const fake of buttons) fake.element.remove();
    }
    check(34, "The live registry is untouched by the test instance; nothing of the test instance is left",
      window.__gradientBars === liveBefore && window.__gradientBars?.entries.map((e) => e.id).join() === liveEntries &&
        !(KEY in window) && !(OTHER_KEY in window) && !document.querySelector(`[id^="${PREFIX}"], [class^="${PREFIX}"]`),
      `live entries ${window.__gradientBars?.entries.map((e) => e.id).join() ?? "none"}`);
  }

  async function runChecks(check, skip, rootStyle, restoreButton) {
    // ── Selector (#3) ──
    const scoped = document.querySelectorAll(SELECTOR).length;
    const unscoped = document.querySelectorAll(UNSCOPED).length;
    const counts = `scoped ${scoped}, without the "${PARENT} >" prefix ${unscoped}`;
    if (scoped > 1 || unscoped > 1) check(3, "Selector matches at most one element", false, `${counts}: more than one match`);
    else if (!scoped && unscoped) check(3, "Selector finds the bar inside the now-playing aside", false, `${counts}: parent changed`);
    else if (!scoped) skip(3, "Selector finds exactly one bar");
    else check(3, "Selector finds exactly one bar", true, counts);
    const bar = scoped === 1 ? findBar() : null;

    // ── Gradient builder (#3, #4) ──
    const css = (gradient, stops, text = null) => buildCss({ version: SCHEMA_VERSION, gradient, textColour: DEFAULT_TEXT, stops }, text);
    const image = (gradient, stops) => barImage({ version: SCHEMA_VERSION, gradient, textColour: DEFAULT_TEXT, stops });
    const eight = ["#ff0000", "#ff8000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#8000ff", "#ff00ff"];
    const builds = {
      "1 stop (solid)": [image(false, [custom("s1", RED)]), `linear-gradient(to right, ${RED}, ${RED})`],
      "2 stops": [image(true, [custom("s1", RED), custom("s2", BLUE)]), `linear-gradient(to right, ${RED}, ${BLUE})`],
      "8 stops": [image(true, eight.map((c, i) => custom(`s${i + 1}`, c))), `linear-gradient(to right, ${eight.join(", ")})`],
      "theme stops": [image(true, [theme("s1"), custom("s2", RED), theme("s3")]), `linear-gradient(to right, ${THEME_COLOUR}, ${RED}, ${THEME_COLOUR})`],
      "gradient off, 3 stops → the first only": [image(false, [custom("s1", RED), custom("s2", GREEN), custom("s3", BLUE)]), `linear-gradient(to right, ${RED}, ${RED})`],
    };
    const wrongBuilds = Object.entries(builds).filter(([, [got, want]]) => got !== want);
    check(3, "Gradient builder: 1, 2 and 8 stops, theme stops, gradient off", !wrongBuilds.length,
      wrongBuilds.map(([label, [got, want]]) => `${label}: ${got} (expected ${want})`).join("; ") || `${Object.keys(builds).length} cases`);
    const inertCases = { default: buildCss(defaultSettings()), "solid theme with more stops": css(false, [theme("s1"), custom("s2", RED)]) };
    check(3, "A solid theme colour leaves the background alone (no rule without a text colour)",
      Object.values(inertCases).every((c) => c === ""), Object.entries(inertCases).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("; "));
    const themeCss = css(true, [theme("s1"), theme("s2")]);
    check(4, "Theme stop emits var(--spice-button …), never a resolved hex",
      themeCss.includes(THEME_COLOUR) && !/#[0-9a-f]{3,8}\b/i.test(themeCss.replaceAll(THEME_COLOUR, "")), themeCss.replace(/\s+/g, " "));
    check(6, "No Spread modes and no progress-bar code: the gradient spans the full width",
      !/background-(size|position|repeat)|clip-path|transform|progress-bar/.test(css(true, [custom("s1", RED), custom("s2", BLUE)])) &&
        !("mode" in defaultSettings()),
      css(true, [custom("s1", RED), custom("s2", BLUE)]).replace(/\s+/g, " "));

    // ── Injected CSS (#3) ──
    const samples = [
      [false, [custom("s1", RED)]],
      [true, [theme("s1"), custom("s2", RED), custom("s3", GREEN)], WHITE],
      [true, eight.map((c, i) => custom(`s${i + 1}`, c)), BLACK],
      [false, [theme("s1")], WHITE], // inert background, text colour only
    ];
    const lint = samples.flatMap(([gradient, stops, text]) => cssProblems(css(gradient, stops, text)));
    check(3, "CSS: one rule on SELECTOR, no !important, no hash-like class names, never --background-base", !lint.length,
      lint.join("; ") || `${samples.length} samples clean`);
    const parse = samples.flatMap(([gradient, stops, text]) => parseProblems(css(gradient, stops, text)));
    check(3, "CSS parses: every rule and declaration survives the browser's parser", !parse.length,
      parse.join("; ") || `${samples.length} samples parsed`);
    // Opaque only: the generated CSS for every sample and every text colour mode, live included.
    const opaqueCases = [...samples, [true, [theme("s1"), custom("s2", RED)]], [false, [custom("s1", BLUE)]]];
    const translucent = [];
    for (const [gradient, stops] of opaqueCases)
      for (const mode of TEXT_MODES) {
        setTestSettings(gradient, stops, mode);
        for (const found of opacityIn(styleText() + css(gradient, stops, appliedTextColour()))) translucent.push(`${mode}: ${found}`);
      }
    check(4, "Generated CSS contains no rgba(, no transparent and no 8-digit hex (every sample, every text colour mode)",
      !translucent.length, translucent.join("; ") || `${opaqueCases.length * TEXT_MODES.length} stylesheets`);
    const flagged = {
      "!important": cssProblems(`${SELECTOR} {\n  background-image: none !important;\n}\n`),
      "a hashed class": cssProblems(`${SELECTOR}${HASHED_SAMPLE} {\n  background-image: none;\n}\n`),
      "--background-base": cssProblems(`${SELECTOR} {\n  --background-base: red;\n}\n`),
      "a global rule": cssProblems(`:root {\n  background-image: none;\n}\n`),
      "a global --text-base": cssProblems(`:root {\n  --text-base: #ffffff;\n}\n`),
      "transparent": cssProblems(`${SELECTOR} {\n  background-image: linear-gradient(to right, transparent, red);\n}\n`),
      "rgba(": cssProblems(`${SELECTOR} {\n  background-image: linear-gradient(to right, rgba(0, 0, 0, .5), red);\n}\n`),
      "an 8-digit hex": cssProblems(`${SELECTOR} {\n  background-image: linear-gradient(to right, #ff000080, red);\n}\n`),
    };
    const missed = Object.entries(flagged).filter(([, found]) => !found.length).map(([label]) => label);
    check(3, "The CSS lint itself flags !important, a hashed class, --background-base, rules elsewhere (a global --text-base too) and translucent colours", !missed.length,
      missed.length ? `not flagged: ${missed.join(", ")}` : Object.values(flagged).map((p) => p.join("/")).join("; "));
    const modalHashes = [...MODAL_CSS.matchAll(/([^{}]+)\{/g)].flatMap(([, sel]) => hashLike(sel));
    check(3, "Settings CSS: no hash-like class names, no !important, no --spice-rgb-button (Hazy leaves it stale)",
      !modalHashes.length && !/!important/.test(MODAL_CSS) && !MODAL_CSS.includes("--spice-rgb-button"),
      modalHashes.join(", ") || "clean");

    // ── The live bar (#3, #4) ──
    const barChecks = [
      "Bar's computed background-image = the generated gradient",
      "Bar's background-color (--background-base), size and radius untouched by our rules",
      "No inline style added to the bar",
      "Theme stop on the live bar follows a runtime --spice-button change, no JS",
    ];
    if (!bar) barChecks.forEach((name) => skip(3, name));
    else {
      const styleBefore = bar.getAttribute("style");
      const gradients = [
        [true, [custom("s1", RED), custom("s2", GREEN), custom("s3", BLUE)]],
        [true, [theme("s1"), custom("s2", GREEN), custom("s3", RED)]],
        [false, [custom("s1", BLUE)]],
      ];
      const mismatches = [];
      for (const [gradient, stops] of gradients) {
        setTestSettings(gradient, stops);
        const got = getComputedStyle(bar).backgroundImage;
        const want = computedImage(image(gradient, stops));
        if (got !== want) mismatches.push(`${got} (expected ${want})`);
      }
      check(3, barChecks[0], !mismatches.length, mismatches.join("; ") || `${gradients.length} gradients`);
      const geometry = barWithAndWithout(bar, barGeometry);
      check(3, barChecks[1], geometry.ours === geometry.spotify, `ours ${geometry.ours}; Spotify's ${geometry.spotify}`);
      check(3, barChecks[2], bar.getAttribute("style") === styleBefore, `style="${bar.getAttribute("style") ?? ""}"`);
      setTestSettings(true, [theme("s1"), theme("s2")]);
      rootStyle.setProperty("--spice-button", PROBE, "important");
      const followed = getComputedStyle(bar).backgroundImage;
      restoreButton();
      check(4, barChecks[3], followed.includes("rgb(18, 52, 86)"), followed);
    }

    // ── Right-click (#5) ──
    settings = defaultSettings();
    update();
    const closeIfOpen = () => {
      if (!modal) return;
      Spicetify.PopupModal.hide();
      closeModal(modal);
    };
    const contextMenu = (el) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    // Not the song progress bar: that's Gradient Progress Bar's right-click, and would open its settings.
    const elsewhere = [document.body, document.querySelector(PARENT)].filter(Boolean);
    const openedElsewhere = elsewhere.filter((el) => {
      contextMenu(el);
      const opened = !!modal;
      closeIfOpen();
      return opened;
    });
    check(5, "Right-click elsewhere (the page, the now-playing aside around the bar) doesn't open the settings",
      !openedElsewhere.length, `${elsewhere.length} targets${openedElsewhere.length ? `, opened on ${openedElsewhere.map((el) => el.tagName.toLowerCase()).join(", ")}` : ""}`);
    if (!bar) skip(5, "Right-click on the bar opens the settings and suppresses Spotify's menu");
    else {
      const target = bar.querySelector(BAR_LINK)?.querySelector("span") ?? bar;
      const kept = contextMenu(target);
      const opened = !!modal?.root.isConnected;
      closeIfOpen();
      check(5, "Right-click on the bar opens the settings and suppresses Spotify's menu", opened && !kept,
        `opened ${opened}, default prevented ${!kept}`);
    }

    // ── Gradient Progress Bar alongside ──
    if (!window.__gpb) skip(4, "Gradient Progress Bar alongside: separate stylesheets, no overlap", "Gradient Progress Bar isn't running");
    else {
      setTestSettings(true, [custom("s1", RED), custom("s2", BLUE)]);
      const gpbStyle = document.getElementById("gpb-style");
      const ours = document.getElementById("gcb-style");
      const gpbRules = [...(gpbStyle?.sheet?.cssRules ?? [])].filter((r) => r.selectorText);
      const gpbTargets = [...new Set(gpbRules.flatMap((r) => [...document.querySelectorAll(r.selectorText)]))];
      const songBar = document.querySelector('[data-testid="playback-progressbar"]');
      const ourTargets = [...document.querySelectorAll(SELECTOR)];
      const touches = (a, b) => a === b || a.contains(b) || b.contains(a);
      const overlaps = ourTargets.filter((el) => gpbTargets.some((t) => touches(el, t)) || (songBar && touches(el, songBar)));
      const gpbOnOurs = gpbRules.filter((r) => ourTargets.some((el) => el.matches(r.selectorText)));
      check(4, "Gradient Progress Bar alongside: both stylesheets present, neither rule matches the other's target",
        !!gpbStyle && !!ours && gpbStyle !== ours && !overlaps.length && !gpbOnOurs.length &&
          !(songBar && songBar.matches(SELECTOR)) && !gpbRules.some((r) => r.selectorText === SELECTOR),
        `#gpb-style ${!!gpbStyle} (${gpbRules.length} rules, ${gpbTargets.length} targets), #gcb-style ${!!ours} (${ourTargets.length} targets); ` +
          `overlaps ${overlaps.length}, GPB rules on our bar ${gpbOnOurs.length}; GPB ${window.__gpb.version}`);
    }

    // ── Text colour: contrast unit tests (#13) ──
    const about = (value, want, tolerance) => Math.abs(value - want) <= tolerance;
    const pairs = [[BLACK, WHITE, 21], ["#767676", WHITE, 4.54], ["#777777", WHITE, 4.48], [RED, WHITE, 4.0], [BLUE, WHITE, 8.59], ["#8372fd", BLACK, 5.79]];
    const wrongPairs = pairs.filter(([a, b, want]) => !about(contrast(hexToRgb(a), hexToRgb(b)), want, 0.01));
    check(13, "WCAG contrast of known pairs (21, 4.54, 4.48, 4.0, 8.59, 5.79 for #8372fd on black)", !wrongPairs.length,
      pairs.map(([a, b]) => `${a}/${b} ${contrast(hexToRgb(a), hexToRgb(b)).toFixed(3)}`).join(", "));
    // Pure runs with a fixed theme and bar colour (Hazy's custom #8372fd), independent of the live theme.
    const hazy = { theme: hexToRgb("#8372fd"), base: hexToRgb("#8372fd") };
    const stopsOf = (colours) => colours.map((c, i) => (c === "theme" ? theme(`s${i + 1}`) : custom(`s${i + 1}`, c)));
    const pickFor = (colours, region, ctx = hazy) =>
      pickTextColour(gradientSamples({ version: SCHEMA_VERSION, gradient: colours.length > 1, textColour: "auto", stops: stopsOf(colours) }, region, ctx));
    const whole = { from: 0, to: 1 };
    const right = { from: 0.8, to: 1 };
    const fmt = (p) => `${p.colour} (black ${p.black.toFixed(2)}, white ${p.white.toFixed(2)})`;
    const solidHazy = pickFor(["#8372fd"], whole);
    const inertHazy = pickFor(["theme"], whole);
    check(13, "#8372fd → black, ≈ 5.8:1 (as a colour and as Hazy's own bar colour behind a solid theme stop)",
      solidHazy.colour === BLACK && about(solidHazy.black, 5.79, 0.01) && inertHazy.colour === BLACK && about(inertHazy.black, 5.79, 0.01),
      `${fmt(solidHazy)}; inert ${fmt(inertHazy)}`);
    const darkToLight = pickFor([BLACK, WHITE], right);
    const lightToDark = pickFor([WHITE, BLACK], right);
    check(13, "Dark-left / light-right gradient, text at the right → black; the reverse → white",
      darkToLight.colour === BLACK && lightToDark.colour === WHITE, `${fmt(darkToLight)}; reverse ${fmt(lightToDark)}`);
    const lightWithDark = [WHITE, "#fff8e1", WHITE, "#1a1a1a", WHITE];
    const darkStopRegion = { from: 0.55, to: 0.95 };
    const worstCase = pickFor(lightWithDark, darkStopRegion);
    const darkSamples = gradientSamples({ version: SCHEMA_VERSION, gradient: true, textColour: "auto", stops: stopsOf(lightWithDark) }, darkStopRegion, hazy);
    const meanLuminance = darkSamples.reduce((sum, sample) => sum + luminance(sample.rgb), 0) / darkSamples.length;
    const byAverage = (meanLuminance + 0.05) / 0.05 > 1.05 / (meanLuminance + 0.05) ? "black" : "white";
    check(13, "A light gradient with a dark stop inside the text region → white (the worst case, not an average)",
      worstCase.colour === WHITE && byAverage === "black",
      `${fmt(worstCase)}; an average luminance (${meanLuminance.toFixed(3)}) would have picked ${byAverage}`);
    const counted = gradientSamples({ version: SCHEMA_VERSION, gradient: true, textColour: "auto", stops: stopsOf([RED, GREEN, BLUE, WHITE, BLACK]) }, { from: 0.2, to: 0.8 }, hazy);
    const atStops = counted.filter((sample) => [0.25, 0.5, 0.75].includes(sample.t)).map((sample) => rgbToHex(sample.rgb.map(Math.round)));
    const midway = gradientSamples({ version: SCHEMA_VERSION, gradient: true, textColour: "auto", stops: stopsOf([BLACK, WHITE]) }, { from: 0.5, to: 0.5 }, hazy);
    check(13, "Samples: both edges + every stop inside + 8 in between; at a stop the sample is the stop's own colour, between stops plain sRGB interpolation",
      counted.length === 2 + 3 + SAMPLES_BETWEEN && counted[0].t === 0.2 && counted[counted.length - 1].t === 0.8 &&
        atStops.join() === [GREEN, BLUE, WHITE].join() && midway.every((sample) => sample.rgb.every((v) => about(v, 127.5, 0.01))),
      `${counted.length} samples at ${counted.map((sample) => sample.t.toFixed(2)).join(", ")}; at the stops ${atStops.join(", ")}; black→white at 50 %: ${midway[0].rgb.map((v) => v.toFixed(1)).join(", ")}`);
    rootStyle.setProperty("--spice-button", PROBE, "important");
    const liveTheme = textContext().theme;
    restoreButton();
    check(13, "Theme stops are resolved from getComputedStyle(document.documentElement) at the time of the calculation",
      rgbToHex(liveTheme) === PROBE, `${rgbToHex(liveTheme)} with --spice-button ${PROBE}`);
    const hopeless = pickFor([BLACK, WHITE], whole);
    check(13, "Both contrasts low (black → white across the text) → still the better one (tie: black), and no warning",
      hopeless.colour === BLACK && Object.keys(hopeless).join() === "colour,black,white", `${fmt(hopeless)}; keys ${Object.keys(hopeless).join()}`);

    // ── Text colour on the live bar (#12, #14) ──
    const textChecks = [
      "Text region measured from the icon's left edge to the text's right edge, at the right-hand end",
      "Auto / Black / White: the text span's and the icon's computed colours equal the chosen colour",
      "Spotify default leaves the text and icon colours unchanged and writes no --text-base",
    ];
    if (!bar) {
      textChecks.forEach((name) => skip(textChecks.indexOf(name) ? 14 : 12, name));
      const keptRegion = textRegion;
      try {
        textRegion = { from: 0.9, to: 0.95 };
        const kept = recalcTextColour();
        textRegion = null;
        const unseen = recalcTextColour();
        check(15, "Without the bar the last region is kept; before it has ever been seen, the whole width counts",
          kept.region.from === 0.9 && kept.region.to === 0.95 && kept.measured && !kept.barPresent &&
            unseen.region.from === 0 && unseen.region.to === 1 && !unseen.measured,
          `kept ${JSON.stringify(kept.region)}, never seen ${JSON.stringify(unseen.region)}`);
      } finally {
        textRegion = keptRegion;
        recalcTextColour();
      }
    } else {
      const link = bar.querySelector(BAR_LINK);
      const span = link?.querySelector("span") ?? link;
      const icon = bar.querySelector(BAR_ICON);
      setTestSettings(false, [custom("s1", "#8372fd")]);
      const r = textResult.region;
      const box = bar.getBoundingClientRect();
      const width = bar.clientWidth || box.width;
      const left = box.left + bar.clientLeft;
      const iconFrom = (icon.getBoundingClientRect().left - left) / width;
      const linkTo = (link.getBoundingClientRect().right - left) / width;
      check(12, textChecks[0],
        textResult.measured && about(r.from, iconFrom, 0.001) && about(r.to, linkTo, 0.001) && r.from < r.to && r.from > 0.5 && r.to <= 1,
        `${r.from.toFixed(3)}–${r.to.toFixed(3)} of ${width} px (icon ${iconFrom.toFixed(3)}, text ends ${linkTo.toFixed(3)})`);
      const shown = () => ({ text: computedHex(span, "color"), icon: toHex(getComputedStyle(icon).fill) });
      const cases = [["auto", "#202020", WHITE], ["auto", "#8372fd", BLACK], ["black", "#202020", BLACK], ["white", "#8372fd", WHITE]];
      const wrongText = cases.filter(([mode, colour, want]) => {
        setTestSettings(false, [custom("s1", colour)], mode);
        const got = shown();
        return got.text !== want || got.icon !== want || appliedTextColour() !== want;
      }).map(([mode, colour, want]) => `${mode} on ${colour}: expected ${want}`);
      const last = shown();
      check(14, textChecks[1], !wrongText.length, wrongText.join("; ") || `${cases.length} cases; last: text ${last.text}, icon ${last.icon}`);
      setTestSettings(true, [custom("s1", "#202020"), custom("s2", "#303030")], "default");
      const spotify = barWithAndWithout(bar, () => JSON.stringify(shown()));
      check(14, textChecks[2], spotify.ours === spotify.spotify && !styleText().includes("--text-base") && appliedTextColour() === null,
        `ours ${spotify.ours}, Spotify's ${spotify.spotify}`);
    }

    // ── Recalculation triggers (#15) ──
    const runsAfter = async (action) => {
      const before = textRuns;
      await action();
      await sleep(TEXT_DELAY + 60);
      return textRuns - before;
    };
    setTestSettings(true, [custom("s1", RED), custom("s2", BLUE)]);
    const onSettings = await runsAfter(() => {
      settings.stops[0].color = GREEN;
      update({ rerender: false });
      settings.stops[0].color = RED;
      update({ rerender: false });
    });
    const onResize = await runsAfter(() => window.dispatchEvent(new Event("resize")));
    const customSong = await runsAfter(() => onThemeChange());
    setTestSettings(true, [theme("s1"), custom("s2", BLUE)]);
    const themeSong = await runsAfter(() => onThemeChange());
    const themeRoot = await runsAfter(async () => {
      rootStyle.setProperty("--spice-button", PROBE, "important");
      await tick();
    });
    const followedProbe = textResult.black === pickTextColour(gradientSamples(settings, textResult.region, textContext())).black;
    restoreButton();
    await sleep(TEXT_DELAY + 60);
    const registered = Spicetify.Player.eventListeners?.songchange;
    const aside = document.querySelector(PARENT);
    check(15, "Debounced recalculation on settings changes (two quick edits → one run) and on window resize",
      onSettings === 1 && onResize === 1, `settings ${onSettings} run(s), resize ${onResize}`);
    check(15, "Song and :root colour changes recalculate only while a theme-colour stop is used",
      customSong === 0 && themeSong === 1 && themeRoot >= 1 && followedProbe && (!registered || registered.includes(onThemeChange)),
      `custom only ${customSong}, theme stop ${themeSong}, :root change ${themeRoot}; songchange listener ${registered ? (registered.includes(onThemeChange) ? "registered" : "MISSING") : "not inspectable"}`);
    check(15, "The now-playing aside is watched for the bar appearing", !aside || (watchedAside === aside && !!asideObserver),
      aside ? `watching ${watchedAside === aside ? "the current aside" : "a stale aside"}` : "no aside on the page; waiting for it");

    // ── status() (#17) ──
    const st = window.__gcb.status().textColour;
    const statusKeys = ["mode", "colour", "contrast", "region", "barPresent"];
    check(17, "status() reports the text colour as plain values: mode, chosen colour, worst-case contrast, region fractions, bar present; no warning",
      !!st && statusKeys.every((key) => key in st) && !("warning" in st) && st.mode === settings.textColour && st.colour === textResult.colour &&
        typeof st.contrast === "number" && typeof st.region?.from === "number" && st.barPresent === !!bar,
      JSON.stringify(st));

    // ── Modal (#5, #7) ──
    settings = defaultSettings();
    update();
    const listenersBefore = songchangeCount();
    window.__gcb.openSettings();
    let m = modal;
    check(5, "Settings open with __gcb.openSettings()", m?.root.isConnected, "");
    if (!m) return;
    // Records whether the modal survived an action; reopens it so later checks still run.
    const stillOpen = (after) => {
      const open = m.root.isConnected && modal === m;
      check(5, `Settings still open after ${after}`, open, open ? "" : "modal closed itself");
      if (!open) {
        if (modal) closeModal(modal);
        openModal();
        m = modal;
      }
    };

    const dots = () => [...m.stopsRow.querySelectorAll(".gcb-stop")];
    const ringed = () => dots().filter((el) => el.classList.contains("gcb-selected"));
    // Exactly one ring, on `id`'s dot, and the picker (hex and R/G/B) shows that stop's colour.
    const selectionIs = (id) => {
      const stop = findStop(id);
      const hex = stop && resolveStop(stop);
      return !!stop && selectedId === id && ringed().length === 1 && ringed()[0].dataset.id === id &&
        m.hex.value === hex && m.rgb.map((f) => f.value).join() === hexToRgb(hex).join();
    };
    const selection = () =>
      `selected ${selectedId}, ring on ${ringed().map((el) => el.dataset.id).join() || "none"}, hex "${m.hex.value}", ` +
      `stops ${settings.stops.map((s) => s.id).join()}`;
    const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));

    check(5, "On open the first dot is selected and the picker shows its colour",
      selectionIs(settings.stops[0].id) && m.hex.value !== "", selection());
    // ── Gradient switch with one colour: it adds a second colour instead of being disabled ──
    const switchNode = m.switchButton;
    const switchState = () =>
      `${settings.stops.map((s) => `${s.id}:${s.kind}${s.color ? ` ${s.color}` : ""}`).join(", ")}; gradient ${settings.gradient}, ` +
      `aria-checked ${switchNode.getAttribute("aria-checked")}, disabled ${switchNode.disabled}, focus .${document.activeElement?.className}`;
    check(5, "One stop → switch enabled and off",
      settings.stops.length === 1 && !switchNode.disabled && switchNode.getAttribute("aria-checked") === "false" && !settings.gradient,
      switchState());
    const onlyStop = { ...settings.stops[0] };
    switchNode.focus();
    click(switchNode);
    await sleep(20);
    check(5, "Switch on with one colour → a copy of it after it (theme stays theme), gradient on, the new dot selected, focus on the switch",
      settings.stops.length === 2 && settings.gradient && settings.stops[0].id === onlyStop.id &&
        settings.stops[1].kind === onlyStop.kind && selectionIs(settings.stops[1].id) &&
        document.activeElement === switchNode && m.switchButton === switchNode && switchNode.getAttribute("aria-checked") === "true",
      `${switchState()}; ${selection()}`);
    stillOpen("switching the gradient on with one colour");
    click(m.switchButton);
    check(5, "Switch off → both stops kept, colour 2 dimmed",
      settings.stops.length === 2 && !settings.gradient && dots()[1]?.classList.contains("gcb-unused"), switchState());
    click(m.switchButton);

    const foreign = [m.root, ...m.root.querySelectorAll("*")].filter(
      (el) => (el.id && !el.id.startsWith("gcb-")) || [...el.classList].some((c) => !c.startsWith("gcb-"))
    );
    check(5, "Every id and class in the settings starts with gcb-", !foreign.length,
      foreign.map((el) => `${el.tagName.toLowerCase()}#${el.id}.${[...el.classList].join(".")}`).join(", ") || "all prefixed");
    const hazyHooks = m.root.querySelectorAll("#color-input, .slider, .toggle, .toggleWrapper, select");
    check(5, "Settings use none of Hazy's global hooks (#color-input, .slider, .toggle, .toggleWrapper, select)",
      !hazyHooks.length, `${hazyHooks.length} found`);
    const ownBar = [...document.querySelectorAll(`${SELECTOR}, ${UNSCOPED}`)].filter((el) => m.root.contains(el));
    check(7, "The preview strip never matches the bar's selector", !ownBar.length, `${ownBar.length} matches inside the settings`);
    const help = m.help;
    const helpLines = help.innerHTML.split(/<br\s*\/?>/).map((line) => line.trim());
    check(5, "Help text is the last element, after the action row, in its lines in order",
      helpLines.length === HELP_LINES.length && helpLines.every((line, i) => line === HELP_LINES[i]) &&
        m.root.lastElementChild === help && m.actions.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING,
      `last child .${m.root.lastElementChild?.className}, text "${help.innerText ?? help.textContent}"`);
    check(5, "Picker is an inline panel between the dots and the Reset row, not a popover",
      m.picker.parentElement === m.root && m.picker.previousElementSibling === m.dotsLine &&
        m.picker.nextElementSibling === m.actions && !m.picker.hidden && getComputedStyle(m.picker).position === "static",
      `after .${m.picker.previousElementSibling?.className}, before .${m.picker.nextElementSibling?.className}`);
    const tabOrder = [...m.dotsLine.querySelectorAll("button")].filter((el) => el.tabIndex >= 0);
    const tabNames = tabOrder.map((el) => (el.classList.contains("gcb-stop") ? "dot" : el === m.minusButton ? "−" : el === m.plusButton ? "+" : el.className));
    check(5, "−|+ stepper: a group 'Colours' right after the dots, − then +, labelled, not draggable; tab order dots, −, +",
      m.stepper?.getAttribute("role") === "group" && m.stepper.getAttribute("aria-label") === "Colours" &&
        !m.stopsRow.contains(m.stepper) && m.stopsRow.nextElementSibling === m.stepper &&
        [...m.stepper.querySelectorAll("button")].every((b, i) => b === [m.minusButton, m.plusButton][i] && !b.draggable) &&
        m.minusButton.getAttribute("aria-label") === REMOVE_LABEL && m.plusButton.getAttribute("aria-label") === ADD_LABEL &&
        tabNames.join() === [...dots().map(() => "dot"), "−", "+"].join(),
      `tab order ${tabNames.join(", ")}`);

    // ── Dot menu ──
    const menuShown = () => !m.menu.hidden && popover?.el === m.menu && m.root.contains(m.menu);
    const rightClick = (el) => {
      const r = el.getBoundingClientRect();
      const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: at.x, clientY: at.y }));
      return at;
    };
    const press = (el, key, init = {}) =>
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    // Scrolled into view (not for the fixed menu), the element's centre hit-tests to the element
    // or a descendant: visible, not clipped or covered.
    const reachable = (el, scroll = true) => {
      if (scroll) el.scrollIntoView({ block: "nearest", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return r.width > 0 && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    };

    await sleep(350); // let the modal's opening animation settle before measuring positions
    const titleBar = [...(m.root.closest(".GenericModal") ?? document.body).querySelectorAll("*")].find(
      (el) => !el.contains(m.root) && !m.root.contains(el) && el.textContent.trim() === TITLE
    );
    const titleGap = titleBar ? m.gradientRow.getBoundingClientRect().top - titleBar.getBoundingClientRect().bottom : NaN;
    const helpGap = help.getBoundingClientRect().top - m.actions.getBoundingClientRect().bottom;
    check(5, "Spacing: title bar → Gradient row and action row → help text are both ≥ 16 px", titleGap >= 16 && helpGap >= 16,
      `title gap ${titleBar ? `${Math.round(titleGap)} px` : "title bar not found"}, help gap ${Math.round(helpGap)} px`);
    const rowRect = m.actions.getBoundingClientRect();
    const resetRect = m.resetButton.getBoundingClientRect();
    const centreX = (r) => r.left + r.width / 2;
    const centreY = (r) => r.top + r.height / 2;
    check(5, "Reset alone in the action row, centred (±1 px)",
      m.actions.children.length === 1 && Math.abs(centreX(resetRect) - centreX(rowRect)) <= 1,
      `Reset's centre ${(centreX(resetRect) - centreX(rowRect)).toFixed(1)} px from the row's`);
    const lastDot = dots()[dots().length - 1];
    const dotRect = lastDot.getBoundingClientRect();
    const stepperRect = m.stepper.getBoundingClientRect();
    const stepperGap = stepperRect.left - dotRect.right;
    check(5, `Stepper right after the last dot on the same line (${STOP_GAP} px), a dot's height, both halves hit-test to themselves`,
      Math.abs(centreY(stepperRect) - centreY(dotRect)) <= 2 && Math.abs(stepperGap - STOP_GAP) <= 1 &&
        Math.abs(stepperRect.height - dotRect.height) <= 1 && reachable(m.minusButton, false) && reachable(m.plusButton, false),
      `gap ${stepperGap.toFixed(1)} px, stepper ${stepperRect.width.toFixed(1)}×${stepperRect.height.toFixed(1)}`);
    // ── Bottom margin: help text → the dialog's bottom edge ≈ our root → its left edge ──
    const dialog = m.root.closest(".GenericModal");
    const scroller = m.root.closest(".spicetify-popup-content");
    const scrollBefore = scroller?.scrollTop ?? 0;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    const bottomGap = dialog ? dialog.getBoundingClientRect().bottom - help.getBoundingClientRect().bottom : NaN;
    const sideGap = dialog ? m.root.getBoundingClientRect().left - dialog.getBoundingClientRect().left : NaN;
    if (scroller) scroller.scrollTop = scrollBefore;
    check(5, "Space below the help text matches the sides (≤ 4 px)", Math.abs(bottomGap - sideGap) <= 4,
      dialog ? `bottom ${bottomGap.toFixed(1)} px, side ${sideGap.toFixed(1)} px` : "dialog (.GenericModal) not found");

    const cursor = rightClick(dots()[1]);
    const mr = m.menu.getBoundingClientRect();
    const near = (a, b) => Math.abs(a - b) < 1.5;
    const atCursor = (near(mr.left, cursor.x) || near(mr.right, cursor.x)) && (near(mr.top, cursor.y) || near(mr.bottom, cursor.y));
    check(5, "Right-click on a dot opens the menu inside the settings, at the cursor, both items reachable",
      menuShown() && atCursor && reachable(m.duplicateItem, false) && reachable(m.removeItem, false),
      `shown ${menuShown()}, menu ${Math.round(mr.left)},${Math.round(mr.top)}, cursor ${Math.round(cursor.x)},${Math.round(cursor.y)}`);
    m.removeItem.click();
    await sleep(20);
    stillOpen("Remove in the dot menu");
    check(5, "Remove down to one stop → gradient off, switch off but enabled, menu closed, the remaining dot selected",
      settings.stops.length === 1 && !settings.gradient && m.switchButton.getAttribute("aria-checked") === "false" &&
        !m.switchButton.disabled && !menuShown() && selectionIs(settings.stops[0].id),
      `${settings.stops.length} stop(s), gradient ${settings.gradient}; ${selection()}`);
    rightClick(dots()[0]);
    check(5, "One stop → Remove disabled, Duplicate enabled", m.removeItem.disabled && !m.duplicateItem.disabled,
      `remove disabled ${m.removeItem.disabled}, duplicate disabled ${m.duplicateItem.disabled}`);
    m.duplicateItem.click();
    await sleep(20);
    stillOpen("Duplicate in the dot menu");
    check(5, "Duplicate from one stop → an identical copy after it, gradient on, the copy selected",
      settings.stops.length === 2 && settings.gradient && settings.stops[1].kind === settings.stops[0].kind && selectionIs(settings.stops[1].id),
      JSON.stringify(settings.stops));

    setTestSettings(true, [theme("s1"), custom("s2", RED)]);
    rightClick(dots()[0]);
    m.duplicateItem.click();
    await sleep(20);
    check(4, "Duplicating a theme stop inserts a theme stop directly after it",
      settings.stops.map((s) => `${s.id}:${s.kind}`).join() === "s1:theme,s3:theme,s2:custom",
      settings.stops.map((s) => `${s.id}:${s.kind}`).join());
    dots()[0].focus();
    press(dots()[0], "F10", { shiftKey: true });
    const firstFocused = menuShown() && document.activeElement === m.duplicateItem;
    press(document.activeElement, "ArrowDown");
    const secondFocused = document.activeElement === m.removeItem;
    press(document.activeElement, "Escape");
    check(5, "Keyboard: Shift+F10 opens the menu, arrows move, Escape closes and refocuses the dot",
      firstFocused && secondFocused && !menuShown() && document.activeElement === dots()[0],
      `first ${firstFocused}, arrow ${secondFocused}, closed ${!menuShown()}, focus ${document.activeElement?.className}`);
    stillOpen("Escape in the dot menu");

    const plusNode = m.plusButton;
    plusNode.focus();
    for (let i = 0; i < MAX_STOPS + 2 && !m.plusButton.disabled; i++) click(m.plusButton);
    await sleep(20);
    stillOpen("+ up to eight colours");
    check(5, "+ adds up to 8 stops, then is disabled ('Up to 8 colours') and focus moves to the selected dot",
      settings.stops.length === MAX_STOPS && m.plusButton.disabled && m.plusButton.title === ADD_FULL_LABEL &&
        m.plusButton === plusNode && document.activeElement === dotEl(selectedId),
      `${settings.stops.length} stops, disabled ${m.plusButton.disabled}, title "${m.plusButton.title}"`);
    setTestSettings(true, [custom("s1", RED), custom("s2", GREEN), custom("s3", BLUE)]);
    selectStop("s2");
    m.minusButton.focus();
    click(m.minusButton);
    await sleep(20);
    check(5, "− removes the selected dot; the one now in its place is selected; focus stays on −",
      settings.stops.map((s) => s.id).join() === "s1,s3" && selectionIs("s3") && document.activeElement === m.minusButton, selection());
    stillOpen("−");

    // ── Colour picker and theme stops (#4, #5) ──
    const frame = () => new Promise((r) => (requestAnimationFrame(() => r()), setTimeout(r, 100)));
    const pointer = (el, type, fx, fy) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
        button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1,
        clientX: r.left + r.width * fx, clientY: r.top + r.height * fy,
      }));
    };
    setTestSettings(true, [theme("s1"), custom("s2", RED), custom("s3", BLUE)]);
    const themeDot = dots()[0];
    const rowBefore = dots();
    const inPlace = (hex) =>
      dots().every((el, i) => el === rowBefore[i] && el.isConnected) && computedHex(themeDot, "backgroundColor") === hex &&
      styleText().includes(hex) && selectedId === themeDot.dataset.id;
    const state = () => `${JSON.stringify(settings.stops[0])}, dot ${computedHex(themeDot, "backgroundColor")}, selected ${selectedId}`;
    selectStop("s2");
    click(themeDot);
    check(5, "Clicking the theme dot shows it in the picker; 'Following theme colour' disabled",
      selectionIs("s1") && m.useThemeButton.disabled && m.useThemeButton.textContent === THEME_LABELS.on, selection());
    const opacityControls = [...m.root.querySelectorAll("button, input")].filter((el) =>
      /transparen|opacity|alpha/i.test(`${el.className} ${el.textContent} ${el.title} ${el.getAttribute("aria-label") ?? ""}`));
    check(4, "No 'Make transparent' control (or any other transparency or opacity control) in the settings",
      !opacityControls.length && !m.root.querySelector(".gcb-use-transparent") && m.picker.querySelectorAll(".gcb-controls > .gcb-button").length === 1,
      opacityControls.map((el) => `${el.tagName.toLowerCase()}.${el.className} "${el.textContent}"`).join(", ") || "none");
    const sr = m.sv.getBoundingClientRect();
    const cr = m.picker.querySelector(".gcb-controls").getBoundingClientRect();
    check(5, `Picker columns side by side (needs ≥ ${PICKER_COLUMNS_MIN} px of content)`, cr.left >= sr.right && Math.abs(cr.top - sr.top) < 1,
      `content ${Math.round(m.picker.getBoundingClientRect().width)} px`);
    const pickerControls = {
      "SV square": m.sv, "hue slider": m.hue, R: m.rgb[0], G: m.rgb[1], B: m.rgb[2], "hex field": m.hex, "hex copy button": m.hexCopy,
      "theme button": m.useThemeButton, ...(m.eyedropper ? { eyedropper: m.eyedropper } : {}),
    };
    const unreachable = Object.entries(pickerControls).filter(([, el]) => !reachable(el)).map(([name]) => name);
    check(5, "Every picker control is reachable (scrolled into view, its centre hit-tests to it)", !unreachable.length,
      unreachable.length ? `not reachable: ${unreachable.join(", ")}` : `${Object.keys(pickerControls).length} controls`);
    rootStyle.setProperty("--spice-button", PROBE, "important");
    await tick(); // let the :root MutationObserver run
    const swatch = computedHex(themeDot, "backgroundColor");
    const pickerSeen = m.hex.value;
    restoreButton();
    await tick();
    check(4, "Theme dot and picker follow a runtime --spice-button change", swatch === PROBE && pickerSeen === PROBE,
      `dot ${swatch}, picker ${pickerSeen}`);

    pointer(m.sv, "pointerdown", 0.9, 0.1);
    pointer(m.sv, "pointermove", 0.5, 0.5);
    await frame();
    const svExpected = hsvToHex({ h: pickerHsv.h, s: 0.5, v: 0.5 });
    pointer(m.sv, "pointerup", 0.5, 0.5);
    check(5, "Dragging in the square: theme stop → custom, live, dot updated in place, bar CSS follows",
      settings.stops[0].kind === "custom" && settings.stops[0].color === svExpected && inPlace(svExpected),
      `expected ${svExpected}; ${state()}`);
    pointer(m.hue, "pointerdown", 1 / 3, 0.5);
    pointer(m.hue, "pointerup", 1 / 3, 0.5);
    check(5, "Dragging the hue bar to 120° → #408040 everywhere", settings.stops[0].color === "#408040" && inPlace("#408040") &&
      m.hex.value === "#408040" && m.rgb.map((f) => f.value).join() === "64,128,64", state());
    [10, 20, 30].forEach((n, i) => (m.rgb[i].value = String(n)));
    m.rgb[2].dispatchEvent(new Event("input", { bubbles: true }));
    check(5, "R/G/B fields 10/20/30 → #0a141e everywhere", settings.stops[0].color === "#0a141e" && inPlace("#0a141e"), state());
    const typeHex = (value) => {
      m.hex.value = value;
      m.hex.dispatchEvent(new Event("input", { bubbles: true }));
    };
    typeHex("ABCDEF");
    const afterPlain = settings.stops[0].color;
    typeHex("#0f0");
    check(5, "Hex field accepts rrggbb and #rgb, case-insensitive", afterPlain === "#abcdef" && settings.stops[0].color === "#00ff00" &&
      inPlace("#00ff00"), `${afterPlain}; ${state()}`);
    typeHex("#zz12");
    check(5, "Invalid hex is flagged and ignored", m.hex.getAttribute("aria-invalid") === "true" && settings.stops[0].color === "#00ff00",
      `aria-invalid ${m.hex.getAttribute("aria-invalid")}, colour ${settings.stops[0].color}`);
    m.hex.dispatchEvent(new Event("change", { bubbles: true }));
    stillOpen("editing the colour");

    check(5, "Custom stop → 'Use theme colour' enabled", !m.useThemeButton.disabled && m.useThemeButton.textContent === THEME_LABELS.off,
      m.useThemeButton.textContent);
    m.useThemeButton.focus();
    m.useThemeButton.click();
    await sleep(20);
    check(4, "'Use theme colour' → a theme stop, dot updated in place, button disabled, focus on the hex field; CSS has var(--spice-button …)",
      settings.stops[0].kind === "theme" && !("color" in settings.stops[0]) && dots()[0] === themeDot && m.useThemeButton.disabled &&
        m.useThemeButton.textContent === THEME_LABELS.on && document.activeElement === m.hex && styleText().includes(THEME_COLOUR),
      JSON.stringify(settings.stops[0]));
    stillOpen("'Use theme colour'");

    // ── Hex copy button ──
    {
      const realSources = { ...clipboardSources };
      let copied = null;
      try {
        clipboardSources.api = () => ({ copy: async (text) => (copied = text) });
        setTestSettings(true, [custom("s1", RED), custom("s2", GREEN), theme("s3")]);
        selectStop("s2");
        m.hexCopy.click();
        await sleep(20);
        const first = copied;
        selectStop("s3");
        m.hexCopy.click();
        await sleep(20);
        check(5, "Hex copy button copies the selected #rrggbb (a theme stop's: the resolved theme colour) and announces it",
          first === GREEN && copied === themeHex() && m.announce.textContent === "Hex code copied", `copied ${first}, then ${copied}`);
      } finally {
        Object.assign(clipboardSources, realSources);
      }
    }

    // ── Drag and keyboard reordering, Delete ──
    setTestSettings(true, [custom("s1", RED), custom("s2", GREEN), custom("s3", BLUE)]);
    selectStop("s3");
    const stopEls = m.stopsRow.querySelectorAll(".gcb-stop");
    const dt = new DataTransfer();
    stopEls[0].dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const lastRect = stopEls[2].getBoundingClientRect();
    const at = { clientX: lastRect.right + 4, clientY: lastRect.top + lastRect.height / 2 };
    m.stopsRow.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    m.stopsRow.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    const dragged = settings.stops.map((s) => s.id).join();
    click(dots()[0]);
    check(5, "Dragging stop 1 past the last moves it to the end; a click straight after doesn't change the selection",
      dragged === "s2,s3,s1" && selectionIs("s3"), `order ${dragged}; ${selection()}`);
    setTestSettings(true, [custom("s1", RED), custom("s2", GREEN), custom("s3", BLUE)]);
    selectStop("s2");
    const stopOrder = () => settings.stops.map((s) => s.id).join();
    dotEl("s1").focus();
    press(dotEl("s1"), "ArrowRight", { altKey: true });
    const afterRight = stopOrder();
    press(dotEl("s1"), "End", { altKey: true });
    check(5, "Alt+→ and Alt+End move the focused dot; focus kept, selection unchanged, announced",
      afterRight === "s2,s1,s3" && stopOrder() === "s2,s3,s1" && document.activeElement === dotEl("s1") && selectionIs("s2") &&
        m.announce.textContent === "Moved to position 3 of 3",
      `${afterRight} → ${stopOrder()}, announced "${m.announce.textContent}"`);
    stillOpen("Alt+arrow keys on a dot");
    dotEl("s3").focus();
    const deleteKept = press(dotEl("s3"), "Delete");
    check(5, "Delete on a focused dot removes it (key consumed), announced",
      stopOrder() === "s2,s1" && !deleteKept && m.announce.textContent === "Colour removed, 2 left", `${stopOrder()}`);
    stillOpen("Delete on a dot");

    // ── Two-step Reset ──
    const realClick = (el) => {
      const r = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, button: 0, detail: 1,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      const ptr = { pointerId: 1, pointerType: "mouse", isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...init, ...ptr, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...init, ...ptr, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", init));
      el.dispatchEvent(new MouseEvent("click", init));
    };
    const resetBtn = m.resetButton;
    const isArmed = () => resetBtn.classList.contains("gcb-armed") && m.resetLabel.textContent === RESET_CONFIRM_LABEL;
    const isIdle = () => !resetBtn.classList.contains("gcb-armed") && m.resetLabel.textContent === "Reset";
    const beforeReset = JSON.stringify(settings);
    const idleWidth = resetBtn.getBoundingClientRect().width;
    realClick(resetBtn);
    check(5, "First click on Reset doesn't reset; 'Confirm reset?', same width",
      JSON.stringify(settings) === beforeReset && isArmed() && Math.abs(resetBtn.getBoundingClientRect().width - idleWidth) <= 1,
      m.resetLabel.textContent);
    press(resetBtn, "Escape");
    check(5, "Escape disarms Reset without resetting", isIdle() && JSON.stringify(settings) === beforeReset, m.resetLabel.textContent);
    stillOpen("Escape on an armed Reset");
    realClick(resetBtn);
    realClick(resetBtn);
    await sleep(TEXT_DELAY + 60);
    check(5, "Second click on Reset → defaults (no background rule, Auto text), the first dot selected, the same button reads 'Reset'",
      JSON.stringify(settings) === JSON.stringify(defaultSettings()) && !styleText().includes("background-image") &&
        styleText() === buildCss(settings, appliedTextColour()) && settings.textColour === "auto" &&
        m.textButtons[0].getAttribute("aria-checked") === "true" &&
        selectionIs(settings.stops[0].id) && m.resetButton === resetBtn && isIdle(),
      `${JSON.stringify(settings)}; ${styleText().replace(/\s+/g, " ")}`);
    stillOpen("Reset");

    // ── Text colour row (#11) ──
    const textRowNodes = [...m.textButtons];
    const textState = () =>
      `mode ${settings.textColour}, checked ${m.textButtons.filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.mode).join() || "none"}, ` +
      `tabindex ${m.textButtons.map((b) => b.tabIndex).join()}, focus ${document.activeElement?.dataset?.mode ?? document.activeElement?.className}`;
    const textShows = (mode) =>
      settings.textColour === mode && m.textButtons.every((b, i) => b === textRowNodes[i] && b.isConnected &&
        (b.getAttribute("aria-checked") === "true") === (b.dataset.mode === mode) && b.tabIndex === (b.dataset.mode === mode ? 0 : -1));
    check(11, "Text colour row between the Gradient row and the Presets row: a radiogroup of Auto, Black, White, Spotify default; no <select>",
      m.gradientRow.nextElementSibling === m.text && m.text.nextElementSibling === m.presets && m.textModes.getAttribute("role") === "radiogroup" &&
        m.textModes.getAttribute("aria-labelledby") === "gcb-text-label" &&
        m.textButtons.map((b) => b.textContent).join() === "Auto,Black,White,Spotify default" &&
        m.textButtons.every((b) => b.tagName === "BUTTON" && b.getAttribute("role") === "radio") && !m.root.querySelector("select") &&
        m.textButtons.every((b) => reachable(b)),
      textState());

    // No hint and no warning in any mode, even where neither black nor white reads well (black →
    // white across the whole bar), nothing logged, and the row sits right above the preview.
    setTestSettings(true, [custom("s1", BLACK), custom("s2", WHITE)]);
    const hintProblems = [];
    const ourWarnings = [];
    const warn = console.warn;
    console.warn = (...args) => (String(args[0]).startsWith("[gcb]") ? ourWarnings.push(args.join(" ")) : warn(...args));
    try {
      for (const [i, mode] of TEXT_MODES.entries()) {
        realClick(m.textButtons[i]);
        recalcTextColour({ region: { from: 0, to: 1 } });
        window.__gcb.status();
        const extra = [...m.text.children].filter((el) => el !== m.textLabel && el !== m.textModes);
        const hintLike = m.root.querySelector(".gcb-text-hint, .gcb-warning") ?? m.text.querySelector('[id$="-hint"], [aria-describedby]') ??
          (m.text.nextElementSibling === m.presets ? null : m.text.nextElementSibling);
        const words = /\d(\.\d)?:1\b|4\.5|contrast|readab|warning/i.exec(m.text.textContent);
        const gap = m.presets.getBoundingClientRect().top - m.text.getBoundingClientRect().bottom;
        const rowGap = parseFloat(getComputedStyle(m.root).rowGap);
        if (!textShows(mode) || extra.length || hintLike || words || Math.abs(gap - rowGap) > 0.5)
          hintProblems.push(`${mode}: ${extra.length} extra element(s), ${hintLike ? `.${hintLike.className}` : "no hint element"}, ` +
            `${words ? `"${words[0]}"` : "no contrast text"}, gap ${gap.toFixed(1)} px (modal gap ${rowGap} px)`);
      }
    } finally {
      console.warn = warn;
    }
    recalcTextColour();
    check(11, "No hint or warning under the Text colour row in any of the four modes, nothing logged; the Presets row follows at the modal's normal gap",
      !hintProblems.length && !ourWarnings.length,
      [...hintProblems, ...ourWarnings].join("; ") || `${TEXT_MODES.join(", ")}: no hint, ${m.text.children.length} children (label, radiogroup)`);

    setTestSettings(true, [custom("s1", RED), custom("s2", BLUE)]);
    realClick(m.textButtons[2]);
    const whiteCss = styleText();
    const previewWhite = toHex(getComputedStyle(m.previewLabel).color);
    check(11, "Clicking White applies it live: --text-base and --essential-base #ffffff in the bar's rule, the preview label white, the row updated in place",
      textShows("white") && whiteCss.includes("--text-base: #ffffff;") && whiteCss.includes("--essential-base: #ffffff;") &&
        previewWhite === WHITE && toHex(getComputedStyle(m.previewIcon).fill) === WHITE,
      `${textState()}; preview ${previewWhite}`);
    realClick(m.textButtons[3]);
    check(11, "Spotify default writes no text colour; the preview shows Spotify's own",
      textShows("default") && !styleText().includes("--text-base") && toHex(getComputedStyle(m.previewLabel).color) === spotifyTextColour(),
      `${textState()}; preview ${toHex(getComputedStyle(m.previewLabel).color)}, Spotify's ${spotifyTextColour()}`);
    m.textButtons[3].focus();
    const textKeys = [];
    for (const [key, expected] of [["Home", "auto"], ["ArrowRight", "black"], ["End", "default"], ["ArrowRight", "auto"]]) {
      press(document.activeElement, key);
      const ok = textShows(expected) && document.activeElement === m.textButtons[TEXT_MODES.indexOf(expected)];
      textKeys.push(`${key} → ${settings.textColour}${ok ? "" : ` (expected ${expected} focused)`}`);
    }
    const altText = press(document.activeElement, "ArrowRight", { altKey: true });
    textKeys.push(`Alt+→ → ${settings.textColour}${settings.textColour === "auto" && altText ? "" : " (expected no change)"}`);
    check(11, "Keyboard: Home, →, End and → (wrapping) change the text colour and move focus; Alt+→ doesn't",
      !textKeys.some((step) => step.includes("expected")), textKeys.join(", "));
    stillOpen("changing the text colour");
    realClick(m.textButtons[1]);
    await sleep(SAVE_DELAY + 100);
    const storedText = JSON.parse(Spicetify.LocalStorage.get(STORAGE_KEY) ?? "{}").textColour;
    check(11, "The chosen text colour is saved", storedText === "black", `stored ${storedText}`);
    realClick(m.textButtons[0]);

    // The checked button is filled with the live --spice-button; its label takes whichever of
    // --spice-text and --spice-main contrasts more (GPB #43). A dark and a light probe.
    const fillProblems = [];
    for (const probe of ["#123456", "#ffe680"]) {
      rootStyle.setProperty("--spice-button", probe, "important");
      await sleep(250); // the :root observer, then the background-color transition (.15 s)
      const checked = m.textButtons.find((b) => b.getAttribute("aria-checked") === "true");
      for (const animation of checked.getAnimations()) animation.finish(); // our own button's fade, not Spotify's
      const fill = parseRgb(getComputedStyle(checked).backgroundColor);
      const label = parseRgb(getComputedStyle(checked).color);
      const want = hexToRgb(probe);
      const ratio = label ? contrast(label, want) : 0;
      if (!fill || !fill.every((v, i) => Math.abs(v - want[i]) <= 1) || ratio < 4.5) // parseRgb() only takes opaque colours
        fillProblems.push(`${probe}: fill ${getComputedStyle(checked).backgroundColor}, label ${getComputedStyle(checked).color} (${ratio.toFixed(2)}:1)`);
    }
    restoreButton();
    await sleep(250);
    check(11, "The checked text colour button is filled with a runtime --spice-button; its label reaches 4.5:1 on a dark and a light probe",
      !fillProblems.length, fillProblems.join("; ") || "both probes fine");

    // ── Presets and share codes (#29, #36) ──
    // Store and codes first: pure functions on crafted raw values, counting [gcb] warnings per load.
    const gcbWarnings = (fn) => {
      const original = console.warn;
      let count = 0;
      console.warn = (...args) => (String(args[0]).startsWith("[gcb]") ? count++ : original(...args));
      try {
        return [fn(), count];
      } finally {
        console.warn = original;
      }
    };
    const presetsJson = (list) => JSON.stringify({ version: PRESETS_VERSION, presets: list });
    const own = (id, name, sets) => ({ id, name, settings: sets });
    const sampleA = { gradient: true, textColour: "white", stops: [theme("s1"), custom("s2", RED)] };
    const sampleB = { gradient: false, textColour: "default", stops: [custom("s1", BLUE)] };
    const names = (list) => list.map((p) => p.name).join(", ");

    presets = [own("p1", "One", sampleA), own("p2", "Two", sampleB)];
    savePresets();
    const [reloadedPresets, reloadWarnings] = gcbWarnings(() => loadPresets());
    check(29, "Presets store: save → load round-trip in gcb:presets (theme and custom stops, gradient, text colour); gcb:settings untouched",
      JSON.stringify(reloadedPresets) === JSON.stringify(presets) && !reloadWarnings && PRESETS_KEY === "gcb:presets" &&
        JSON.parse(Spicetify.LocalStorage.get(PRESETS_KEY)).version === PRESETS_VERSION,
      `${names(reloadedPresets)}; ${reloadWarnings} warning(s); ${Spicetify.LocalStorage.get(PRESETS_KEY).length} characters`);
    const [kept, dropWarnings] = gcbWarnings(() => loadPresets(presetsJson([
      own("p1", "  Good  ", sampleA),
      own("p2", "Bad hex", { ...sampleA, stops: [custom("s1", "#12345")] }),
      own("p3", "   ", sampleB),
      own("p4", "x".repeat(PRESET_NAME_MAX + 1), sampleB),
      own("p5", "Bad text colour", { ...sampleB, textColour: "grey" }),
      { id: "p6", name: "No settings" },
      own("p1", "Same id", sampleB),
      own("p7", "good", sampleB),
    ])));
    check(29, "Invalid presets are dropped with one [gcb] warning; names trimmed; a name clash gets ' (2)'",
      names(kept) === "Good, good (2)" && dropWarnings === 1, `kept ${names(kept)}; ${dropWarnings} warning(s)`);
    const corrupt = ["{nope", JSON.stringify({ version: 2, presets: [] }), JSON.stringify([1, 2]), JSON.stringify({ version: 1 })]
      .map((raw) => gcbWarnings(() => loadPresets(raw)));
    check(29, "A corrupt or unknown gcb:presets gives an empty list and one warning",
      corrupt.every(([list, warnings]) => list.length === 0 && warnings === 1),
      corrupt.map(([list, warnings]) => `${list.length} presets/${warnings} warning(s)`).join(", "));
    const [capped, capWarnings] = gcbWarnings(() =>
      loadPresets(presetsJson(Array.from({ length: MAX_PRESETS + 2 }, (_, i) => own(`p${i + 1}`, `Mine ${i + 1}`, sampleB))))
    );
    presets = [own("p1", "Mine", sampleB)];
    const clashes = [uniqueName("Mine"), uniqueName("fairy"), uniqueName(" Spaced "), uniqueName("y".repeat(30))];
    presets = [own("p1", "y".repeat(PRESET_NAME_MAX), sampleB)];
    const longClash = uniqueName("y".repeat(PRESET_NAME_MAX));
    check(29, `At most ${MAX_PRESETS} presets load; names are unique (built-ins included, any case), trimmed and ≤ ${PRESET_NAME_MAX} characters`,
      capped.length === MAX_PRESETS && capWarnings === 1 &&
        clashes.join("|") === `Mine (2)|fairy (2)|Spaced|${"y".repeat(PRESET_NAME_MAX)}` &&
        longClash.length === PRESET_NAME_MAX && longClash.endsWith(" (2)"),
      `${capped.length} loaded, ${capWarnings} warning(s); ${clashes.join(" | ")} | ${longClash}`);
    presets = [];
    savePresets();
    check(29, "Built-ins can't be deleted, renamed or updated",
      deletePreset("b:fairy") === null && !renamePreset("b:fairy", "Sea") && !updatePreset("b:fairy") && BUILT_IN_PRESETS[4].name === "Fairy",
      BUILT_IN_PRESETS.map((p) => p.id).join());
    const builtInColours = {
      "b:void": ["Void", "#8372fd,#5a82ff,#8372fd"], "b:sunset": ["Sunset", "#6e33ff,#ff5f6d,#ffc371"],
      "b:aurora": ["Aurora", "#00f5a0,#00d9f5,#7f5af0"], "b:neon": ["Neon", "#ff00cc,#3333ff,#33f7ff"], "b:fairy": ["Fairy", "#ff59d1,#ffb800,#77bc00"],
    };
    const builtInMismatches = Object.entries(builtInColours).filter(([id, [name, colours]], i) => {
      const preset = BUILT_IN_PRESETS[i];
      const applied = preset && presetSettings(preset, { textColour: "black" });
      const back = applied && decodeCode(encodeCode(applied));
      return !preset || preset.id !== id || preset.name !== name || preset.colours.join() !== colours ||
        applied.textColour !== "black" || !applied.gradient || !back || !sameSettings(back.settings, applied);
    }).map(([id]) => id);
    check(29, "The built-ins are GPB's five (Void, Sunset, Aurora, Neon, Fairy: ids, order, colours); applied they keep the current text colour",
      BUILT_IN_PRESETS.length === 5 && !builtInMismatches.length,
      builtInMismatches.length ? `mismatch: ${builtInMismatches.join(", ")}` : BUILT_IN_PRESETS.map((p) => `${p.name} ${p.colours.join("→")}`).join("; "));
    const [renamedOnLoad, renameWarnings] = gcbWarnings(() =>
      loadPresets(presetsJson([own("p3", "fairy", sampleB), own("p1", "Void", sampleA), own("p2", "Ocean", sampleB)]))
    );
    check(29, "Stored own presets whose names clash with a built-in are renamed on load (' (2)'), ids unchanged, no warning",
      names(renamedOnLoad) === "fairy (2), Void (2), Ocean" && renamedOnLoad.map((p) => p.id).join() === "p3,p1,p2" && !renameWarnings,
      `${names(renamedOnLoad)}; ids ${renamedOnLoad.map((p) => p.id).join()}; ${renameWarnings} warning(s)`);

    // Share codes (#36): the fixtures GPB's self-test uses too, so both sides agree.
    const FIXTURES = {
      gpbVoid: "gpb1:eyJnIjoxLCJtIjoiYyIsInMiOlsiODM3MmZkIiwiNWE4MmZmIiwiODM3MmZkIl19",
      gpbThemeAnchored: "gpb1:eyJnIjoxLCJtIjoiYSIsInMiOlsidCIsImZmNWY2ZCJdfQ",
      gcbVoidAuto: "gcb1:eyJnIjoxLCJ4IjoiYSIsInMiOlsiODM3MmZkIiwiNWE4MmZmIiwiODM3MmZkIl19",
      gcbThemeWhite: "gcb1:eyJnIjoxLCJ4IjoidyIsInMiOlsidCIsImZmNWY2ZCJdfQ",
      gcbSolidThemeDefault: "gcb1:eyJnIjowLCJ4IjoiZCIsInMiOlsidCJdfQ",
    };
    const shape = (decoded) => decoded
      ? `${decoded.from}: g ${decoded.settings.gradient ? 1 : 0}, ${decoded.settings.textColour}, ${decoded.settings.stops.map((stop) => (stop.kind === "theme" ? "t" : stop.color)).join("→")}`
      : "null";
    const decodeWith = (code, textColour) => decodeCode(code, { textColour });
    const fixtureResults = {
      gpbVoid: [shape(decodeWith(FIXTURES.gpbVoid, "white")), "gpb: g 1, white, #8372fd→#5a82ff→#8372fd"],
      gpbVoidAuto: [shape(decodeWith(FIXTURES.gpbVoid, "auto")), "gpb: g 1, auto, #8372fd→#5a82ff→#8372fd"],
      gpbThemeAnchored: [shape(decodeWith(FIXTURES.gpbThemeAnchored, "default")), "gpb: g 1, default, t→#ff5f6d"],
      gcbVoidAuto: [shape(decodeWith(FIXTURES.gcbVoidAuto, "black")), "gcb: g 1, auto, #8372fd→#5a82ff→#8372fd"],
      gcbThemeWhite: [shape(decodeWith(FIXTURES.gcbThemeWhite, "black")), "gcb: g 1, white, t→#ff5f6d"],
      gcbSolidThemeDefault: [shape(decodeWith(FIXTURES.gcbSolidThemeDefault, "black")), "gcb: g 0, default, t"],
    };
    const wrongFixtures = Object.entries(fixtureResults).filter(([, [got, want]]) => got !== want);
    check(36, "Fixtures decode as specified: gpb1: keeps the current text colour (Spread dropped), gcb1: brings its own",
      !wrongFixtures.length, wrongFixtures.map(([k, [got, want]]) => `${k}: ${got} (expected ${want})`).join("; ") || `${Object.keys(fixtureResults).length} decodes`);
    const voidAuto = encodeCode(presetSettings(BUILT_IN_PRESETS[0], { textColour: "auto" }));
    const reEncoded = ["gcbThemeWhite", "gcbSolidThemeDefault"].map((k) => encodeCode(decodeCode(FIXTURES[k]).settings) === FIXTURES[k]);
    check(36, "Export of the Void built-in with Auto gives exactly the gcb1: Void fixture; the other gcb1: fixtures re-encode to themselves",
      voidAuto === FIXTURES.gcbVoidAuto && reEncoded.every(Boolean), `${voidAuto}; re-encoded ${reEncoded.join(", ")}`);
    const codeCases = TEXT_MODES.flatMap((textColour) => [true, false].map((gradient) =>
      ({ version: SCHEMA_VERSION, gradient, textColour, stops: [theme("a"), custom("b", RED), custom("c", "#00ff7f")] })));
    const roundTrips = codeCases.map((c) => {
      const back = decodeCode(encodeCode(c));
      return !!back && back.from === "gcb" && sameSettings(back.settings, c) && back.settings.stops.map((stop) => stop.id).join() === "s1,s2,s3";
    });
    check(36, "gcb1: round-trip: theme and custom stops, every text colour, gradient on and off (ids s1…sN)",
      roundTrips.every(Boolean) && voidAuto.startsWith(CODE_PREFIX), `${roundTrips.filter(Boolean).length}/${roundTrips.length}`);
    const raw = (prefix, data) => prefix + toBase64Url(data);
    const validBody = FIXTURES.gcbVoidAuto.slice(CODE_PREFIX.length);
    const invalidCodes = {
      garbage: "garbage",
      empty: "",
      "wrong prefix": `gcb2:${validBody}`,
      "prefix only": CODE_PREFIX,
      "not base64": `${CODE_PREFIX}@@@`,
      "9 stops": raw(CODE_PREFIX, { g: 1, x: "a", s: Array(9).fill("ff0000") }),
      "bad hex": raw(CODE_PREFIX, { g: 1, x: "a", s: ["zzzzzz"] }),
      "short hex": raw(CODE_PREFIX, { g: 1, x: "a", s: ["fff"] }),
      "unknown x": raw(CODE_PREFIX, { g: 1, x: "q", s: ["ff0000"] }),
      "no x": raw(CODE_PREFIX, { g: 1, s: ["ff0000"] }),
      "g 2": raw(CODE_PREFIX, { g: 2, x: "a", s: ["ff0000"] }),
      "gpb1: unknown m": raw(GPB_CODE_PREFIX, { g: 1, m: "x", s: ["ff0000"] }),
      "gpb1: no m": raw(GPB_CODE_PREFIX, { g: 1, s: ["ff0000"] }),
      "gpb1: x instead of m": raw(GPB_CODE_PREFIX, { g: 1, x: "a", s: ["ff0000"] }),
      "gpb1: 9 stops": raw(GPB_CODE_PREFIX, { g: 1, m: "c", s: Array(9).fill("ff0000") }),
      "gpb2:": `gpb2:${FIXTURES.gpbVoid.slice(5)}`,
    };
    const accepted = Object.entries(invalidCodes).filter(([, code]) => decodeCode(code) !== null).map(([label]) => label);
    check(36, "Invalid codes are rejected: garbage, wrong prefixes, 9 stops, bad hex, an unknown x, a gpb1: code GPB itself wouldn't accept",
      !accepted.length, accepted.length ? `accepted: ${accepted.join(", ")}` : `${Object.keys(invalidCodes).length} rejected`);
    check(36, "Whitespace around a code is accepted", !!decodeCode(`  \n${FIXTURES.gcbThemeWhite}\t `) && !!decodeCode(` ${FIXTURES.gpbVoid} `), "");

    // The Presets row in the open modal.
    renderChips(m);
    const chipIds = () => [...m.chips.querySelectorAll(".gcb-chip")].filter((el) => !el.hidden)
      .map((el) => (el === m.saveChip ? "save" : el.dataset.preset)).join();
    const chipOf = (id) => chipEl(id);
    const pressed = () => [...m.chips.querySelectorAll('.gcb-preset-chip[aria-pressed="true"]')].map((el) => el.dataset.preset).join() || "none";
    const undoState = () => `undo "${m.undoText.textContent}"${m.undoButton.hidden ? " (no button)" : " + Undo"}`;
    const undoShows = (message) => m.undoText.textContent === `${message} · ` && !m.undoButton.hidden &&
      m.undoLine.getAttribute("aria-live") === "polite";
    const presetsRect = m.presets.getBoundingClientRect();
    const toolsRect = m.presetsRow.querySelector(".gcb-presets-tools").getBoundingClientRect();
    const labelRect0 = m.presetsRow.querySelector(".gcb-label").getBoundingClientRect();
    const unreachableChips = [...m.chips.querySelectorAll(".gcb-chip"), m.exportButton, m.importButton].filter((el) => !reachable(el));
    check(29, "Presets row between the Text colour row and the preview: label left, Export and Import right, every chip reachable",
      m.presets.previousElementSibling === m.text && m.presets.nextElementSibling === m.preview &&
        Math.abs(labelRect0.left - presetsRect.left) <= 1 && Math.abs(toolsRect.right - presetsRect.right) <= 1 && !unreachableChips.length,
      `after .${m.presets.previousElementSibling?.className}, before .${m.presets.nextElementSibling?.className}` +
        (unreachableChips.length ? `; not reachable: ${unreachableChips.map((el) => el.textContent).join(", ")}` : ""));
    const shareButtons = [[m.exportButton, "Export", EXPORT_TITLE], [m.importButton, "Import", IMPORT_TITLE]];
    const shareProblems = shareButtons.flatMap(([el, label, title]) => {
      const cs = getComputedStyle(el);
      const svg = el.querySelector("svg");
      const problems = [];
      if (!(parseFloat(cs.borderTopWidth) >= 1) || cs.borderTopStyle !== "solid") problems.push(`${label}: border ${cs.borderTopWidth} ${cs.borderTopStyle}`);
      if (!svg || el.firstElementChild !== svg || Math.abs(svg.getBoundingClientRect().width - 14) > 0.5) problems.push(`${label}: icon`);
      const shownLabel = el.querySelector(".gcb-share-label")?.textContent;
      if (shownLabel !== label || el.title !== title) problems.push(`${label}: label "${shownLabel}", title "${el.title}"`);
      if (parseInt(cs.fontWeight, 10) < 700 || cs.borderTopLeftRadius === "0px") problems.push(`${label}: weight ${cs.fontWeight}, radius ${cs.borderTopLeftRadius}`);
      return problems;
    });
    check(36, "Export and Import are outlined pills with a 14 px icon first, bold labels and their titles", !shareProblems.length,
      shareProblems.join("; ") || "both fine");
    const chipSwatch = chipOf("b:aurora")?.querySelector(".gcb-chip-swatch");
    const swatchRect = chipSwatch?.getBoundingClientRect();
    const rowIds = (row) => [...row.querySelectorAll(".gcb-chip")].filter((el) => !el.hidden)
      .map((el) => (el === m.saveChip ? "save" : el.dataset.preset)).join();
    const rowsSplit = (ownIds) => rowIds(m.builtInRow) === BUILT_IN_PRESETS.map((p) => p.id).join() && rowIds(m.ownRow) === [...ownIds, "save"].join();
    const rowGap = m.ownRow.getBoundingClientRect().top - m.builtInRow.getBoundingClientRect().bottom;
    check(29, "Chips: two rows (the built-ins; own presets and + Save), 8 px apart, 12 px swatches painted with barImage()",
      chipIds() === "b:void,b:sunset,b:aurora,b:neon,b:fairy,save" && rowsSplit([]) && Math.abs(rowGap - 8) <= 1 &&
        swatchRect && Math.abs(swatchRect.width - 12) <= 0.5 && chipSwatch.style.backgroundImage.startsWith("linear-gradient"),
      `${chipIds()}; gap ${rowGap.toFixed(1)} px; swatch ${swatchRect?.width.toFixed(1)} px`);

    // Two-step apply with a preview in the strip, text colour included.
    setTestSettings(true, [custom("s1", BLACK)], "auto");
    setTestSettings(false, [custom("s1", BLACK)], "auto");
    const notAPreset = JSON.stringify(settings);
    const cssBeforePreview = styleText();
    const stripProbe = document.createElement("span"); // the same serialisation as the strip's inline style
    const stripShows = (sets) => {
      stripProbe.style.backgroundImage = barImage(sets);
      return m.preview.style.backgroundImage === stripProbe.style.backgroundImage;
    };
    const stripText = () => toHex(getComputedStyle(m.previewLabel).color);
    const statusText = () => m.undoText.textContent;
    const previewMessage = (name) => `Previewing "${name}" — click it again to apply, Esc to cancel`;
    const untouched = () => JSON.stringify(settings) === notAPreset && styleText() === cssBeforePreview;
    const fairy = chipOf("b:fairy");
    const fairyLabel = () => fairy.querySelector(".gcb-chip-label").textContent;
    const idleChipWidth = fairy.getBoundingClientRect().width;
    const textBefore = stripText();
    realClick(fairy);
    const fairyText = textColourFor(presetSettings(BUILT_IN_PRESETS[4]));
    check(29, "First click arms a chip ('Apply?', same width) and previews it in the strip, its text colour too (Auto computed for its colours); nothing applied",
      fairy.classList.contains("gcb-armed") && fairyLabel() === APPLY_LABEL && Math.abs(fairy.getBoundingClientRect().width - idleChipWidth) <= 1 &&
        stripShows(presetSettings(BUILT_IN_PRESETS[4])) && stripText() === fairyText && textBefore === WHITE && fairyText === BLACK && untouched() &&
        statusText() === previewMessage("Fairy") && m.undoButton.hidden,
      `label "${fairyLabel()}", strip text ${textBefore} → ${stripText()} (Fairy with Auto: ${fairyText}), status "${statusText()}"`);
    stillOpen("arming a preset chip");
    press(fairy, "Escape");
    check(29, "Escape disarms: the strip (colours and text) shows the current settings again, the status line is empty, nothing applied",
      !fairy.classList.contains("gcb-armed") && fairyLabel() === "Fairy" && stripShows(settings) && stripText() === WHITE && !statusText() && untouched(),
      `label "${fairyLabel()}", strip text ${stripText()}, status "${statusText()}"`);
    realClick(fairy);
    await sleep(RESET_CONFIRM_MS + 500);
    const stillArmed = fairy.classList.contains("gcb-armed") && stripShows(presetSettings(BUILT_IN_PRESETS[4]));
    const aurora = chipOf("b:aurora");
    realClick(aurora);
    check(29, "No timeout while previewing; a click on another chip moves the arm and the preview to it",
      stillArmed && !fairy.classList.contains("gcb-armed") && aurora.classList.contains("gcb-armed") &&
        stripShows(presetSettings(BUILT_IN_PRESETS[2])) && statusText() === previewMessage("Aurora") && untouched(),
      `still armed after ${(RESET_CONFIRM_MS + 500) / 1000} s ${stillArmed}; armed ${m.armed?.chip.dataset.preset}`);
    realClick(dots()[0]);
    check(29, "A click elsewhere disarms: the strip reverts, the status line clears, nothing applied",
      !aurora.classList.contains("gcb-armed") && !m.armed && stripShows(settings) && !statusText() && untouched(), `status "${statusText()}"`);
    stillOpen("a click outside an armed chip");

    setTestSettings(true, [custom("s1", RED), custom("s2", GREEN)], "white");
    realClick(fairy);
    realClick(fairy);
    check(29, "Second click applies Fairy: its colours, gradient on, the text colour kept (White), the first dot selected; same chip node",
      sameSettings(settings, presetSettings(BUILT_IN_PRESETS[4])) && settings.textColour === "white" && styleText().includes("--text-base: #ffffff;") &&
        selectionIs(settings.stops[0].id) && chipOf("b:fairy") === fairy && fairy.isConnected && stripShows(settings),
      `${settings.textColour}, ${settings.stops.map((x) => x.color).join(", ")}; ${selection()}`);
    stillOpen("applying a preset");
    const fairyBorder = parseRgb(getComputedStyle(fairy).borderTopColor);
    const buttonColour = computedRgb(m.root, "var(--spice-button)");
    check(29, "The active chip is marked (aria-pressed, --spice-button border); a built-in matches by colours only, whatever the text colour",
      pressed() === "b:fairy" && !!fairyBorder && !!buttonColour && fairyBorder.every((v, i) => Math.abs(v - buttonColour[i]) <= 1) &&
        matchesPreset(BUILT_IN_PRESETS[4], { ...settings, textColour: "black" }),
      `pressed ${pressed()}, border ${getComputedStyle(fairy).borderTopColor}`);
    check(29, "Undo line after applying: 'Applied \"Fairy\" · Undo' in a polite live region", undoShows('Applied "Fairy"'), undoState());
    const fairyApplied = JSON.stringify(settings);
    realClick(fairy);
    check(29, "A click on the active chip does nothing: not armed, nothing applied, the Undo kept",
      !fairy.classList.contains("gcb-armed") && !m.armed && JSON.stringify(settings) === fairyApplied && undoShows('Applied "Fairy"'),
      `armed ${!!m.armed}, ${undoState()}`);
    const sunset = chipOf("b:sunset");
    realClick(sunset);
    realClick(sunset);
    const sunsetApplied = sameSettings(settings, presetSettings(BUILT_IN_PRESETS[1])) && pressed() === "b:sunset";
    realClick(m.undoButton);
    check(29, "A new action replaces the pending undo: Undo goes back to Fairy, not further",
      sunsetApplied && sameSettings(settings, presetSettings(BUILT_IN_PRESETS[4])) && m.undoButton.hidden && !m.undoText.textContent,
      `${settings.stops.map((x) => x.color).join(", ")}; ${undoState()}`);
    setTestSettings(true, [theme("s1"), custom("s2", RED), custom("s3", GREEN)], "black");
    selectStop("s3");
    const exact = JSON.stringify(settings);
    realClick(fairy);
    realClick(fairy);
    realClick(m.undoButton);
    check(29, "Undo after applying restores exactly the previous settings (ids and text colour included), the selection on the first dot",
      JSON.stringify(settings) === exact && selectionIs("s1"), `${JSON.stringify(settings)}; ${selection()}`);
    stillOpen("Undo after applying");
    realClick(chipOf("b:neon"));
    realClick(chipOf("b:neon"));
    setStopColour(settings.stops[0].id, BLUE);
    check(29, "Editing the colours afterwards drops the pending undo", m.undoButton.hidden && !pendingUndo, undoState());

    // + Save, the inline name field, own presets: they save and restore the text colour.
    setTestSettings(true, [theme("s1"), custom("s2", RED)], "default");
    const saveNode = m.saveChip;
    realClick(saveNode);
    const nameShown = !m.nameField.hidden && m.saveChip.hidden && document.activeElement === m.nameField && m.nameField.value === "Preset 1" &&
      !m.nameField.closest(".gcb-popover") && saveNode.isConnected;
    press(m.nameField, "Escape");
    const cancelled = !presets.length && m.nameField.hidden && !m.saveChip.hidden && document.activeElement === m.saveChip;
    realClick(m.saveChip);
    m.nameField.value = "  Mine  ";
    press(m.nameField, "Enter");
    await tick();
    await tick();
    const mineId = presets[0]?.id;
    const mineChip = mineId && chipOf(mineId);
    check(29, "+ Save: an inline name field ('Preset 1'); Escape cancels; Enter saves 'Mine' with the text colour, its chip in row 2, active and focused",
      nameShown && cancelled && presets.length === 1 && presets[0].name === "Mine" && presets[0].settings.textColour === "default" &&
        JSON.parse(Spicetify.LocalStorage.get(PRESETS_KEY) ?? "{}").presets?.[0]?.settings.textColour === "default" &&
        rowsSplit([mineId]) && mineChip?.getAttribute("aria-pressed") === "true" && document.activeElement === mineChip && m.saveChip === saveNode,
      `field ${nameShown}, cancelled ${cancelled}; ${chipIds()}; pressed ${pressed()}`);
    stillOpen("saving a preset");
    setTestSettings(true, [custom("s1", GREEN), custom("s2", BLUE)], "white");
    check(29, "An own preset doesn't match other settings that differ only in the text colour",
      !matchesPreset(presets[0], { ...presetSettings(presets[0]), textColour: "white" }) && pressed() === "none", `pressed ${pressed()}`);
    realClick(chipOf(mineId));
    const ownText = stripText();
    realClick(chipOf(mineId));
    check(29, "An own preset previews and restores everything: gradient, stops (theme stays theme) and its text colour (Spotify default)",
      ownText === spotifyTextColour() && sameSettings(settings, { gradient: true, textColour: "default", stops: [theme("x"), custom("y", RED)] }) &&
        !styleText().includes("--text-base"),
      `preview text ${ownText}; ${JSON.stringify(settings)}`);
    stillOpen("applying an own preset");

    rightClick(chipOf("b:fairy"));
    const builtInMenu = menuShown();
    closePopover();
    rightClick(chipOf(mineId));
    const shownItems = [...m.menu.querySelectorAll(".gcb-menu-item")].filter((el) => !el.hidden).map((el) => el.textContent);
    const renameNode = m.renameItem;
    realClick(renameNode);
    const renaming = !m.nameField.hidden && m.nameField.value === "Mine" && chipOf(mineId)?.hidden && renameNode.isConnected && !menuShown();
    m.nameField.value = "Fairy";
    press(m.nameField, "Enter");
    await tick();
    await tick();
    check(29, "Own chips have Rename, Update to current colours, Delete (built-ins no menu); Rename in place, a clash with a built-in gets ' (2)'",
      !builtInMenu && shownItems.join() === "Rename,Update to current colours,Delete" && renaming && presets[0].name === "Fairy (2)" &&
        chipOf(mineId)?.textContent.includes("Fairy (2)"),
      `built-in menu ${builtInMenu}; items ${shownItems.join(", ")}; name "${presets[0].name}"`);
    setTestSettings(true, [custom("s1", RED), custom("s2", GREEN), custom("s3", BLUE)], "black");
    rightClick(chipOf(mineId));
    realClick(m.updatePresetItem);
    await tick();
    await tick();
    check(29, "Update to current colours stores the current settings (text colour included); its chip turns active",
      sameSettings(presetSettings(presets[0]), settings) && presets[0].settings.textColour === "black" && chipOf(mineId)?.getAttribute("aria-pressed") === "true",
      `pressed ${pressed()}`);
    addPreset("Second");
    renderChips(m);
    const beforeDelete = JSON.stringify(presets);
    rightClick(chipOf(mineId));
    const deleteNode = m.deletePresetItem;
    realClick(deleteNode);
    await tick();
    await tick();
    const deleted = presets.length === 1 && !chipOf(mineId) && undoShows('Deleted "Fairy (2)"') && deleteNode.isConnected;
    realClick(m.undoButton);
    await tick();
    await tick();
    check(29, "Delete at once with 'Deleted \"…\" · Undo'; Undo restores the preset in its old place, in storage too",
      deleted && JSON.stringify(presets) === beforeDelete && Spicetify.LocalStorage.get(PRESETS_KEY) === presetsJson(JSON.parse(beforeDelete)),
      `deleted ${deleted}; ${names(presets)}`);
    stillOpen("deleting a preset");
    while (presets.length < MAX_PRESETS) addPreset("Fill");
    renderChips(m);
    check(29, `+ Save is disabled at ${MAX_PRESETS} presets ('Up to ${MAX_PRESETS} presets'); a ${MAX_PRESETS + 1}th isn't added`,
      m.saveChip.disabled && m.saveChip.title === SAVE_FULL_LABEL && addPreset("One more") === null && presets.length === MAX_PRESETS,
      `${presets.length} presets, disabled ${m.saveChip.disabled}`);
    presets = [];
    savePresets();
    renderChips(m);

    // Import: gcb1: brings its text colour, gpb1: keeps the current one.
    setTestSettings(true, [custom("s1", RED), custom("s2", GREEN)], "black");
    const beforeImport = JSON.stringify(settings);
    realClick(m.importButton);
    const importOpen = !m.importPanel.hidden && m.importButton.getAttribute("aria-expanded") === "true" && document.activeElement === m.codeInput;
    m.codeInput.value = "gcb1:not-a-code";
    const applyNode = m.importApply;
    realClick(applyNode);
    check(36, "Import: an invalid code is flagged (aria-invalid, 'Not a valid code') and changes nothing",
      importOpen && m.codeInput.getAttribute("aria-invalid") === "true" && m.importError.textContent === IMPORT_ERROR &&
        JSON.stringify(settings) === beforeImport, `panel ${importOpen}, error "${m.importError.textContent}"`);
    const typeCode = (value) => {
      m.codeInput.value = value;
      m.codeInput.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const cssBeforeImport = styleText();
    typeCode(`  ${FIXTURES.gcbThemeWhite}  `);
    const gcbPreview = stripShows(decodeCode(FIXTURES.gcbThemeWhite).settings) && stripText() === WHITE && statusText() === PREVIEW_CODE_MESSAGE &&
      JSON.stringify(settings) === beforeImport && styleText() === cssBeforeImport;
    typeCode(FIXTURES.gpbVoid);
    const gpbPreview = stripShows(decodeCode(FIXTURES.gpbVoid).settings) && stripText() === BLACK && JSON.stringify(settings) === beforeImport;
    typeCode("");
    const clearedReverts = stripShows(settings) && !statusText();
    check(36, "A valid code in the Import field previews in the strip, text colour included (gcb1: White; gpb1: the current Black); clearing reverts",
      gcbPreview && gpbPreview && clearedReverts, `gcb1 ${gcbPreview}, gpb1 ${gpbPreview}, cleared ${clearedReverts}`);
    typeCode(FIXTURES.gcbThemeWhite);
    realClick(applyNode);
    const gcbApplied = sameSettings(settings, decodeCode(FIXTURES.gcbThemeWhite).settings) && settings.textColour === "white" &&
      m.importPanel.hidden && undoShows("Imported code") && applyNode.isConnected;
    realClick(m.undoButton);
    const undone = JSON.stringify(settings) === beforeImport;
    check(36, "Import gcb1: applies its colours and its text colour (White), 'Imported code · Undo'; Undo restores exactly",
      gcbApplied && undone, `applied ${gcbApplied}, undone ${undone}; ${undoState()}`);
    realClick(m.importButton);
    typeCode(FIXTURES.gpbThemeAnchored);
    press(m.codeInput, "Enter");
    check(36, "Import gpb1: (GPB's code) applies its colours, keeps the current text colour (Black), 'Imported code from Gradient Progress Bar · Undo'",
      settings.gradient && settings.stops.map((x) => (x.kind === "theme" ? "t" : x.color)).join() === "t,#ff5f6d" && settings.textColour === "black" &&
        undoShows("Imported code from Gradient Progress Bar") && !("mode" in settings),
      `${JSON.stringify(settings)}; ${undoState()}`);
    stillOpen("importing a code");
    realClick(m.undoButton);

    // Export: writeClipboard()'s tiers in order with stubbed sources, then the real ones.
    const realSources = { ...clipboardSources };
    const exportWidth = () => m.exportButton.getBoundingClientRect().width;
    const idleExportWidth = exportWidth();
    const showsCopied = () => m.exportLabel.textContent === COPIED_LABEL && m.exportIcon.hasAttribute("hidden") && !m.exportCheck.hasAttribute("hidden") &&
      Math.abs(exportWidth() - idleExportWidth) <= 1;
    const showsExport = () => m.exportLabel.textContent === EXPORT_LABEL && !m.exportIcon.hasAttribute("hidden") && m.exportCheck.hasAttribute("hidden");
    let captured = null;
    const tierLog = [];
    const stubClipboard = ({ apiTier, write, exec }) => {
      tierLog.length = 0;
      captured = null;
      clipboardSources.api = () => apiTier && { copy: async (text) => {
        tierLog.push("ClipboardAPI");
        if (apiTier !== "ok") throw new Error("stub");
        captured = text;
      } };
      clipboardSources.clipboard = () => write && { writeText: async (text) => {
        tierLog.push("writeText");
        if (write !== "ok") throw new Error("stub");
        captured = text;
      } };
      clipboardSources.execCommand = (command) => {
        tierLog.push("execCommand");
        if (exec !== "ok" || command !== "copy") return false;
        captured = document.activeElement?.value ?? null;
        return true;
      };
    };
    try {
      setTestSettings(true, BUILT_IN_PRESETS[0].colours.map((c, i) => custom(`s${i + 1}`, c)), "auto");
      stubClipboard({ apiTier: "ok", write: "ok", exec: "ok" });
      const viaApi = await copyCode(m);
      check(36, "Export copies the gcb1: code through Spicetify's ClipboardAPI first (Void + Auto = the fixture); the button reads 'Copied' with the check, same width",
        viaApi === "ClipboardAPI" && tierLog.join() === "ClipboardAPI" && captured === FIXTURES.gcbVoidAuto && showsCopied() &&
          m.announce.textContent === "Share code copied" && m.codeFallback.hidden,
        `tiers ${tierLog.join(" → ")}; copied ${captured}`);
      await sleep(COPIED_MS + 200);
      const backToExport = showsExport();
      stubClipboard({ apiTier: "fail", write: "fail", exec: "ok" });
      const viaExec = await copyCode(m);
      stubClipboard({ apiTier: "fail", write: "fail", exec: "fail" });
      realClick(m.exportButton);
      await sleep(50);
      check(36, `Export: 'Export' again after ${COPIED_MS / 1000} s; execCommand when both async tiers fail; the selected code field when all three fail`,
        backToExport && viaExec === "execCommand" && tierLog.join() === "ClipboardAPI,writeText,execCommand" && !m.codeFallback.hidden &&
          m.codeOutput.value === FIXTURES.gcbVoidAuto && document.activeElement === m.codeOutput && showsExport(),
        `back ${backToExport}, exec ${viaExec}, fallback shown ${!m.codeFallback.hidden}`);
      stillOpen("Export");
    } finally {
      Object.assign(clipboardSources, realSources);
    }
    m.codeFallback.hidden = true;

    // ── Preview strip (#7) ──
    setTestSettings(true, [theme("s1"), custom("s2", GREEN), custom("s3", RED)]);
    await sleep(50);
    const pv = m.preview;
    const pr = pv.getBoundingClientRect();
    const pcs = getComputedStyle(pv);
    const labelRect = m.previewLabel.getBoundingClientRect();
    const iconRect = m.previewIcon.getBoundingClientRect();
    check(7, "Preview strip: 24 px high, 4 px radius, between the Presets row and the dots",
      Math.abs(pr.height - 24) <= 0.5 && pcs.borderTopLeftRadius === "4px" && pcs.borderBottomRightRadius === "4px" &&
        m.presets.nextElementSibling === pv && pv.nextElementSibling === m.dotsLine,
      `${pr.width.toFixed(1)}×${pr.height.toFixed(1)}, radius ${pcs.borderRadius}`);
    check(7, "Preview strip: the bar's gradient over the bar's own colour",
      pcs.backgroundImage === computedImage(barImage(settings)) && toHex(pcs.backgroundColor) === barBase(),
      `image ${pcs.backgroundImage}; colour ${toHex(pcs.backgroundColor)} (bar ${barBase()})`);
    check(7, "Preview strip: 'Playing on Device' with the icon before it at the right-hand end",
      m.previewLabel.textContent === PREVIEW_LABEL && iconRect.right <= labelRect.left && pr.right - labelRect.right <= 16 &&
        labelRect.right <= pr.right && Math.abs(centreY(iconRect) - centreY(pr)) <= 1,
      `label ${labelRect.left.toFixed(1)}–${labelRect.right.toFixed(1)}, icon ${iconRect.left.toFixed(1)}–${iconRect.right.toFixed(1)}, strip right ${pr.right.toFixed(1)}`);
    setTestSettings(false, [theme("s1")]);
    check(7, "Preview strip with a solid theme colour: no image, just the bar's own colour",
      getComputedStyle(pv).backgroundImage === "none" && toHex(getComputedStyle(pv).backgroundColor) === barBase(),
      `${getComputedStyle(pv).backgroundImage}, ${getComputedStyle(pv).backgroundColor}`);
    if (!bar) skip(7, "Preview label matches the bar's text size, weight and icon size");
    else {
      const link = bar.querySelector(BAR_LINK);
      const span = link?.querySelector("span") ?? link;
      const icon = bar.querySelector(BAR_ICON);
      const fontOf = (el) => `${getComputedStyle(el).fontSize} ${getComputedStyle(el).fontWeight}`;
      const size = (el) => `${el.getBoundingClientRect().width.toFixed(0)}×${el.getBoundingClientRect().height.toFixed(0)}`;
      check(7, "Preview label matches the bar's text size, weight and icon size",
        fontOf(span) === fontOf(m.previewLabel) && size(icon) === size(m.previewIcon),
        `bar ${fontOf(span)}, icon ${size(icon)}; preview ${fontOf(m.previewLabel)}, icon ${size(m.previewIcon)}`);
    }

    // ── Clean-up on close ──
    const listenersOpen = songchangeCount();
    const observersOpen = liveObservers;
    Spicetify.PopupModal.hide();
    await tick();
    check(5, "Closing the settings removes the songchange listener and the observers, and leaves nothing of ours",
      listenersOpen === listenersBefore + 1 && songchangeCount() === listenersBefore && observersOpen > 0 && liveObservers === 0 &&
        modal === null && !document.querySelector(".gcb-modal, .gcb-stop, .gcb-switch"),
      `songchange ${listenersBefore} → ${listenersOpen} → ${songchangeCount()}, observers ${observersOpen} → ${liveObservers}`);

    // ── Persistence (#2) ──
    // loadSettings() with console.warn captured; returns the result and the number of [gcb] warnings.
    const loadQuietly = (raw) => {
      const warnings = [];
      const warn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));
      try {
        return { loaded: loadSettings(raw), ours: warnings.filter((w) => w.startsWith("[gcb]")).length };
      } finally {
        console.warn = warn;
      }
    };
    check(2, "Storage key is our own (gcb:…), never Gradient Progress Bar's", STORAGE_KEY !== GPB_STORAGE_KEY && STORAGE_KEY.startsWith("gcb:"),
      `${STORAGE_KEY} vs GPB's ${GPB_STORAGE_KEY}`);
    check(2, "Defaults: one theme stop, gradient off, text colour Auto",
      JSON.stringify(defaultSettings()) === JSON.stringify({ version: 2, gradient: false, textColour: "auto", stops: [{ id: "s1", kind: "theme" }] }),
      JSON.stringify(defaultSettings()));
    const invalid = {
      "corrupt JSON": "{broken",
      "not an object": "42",
      "bad hex": JSON.stringify({ version: 1, gradient: false, stops: [{ id: "s1", kind: "custom", color: "red" }] }),
      "unknown kind": JSON.stringify({ version: 1, gradient: false, stops: [{ id: "s1", kind: "rainbow" }] }),
      "no stops": JSON.stringify({ version: 1, gradient: false, stops: [] }),
      "9 stops": JSON.stringify({ version: 1, gradient: true, stops: Array.from({ length: 9 }, (_, i) => theme(`s${i}`)) }),
      "duplicate ids": JSON.stringify({ version: 1, gradient: true, stops: [theme("s1"), theme("s1")] }),
      "unknown text colour": JSON.stringify({ version: 1, gradient: false, textColour: "grey", stops: [theme("s1")] }),
      "old version without a migration": JSON.stringify({ version: 0, gradient: false, stops: [theme("s1")] }),
      "a transparent stop in version 2": JSON.stringify({ version: 2, gradient: true, stops: [theme("s1"), { id: "s2", kind: "transparent" }] }),
      "an 8-digit hex in version 2": JSON.stringify({ version: 2, gradient: false, stops: [custom("s1", "#ff000080")] }),
    };
    const wrongLoads = Object.entries(invalid).map(([label, raw]) => [label, loadQuietly(raw)])
      .filter(([, { loaded, ours }]) => JSON.stringify(loaded) !== JSON.stringify(defaultSettings()) || ours !== 1);
    check(2, "Corrupt or old stored settings → defaults + exactly one [gcb] warning each", !wrongLoads.length,
      wrongLoads.map(([label, { ours }]) => `${label}: ${ours} warning(s)`).join("; ") || `${Object.keys(invalid).length} cases`);
    const newer = JSON.stringify({ version: SCHEMA_VERSION + 1, gradient: true, stops: [theme("s1")] });
    Spicetify.LocalStorage.set(STORAGE_KEY, newer);
    const fromNewer = loadQuietly(newer);
    check(2, "Settings from a newer version → defaults + one warning; the stored value is left alone",
      JSON.stringify(fromNewer.loaded) === JSON.stringify(defaultSettings()) && fromNewer.ours === 1 && Spicetify.LocalStorage.get(STORAGE_KEY) === newer,
      `${fromNewer.ours} warning(s)`);
    MIGRATIONS[0] = (data) => ({ ...data, version: 1, stops: data.colours.map((color, i) => custom(`s${i + 1}`, color)) });
    let migrated;
    try {
      migrated = loadQuietly(JSON.stringify({ version: 0, gradient: true, colours: [RED, BLUE] }));
    } finally {
      delete MIGRATIONS[0];
    }
    check(2, "Migration scaffold: a version-0 step (test only) upgrades old data without a warning",
      migrated.loaded.gradient && migrated.loaded.stops.map((s) => s.color).join() === `${RED},${BLUE}` && migrated.ours === 0,
      `${JSON.stringify(migrated.loaded)}, ${migrated.ours} warning(s)`);
    const beforeText = loadQuietly(JSON.stringify({ version: 1, gradient: true, stops: [theme("s1"), custom("s2", RED)] }));
    check(11, "Settings saved before the text colour option (no textColour) → Auto, no warning",
      beforeText.loaded.textColour === "auto" && beforeText.loaded.gradient && beforeText.loaded.stops.length === 2 && beforeText.ours === 0,
      `${JSON.stringify(beforeText.loaded)}, ${beforeText.ours} warning(s)`);
    // Version 1 → 2: transparency removed. A fully transparent stop (kind or alpha 00) goes, a half
    // transparent one keeps its RGB; nothing left → the defaults. No warning either way.
    const v1 = (stops, gradient = true) => JSON.stringify({ version: 1, gradient, textColour: "white", stops });
    const mixed = loadQuietly(v1([{ id: "s1", kind: "transparent" }, custom("s2", "#ff000080"), custom("s3", BLUE)]));
    const alphaZero = loadQuietly(v1([custom("s1", "#00ff0000"), theme("s2"), custom("s3", "#123456ff")]));
    const allClear = loadQuietly(v1([{ id: "s1", kind: "transparent" }, { id: "s2", kind: "transparent" }, custom("s3", "#ffffff00")]));
    const loaded = (r) => `${JSON.stringify(r.loaded)} (${r.ours} warning(s))`;
    check(2, "Migration 1 → 2: one transparent, one half-transparent and one opaque stop → two opaque stops (the half-transparent one keeps its RGB)",
      mixed.loaded.version === 2 && mixed.loaded.stops.map((stop) => stop.color).join() === `${RED},${BLUE}` && mixed.loaded.gradient &&
        mixed.loaded.textColour === "white" && !mixed.ours &&
        alphaZero.loaded.stops.map((stop) => `${stop.kind}${stop.color ? ` ${stop.color}` : ""}`).join() === "theme,custom #123456" && !alphaZero.ours,
      `${loaded(mixed)}; alpha 00 / opaque 8-digit: ${loaded(alphaZero)}`);
    check(2, "Migration 1 → 2: only transparent stops → the defaults",
      JSON.stringify(allClear.loaded) === JSON.stringify(defaultSettings()) && !allClear.ours, loaded(allClear));
    setTestSettings(true, [theme("s1"), custom("s2", RED), custom("s4", BLUE)], "white");
    const writtenAtOnce = Spicetify.LocalStorage.get(STORAGE_KEY) === JSON.stringify(settings);
    await sleep(SAVE_DELAY + 100);
    const reloaded = loadSettings();
    check(2, "Saves are debounced, then a load returns identical settings (round-trip, theme and custom stops, the text colour)",
      !writtenAtOnce && JSON.stringify(reloaded) === JSON.stringify(settings), `written at once ${writtenAtOnce}, ${JSON.stringify(reloaded)}`);
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────

  // Compact outline of a DOM subtree — enough to fix selectors after a Spotify update without
  // another round trip.
  function outline(el, depth = 0, maxDepth = 3) {
    if (!el || depth > maxDepth) return [];
    const testid = el.dataset?.testid ? `[data-testid="${el.dataset.testid}"]` : "";
    const encore = el.dataset?.encoreId ? `[data-encore-id="${el.dataset.encoreId}"]` : "";
    const cls = [...(el.classList ?? [])].map((c) => `.${c}`).join("");
    const line = `${"  ".repeat(depth)}${el.tagName.toLowerCase()}${testid}${encore}${cls}`;
    return [line, ...[...el.children].flatMap((c) => outline(c, depth + 1, maxDepth))];
  }

  function domProbe() {
    const all = (sel) => document.querySelectorAll(sel).length;
    const aside = document.querySelector(PARENT);
    return {
      bar: all(SELECTOR),
      unscoped: all(UNSCOPED),
      accentSets: all(".encore-bright-accent-set"),
      aside: !!aside,
      asideChildren: aside ? [...aside.children].map((c) => outline(c, 0, 0)[0]) : [],
      barOutline: [...document.querySelectorAll(".encore-bright-accent-set")].map((el) => outline(el, 0, 2).join("\n")).join("\n") || "no .encore-bright-accent-set on the page",
    };
  }

  function statusReport() {
    const report = {
      version: VERSION,
      phase: startup.phase,
      waitingFor: startup.waitingFor,
      entry: startup.entry,
      error: startup.error,
      spotify: window.Spicetify?.Platform?.version ?? null,
      spicetify: spicetifyVersion(),
      apis: Object.fromEntries(["LocalStorage", "PopupModal", "Player", "Menu", "Topbar", "ReactJSX"].map((n) => [n, !!api(n)])),
      entryErrors: startup.entryErrors,
      menu: { registered: menuRegistered, menuItemUsable: menuItemUsable() },
      topbar: { created: !!shared?.button, connected: !!shared?.button?.element?.isConnected },
      shared: shared?.status() ?? null,
      // While start-up waits for Spicetify, the text colour's state isn't initialised yet.
      textColour: startup.phase === "waiting for Spicetify" ? null : textStatus(),
      page: location.href,
      dom: domProbe(),
    };
    console.log(`[gcb] ${report.phase}${report.entry ? `, entry: ${report.entry}` : ""}`);
    return report;
  }

  // The text colour in status() (#17), for debugging: mode, the chosen colour, its worst-case
  // contrast, the text region as fractions of the bar's width, and whether the bar is there.
  function textStatus() {
    const r = textResult;
    const round = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : null);
    const mode = settings?.textColour ?? null;
    return {
      mode,
      colour: r?.colour ?? null,
      contrast: round(r?.contrast),
      black: round(r?.black),
      white: round(r?.white),
      region: r?.region ? { from: round(r.region.from), to: round(r.region.to), measured: r.measured } : null,
      barPresent: !!document.querySelector(SELECTOR),
    };
  }

  // ── Start-up ────────────────────────────────────────────────────────────────

  const ENTRY_LABEL = "Gradient Connect Bar";
  // GPB's entry icon, byte for byte (#34): a brush over a progress bar. Monochrome (currentColor
  // follows the theme and hover), 16 × 16, no <defs> and no ids. The shared top-bar button looks
  // the same whichever extension owns it, and both profile-menu entries use it too.
  const ENTRY_ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M14.6 1.4a1.3 1.3 0 0 0-1.85 0L7.6 6.55l1.85 1.85 5.15-5.15a1.3 1.3 0 0 0 0-1.85zM6.7 7.5c-1.3 0-2.2 1-2.2 2.3 0 .5-.3.9-.9 1.1 1.5.9 4.3.7 4.9-1.3.1-.4.1-.7 0-1z"/><rect x="0.5" y="12.5" width="15" height="2.5" rx="1.25" opacity=".35"/><rect x="0.5" y="12.5" width="9" height="2.5" rx="1.25"/></svg>';

  // The settings, from anywhere: the top bar, the profile menu, __gcb.openSettings().
  function openSettings() {
    return modal || openModal();
  }

  // ── Shared entry (protocol 1) — keep identical in GCB and GPB ──
  // Gradient Connect Bar and Gradient Progress Bar share one top-bar button. Whichever starts
  // first creates window.__gradientBars (it's the owner) and the only button; the other registers
  // its entry. One entry: the button opens it directly. Two: a small menu with both. Each
  // extension keeps its own right-click and profile-menu entries; the only call across is
  // entries[i].open. This block depends on nothing but SELF, ENTRY_ICON and window.Spicetify.
  // joinGradientBars() takes overrides for a separate test instance (key, prefix, createButton);
  // the live registry uses the defaults.
  const SELF = { id: "gcb", name: "Gradient Connect Bar", open: openSettings };

  function joinGradientBars({ self = SELF, key = "__gradientBars", prefix = "gradient-bars", createButton = null } = {}) {
    const PROTOCOL = 1;
    const MULTI_LABEL = "Gradient bars";
    const GAP = 8; // menu below the button, and its distance from the window edges
    const makeButton = createButton ?? ((label, icon, onClick) => new window.Spicetify.Topbar.Button(label, icon, onClick));
    let button = null;
    let hideMenu = () => {};
    const errors = [];

    // The registry: created by the first extension, a synchronous check-and-set, so two that
    // start close together can't both become owner. Its shape is frozen for protocol 1.
    function ownerRegistry() {
      let menu = null;
      let anchor = null;
      let detach = null; // removes the open menu's listeners
      const items = () => [...menu.querySelectorAll(`.${prefix}-item`)];
      const reg = {
        protocol: PROTOCOL,
        owner: self.id,
        entries: [],
        // Adds, or replaces by id; sorted by name.
        register(entry) {
          const i = reg.entries.findIndex((e) => e.id === entry.id);
          if (i === -1) reg.entries.push(entry);
          else reg.entries[i] = entry;
          reg.entries.sort((a, b) => a.name.localeCompare(b.name));
          reg.refresh();
        },
        refresh() {
          if (button) button.label = reg.entries.length === 1 ? reg.entries[0].name : MULTI_LABEL;
        },
        // One entry: open it. Two or more: toggle the menu. Entries are read at click time.
        click(at) {
          if (reg.entries.length === 1) return reg.entries[0].open();
          if (menu && !menu.hidden) return hide();
          // Keyboard activation clicks with detail 0 (or isn't a click at all).
          const e = window.event;
          show(at, e ? e.type !== "click" || e.detail === 0 : !!at?.matches?.(":focus-visible"));
        },
      };

      // One element, appended once, hidden and shown, never removed while the page lives.
      function build() {
        menu = document.getElementById(`${prefix}-menu`);
        if (menu) return;
        menu = document.createElement("div");
        menu.id = `${prefix}-menu`;
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", MULTI_LABEL);
        menu.hidden = true;
        menu.innerHTML = `<style>
#${prefix}-menu { position: fixed; z-index: 9999; display: flex; flex-direction: column; box-sizing: border-box; min-width: 180px; padding: 4px; border-radius: 8px; background-color: var(--spice-card, var(--spice-main)); color: var(--spice-text); box-shadow: 0 8px 24px rgba(0, 0, 0, .5); }
#${prefix}-menu[hidden] { display: none; }
.${prefix}-item { padding: 8px 12px; border: 0; border-radius: 4px; background: none; color: inherit; font: inherit; font-size: .875rem; text-align: left; white-space: nowrap; cursor: pointer; }
.${prefix}-item:hover, .${prefix}-item:focus-visible { outline: none; background-color: color-mix(in srgb, var(--spice-button) 20%, transparent); }
</style>`;
        menu.addEventListener("keydown", (e) => {
          const list = items();
          const i = list.indexOf(document.activeElement);
          const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
          if (next !== undefined) {
            e.preventDefault();
            list[(next + list.length) % list.length]?.focus();
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (i !== -1) activate(i);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            hide({ refocus: true });
          } else if (e.key === "Tab") hide();
        });
        menu.addEventListener("click", (e) => {
          const item = e.target.closest(`.${prefix}-item`);
          if (item) activate(items().indexOf(item));
        });
        document.body.append(menu);
      }

      // The items are rebuilt on opening only, never during a click on one of them.
      function show(at, keyboard) {
        build();
        for (const item of items()) item.remove();
        for (const entry of reg.entries) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = `${prefix}-item`;
          item.setAttribute("role", "menuitem");
          item.dataset.entry = entry.id;
          item.textContent = entry.name;
          menu.append(item);
        }
        anchor = at ?? null;
        menu.hidden = false;
        place();
        const outside = (e) => !menu.contains(e.target) && !anchor?.contains(e.target) && hide();
        const close = () => hide();
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("scroll", close, true);
        window.addEventListener("blur", close);
        window.addEventListener("resize", close);
        detach = () => {
          document.removeEventListener("pointerdown", outside, true);
          document.removeEventListener("scroll", close, true);
          window.removeEventListener("blur", close);
          window.removeEventListener("resize", close);
        };
        if (keyboard) items()[0]?.focus({ preventScroll: true });
      }

      // 8 px below the button, right edges aligned, clamped into the window.
      function place() {
        const r = anchor?.getBoundingClientRect() ?? { right: innerWidth - GAP, bottom: GAP };
        const { width, height } = menu.getBoundingClientRect();
        const left = Math.min(Math.max(r.right - width, GAP), Math.max(GAP, innerWidth - GAP - width));
        const top = Math.min(Math.max(r.bottom + GAP, GAP), Math.max(GAP, innerHeight - GAP - height));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
      }

      function hide({ refocus = false } = {}) {
        if (!menu || menu.hidden) return;
        menu.hidden = true;
        detach?.();
        detach = null;
        if (refocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
      }
      hideMenu = hide;

      // Hidden first, then opened in the next task: the clicked item stays connected.
      function activate(i) {
        const entry = reg.entries[i];
        hide();
        if (entry) setTimeout(() => entry.open(), 0);
      }

      return reg;
    }

    const found = window[key];
    let registry = null;
    let role;
    if (found?.protocol === PROTOCOL) {
      registry = found;
      role = "member";
    } else if (found) role = `own button (protocol ${found.protocol})`;
    else {
      registry = window[key] = ownerRegistry();
      role = "owner";
    }
    registry?.register(self);

    // The owner (or, next to another protocol, each extension) creates one button at most. It
    // stays registered while it isn't on screen yet: Spicetify mounts it once it finds its top bar.
    function ensureButton() {
      if (button || role === "member") return button;
      if (!createButton && !window.Spicetify?.Topbar?.Button) return null;
      try {
        if (registry) {
          button = makeButton(self.name, ENTRY_ICON, () => registry.click(button?.element));
          registry.refresh();
        } else button = makeButton(self.name, ENTRY_ICON, () => self.open());
      } catch (e) {
        errors.push(`Topbar: ${e?.message || e}`);
      }
      return button;
    }

    return {
      role,
      registry,
      errors,
      ensureButton,
      get button() {
        return button;
      },
      status: () => ({
        protocol: registry?.protocol ?? found?.protocol ?? PROTOCOL,
        role,
        owner: registry?.owner ?? null,
        entries: registry ? registry.entries.map((e) => e.id) : [self.id],
      }),
      // Test instances only: the live menu and registry stay for the page's lifetime.
      dispose() {
        hideMenu();
        document.getElementById(`${prefix}-menu`)?.remove();
        button?.element?.remove();
        if (role === "owner" && window[key] === registry) delete window[key];
      },
    };
  }
  // ── End shared entry ──

  // The states reported by the separate spicetify-fixes extension (window.__fixes), if it runs: its
  // workarounds for the top bar and MenuItem make ours work too. Read only, never relied on (GPB #55).
  function otherFixes() {
    const fixes = window.__fixes?.fixes;
    return Array.isArray(fixes) ? Object.fromEntries(fixes.map((fix) => [fix?.id, fix?.state])) : null;
  }

  // Spicetify renders its profile-menu items inside Spotify's legacy menu. On Spotify 1.3.4,
  // Spicetify.ReactComponent.MenuItem resolves to Spotify's V2-only item, which throws "cannot be
  // rendered outside a collection" there, so with any Spicetify item registered the profile menu
  // doesn't open at all (spicetify/cli#4012). The V2-only item's source has "forceV2LeadingIcon"
  // but not "aria-describedby"; Spotify's layout-switching item, the right one, has both.
  // Unknown shapes count as usable. Cached per component, since shouldAdd runs on every render.
  // Ported unchanged from GPB (GPB #27).
  function menuItemUsable() {
    const component = api("ReactComponent")?.MenuItem;
    if (!component || !["function", "object"].includes(typeof component)) return true;
    if (!menuItemVerdicts.has(component)) {
      const fn = typeof component === "function" ? component : component.render ?? component.type?.render ?? component.type;
      let source = "";
      try {
        source = Function.prototype.toString.call(fn);
      } catch {}
      menuItemVerdicts.set(component, !(source.includes("forceV2LeadingIcon") && !source.includes("aria-describedby")));
    }
    return menuItemVerdicts.get(component);
  }

  // Both Spicetify entries, independently and at the same time, not one as the other's fallback
  // (GPB #45): the profile menu (#35) and the shared top-bar button (#34). Resolves to a
  // description of what's registered, or null.
  async function registerSpicetifyEntries() {
    const entries = await Promise.all([registerMenuEntry(), registerTopbarEntry()]);
    return entries.filter(Boolean).join(" + ") || null;
  }

  // Our own profile-menu entry (#35). Menu.Item's constructor calls Spicetify.ReactJSX.jsx() right
  // away, and spicetify-bindings set ReactJSX only after CLI extensions have started (GPB #27), so
  // only this entry waits. Never a MenuItem swap or any other global Spicetify fix: that's
  // spicetify-fixes' job.
  async function registerMenuEntry() {
    if (!api("Menu")?.Item) return null;
    for (let waited = 0; !window.Spicetify?.ReactJSX?.jsx && waited < 15000; waited += 250) await sleep(250);
    if (!window.Spicetify?.ReactJSX?.jsx) {
      startup.entryErrors.push("Menu: Spicetify.ReactJSX not ready after 15 s");
      return null;
    }
    try {
      const item = new Spicetify.Menu.Item(ENTRY_LABEL, false, openSettings, ENTRY_ICON);
      // On an affected build our entry must never be what breaks the profile menu. shouldAdd runs
      // on every render, so the entry appears by itself once MenuItem is fixed.
      const base = item.shouldAdd;
      item.shouldAdd = (...a) => menuItemUsable() && base(...a);
      item.register();
      window.__gcb.menuItem = item;
      menuRegistered = true;
      return menuItemUsable() ? "profile menu" : "profile menu (hidden while Spicetify's MenuItem is broken)";
    } catch (e) {
      startup.entryErrors.push(`Menu: ${e?.message || e}`);
      return null;
    }
  }

  // The shared top-bar button (#34): a member creates none; the owner (or an extension next to
  // another protocol) creates one once Spicetify.Topbar exists (waiting up to 15 s for it), and
  // counts it once it's on screen.
  async function registerTopbarEntry() {
    if (shared.role === "member") return `shared top-bar button (owner: ${shared.registry.owner})`;
    for (let waited = 0; !api("Topbar")?.Button && waited < 15000; waited += 250) await sleep(250);
    if (!api("Topbar")?.Button) return null;
    if (!shared.ensureButton()) {
      startup.entryErrors.push(...shared.errors);
      return null;
    }
    window.__gcb.topbarButton = shared.button;
    for (let waited = 0; waited < 4000; waited += 250) {
      if (shared.button.element?.isConnected) return shared.role === "owner" ? "top bar button (shared)" : "top bar button";
      await sleep(250);
    }
    startup.entryErrors.push("Topbar: button created, not on screen yet (Spicetify hasn't found its top bar)");
    return null;
  }

  // The settings open by right-clicking the Connect bar: one delegated capture-phase listener on
  // document, so it survives Spotify removing and re-creating the bar. The bar only exists during
  // remote playback, so the shared top-bar button (#34), the profile menu (#35) and
  // __gcb.openSettings() open them too.
  function enableBarContextMenu() {
    document.addEventListener(
      "contextmenu",
      (e) => {
        if (!e.target.closest?.(SELECTOR)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!modal) openModal();
      },
      true
    );
    return "right-click on the Connect bar";
  }

  let settings;
  try {
    settings = loadSettings();
    presets = loadPresets(); // #29
    window.addEventListener("beforeunload", flushSettings);
    recalcTextColour(); // applies the stylesheet, text colour included, so there's no flash of the old one
    watchTextTriggers();
    window.__gcb = { version: VERSION, status: () => statusReport(), selfTest, openSettings };
    startup.entry = enableBarContextMenu();
    shared = joinGradientBars(); // synchronous: the registry is claimed before anything awaits
    startup.phase = "registering entry point";
    const extra = await registerSpicetifyEntries();
    if (extra) startup.entry += ` + ${extra}`;
    startup.phase = "ready";
    console.log(`[gcb] v${VERSION} ready — open the settings with a ${startup.entry}, or __gcb.openSettings().`);
    if (startup.entryErrors.length) console.warn("[gcb] Spicetify entry points unavailable:", startup.entryErrors.join("; "));
  } catch (e) {
    startup.phase = "failed";
    startup.error = e?.stack || String(e);
    console.error("[gcb] Start-up failed:", e);
  }
})();
