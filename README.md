# Gradient Connect Bar

A [Spicetify](https://spicetify.app) extension that recolours Spotify's **Connect bar** — the "Playing on …" strip below the player while audio plays on another device — with one colour, or several blended into a gradient.

> **Status:** in development, not released yet. See the [roadmap](ROADMAP.md).

![Gradient Connect Bar: a gradient Connect bar](preview.png)

## Features

- **Solid colour or gradient**: start with one colour, add more and the bar becomes a gradient. The gradient spans the whole bar.
- **Up to 8 colours**, edited in a built-in colour picker with R/G/B and hex input, and reordered by drag-and-drop.
- **Theme colour**: a colour that follows your theme's accent instead of a fixed value. With themes that change their accent per song (like Hazy's album-art mode), the bar follows along.
- **Transparent**: a colour that lets the bar's own colour show through, for fading into your theme.
- **Readable text**: *Auto* picks black or white text, whichever stays readable over every colour behind it, and warns you if neither does. Or choose *Black*, *White*, or *Spotify default* to leave the text alone.
- **Preview strip**: the bar only exists while you play on another device, so the settings show what it will look like.
- **Leaves everything else alone**: only the Connect bar changes. It runs side by side with [Gradient Progress Bar](https://github.com/VoidCrowned/spicetify-gradient-progress-bar), each with its own settings.

## Installation

**Manual** (until the first release is on the Marketplace):

1. Download `gradientConnectBar.js` from this repository.
2. Copy it into the `Extensions` folder inside your Spicetify config folder (`spicetify config-dir` shows where), then enable it:
   ```sh
   spicetify config extensions gradientConnectBar.js
   spicetify apply
   ```

To uninstall: `spicetify config extensions gradientConnectBar.js-` then `spicetify apply`.

## Usage

**Right-click the Connect bar** to open the settings. The bar is only there while audio plays on another device. To open the settings without it, run `__gcb.openSettings()` in the devtools console ([how to open it](TESTING.md#opening-the-devtools-console)).

- **Text colour** (below the Gradient switch): **Auto** (the default) looks at the colours behind the "Playing on …" text and picks black or white, whichever has the better contrast at the *worst* spot, so a dark patch behind light text can't hide. The line below the buttons shows the contrast it reaches; if neither black nor white reaches 4.5:1 (the usual minimum for readable text), it says so in red, and lighter or darker colours behind the text will help. **Black** and **White** force that colour; **Spotify default** leaves the text as Spotify and your theme colour it.
- **Click a colour dot** to select it (it gets a ring) and edit it in the colour picker below the dots: drag in the square and the hue bar, use the eyedropper (where available), or type R/G/B values or a **hex code** (`#8372fd`, `8372fd` or `#87f`). The **copy icon** inside the hex field copies the colour as `#rrggbb`.
- **Use theme colour** makes the selected colour follow your theme's accent; **Make transparent** lets the bar's own colour show through at that point. A transparent colour's dot shows a checkerboard.
- **Right-click a dot** for **Duplicate** and **Remove** (also with the context-menu key or Shift+F10).
- **Gradient** switches the gradient on and off. With only one colour, switching it on adds a second colour (a copy of the first) for you to change.
- **− | +** (the pill after the dots): **+** adds a copy of the last colour; **−** removes the selected one. Up to 8 colours; at least one always stays.
- **Delete** or **Backspace** on a colour dot you've tabbed to removes that colour.
- **Drag the dots** to reorder the gradient. With the keyboard, Alt + arrow keys move the focused colour (Alt + Home / End to the first or last place).
- **Reset** goes back to the default: a single colour that follows your theme, which leaves the bar its own colour, and *Auto* text. It asks for a second click to confirm.

With a single colour that follows your theme (or is transparent), the bar keeps its own colour.

## Compatibility

Designed to sit on top of any theme without fighting it: it uses no `!important`, never changes the bar's size, shape or theme variables, and only targets the Connect bar.

| | Notes |
|---|---|
| [Hazy](https://github.com/Astromations/Hazy) | The theme colour follows Hazy's accent, whether that's the album-art colour or your *Custom color*. Transparent colours show Hazy's bar colour. |
| [Gradient Progress Bar](https://github.com/VoidCrowned/spicetify-gradient-progress-bar) | Runs alongside: separate settings, separate stylesheet, no overlap. |

## Troubleshooting

- **There's no Connect bar to right-click:** it only appears while audio plays on another device (your phone, a speaker, the web player). Start playback there, or open the settings with `__gcb.openSettings()` in the devtools console.
- **After a Spotify update the bar is back to normal:** updates remove Spicetify's patch. Run `spicetify apply`, or `spicetify backup apply` if Spicetify asks for it.
- **Something looks wrong with your theme or another extension:** [open an issue](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/new/choose) and follow [CONTRIBUTING.md → Reporting a bug](CONTRIBUTING.md#reporting-a-bug).

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## Contributing

Bug reports and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and [TESTING.md](TESTING.md).

## Credits

- [Spicetify](https://spicetify.app)
- [Hazy](https://github.com/Astromations/Hazy) by Astromations — the theme this was built and tested against.
- Built on the code of [Gradient Progress Bar](https://github.com/VoidCrowned/spicetify-gradient-progress-bar).

## Licence

Copyright © 2026 VoidCrowned. This program is free software. It comes without any warranty, to the extent permitted by applicable law. You can redistribute it and/or modify it under the terms of the Do What The Fuck You Want To Public License, Version 2, as published by Sam Hocevar. See [LICENSE](LICENSE) or http://www.wtfpl.net/ for more details.
