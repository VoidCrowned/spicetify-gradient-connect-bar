# Roadmap

Mirrors the [GitHub milestones](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/milestones). Issues are the source of truth; this file and each milestone's tracking issue are kept in sync when they change.

## Milestone 1 — Port & retarget — done 2026-10-19

Gradient Progress Bar's code, pointed at the Connect bar. Tracking: [#30](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/30).

| # | Issue | Area | Status |
|---|---|---|---|
| [#1](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/1) | Scaffold the repository like Gradient Progress Bar | packaging, documentation | ✅ |
| [#2](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/2) | Settings storage and migrations scaffold | core | ✅ |
| [#3](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/3) | Connect bar rendering: solid colour or a gradient of up to 8 colours | rendering | ✅ |
| [#4](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/4) | Theme-colour ~~and transparent~~ stops — transparent stops removed: no opacity, matching GPB | rendering, compatibility | ✅ |
| [#5](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/5) | Settings modal: stop editor and inline colour picker | ui | ✅ |
| [#6](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/6) | Remove the Spread modes and all progress-bar code | rendering | ✅ |
| [#7](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/7) | Preview strip in the settings | ui | ✅ |
| [#8](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/8) | jsDelivr purge and CDN heal workflows | packaging | ✅ |
| [#9](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/9) | Self-test harness: `await __gcb.selfTest()` | testing | ✅ |
| [#10](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/10) | Dev setup: link, register, apply | packaging | ✅ |

## Milestone 2 — Text colour — done 2026-10-19

A *Text colour* setting: Auto (default), Black, White or Spotify default. Auto picks whichever of black and white has the higher worst-case contrast over the colours behind the text. Tracking: [#31](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/31).

| # | Issue | Area | Status |
|---|---|---|---|
| [#11](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/11) | Text colour setting: Auto / Black / White / Spotify default | ui, enhancement | ✅ |
| [#12](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/12) | Auto: measure the text region | rendering | ✅ |
| [#13](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/13) | Auto: sample the gradient and pick by worst-case WCAG contrast | rendering | ✅ |
| [#14](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/14) | Write the chosen text colour into the bar's rule | rendering | ✅ |
| [#15](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/15) | Recalculate the text colour when things change (debounced) | rendering | ✅ |
| [#16](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/16) | ~~Warn when neither black nor white is readable~~ superseded — no hint or warnings, user decides | ui | — |
| [#17](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/17) | `__gcb.status()` reports the text colour | testing | ✅ |

## Milestone 3 — GPB parity — done 2026-10-19

The features GCB shares with Gradient Progress Bar. Tracking: [#37](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/37).

| # | Issue | Area | Status |
|---|---|---|---|
| [#34](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/34) | Shared top-bar button with Gradient Progress Bar (protocol 1; opens directly when alone, a menu with both when both are installed) | ui, compatibility | ✅ |
| [#35](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/35) | Profile-menu entry (its own entry, guarded like GPB #27) | compatibility | ✅ |
| [#29](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/29) | Presets (built-in + your own); built-ins keep the text colour, own presets save it | ui, enhancement | ✅ |
| [#36](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/36) | Share codes: Export / Import, also GPB's `gpb1:` codes | ui, compatibility | ✅ |

## Milestone 4 — Release 1.0.0 — done 2026-10-19

Tracking: [#32](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/32).

| # | Issue | Area | Status |
|---|---|---|---|
| [#18](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/18) | Real `preview.png` (Void provides the screenshot) | packaging | ✅ |
| [#19](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/19) | README screenshots — the settings window only; the preview strip shows the bar (Void) | documentation | ✅ |
| [#20](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/20) | Add the repo topic `spicetify-extensions` | packaging | ✅ |
| [#21](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/21) | Tag and release v1.0.0 | packaging | ✅ |
| [#22](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/22) | Marketplace check | packaging, testing | ✅ |

Milestones 1–3 were tested together: Void's self-test 170/170 on Spotify 1.3.5.3058 (v0.4.1), every visual checklist ticked. v1.0.0 was then installed from the Marketplace with no local copy: every self-test check passed and both Marketplace checklist items were ticked. Builds are handed over as `Test build <sha>` comments on the open milestone's tracking issue. See `CLAUDE.md → Working mode`; test procedure: [TESTING.md](TESTING.md).

## Future

Agreed ideas, not scheduled. Tracking: [#33](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/33).

| # | Issue | Notes |
|---|---|---|
| [#23](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/23) | "Mirror song progress" mode | the bar shows the playback position |
| [#24](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/24) | Pull the code shared with GPB into a common module | settings, picker, stop editor, self-test helpers |
| [#25](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/25) | Hover effect | |
| [#26](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/26) | ~~Per-colour opacity~~ dropped — no opacity, matching GPB ([VoidCrowned/spicetify-gradient-progress-bar#17](https://github.com/VoidCrowned/spicetify-gradient-progress-bar/issues/17)) | |
| [#27](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/27) | ~~Gradient angle~~ dropped — not planned in GPB ([VoidCrowned/spicetify-gradient-progress-bar#16](https://github.com/VoidCrowned/spicetify-gradient-progress-bar/issues/16)) | |
| [#28](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/28) | Custom stop positions | schema change |
| [#29](https://github.com/VoidCrowned/spicetify-gradient-connect-bar/issues/29) | Presets | ➜ moved to Milestone 3, done |
