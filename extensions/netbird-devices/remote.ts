// Remote shell scripts (probe, bash wrapper, root askpass helpers). Pure strings: no pi imports,
// unit-tested. Commands run through the login shell of the device user (zsh on macOS), so they are
// POSIX sh and the agent's command itself runs in /bin/bash.

export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** One round trip that tells us everything about the account: OS, home, shell, PATH, console user. */
export const PROBE_SCRIPT = [
	'echo "nb_os=$(uname -s)"',
	'echo "nb_arch=$(uname -m)"',
	'echo "nb_user=$(id -un)"',
	'echo "nb_home=$HOME"',
	'echo "nb_shell=${SHELL:-/bin/sh}"',
	'if [ "$(uname -s)" = Darwin ]; then',
	'  echo "nb_osver=macOS $(sw_vers -productVersion 2>/dev/null)"',
	'  echo "nb_console=$(stat -f%Su /dev/console 2>/dev/null)"',
	"else",
	'  ( . /etc/os-release 2>/dev/null; echo "nb_osver=${PRETTY_NAME:-$(uname -sr)}" )',
	'  s=$(loginctl show-seat seat0 -p ActiveSession --value 2>/dev/null)',
	'  [ -n "$s" ] && echo "nb_console=$(loginctl show-session "$s" -p Name --value 2>/dev/null)"',
	"fi",
	'p=$("${SHELL:-/bin/sh}" -lc \'printf "\\nnb_path=%s\\n" "$PATH"\' </dev/null 2>/dev/null | grep "^nb_path=" | tail -n 1)',
	'[ -n "$p" ] && echo "$p" || echo "nb_path=$PATH"',
	'command -v sudo >/dev/null 2>&1 && echo "nb_sudo=1"',
].join("\n");

export interface ProbeInfo {
	os: string;
	arch?: string;
	user: string;
	home: string;
	shell?: string;
	osver?: string;
	console?: string;
	path?: string;
	sudo: boolean;
}

export function parseProbe(out: string): ProbeInfo | undefined {
	const kv: Record<string, string> = {};
	for (const line of out.split("\n")) {
		const m = /^nb_(\w+)=(.*)$/.exec(line.trim());
		if (m) kv[m[1]] = m[2];
	}
	if (!kv.user || !kv.home) return undefined;
	return {
		os: kv.os || "unknown",
		arch: kv.arch || undefined,
		user: kv.user,
		home: kv.home,
		shell: kv.shell || undefined,
		osver: kv.osver || undefined,
		console: kv.console && !["root", "loginwindow", "_mbsetupuser", "gdm", "sddm", "lightdm"].includes(kv.console) ? kv.console : undefined,
		path: kv.path || undefined,
		sudo: kv.sudo === "1",
	};
}

/** `cd` into `cwd`, or into home when none is given; a missing directory is an error, not a silent fall back to home. */
export function cdStep(cwd?: string): string {
	if (!cwd) return "cd";
	return `cd ${shq(cwd)} 2>/dev/null || { echo ${shq(`pi-nb: no such directory: ${cwd}`)} >&2; exit 2; }`;
}

/**
 * The agent's command as the script of `/bin/bash -c`. Its stdin is always empty: whatever the wrapper
 * reads from stdin (a sudo password) must never reach the command (`sudo cat` with NOPASSWD would echo it).
 */
export function agentScript(command: string): string {
	return `exec </dev/null; ${command}`;
}

/** Run the agent's command in /bin/bash with the user's login PATH, from `cwd` (or home). */
export function bashWrapper(command: string, opts: { cwd?: string; path?: string }): string {
	const path = opts.path ? `export PATH=${shq(opts.path)}; ` : "";
	return `${cdStep(opts.cwd)}; ${path}exec /bin/bash -c ${shq(agentScript(command))}`;
}

export const ASKPASS_STATUS_CANCEL = 197;
export const ASKPASS_STATUS_UNAVAILABLE = 196;

const MAC_ASKPASS = `#!/bin/sh
d=$(dirname "$0")
r=$(/usr/bin/osascript - "$PI_NB_TITLE" "$PI_NB_TEXT" "$1" 2>"$d/err" <<'OSA'
on run argv
	tell application "System Events"
		activate
		set res to display dialog ((item 2 of argv) & return & return & (item 3 of argv)) with title (item 1 of argv) default answer "" with hidden answer buttons {"Cancel", "Allow"} default button "Allow" cancel button "Cancel" with icon caution giving up after 120
	end tell
	if gave up of res then error number -128
	return text returned of res
end run
OSA
)
if [ $? -eq 0 ]; then echo ok > "$d/status"; printf '%s\\n' "$r"; exit 0; fi
if grep -q -- '-128' "$d/err"; then echo cancel > "$d/status"; else echo unavailable > "$d/status"; fi
exit 1
`;

