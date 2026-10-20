# Gradient Connect Bar

A [Spicetify](https://spicetify.app) extension that recolours Spotify's **Connect bar** — the "Playing on …" strip below the player while audio plays on another device — with one colour, or several blended into a gradient.

> **Status:** released — **v1.0.0**. See the [changelog](CHANGELOG.md) and the [roadmap](ROADMAP.md).

<p align="center"><img src="preview.png" alt="Gradient Connect Bar: a gradient Connect bar and the settings window with the preview strip" width="580"></p>

## Features

Your Connect bar, your colours. When Spotify plays on another device, the "Playing on …" bar under the player gets one colour or a gradient of up to eight, and it changes as you go.

- **Paint it your way.** Click a colour dot, then drag in the picker, type a hex code, or take any colour from the screen with the eyedropper. Press **+** for another colour and the bar becomes a gradient across its full width. Drag the dots to reorder them.
- **Text that stays readable.** *Auto* picks black or white for the "Playing on …" text, whichever reads better over the colours behind it. Or choose *Black*, *White*, or *Spotify default*.
- **Match your theme.** *Use theme colour* makes a colour follow your theme's accent, even one that changes with every album cover, like Hazy's album-art mode.
- **Presets to start from.** There are five built-in gradients (Void, Sunset, Aurora, Neon, Fairy) and room for 12 of your own. Click a preset once to preview it and again to apply it. *Undo* is there if you change your mind.
- **Share your look.** **Export** copies your settings as a short code (`gcb1:…`), and whoever you send it to pastes it into **Import**. Codes from [Gradient Progress Bar](https://github.com/VoidCrowned/spicetify-gradient-progress-bar) (`gpb1:…`) work too.
- **See it before you need it.** The bar only shows while audio plays on another device, so the settings window has a preview strip that looks just like it.
- **Plays nicely with others.** Only the Connect bar changes. It runs alongside Gradient Progress Bar, each with its own settings. With default settings the bar keeps its own colour, and *Reset* takes you back there in two clicks.

## Installation

**Spicetify Marketplace:** search for **Gradient Connect Bar** and click *Install*.

**Manual:**

1. Download `gradientConnectBar.js` from the [latest release](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/releases/latest).
2. Copy it into the `Extensions` folder inside your Spicetify config folder (`spicetify config-dir` shows where), then enable it:
   ```sh
   spicetify config extensions gradientConnectBar.js
   spicetify apply
   ```

To uninstall: `spicetify config extensions gradientConnectBar.js-` then `spicetify apply`.

## Usage

**Right-click the Connect bar** to open the settings. It's only there while audio plays on another device, so you can also use the brush icon in the top bar or the profile menu, where Spicetify shows them ([Troubleshooting](#troubleshooting)). If you also use Gradient Progress Bar, the two share one top-bar button.

The window explains the rest, with a short help text at the bottom and tooltips on the controls.

**Keyboard:**
- Alt + ←/→ moves a colour.
- Delete removes it.
- Enter jumps to the hex field.
- Shift + F10 opens a colour's menu.

## Compatibility

Designed to sit on top of any theme without fighting it: it uses no `!important`, never changes the bar's size, shape or theme variables, and only targets the Connect bar.

| | Notes |
|---|---|
| [Hazy](https://github.com/Astromations/Hazy) | The theme colour follows Hazy's accent, whether that's the album-art colour or your *Custom color*. |
| [Gradient Progress Bar](https://github.com/VoidCrowned/spicetify-gradient-progress-bar) | Runs alongside: separate settings, separate stylesheet, no overlap. Shares one top-bar button (from its next version), the five built-in presets, and share codes in both directions. |

## Troubleshooting

> **Spicetify 2.45.3 on Spotify 1.3.4 or later:** two Spicetify bugs hide the top-bar button ([GPB #38](https://github.com/VoidCrowned/spicetify-gradient-progress-bar/issues/38)) and the profile-menu entry ([spicetify/cli#4012](https://github.com/spicetify/cli/issues/4012)). Until Spicetify releases the fixes, my [spicetify-fixes](https://github.com/VoidCrowned/spicetify-fixes) works around both (read its README first). Either way, the settings open with a right-click on the Connect bar while audio plays on another device, or with `__gcb.openSettings()` in DevTools.

- **There's no Connect bar to right-click:** Spotify only shows it while audio plays on another device (your phone, a speaker, the web player). Start playback there, or use the top-bar button or the profile menu.
- **Two brush buttons in the top bar:** Gradient Progress Bar 1.6.1 or earlier still adds its own. From 1.7.0 the two extensions share one button, which opens a small menu with both; update Gradient Progress Bar.
- **After a Spotify update the bar is back to normal:** updates remove Spicetify's patch. Run `spicetify apply`, or `spicetify backup apply` if Spicetify asks for it.
- **The bar keeps the theme colour although you set colours:** with the gradient off, only the first colour counts. If that one follows the theme, the extension deliberately leaves the bar's colour alone (the text colour still applies). Click it and pick a colour, or switch the gradient on.
- **Something looks wrong with your theme or another extension:** [open an issue](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/new/choose) and follow [CONTRIBUTING.md → Reporting a bug](CONTRIBUTING.md#reporting-a-bug).

## Roadmap

See [ROADMAP.md](ROADMAP.md) and the [changelog](CHANGELOG.md).

## Contributing

Bug reports and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and [TESTING.md](TESTING.md).

## Credits

- [Spicetify](https://spicetify.app)
- [Hazy](https://github.com/Astromations/Hazy) by Astromations — the theme this was built and tested against.
- Built on the code of [Gradient Progress Bar](https://github.com/VoidCrowned/spicetify-gradient-progress-bar).

## Licence

Copyright © 2026 VoidCrowned. This program is free software. It comes without any warranty, to the extent permitted by applicable law. You can redistribute it and/or modify it under the terms of the Do What The Fuck You Want To Public License, Version 2, as published by Sam Hocevar. See [LICENSE](LICENSE) or http://www.wtfpl.net/ for more details.
