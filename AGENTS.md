# gif-studio — agent playbook

You are making marketing assets (looping GIFs, MP4s, stills) from whatever the user pointed you at: an app repo, a
static site, a folder of screenshots, or a brief. gif-studio gives you eyes (a browser), hands (journeys, recording),
a scene runtime, a renderer and a review loop. This file is the whole manual. `gif-studio guide` prints it; the MCP
server serves it as `gif-studio://guide`.

Every CLI command takes `--json` and returns `{ok, data, summary, next}`. Errors return `{ok: false, error, hint}`.
`next` is always the most useful follow-up; when unsure, run `gif-studio status --json`. The MCP tools are the same
operations with the same names (`app_start` = `app start`, `browser_click` = `browse click`, and so on), and visual
tools return images inline, so prefer MCP when it is connected.

## The loop

1. **Understand** — `scan` → read `data.kind`, pitch, brand, routes, seed accounts.
2. **See** — for apps: `app start` → `explore` → look at the contact sheet. For assets: look at the images.
3. **Choose** — pick 1–3 core journeys or messages. Write them down as journeys (`journeys save`) or a brief.
4. **Capture** — `record <journey>` → plates (hi-res screenshots + element boxes) and/or footage.
5. **Compose** — `new <asset> --template … --journey … --format …` → edit `scene.html` until `preview` looks great.
6. **Render** — `render <asset>` → `versions/<asset>-vN-<len>s.gif|mp4` + stills. Look at the stills.
7. **Review** — `studio --background`; give the user the URL. They scrub, pin notes, tune pacing, export.
8. **Iterate** — user says "apply notes from vN" → `notes <asset> --version vN --open` → edit scene → `render` →
   `notes --done <id>` for each note you addressed → tell the user what changed.
9. **Ship** — `promote <asset> vN` → `final/<asset>.gif` (master), `.mp4`, stills; older versions move to `archive/`.

Do not stop at step 6 with an unchecked render. Always look at `preview`/`render` stills before you hand anything over.

## Decide what you are working with

`scan` classifies the location:

| kind | what to do |
| --- | --- |
| `app` | Run it (`app start`), explore, record real journeys → `product-walkthrough` / `feature-highlight`. |
| `static-site` | `app start --static --cwd <dir>`, then the same as an app. |
| `asset-folder` | No app. Use the images: `feature-highlight`, `before-after`, `step-card-loop`. |
| `docs` | Pull the pitch and steps from the docs; `step-card-loop` or `synthetic`. |
| `mixed` | Prefer the app if it runs; fall back to media. |
| `empty` | Ask the user for a brief or images, or build a `synthetic` scene from their description. |

If the app needs a login: use seed/demo accounts from `scan` (`data.seedAccounts`) by scripting the login as journey
steps, or run `auth login <url>` once — a headed browser opens, the user signs in, close the window, and the session is
saved to `.gif-studio/auth/default.json` and reused by `browse`, `explore` and `record` (journey field `"auth"`).
Never put real credentials in journeys or scenes.

## Running and seeing the app

```bash
gif-studio app start                         # uses config.app.command, or the detected dev command
gif-studio app start --command "pnpm dev" --url http://localhost:3000
gif-studio app start --static --cwd dist     # serve a built folder
gif-studio explore --max-pages 15            # sitemap + screenshot per page + suggested journeys
gif-studio browse open /settings             # every browse command saves a screenshot under .gif-studio/shots/
gif-studio browse snapshot                   # headings, interactive elements (role, name, box), aria tree
gif-studio browse click "role=button:New project"
gif-studio browse type "label=Project name" "Q3 launch plan"
gif-studio app stop                          # when you are done
```

Look at the screenshots. Pick journeys that show the product's core value in under ~8 seconds of screen time: create
the main thing, the "aha" interaction, the result. Avoid settings pages, empty states and long forms unless that is the
feature being marketed.

## Journeys (`marketing/gifs/journeys.json`)

```json
{
  "journeys": [
    {
      "id": "create-project",
      "title": "Create a project in seconds",
      "why": "The first thing every user does; shows speed",
      "score": 9,
      "auth": "default",
      "steps": [
        {"goto": "/", "beat": "Projects", "caption": "All your projects in one place"},
        {"click": {"role": "button", "name": "New project"}, "beat": "New project"},
        {"type": {"label": "Project name", "text": "Q3 launch plan"}, "beat": "Name it"},
        {"click": {"role": "button", "name": "Create project"}, "beat": "Created", "caption": "Ready to share", "hold": 1200}
      ]
    }
  ]
}
```