const LINUX_ASKPASS = `#!/bin/sh
d=$(dirname "$0"); uid=$(id -u)
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$uid}"
[ -z "$DBUS_SESSION_BUS_ADDRESS" ] && [ -S "$XDG_RUNTIME_DIR/bus" ] && export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
if [ -z "$WAYLAND_DISPLAY" ]; then for s in "$XDG_RUNTIME_DIR"/wayland-[0-9]*; do case "$s" in *.lock) continue;; esac; [ -S "$s" ] && { export WAYLAND_DISPLAY="\${s##*/}"; break; }; done; fi
if [ -z "$DISPLAY" ]; then for s in /tmp/.X11-unix/X*; do [ -S "$s" ] && { export DISPLAY=":\${s##*/X}"; break; }; done; fi
if [ -z "$XAUTHORITY" ]; then for f in "$XDG_RUNTIME_DIR"/gdm/Xauthority "$XDG_RUNTIME_DIR"/.mutter-Xwaylandauth.* "$XDG_RUNTIME_DIR"/xauth_* "$HOME/.Xauthority"; do [ -r "$f" ] && { export XAUTHORITY="$f"; break; }; done; fi
if [ -z "$WAYLAND_DISPLAY$DISPLAY" ]; then echo unavailable > "$d/status"; exit 1; fi
text="$PI_NB_TEXT

$1"
if command -v zenity >/dev/null 2>&1; then
	r=$(zenity --entry --hide-text --title="$PI_NB_TITLE" --text="$text" --timeout=120 2>"$d/err"); rc=$?
elif command -v kdialog >/dev/null 2>&1; then
	r=$(kdialog --title "$PI_NB_TITLE" --password "$text" 2>"$d/err"); rc=$?
else
	a=""; for p in ksshaskpass /usr/lib/ssh/ssh-askpass /usr/libexec/openssh/gnome-ssh-askpass /usr/lib/openssh/gnome-ssh-askpass /usr/bin/ssh-askpass; do command -v "$p" >/dev/null 2>&1 && { a="$p"; break; }; done
	if [ -z "$a" ]; then echo unavailable > "$d/status"; exit 1; fi
	r=$("$a" "$text" 2>"$d/err"); rc=$?
fi
if [ $rc -eq 0 ]; then echo ok > "$d/status"; printf '%s\\n' "$r"; exit 0; fi
if grep -qiE 'cannot open display|unable to init|failed to connect|could not connect|gtk-warning|qt.qpa' "$d/err"; then echo unavailable; else echo cancel; fi > "$d/status"
exit 1
`;

export function askpassScript(os: string): string {
	return os === "Darwin" ? MAC_ASKPASS : LINUX_ASKPASS;
}

/**
 * Root through a native password dialog on the device: a private temp askpass helper, then
 * `sudo -k -A` (always asks, never uses cached credentials). The password goes from the dialog to
 * sudo on the device and never leaves it. Exit 196/197 when the dialog was unavailable/cancelled.
 */
export function rootNativeWrapper(command: string, opts: { os: string; cwd?: string; path?: string; title: string; text: string }): string {
	const script = askpassScript(opts.os);
	return [
		"umask 077",
		't=$(mktemp -d "${TMPDIR:-/tmp}/pinb.XXXXXX") || exit 1',
		'trap \'rm -rf "$t"\' EXIT',
		`cat > "$t/askpass" <<'PINB_ASKPASS_EOF'\n${script}PINB_ASKPASS_EOF`,
		'chmod 700 "$t/askpass"',
		cdStep(opts.cwd),
		opts.path ? `export PATH=${shq(opts.path)}` : ":",
		`SUDO_ASKPASS="$t/askpass" PI_NB_TITLE=${shq(opts.title)} PI_NB_TEXT=${shq(opts.text)} sudo -k -A -p 'Password:' -- /bin/bash -c ${shq(agentScript(command))}`,
		"rc=$?",
		'st=$(cat "$t/status" 2>/dev/null)',
		`[ "$st" = unavailable ] && exit ${ASKPASS_STATUS_UNAVAILABLE}`,
		`[ "$st" = cancel ] && exit ${ASKPASS_STATUS_CANCEL}`,
		"exit $rc",
	].join("\n");
}

/** Root with the password from a masked pi dialog, sent on stdin to `sudo -S` only. */
export function rootStdinWrapper(command: string, opts: { cwd?: string; path?: string }): string {
	return [
		cdStep(opts.cwd),
		opts.path ? `export PATH=${shq(opts.path)}` : ":",
		`exec sudo -S -k -p '' -- /bin/bash -c ${shq(agentScript(command))}`,
	].join("\n");
}

/** Text shown in the native root dialog. */
export function rootDialogText(command: string, from: string): string {
	const c = command.length > 300 ? `${command.slice(0, 300)}…` : command;
	return `Pi agent on ${from} asks to run as root:\n\n${c}\n\nEnter your password only if you expect this.`;
}

/**
 * Find a file the way macOS names screenshots: narrow no-break space (U+202F) before AM/PM, curly quote,
 * and NFC/NFD forms of the name (the model usually sends NFC, the file system may hold NFD, or the other way).
 */
export function pathVariants(path: string): string[] {
	const variants = new Set<string>();
	for (const base of [path, path.normalize("NFC"), path.normalize("NFD")]) {
		const nnbsp = base.replace(/ (AM|PM)\./gi, "\u202F$1.");
		const curly = (x: string) => x.replace(/'/g, "\u2019");
		for (const v of [base, nnbsp, curly(base), curly(nnbsp)]) variants.add(v);
	}
	return [...variants];
}

export function pathVariantsScript(path: string): string {
	return `for p in ${pathVariants(path).map(shq).join(" ")}; do [ -e "$p" ] && { printf '%s' "$p"; exit 0; }; done; exit 1`;
}
