import * as vscode from 'vscode';

import { errorText } from './core/errors';
import { redact } from './core/redact';

/**
 * Output channel logger. Every registered secret is masked before it reaches
 * the channel, so tokens never end up in the log or in an issue report.
 */
export class Logger implements vscode.Disposable {
	private readonly channel: vscode.OutputChannel;
	private readonly secrets = new Set<string>();

	constructor(name = 'GitHub Switcher') {
		this.channel = vscode.window.createOutputChannel(name);
	}

	/** Registers a value that must be masked in all future log lines. */
	trackSecret(secret: string | undefined): void {
		if (secret && secret.length >= 8) {
			this.secrets.add(secret);
		}
	}

	info(message: string): void {
		this.write('info', message);
	}

	warn(message: string): void {
		this.write('warn', message);
	}

	error(message: string, cause?: unknown): void {
		this.write('error', cause === undefined ? message : `${message}: ${errorText(cause)}`);
	}

	debug(message: string): void {
		this.write('debug', message);
	}

	/** Writes a visible separator so the phases of a switch are easy to spot. */
	phase(title: string): void {
		this.write('info', '');
		this.write('info', `=== ${title} ===`);
	}

	show(): void {
		this.channel.show(true);
	}

	dispose(): void {
		this.channel.dispose();
	}

	private write(level: string, message: string): void {
		const line = `${new Date().toISOString()} [${level}] ${redact(toSingleLine(message), [...this.secrets])}`;
		this.channel.appendLine(line);
	}
}

function toSingleLine(message: string): string {
	return message.replace(/\r?\n/g, ' \\n ');
}