Steps: `goto`, `click`, `hover`, `type {target|label|placeholder|selector, text, human?, submit?}`, `press`,
`scroll {to?, y?}`, `waitFor (target | {ms})`, `capture`. Any step can add `beat` (named moment), `caption` and
`hold` (ms on screen). Targets are a string (visible text or CSS selector) or
`{selector|text|role+name|label|placeholder|testId, exact?, nth?}`. Prefer role + name and labels; they survive
redesigns. Save with `gif-studio journeys save journeys.json` (or `-` for stdin); it merges by id.

`record <id>` replays it. Each interaction becomes a plate: the screen before the action, with the target's box, then
the result. Output goes to `marketing/gifs/captures/<id>/plates.json` and `plates/NN.png` at 2x. Check the plates —
if a modal did not open or a toast is missing, fix the steps (add `waitFor`) and record again. `--mode footage`
records a real screen capture (`footage/frames/*.jpg` + markers) for motion that plates cannot show (drag, live
updates, animations). Mask sensitive data with `mask` (CSS selectors to blur) and `replace` (`{"real text": "demo"}`)
in `gif-studio.config.json`.

## Assets

```
marketing/gifs/
  journeys.json
  captures/<journey>/plates/…, footage/…   # shared by every asset made from the journey
  <asset>/
    brief.md          # the script: who, message, beats, format — write it before the scene
    scene.html        # the working copy, a pure function of time
    media/            # images copied in with --media or `media add`
    notes.json        # review notes (studio writes these)
    pacing.json       # per-section speeds (studio Pacing tab)
    versions/vN/scene.html + <asset>-vN-<len>s.gif|mp4 + stills
    final/            # promoted version
    archive/          # older versions after promote
```

Templates (`gif-studio templates`):

- `product-walkthrough` — recorded plates in a browser frame; camera follows the cursor to each target, typing
  overlays, captions. Needs a journey. The default for apps.
- `feature-highlight` — one screenshot; zoom to a region, ring + callout, zoom out. Set `focus` (fractions of the
  image) and `callout` in the data block.
- `step-card-loop` — 3–5 steps, each a card with an image and a typed label; seamless loop.
- `before-after` — wipe between two images.
- `synthetic` — rebuild a UI in HTML/CSS with the repo's tokens and copy; for unbuilt features, docs or no-app repos.

Formats: `16:9` (960x540), `1:1` (720x720), `4:5` (720x900), `9:16` (540x960), `modal-portrait` (480x630),
`card` (480x250), or `WIDTHxHEIGHT`. Sizes are CSS pixels; render scale 2 gives a crisp MP4, GIFs render at 1x.
Vertical formats crop the app (camera `fit: 'cover'`) and pan to each action.

Each template has a `<script type="application/json" id="data">` block at the top — edit that first (titles, captions,
hold times, focus regions) before touching code.

## Scene contract

A scene is a self-contained `scene.html`. It is valid when it sets

```js
window.__scene = {contract: 1, width, height, duration, sections, beats, seek(t), ready};
```

- `seek(t)` renders the exact frame at `t` ms (may return a Promise). The renderer, preview and studio call it in any
  order — **no `setTimeout`, `setInterval`, CSS transitions/animations or `Date.now()`** driving visuals.
- `sections: [{id, label, start, end}]` — the parts the Pacing tab can speed up or slow down.
- `beats: [{t, label}]` — key moments; one still is exported per beat; shown as ticks on the scrubber.
- `ready` — a Promise that resolves when fonts and images are loaded.
- Paths are relative to the asset folder (`media/x.png`, `../captures/<journey>/plates/01.png`). Versions are snapshots
  with `<base href="../../">`, so relative paths keep working.

The runtime (`/__studio/runtime.js`, also `import … from 'gif-studio/runtime'`) builds that for you:

