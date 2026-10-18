# Testing

Run both layers **before every release** and **after every Spotify update**. Spotify updates can change the DOM the extension depends on, and they remove Spicetify's patch until you run `spicetify apply` again.

1. **Self-test** ([#9](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/9)): everything that can be checked by code.
2. **Visual checklist**: only what a human has to see.

The Connect bar only exists **while audio plays on another device** (a phone, a speaker, the web player). Start playback there first; otherwise the checks that need the bar are skipped.

## Opening the devtools console

1. Enable devtools once: `spicetify enable-devtools`.
2. Open the devtools of Spotify's **main window** (not a helper or service-worker target).
3. If the console says `__gcb is not defined`, run `typeof Spicetify`:
   - `"undefined"`: the console is attached to the wrong target. Pick the main window.
   - `"object"`: run `__gcb.status()`. It shows whether start-up is still waiting, has failed (with the error), or is ready, plus a DOM probe of the Connect bar.

## Self-test

```js
await __gcb.selfTest()
```

It applies test settings through the extension's own code, checks computed styles on the live bar and drives the settings window with real pointer, mouse and keyboard events. Afterwards it **restores your settings**, prints a pass/fail table and **copies a JSON report to the clipboard**. Checks that need the bar say `skipped: "bar not present — play on another device"`.

It covers:
- Exactly one copy of the extension is loaded.
- **Selector**: the scoped selector and the same selector without the `[data-testid="now-playing-bar"] >` prefix are both counted. Unprefixed but not scoped → "parent changed"; more than one match fails.
- **Injected CSS**: parses (every rule and declaration survives the browser's parser), no `!important`, no hash-like class names (16–20 characters, mixed case), only `background-image` on `SELECTOR`, never `--background-base`. The lint is itself tested against bad samples.
- **Gradient builder**: 1 stop (solid), 2 stops, 8 stops, theme stops, transparent stops, gradient off; a solid theme or transparent stop leaves the bar alone.
- **The live bar**: computed `background-image` equals the generated gradient; `background-color`, size and radius unchanged; no inline style added; a runtime `--spice-button` change reaches the bar without JS.
- **Right-click**: on the bar it opens the settings and suppresses Spotify's menu; on the page or the now-playing aside it doesn't.
- **Gradient Progress Bar alongside** (when `__gpb` exists): both stylesheets present, neither rule matches the other's target.
- **Settings window**: prefixes, none of Hazy's global hooks, layout and spacing, the −|+ stepper, the dot menu, the colour picker (square, hue, R/G/B, hex, copy), theme and transparent buttons, drag and keyboard reordering, Delete, two-step Reset, clean-up on close.
- **Preview strip**: 24 px, 4 px radius, the bar's gradient over the bar's colour, the label and icon at the right-hand end, never matching the bar's selector; with the bar present, the same text size, weight and icon size as the bar.
- **Settings**: own storage key, defaults, corrupt and old data → defaults + one warning, newer data left alone, the migration scaffold, debounced save and round-trip.

## Visual checklist

At most 8 items, only what code can't check. Play on another device first.

1. The gradient looks right on the 24 px bar.
2. The corners are rounded.
3. The text is readable.
4. Right-click on the bar opens the settings.
5. The preview strip in the settings matches the bar.
6. The bar disappears and comes back cleanly when switching devices.
7. Gradient Progress Bar still looks and works as before alongside.
8. With a transparent colour, Hazy's colour shows through.
