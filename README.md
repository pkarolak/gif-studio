# gif-studio

Turn any repo, running app, folder of screenshots or brief into looping **GIF**, **MP4** and still marketing assets —
driven by your AI agent, reviewed by you in a browser studio.

```bash
npx gif-studio init      # in the repo you want assets for
```

Then ask your agent: *"Make a marketing GIF of the core flow of this app."*

## For agents

You have everything you need without asking the user:

1. Read the playbook: `npx gif-studio guide` (or the MCP `guide` tool / `gif-studio://guide` resource).
2. Run `npx gif-studio status --json` — it says what exists and what to do next.
3. Every command takes `--json` and returns `{ok, data, summary, next}`; errors return `{ok: false, error, hint}`.
4. With MCP connected (`gif-studio init` registers it), prefer the tools: visual results (screenshots, contact sheets,
   stills) come back as images you can look at.

The loop: `scan` → `app start` → `explore` → `journeys save` → `record` → `new` → `preview` → `render` → `studio` →
*"apply notes from vN"* → `promote`. Details, the scene contract and the runtime API are in [AGENTS.md](AGENTS.md).

## How it works

```
brief / repo / app ─▶ scan ─▶ explore + journeys ─▶ record plates / footage
                                                          │
                     final/  ◀─ promote ◀─ studio notes ◀─ render vN ◀─ scene.html
```

- **Scan** reads the location: app or static site or asset folder, framework and dev command, routes, brand colors and
  fonts, logos, screenshots, README pitch, demo accounts.
