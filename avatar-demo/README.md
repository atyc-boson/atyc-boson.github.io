# Boson Avatar — call demo

A static demo that looks like the Boson Avatar eval site but needs no GPU,
server, or API key. **Start Call** plays a pre-recorded avatar conversation as
if it were a live call. When the recording finishes the call keeps going: the
Avatar idles on a seamless loop (and the timer keeps counting) until you click
**End Call**, which returns to the start screen. Your camera and microphone are real, but they stay in
your browser: nothing is recorded or uploaded.

- **Settings → Conversation**: pick *Office* or *Vacation*.
- **Settings → Display**: aspect ratio (1:1, 4:3, 3:4), call timer on/off.
- **Controls** (one row under the video, before and during a call): camera
  (with camera picker), microphone (with mic picker and level meter), and
  Start Call / End Call.
- **Self-view**: turn the camera on to get a picture-in-picture tile. Tap it to
  swap views; drag it to any corner.

No build step and no dependencies (Geist fonts load from Google Fonts).

## Run locally

```bash
python3 serve.py
```

Open http://localhost:8080. Use `serve.py` rather than `python3 -m
http.server`: the built-in server ignores byte-range requests, so browsers
cannot seek in the videos (needed to restart a call and for the idle loop).
Browsers only allow the camera on HTTPS pages or on localhost.

## Publish on GitHub Pages

1. Push this folder to a GitHub repository (the two videos are about 16 MB
   each, well under GitHub's 100 MB file limit).
2. In the repository, open **Settings → Pages**, set **Source** to *Deploy from
   a branch*, and pick `main` and `/ (root)`.
3. The site appears at `https://<user>.github.io/<repo>/`. Pages serves it over
   HTTPS, so the camera works.

## Notes

- Safari and iOS only allow sound after a tap; Start Call is that tap. If a
  browser still refuses, the call plays silently with an **Enable Sound**
  button.
- On iPhone, turning the microphone on can switch the phone's audio route
  (quieter avatar playback). Leave the mic off for a phone demo if that happens.

## Change the conversations

Replace the files in `media/` and keep the names, or edit `CONVERSATIONS` at
the top of `app.js`. Each conversation needs three files: the video, a poster
image (its first frame), and an idle loop (its last 2 seconds played
backward, then forward). For a 24 fps video with `N` frames (count them with
`ffprobe -v error -select_streams v:0 -count_frames -show_entries
stream=nb_read_frames -of csv=p=0 media/office.mp4`):

```bash
ffmpeg -i media/office.mp4 -frames:v 1 -q:v 4 media/office.jpg
```

```bash
N=1154; L=$((N-1)); ffmpeg -i media/office.mp4 -filter_complex "[0:v]split[a][b];[a]select='between(n\,$((L-48))\,$((L-1)))',setpts=N/24/TB,reverse[r];[b]select='between(n\,$((L-47))\,$L)',setpts=N/24/TB[f];[r][f]concat=n=2:v=1:a=0,format=yuv420p[v]" -map "[v]" -an -r 24 -c:v libx264 -crf 18 -g 24 -movflags +faststart media/office-idle.mp4
```

The loop starts one frame before the video's last frame and ends on it, so
the hand-off and every repeat are seamless.

For fast starts, encode videos as H.264/AAC MP4 with `-movflags +faststart`.

## Files

| File | What it does |
|---|---|
| `index.html` | Page markup |
| `styles.css` | Geist tokens and components copied from the eval site, plus the timer and picture-in-picture styles |
| `app.js` | Call flow, idle loop, timer, camera, microphone, picture-in-picture, settings |
| `serve.py` | Local static server with byte-range support |
| `DESIGN.md` | Design decisions for the new parts |
