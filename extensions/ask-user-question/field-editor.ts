import { Editor } from "@earendil-works/pi-tui";

/** Editor text plus its paste map, so `[paste #N]` markers stay expandable after a reset. */
export interface EditorSnapshot {
	text: string;
	pastes: Map<number, string>;
	counter: number;
}

/**
 * pi-tui's Editor keeps the paste map in private fields and clears it on setText() and on submit.
 * We need it to (a) read the marker text (display) before a submit clears it and (b) put an editor back
 * as it was (Esc, returning to a field). This is the only place that touches those internals. If a
 * pi-tui update renames them, snapshots fall back to the expanded text (no markers), so the user and
 * the model never get a marker that cannot be expanded; test/ask-user-question-ui.test.ts guards this.
 */
export class FieldEditor extends Editor {
	/** Taken right before the editor clears itself on submit, so the display text survives. */
	lastSubmit?: EditorSnapshot;

	/** True when the private paste fields still look the way this adapter expects. */
	hasPasteInternals(): boolean {
		const e = this as any;
		return e.pastes instanceof Map && typeof e.pasteCounter === "number";
	}

	snapshot(): EditorSnapshot {
		if (!this.hasPasteInternals()) return { text: this.getExpandedText(), pastes: new Map(), counter: 0 };
		const e = this as any;
		return { text: this.getText(), pastes: new Map(e.pastes), counter: e.pasteCounter };
	}

	restore(snap: EditorSnapshot): void {
		this.setText(snap.text); // clears the paste map
		if (!this.hasPasteInternals()) return;
		const e = this as any;
		e.pastes = new Map(snap.pastes);
		e.pasteCounter = snap.counter;
	}

	// Every submit path of Editor (Enter, custom submit key, backslash workaround) ends here.
	// @ts-ignore submitValue is private in pi-tui
	submitValue(): void {
		this.lastSubmit = this.snapshot();
		// @ts-ignore
		super.submitValue();
	}
}
