# Dashboard demo recording

Plays `tour.mjs` in your installed Google Chrome. The recorder clicks through
the sidebar and the first detail link on selected pages, shows a cursor and
captions, and narrates each shot with an in-cluster TTS service (Orpheus by default, Piper optional) service. The
output is an MP4 plus an `.srt` subtitle file in `scripts/demo/out/`.

It uses a dedicated Chrome profile (`~/.cache/driftmower-demo/chrome-profile`)
that you sign in to once with your own account. Chrome does not allow
automation of its default profile, and that profile is locked while Chrome is
running.

```sh
# Once: sign in through the dashboard's OIDC provider, then close the window.
scripts/demo/demo.sh --url https://dashboard.driftmower.<cluster-domain> login

# Record. --context selects the kube context used to reach the TTS service.
scripts/demo/demo.sh --context <kube-context> --url https://dashboard.driftmower.<cluster-domain> record
```

Options after `record` go to `record.mjs`: `--size 2560x1440`,
`--theme dark`, `--headless` (after a successful sign-in), and `--no-tts`
for captions only. To change shots, narration or timing, edit `tour.mjs`.
Narration clips are cached by text in `out/tts-cache/`, so re-recording after
changing timing does not synthesize them again.

Everything visible on the dashboard ends up in the video, including namespace,
image and user names. Review the result before publishing it.