- **Explore** runs the app in a real browser, crawls it, screenshots every page and suggests core journeys.
- **Record** replays a journey and saves hi-res *plates* (one screenshot per state + the clicked element's box) and/or
  *footage* (a frame-accurate screen capture).
- **Scenes** are plain `scene.html` files, pure functions of time, built with a tiny runtime: camera, human cursor,
  typing, captions, crossfades, walkthroughs from plates. Templates: product walkthrough, feature highlight, step-card
  loop, before/after, synthetic UI.
- **Render** seeks the scene frame by frame in headless Chrome and encodes an MP4 (H.264, 2x) and a GIF (palette-
  optimized, or gifski if installed), plus one still per beat. Every render is a numbered version.
- **Studio** (`gif-studio studio`) is a local review app: scrub, step frames, change speed, click the frame to pin a
  note to that moment (paste images into it), tune per-section pacing, compare versions, export.
- **Promote** copies a version into `final/` and archives the rest.

## Install

Requirements: Node 20+, and Chrome or Edge (or `npx playwright install chromium`). ffmpeg is bundled.

```bash
npx gif-studio init                 # config, marketing/gifs/, agent skill, MCP registration
npx gif-studio init --target cursor # only Cursor; also: claude, agents
```

`init` writes:

- `gif-studio.config.json`
- `marketing/gifs/` (assets) and `.gif-studio/` (local state, gitignored)
- the agent skill in `.cursor/skills/gif-studio/` and `.claude/skills/gif-studio/`
- the MCP server in `.cursor/mcp.json` and `.mcp.json`:

```json
{"mcpServers": {"gif-studio": {"command": "npx", "args": ["-y", "gif-studio", "mcp"]}}}
```

The MCP server is local: your agent starts it over stdio on your machine; nothing is hosted.

## Quick start by hand

```bash
npx gif-studio scan
npx gif-studio app start                     # or --url http://localhost:3000
npx gif-studio explore
npx gif-studio journeys save journeys.json   # see AGENTS.md for the format
npx gif-studio record create-project
npx gif-studio new hero --template product-walkthrough --journey create-project --format 16:9
npx gif-studio preview hero                  # contact sheet of every beat
npx gif-studio render hero                   # versions/hero-v1-9.8s.gif + .mp4 + stills
npx gif-studio studio                        # review, notes, pacing, export
npx gif-studio promote hero v1
```

Apps behind a login: `npx gif-studio auth login http://localhost:3000/login` opens a browser once; sign in and close
it. The session is reused for exploring and recording.

## Commands

| Command | What it does |
| --- | --- |
| `init`, `guide`, `status`, `templates` | Setup, the agent playbook, project state, templates and formats |
| `scan [path]` | Inventory a location |
| `app start\|stop\|status`, `auth login` | Run the app under test; save a login session |
| `browse open\|click\|type\|press\|hover\|scroll\|screenshot\|snapshot\|links` | Drive the browser; every call saves a screenshot |
| `explore`, `journeys list\|save\|suggest`, `record <journey>` | Find and capture core journeys |
| `new <asset>`, `media add` | Create assets from templates |
| `preview <asset>`, `render <asset>` | Look at a scene; export GIF + MP4 + stills as the next version |
| `notes <asset>`, `pacing <asset>`, `promote <asset> <vN>` | Review loop and shipping |
| `studio`, `mcp`, `skill install` | Review app, MCP server, agent skill |

Run any command with `--help`.

## Assets

```
marketing/gifs/
  journeys.json
  captures/<journey>/plates.json, plates/, footage.json, footage/
  <asset>/
    brief.md  scene.html  media/  notes.json  pacing.json
    versions/<asset>-vN-<length>s.gif|mp4, versions/vN/{scene.html, stills/, meta.json}
    final/    archive/
```

## Scene contract

Any HTML page can be a scene if it sets:

```js
window.__scene = {
  contract: 1,
  width: 960, height: 540,           // CSS px; rendered at 2x for MP4
  duration: 8000,                    // ms
  sections: [{id: 'intro', label: 'Intro', start: 0, end: 1200}],  // Pacing tab
  beats: [{t: 900, label: 'Title'}], // stills + scrubber ticks
  seek(t) { /* draw the frame at t ms; may return a Promise */ },
  ready: Promise.resolve(),          // fonts and images loaded
};
```

Use the runtime to get this for free:

```html
<div id="stage"></div>
<script type="module">
  import {createScene} from '/__studio/runtime.js';
  const scene = createScene({width: 960, height: 540});
  const title = scene.el('h1', {text: 'Ship faster', style: {position: 'absolute', left: '60px', top: '200px'}});
  scene.fadeIn(title, 0, 400, {y: 12});
  scene.beat(600, 'Title');
  scene.done({duration: 3000});
</script>
```

The runtime is also published as `gif-studio/runtime` for bundlers.

## Configuration

`gif-studio.config.json`:

```json
{
  "assetsDir": "marketing/gifs",
  "studioPort": 4455,
  "viewport": {"width": 1440, "height": 900},
  "app": {"command": "pnpm dev", "url": "http://localhost:3000", "cwd": "."},
  "mask": [".user-email", "[data-private]"],
  "replace": {"Jane Real": "Alex Demo"},
  "render": {"fps": 30, "scale": 2, "gifFps": 20, "gifScale": 1, "formats": ["gif", "mp4"], "workers": 4}
}
```

Environment overrides: `GIF_STUDIO_CHROME` (browser executable), `GIF_STUDIO_FFMPEG` (ffmpeg binary),
`GIF_STUDIO_ROOT` (project root). Install [gifski](https://gif.ski) for smaller, better GIFs; it is used automatically.

## Programmatic use

```ts
import {scan, renderAsset, notesFor} from 'gif-studio';

const {data: inventory} = await scan();
const {data: result} = await renderAsset('hero', {formats: ['mp4']});
```

## Development

```bash
npm install
npm run build          # library + studio UI
npm test               # unit tests
npm run test:integration   # demo app end to end + MCP (needs Chrome)
npm run dev:studio     # studio UI with hot reload against a running `gif-studio studio`
```

`examples/demo-app` is a tiny app to try the whole loop on: `cd examples/demo-app && npx gif-studio init`.

## Publishing

Releases are published from CI with npm provenance when a `v*` tag is pushed (see
`.github/workflows/publish.yml`). The first publish of a new package name has to be done by hand
(`npm login && npm publish --access public`), then configure it as a
[Trusted Publisher](https://docs.npmjs.com/trusted-publishers) for this repository.

## License

MIT
