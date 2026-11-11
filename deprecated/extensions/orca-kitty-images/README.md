# orca-kitty-images (deprecated)

In Orca's terminal (`TERM_PROGRAM=orca`, `ORCA_IMAGE_PROTOCOL=kitty`) this extension set
`WEZTERM_PANE`, which made pi's fullscreen mode draw Kitty images after all text, so later
text writes no longer erased the image cells.

Deprecated: pi 1.5.1 does this on every Kitty terminal (#11835). The workaround also
leaked `WEZTERM_PANE` into child processes. Kept for reference only.

## Install

Only for pi older than 1.5.1:

```bash
cp deprecated/extensions/orca-kitty-images/index.ts ~/.pi/agent/extensions/orca-kitty-images.ts
```

Then restart pi or run `/reload`. Rollback: delete the file and restart pi.
