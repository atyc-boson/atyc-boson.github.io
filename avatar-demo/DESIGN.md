# Avatar Call Demo — design notes

A static, dependency-free copy of the Boson Avatar eval site's look
(`avatar-realtime-api/tools/eval-site`). It is used to stage a convincing
avatar call without a GPU, gateway, or LiveKit room: **Start Call** plays a
pre-recorded conversation. The webcam and microphone are real; nothing is
recorded or sent anywhere.

## What is kept from the eval site (unchanged look)

Top bar with the Boson logo and the Settings button · the alert banner ·
the one-frame scene ("Welcome to Higgs Avatar" → frame → Start Call) · the
Start Call → Connecting… → live transition · the floating control bar recipe
(`cb-group` / `cb-btn` / `cb-arrow` / `menu`) · the settings drawer (groups,
Geist switch, footer status chip, theme button) · Geist tokens, light + dark.

## What is dropped

Grant/prepare/activate/join journey, catalog, avatar upload, voices, prompts,
transcript and text output modes, eval window (timeline + log), docs link.

## New parts

### 1. Conversation switch (Settings → Conversation)
- Geist segmented switch: **Office | Vacation**.
- Locked while a call is running, styled as a read-only value (flat, muted,
  current choice as an inset chip) with a lock and "End the call to switch
  conversations."

### 2. Frame and call timer
- The frame always fills the stage (no window-size setting) at the aspect
  ratio chosen in Settings → Display: **1:1 | 4:3 | 3:4**. The square
  recording is cropped to fit, biased upward so the face stays in frame.
- A pill overlaid at the **bottom centre of the call frame**, twice the tile margin from the edge (24 px; 16 px on phones): green live dot with
  a soft halo + `MM:SS` of the recording's playback position.
- If the frame is too narrow for a bottom-corner tile beside it, the tile
  shrinks a little; if it would get too small to tap, the timer moves to the
  opposite bottom corner instead.
- Neutral dark glass (`rgba(0,0,0,.55)`, blur + saturate) so it reads on any
  frame in both themes; Geist Sans tabular numerals (no jitter, not "terminal").
- Settings → Display → **Call timer On | Off**, usable during a call.
- `role="timer"`, not announced every second.

### 3. Controls, camera and microphone
- One centred row of large (48 px) controls under the frame, the same before
  and during a call, with no surrounding bar: camera ▾ · microphone ▾ ·
  Start Call, which becomes End Call once live. No speaker button. You can
  check yourself before starting, so no permission prompt appears mid-call
  unless you ask for it there.
- Camera replaces the eval site's keyboard button and matches the mic recipe.
- Device menus list real devices, check only the running one, explain missing
  names before permission, and stay inside the viewport on phones.
- The mic icon's capsule fills from the bottom with your input level (fast
  attack, slow release).
- Failures are specific and visible: blocked (with steps for this browser and
  platform), not found, busy, insecure page. The button dot takes the alert's
  colour (amber = you can fix it, red = hardware). Repeating a failed action
  nudges the alert so the retry visibly registered; no empty tile flashes.
- Camera and mic stay exactly as you set them. The camera can be turned on
  before a call (the permission prompt comes then), but the self-view tile
  shows only while the call is live: not on the start screen, not while
  connecting. It appears when the call goes live and fades out on End Call.
  Nothing is saved across reloads, so a page load never turns a device on.
- Menus shift and flip (up or down) to stay inside the viewport; Chrome's
  default device reads "System default (<name>)". While a permission prompt
  is open the device icon breathes.
- Labels are fixed ("Camera", "Microphone"); state is `aria-checked`.

### 4. Self-view picture-in-picture
- During a live call, a running camera shows as a tile in a corner of the
  frame (default bottom right).
- Settings → Display → **Main view: Avatar | Self view** picks which feed
  fills the frame when the self-view appears; changing it mid-call swaps
  right away. Tapping the tile still swaps during the call.
- After a swap or resize settles, each video's layout is nudged so browsers
  that keep drawing a video at its old size redraw it (no background strip).
- **Tap/click the tile to swap** main and tile; both layers animate between
  their rectangles (320 ms, the site's standard ease). Swap icon on hover
  (desktop) or as a corner badge for a few seconds (touch).
- **Drag the tile** to any corner: it lifts (scale 1.05, deeper shadow), snaps
  to the nearest corner and remembers it. Arrow keys move it; the new corner
  is announced.
- The tile follows the stream's aspect ratio (clamped), at least 104 px on
  phones; 6 px radius, light Geist-scale shadow plus a hairline inner ring.
- Front cameras are mirrored, rear cameras are not. A spinner shows until the
  first frame (only when permission is already granted).
- Turning the camera off while it is the main view grows the Avatar back first.

### 5. Call start and end
- Connecting lasts at least 3 s and until the video can play; playback is
  unlocked inside the Start click, with an "Enable Sound" fallback centred in
  the frame if the browser still refuses sound.
- Alerts sit above the stage; the frame resizes smoothly to make room.
  On phones they become a one-line toggle (title + chevron, steps one tap
  away, still read by screen readers): above the stage in portrait, docked
  bottom right in landscape, sized to the real free space there. If
  that space is under 200 px, the alert is a 52 px warning chip that opens the
  details as a popover (Escape or an outside tap closes it). A new alert gets
  one amber ring pulse.
- Phones on their side (height ≤ 500 px): two columns, frame | heading and
  controls, before and during the call.
- The call never ends on its own. When the recording finishes, a pre-rendered
  4 s loop takes over (the last 2 s backward, then forward; its first frame
  follows the recording's last and its end leads back into its start), so the
  Avatar keeps idling seamlessly and the timer keeps counting.
- End Call fades back to the start screen ("Welcome to Higgs Avatar",
  "Start Call").
- Light theme by default; the theme button's choice is remembered.

## Review

The new parts were iterated with two independent reviewers (a UX design
expert and an art director) until both scored them at least 9/10; round-by-
round findings covered permission timing, landscape phones, alert placement,
accessibility of compact alerts, and visual consistency with Geist.

## Hosting
Plain static files with relative paths: works from GitHub Pages (HTTPS, which
the camera requires), any static host, or `python3 -m http.server`.
