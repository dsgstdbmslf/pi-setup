/** Number of characters of `prompt` beyond the 3000-character diff budget: 0 means the diff was not clipped. */
export function classifierPromptCheck(prompt: string): number {
	return /more chars\]/.test(prompt) ? 1 : 0;
}
