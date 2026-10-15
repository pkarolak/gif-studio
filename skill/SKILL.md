---
name: gif-studio
description: Make marketing GIFs, MP4s and stills from this repo, a running app, images or a brief with gif-studio. Use when the user asks to make a marketing GIF/video/asset, animate a feature or flow, record a product walkthrough, make a launch/social/changelog/docs visual, or says "apply notes from vN", "export", "render" or "promote" for a gif-studio asset.
---

# gif-studio

gif-studio turns whatever is here (an app, a site, screenshots, docs, a brief) into looping GIFs, MP4s and stills,
with a browser studio for review. Use the `gif-studio` MCP tools when connected (visual tools return images inline);
otherwise run `npx -y gif-studio <command> --json`.

## Start

1. Read the playbook once per session: MCP `guide` (or `npx -y gif-studio guide`). It has the loop, the scene
   contract, the runtime API, journey format and the quality bar.
2. `status` — tells you what exists (inventory, app, journeys, assets, versions, open notes) and what to do next.
3. If `status` says the project is not set up, run `init`.

## Make an asset

1. `scan` → what kind of location this is, brand, routes, pitch, seed accounts.
2. App: `app_start` → `explore` → look at the contact sheet → pick 1–3 core journeys → `journeys_save` → `record`.
   No app: look at the images/docs and pick a message.
3. `asset_new` with a template and format → write `brief.md` → edit `scene.html` (data block first).
4. `scene_preview` until every beat looks right → `render` → look at the stills.
5. `studio_start` and hand the user the URL: "Scrub, click the frame to leave notes, then tell me *apply notes from
   vN*."

## Apply notes from vN

1. `notes` with `version: vN, open: true` — one instruction per note; open attached images.
2. `scene_preview` at each note's time to see what the user saw.
3. Edit `scene.html`, `render`, check the stills.
4. `note_done` for each note you addressed; tell the user what changed in vN+1.

## Ship

`promote` the chosen version → `final/` gets the GIF master, MP4 and stills; older versions move to `archive/`.

Rules: scenes are pure functions of time (no timers or CSS transitions); one message per asset, 5–8 s loops; always
look at previews before handing anything over; never put real credentials or personal data in captures.
