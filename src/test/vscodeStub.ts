/**
 * Minimal stand-in for the `vscode` module so the integration check can run in
 * plain Node. It implements only what `Logger` touches.
 */

export interface StubOutputChannel {
	appendLine(value: string): void;
	show(preserveFocus?: boolean): void;
	dispose(): void;
}

export const lines: string[] = [];

export const window = {
	createOutputChannel(_name: string): StubOutputChannel {
		return {
			appendLine: (value: string) => lines.push(value),
			show: () => undefined,
			dispose: () => undefined,
		};
	},
};

export const workspace = {
	getConfiguration: () => ({
		inspect: () => undefined,
		update: async () => undefined,
	}),
	workspaceFolders: undefined as unknown,
};

export const window_statusBar = true;