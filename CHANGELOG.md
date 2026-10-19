# Changelog

All notable changes to Gradient Connect Bar. Versions follow [semantic versioning](https://semver.org).

## [1.0.0] — 2026-10-19

The first release.

### Added
- **Recolour the Connect bar**, the "Playing on …" strip below the player while audio plays on another device: one colour, or up to 8 blended into a gradient across the whole bar ([#3](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/3)).
- **Theme colour**: a colour that follows your theme's accent, also when it changes per song, as with Hazy's album-art mode ([#4](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/4)).
- **Text colour** ([#11](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/11)): *Auto* picks black or white, whichever reads better at the worst spot behind the "Playing on …" text; or *Black*, *White*, or *Spotify default* to leave it alone.
- **Settings window** with a colour picker (square, hue bar, eyedropper, R/G/B and hex with a copy button), drag-and-drop and keyboard reordering, and a **preview strip** that shows the bar as it will look, since the bar itself only appears during remote playback ([#5](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/5), [#7](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/7)).
- **Presets**: five built-ins (Void, Sunset, Aurora, Neon, Fairy), the same as Gradient Progress Bar's, which keep your text colour, and up to 12 of your own; preview first, apply on the second click, Undo for 10 seconds ([#29](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/29)).
- **Share codes**: *Export* copies a `gcb1:` code, *Import* takes it back, and takes Gradient Progress Bar's `gpb1:` codes too ([#36](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/36)).
- **Opening the settings**: right-click the Connect bar, the profile menu, or the top-bar brush button. With Gradient Progress Bar 1.7.0 or later installed too, the two share one top-bar button with a small menu of both ([#34](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/34), [#35](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/35)).
- **Self-test**: `await __gcb.selfTest()` in DevTools checks the extension against the live bar and copies a report for bug reports ([#9](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/9)).

Verified on Spotify 1.3.5.3058 with Spicetify 2.45.3 and the Hazy theme, alongside Gradient Progress Bar.
