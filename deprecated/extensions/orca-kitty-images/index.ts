// Orca's terminal (xterm.js + addon-image) erases Kitty image cells when later text
// writes clear the rows an image covers, so pi's inline images collapse to a 1-row strip.
// Pi already works around the same behavior for WezTerm in fullscreen mode (draws images
// after all text and clears). Enable that path in Orca by marking the process as WezTerm.
// Protocol detection still picks Orca first (TERM_PROGRAM=orca + ORCA_IMAGE_PROTOCOL=kitty).
// Rollback: delete this file and restart pi.
export default function () {
  if (process.env.TERM_PROGRAM?.toLowerCase() !== "orca") return;
  if (process.env.ORCA_IMAGE_PROTOCOL !== "kitty") return;
  process.env.WEZTERM_PANE ??= "orca-kitty-images";
}