```js
import {createScene, walkthrough, loadJson, fitBox, ease, rng} from '/__studio/runtime.js';

const scene = createScene({width: 960, height: 540, background: '#f6f8ff'});
const title = scene.el('h1', {text: 'Ship faster', style: {position: 'absolute', left: '60px', top: '40px'}});
scene.fadeIn(title, 0, 400, {y: 12});                    // from opacity 0 / offset → current
scene.tween(title, {at: 600, dur: 500, to: {scale: 1.1}, ease: 'outBack'});
scene.section('intro', 'Intro', 0, 1200);
scene.beat(900, 'Title');

const cursor = scene.cursor({name: 'Alex', color: '#4262ff'});
let t = cursor.moveTo(1200, 800, {x: 400, y: 300});      // curved, human path; returns end time
t = cursor.click(t);                                      // ripple; returns end time
t = scene.type(fieldEl, {at: t, text: 'Q3 launch plan'}); // human typing with caret
scene.done({duration: t + 1500});                         // publishes window.__scene
```

- Animatable props: `x`, `y`, `scale`, `scaleX`, `scaleY`, `rotate`, `opacity`, `blur`, `width`, `height`, `left`,
  `top`, `clip` (0–100, inset from the right). `tween` without `from` starts from the value at that time.
- `scene.set`, `fadeOut`, `path` (bezier), `text`, `call(at, dur, fn(p, t))` for anything custom (must be pure),
  `caption(text, {at, dur, position})`, `image(src)`, `crossfade(a, b, at, dur)`.
- `scene.camera(viewportEl, {worldWidth, worldHeight, fit})` → `camera.world` (put content in it), `focus(at, dur, box)`,
  `fit(at, dur)`, `overview(at, dur, box?)`, `to(at, dur, {cx, cy, zoom})`.
- `walkthrough(scene, platesManifest, {base, viewport, zoom, captions, hold, loop, fit})` — the whole product
  walkthrough from recorded plates; returns `{camera, cursor, images, end}` so you can add on top.
- `scene.footage(footageManifest, {base, at, from, to, rate})` — play recorded footage frames.
- `defineCssScene({width, height, duration})` — wraps an existing CSS-animation page so it becomes seekable.

## Quality bar

- **One message per asset.** 5–8 s loops; 10–12 s max for a full walkthrough. Hold each important state ≥ 700 ms.
- **Loop seamlessly**: the last frame should lead back into the first (templates do this with `loop: true`).
- **Readable at the size it ships**: GIF at 1x. Text ≥ 14 px at 1x; zoom into UI that is smaller than that.
- **Real product, real brand**: captured plates, the repo's colors (`scan` → `brand`), fonts and logo. No lorem
  ipsum; use believable demo data and `replace` to scrub real names.
- **Motion with intent**: the cursor goes where the eye should; the camera moves only to make something readable.
- Check every render's stills, and the GIF size (aim < 5 MB; lower `--gif-fps` or `--gif-scale`, or shorten).

## Review notes

`notes <asset> --version vN --open` prints markdown: each note has a time, a position (x/y as fractions of the frame),
text and attached images (paths you can open). Treat each note as one instruction. Seek to it with
`preview <asset> --at <t>` to see exactly what the user saw. After rendering the fix, mark it with
`notes <asset> --done <id>`. Notes left on vN show as "Covered in vN+1" once a newer version exists, so the user can
check them there.

Pacing: `pacing <asset>` shows section speeds; the next `render` applies them. To make them permanent, change the
timings in `scene.html` and reset with `pacing <asset> --set intro=1`.

## Talking to the user

- Before recording, say which journeys you picked and why (one line each).
- After a render, say where the files are, the length and size, and paste the stills or contact sheet.
- Give them the studio URL and the one-liner: "Scrub, click the frame to leave notes, then tell me *apply notes from
  vN*."
- Don't ask for things you can find out with `scan`, `explore` or `browse`.

## Troubleshooting

- `scene.html never defined window.__scene` — the scene threw before `scene.done()`. `preview` lists page errors.
- Blank or wrong frame in a still — something is driven by a timer or CSS transition instead of the timeline.
- `app start` timed out — pass `--url`, or check `.gif-studio/app.log`.
- Element not found while recording — `browse snapshot` and use the role/name it reports.
- No Chrome — set `GIF_STUDIO_CHROME=/path/to/chrome`, or install Chrome/Edge, or run `npx playwright install chromium`.
- ffmpeg — bundled; override with `GIF_STUDIO_FFMPEG`. `gifski` on PATH is used for better GIFs.
