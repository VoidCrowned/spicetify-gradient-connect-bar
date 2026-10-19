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
- **Gradient builder**: 1 stop (solid), 2 stops, 8 stops, theme stops, gradient off; a solid theme colour leaves the bar alone.
- **Opaque only**: the generated CSS contains no `rgba(`, `transparent` or 8-digit hex, for every sample and every text colour mode; there's no *Make transparent* or other opacity control.
- **The live bar**: computed `background-image` equals the generated gradient; `background-color`, size and radius unchanged; no inline style added; a runtime `--spice-button` change reaches the bar without JS.
- **Right-click**: on the bar it opens the settings and suppresses Spotify's menu; on the page or the now-playing aside it doesn't.
- **Gradient Progress Bar alongside** (when `__gpb` exists): both stylesheets present, neither rule matches the other's target.
- **Settings window**: prefixes, none of Hazy's global hooks, layout and spacing, the −|+ stepper, the dot menu, the colour picker (square, hue, R/G/B, hex, copy), the theme button, drag and keyboard reordering, Delete, two-step Reset, clean-up on close.
- **Preview strip**: 24 px, 4 px radius, the bar's gradient over the bar's colour, the label and icon at the right-hand end, never matching the bar's selector; with the bar present, the same text size, weight and icon size as the bar.
- **Text colour, contrast unit tests**: known WCAG pairs; `#8372fd` → black (≈ 5.8:1); a dark-left / light-right gradient with the text at the right → black, the reverse → white; a light gradient with a dark stop inside the text region → white (where an average would say black); the sample set (edges, stops inside, 8 between; at a stop its own colour, plain sRGB interpolation between); theme stops resolved from `:root` at calculation time; with both contrasts low the better one is still picked, without a warning.
- **Text colour on the live bar**: the text region is measured from the icon to the text's end, at the right-hand end; Auto, Black and White set the text span's and the icon's computed colours; Spotify default leaves them as Spotify draws them. Without the bar: the last region is kept, and the whole width counts before it has been seen.
- **Recalculation**: debounced on settings changes and resize; on song and `:root` colour changes only while a theme-colour stop is used; the now-playing aside is watched.
- **Text colour row**: a radiogroup of Auto, Black, White, Spotify default; no hint or warning under it in any mode (even where neither colour reads well), nothing logged, and the modal's normal gap down to the preview; clicks and keys apply live, in place, and are saved; the checked button's label stays readable on a dark and a light theme colour.
- **`status()`**: mode, chosen colour, worst-case contrast, text-region fractions, bar present, as plain values; no warning.
- **Entry points**: the profile-menu entry registers without throwing; the entry icon is GPB's; `status()` has `topbar`, `shared`, `entryErrors`, `menu` and `apis.ReactJSX`; our top-bar button exists (owner) or the owner's shared one has our entry (member); the live registry has protocol 1, our entry once, sorted by name; with a Gradient Progress Bar that shares the button, exactly one of the two has created it (skipped while GPB is 1.6.1 or older).
- **Shared button protocol, on a separate test instance** (its own key and prefix, fake buttons, removed afterwards; the live registry is never touched): one entry opens directly; two entries give one *Gradient bars* button and a menu with both in name order, 8 px below the button with right edges aligned; keyboard (first item focused, ↑/↓ wrap, Home/End, Escape refocuses the button, Tab) and closing (outside pointerdown, blur, resize, a second click); activation hides first and opens in the next task; another protocol gives the own-button path.
- **Presets**: the `gcb:presets` round-trip, invalid entries, the 12 limit, unique names, the built-ins (GPB's five, can't be changed, keep the text colour); the two-step preview and apply in the strip, text colour included; Escape, clicking elsewhere, moving the arm; the active chip; Undo; + Save, Rename, Update and Delete with Undo; own presets save and restore the text colour.
- **Share codes**: the five fixtures from #36 (shared with GPB's self-test); Export of Void with Auto equals its fixture; round-trips for every text colour; invalid codes, including `gpb1:` codes GPB itself wouldn't accept; Import previews (text colour included), applies with Undo, *Imported code from Gradient Progress Bar* for `gpb1:`, which keeps the current text colour; Export's clipboard tiers and fallback field.
- **Settings**: own storage key, defaults, corrupt and old data → defaults + one warning, settings from before the text colour option → Auto, newer data left alone, the migration scaffold, the 1 → 2 migration (a transparent, a half-transparent and an opaque stop → two opaque stops; only transparent stops → the defaults), debounced save and round-trip.

## Visual checklist

At most 8 items, only what code can't check. Play on another device first.

1. The top-bar button opens GCB's settings directly. With Gradient Progress Bar 1.6.1 there are two buttons (GPB's own and the shared one); with a GPB that shares it, one button with a menu of both.
2. The *Gradient Connect Bar* entry appears in the profile menu and opens the settings.
3. Presets row: the chips look right, preview then apply works, the built-ins keep the text colour.
4. Export shows *Copied*; pasting the code into Import previews it.
5. A code exported from Gradient Progress Bar imports and keeps the current text colour.
6. Auto picks a readable colour on a dark-to-light gradient, with no hint text under the switcher.
7. The preview strip matches the real bar, and the bar disappears and comes back cleanly when switching devices.
8. Gradient Progress Bar is still fine alongside.
