// Render fenced code blocks like Claude Code: hide the ``` fence lines and keep
// only the (highlighted) code. Display-only; messages and context are unchanged.
//
// Scope: the patch is on pi-tui's Markdown.renderToken, so fences are hidden on
// every Markdown surface in pi: user and assistant messages (and thinking),
// custom messages, skill blocks, branch and compaction summaries, What's New,
// /changelog and the extension update notices. Changelog code samples included.
// registerMarkdownTransformer (and its messageTypes option) is not used: it
// rewrites the Markdown source before rendering, so it cannot drop the fences
// without losing syntax highlighting. If hiding must ever differ per surface,
// this file needs an explicit check for it.
//
// Mermaid: the built-in transformer turns valid diagrams into rows of inline
// code before rendering, so they never reach this patch as code blocks. An
// invalid or too wide diagram stays a normal code block and loses its fences.
//
// Combine with settings.json "markdown": { "codeBlockIndent": "" } so code is
// not shifted relative to the surrounding text.
// Rollback: delete this file and run /reload (or restart pi).
import { Markdown } from "@earendil-works/pi-tui";

const METHOD = "renderToken";

const PATCHED = Symbol.for("code-fence-hide.patched");
const ANSI = /\x1b\[[0-9;:?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const isFence = (line: string) => /^\s*```/.test(line.replace(ANSI, ""));

export default function () {
  const proto = (Markdown as any)?.prototype;
  if (!proto || typeof proto[METHOD] !== "function" || proto[PATCHED]) return;
  const original = proto[METHOD];
  proto[METHOD] = function (tok: any, ...rest: any[]) {
    const lines: string[] = original.call(this, tok, ...rest);
    if (tok?.type !== "code" || !Array.isArray(lines) || lines.length < 2) return lines;
    if (!isFence(lines[0])) return lines;
    let close = lines.length - 1;
    while (close > 0 && lines[close] === "") close--;
    if (close <= 0 || !isFence(lines[close])) return lines;
    return [...lines.slice(1, close), ...lines.slice(close + 1)];
  };
  proto[PATCHED] = true;
}
