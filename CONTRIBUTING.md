# Contributing

Thanks for helping. Bug reports with the right details are the most useful contribution, because most problems depend on the exact Spotify version, theme and extensions.

## Reporting a bug

Open an issue with the **Bug report** form. It asks for:

- **What happened**, and what you expected.
- **Theme** (name, or "none").
- **Spotify version** (*Settings → About*) and **Spicetify version** (`spicetify -v`).
- **Other extensions** you have enabled.
- A **screenshot**, if it's visual.
- The **JSON report**, ideally while audio plays on another device so the Connect bar is there:
  - if the settings open, run `await __gcb.selfTest()`; it copies the report to your clipboard;
  - otherwise run `__gcb.status()` and copy its output.

  [TESTING.md → Opening the devtools console](TESTING.md#opening-the-devtools-console) explains where to run these.

The report includes an outline of the Connect bar's DOM, so selector problems after a Spotify update can usually be fixed from one report.

## Development setup (Windows)

1. Find Spicetify's config folder:
   ```powershell
   spicetify config-dir
   ```
2. Link the file from your clone into its `Extensions` folder, so edits in the repo are what Spotify loads. In `cmd`, with Windows *Developer Mode* on or as administrator:
   ```bat
   mklink "<config-dir>\Extensions\gradientConnectBar.js" "<repo>\gradientConnectBar.js"
   ```
3. Enable it once and apply:
   ```powershell
   spicetify config extensions gradientConnectBar.js
   spicetify apply
   ```
4. Enable devtools once with `spicetify enable-devtools`. Then reload on save with:
   ```powershell
   spicetify watch -e
   ```
   With a symlinked file, `watch` doesn't always notice changes. If a reload doesn't pick up your edit, run `spicetify apply`.

## Before opening a pull request

- Read [CLAUDE.md](CLAUDE.md). It holds the verified DOM facts and the **hard rules**, for example:
  - one stylesheet, only the Connect bar's selector, no hashed class names;
  - no `!important`, no inline styles on Spotify's elements;
  - never change `--background-base`.

  Don't change selectors on a guess; verify them on the live DOM.
- Run `await __gcb.selfTest()` while playing on another device; every check must pass.
- Go through the items of the [visual checklist](TESTING.md#visual-checklist) that your change touches.
- Plain JavaScript in the one file, no build step, no dependencies; British English in UI strings and docs; every id and class prefixed `gcb-`.

## Project management

- Work is tracked as GitHub issues in milestones, each with a tracking issue. [ROADMAP.md](ROADMAP.md) mirrors them and is updated in the same change as the issues.
- Ideas that come up along the way get their own issue in the `Future` milestone.
- Checklists in issues are kept accurate:
  - tick a box as soon as its item is done;
  - a dropped or replaced item is struck through: `~~item~~ — superseded by #N`;
  - a postponed item stays unticked, gets `➜ moved to #N`, and that issue is opened or extended.
- A workflow strips generated footers from issues, comments and milestones, and ticks the remaining boxes when an issue is closed as completed.
