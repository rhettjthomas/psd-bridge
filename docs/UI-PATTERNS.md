# Figma Plugin UI Patterns

The UI/UX conventions behind PSD Bridge, written so they can be lifted into other Figma
plugins. Copy `src/ui/ui.css` for the tokens and `src/ui/combobox.ts` for the dropdown; the
rest is a way of thinking about the window.

## The shape of the window

340 × 480 px, fixed, in four bands:

```
Header    plugin name · version · settings gear (opens a menu)
Tabs      one per direction of work (Import / Export)
Content   scrolls: input picker → warnings → options → report
Footer    pinned: status line + progress bar, then one primary button
```

The footer never scrolls. The single most important action lives there, always visible and
always in the same place, so the button is never hunted for.

## The flow: pick → preflight → act → report

Every screen follows the same four beats, and the user can stop after any of them.

1. **Pick** the input (a file, a frame), and immediately show what was understood about it:
   name, size, layer count. This is the first honesty checkpoint.
2. **Preflight**: before anything is committed, list what will be approximated or skipped,
   with layer names. Cheap to compute, and it sets expectations while the user can still change
   options or fix the source file.
3. **Act**, with progress ("Importing layer 14 of 62") and a **Cancel** that leaves the
   document untouched.
4. **Report** the same list again, now with counts and elapsed time, and each entry clickable
   to select that layer in the file.

Preflight and report share one renderer, so what you were promised and what you got are
described in the same words.

## Principles worth keeping

**Never silently drop anything.** Every element either converts or appears in the report with a
reason in plain language ("Blend mode 'vivid light' has no Figma equivalent; using Normal").
The report is the product's honesty, and the reason a user trusts it a second time.

**Two levels, not one.** *Approximated* (it's there, but changed) and *skipped* (it isn't
there). Collapsing those into "warnings" loses the distinction that decides whether someone
needs to go back to the source file.

**Make the report actionable.** A layer name that selects and zooms to the layer turns a list
of complaints into a cleanup queue.

**Options are rows, not a settings screen.** Each toggle gets an icon, a label, and one line of
helper text explaining the effect, not the mechanism. They sit on the main screen because they
change what the button will do.

**Remember decisions, per machine.** `figma.clientStorage` keeps toggles and font matches.
Anything a user might want to move between machines needs an escape hatch (see below).

**Block the action, don't fail it.** When something must be resolved first (missing fonts), the
primary button disables and relabels itself: "Match 1 missing font to import". The button says
what is missing instead of failing after a click.

**Status where it's read.** Messages live in the footer, above the button. An earlier version
put them at the bottom of the scrolling area, and users clicked a menu item and saw nothing
happen because the confirmation rendered below the fold. If a message can appear in response to
a click, it must be visible from wherever that click happens.

## Working inside Figma's window

**Two threads, one queue.** The main thread owns the document; the UI iframe owns the DOM and
anything needing a canvas. They speak only through `postMessage`, so define the messages as a
typed union in one file, and process them **in order** on the main side — an async handler that
loads fonts must finish before the layers that need those fonts arrive.

**Send work in batches, and wait for an acknowledgement.** Large jobs (hundreds of layers, tens
of MB of pixels) freeze the window if pushed at once. Batch by count *and* bytes, and let the
receiver confirm each batch before the next is sent. Transfer binary as `Uint8Array`
transferables, never base64.

**Theme with Figma's variables.** `figma.showUI(__html__, { themeColors: true })` injects
`--figma-color-bg`, `--figma-color-text`, `--figma-color-border`, `--figma-color-bg-menu`, and
others. Map them to your own tokens once, with fallbacks, and light and dark both work:

```css
:root {
  --accent: #c6f432;            /* your one brand color */
  --bg: var(--figma-color-bg, #ffffff);
  --text: var(--figma-color-text, #1e1e1e);
  --border: var(--figma-color-border, #e6e6e6);
}
```

Keep the accent to a single token, used for the primary button and progress bar only.

**Build native-looking controls, not native controls.** The browser's `datalist` popup and
default `select` look nothing like Figma and can't be styled. A small custom combobox (filtered
list, arrow keys, Enter, Esc) and an `appearance: none` select with your own chevron cost an
hour and remove the "this is a web page in a box" feeling. Menus use
`--figma-color-bg-menu` so they read as Figma's own.

**Downloads work; the clipboard is unreliable.** `<a download>` from the plugin iframe does
produce a file in the desktop app. `navigator.clipboard` is usually blocked, so copy with
`document.execCommand('copy')` **synchronously inside the click** (an `await` first can cost
the user-gesture permission), and fall back to the async API. For anything the user might need
to move between machines, show the data as selectable text in a panel: select-all and ⌘C always
works, whatever the sandbox allows.

**Type scale and spacing.** 11–13 px type (11 for helper text, 12 for body, 13 for headings),
an 8 px spacing grid, 6 px radius on cards and 4 px on inputs. Figma's own UI is denser than a
web app, and matching that density makes the plugin feel built in.

## Small things that carry weight

- **Version in the header**, so a bug report says which build.
- **Empty states say what to do next**, not just what's missing: "No frames on this page. Select
  a frame on the canvas, then click Refresh."
- **Errors name the fix:** "isn't a valid Photoshop document. Re-save it from Photoshop and try
  again."
- **Re-read the environment on demand.** A "Rescan fonts" or "Refresh" button is the answer to
  anything that can change outside the plugin while it's open.
- **A `[hidden] { display: none !important }` rule**, because any `display: flex` you write will
  otherwise override the `hidden` attribute.
- **Disable inputs while work runs**, and swap the primary button for Cancel.
- **Keyboard and labels:** `role="menu"` with arrow keys and Esc, `aria-label` on icon buttons,
  `role="status"` with `aria-live` on the message area. Small effort, and it makes the window
  usable without a mouse.

## Reuse checklist for the next plugin

1. Copy the four-band layout and the token block from `src/ui/ui.css`.
2. Define the message union first (`src/core/messages.ts`), then build both sides against it.
3. Decide the one primary action and put it in the footer.
4. Write the report model early: every conversion path either succeeds or pushes
   `{ level, layerName, reason }`.
5. Settings menu from day one: reset, and an escape hatch for anything stored per machine.
6. Keep the pure logic (mapping, math, planning) out of the UI and out of the main thread, in a
   `core/` folder that unit tests can reach without Figma.
