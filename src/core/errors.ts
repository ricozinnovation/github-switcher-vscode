/**
 * Error types shared by the extension. This module must not import `vscode`.
 */

/**
 * An error with a message that is safe to show to the user plus an optional
 * hint describing how to recover from it.
 */
export class SwitcherError extends Error {
	public readonly hint?: string;

	constructor(message: string, options: { cause?: unknown; hint?: string } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'SwitcherError';
		this.hint = options.hint;
	}
}

/** Thrown when the user cancels a long running operation. */
export class CancelledError extends Error {
	constructor(message = 'Operation cancelled.') {
		super(message);
		this.name = 'CancelledError';
	}
}

/** Best effort conversion of an unknown throwable into readable text. */
export function errorText(error: unknown): string {
	if (error instanceof Error) {
		return error.message || error.name;
	}
	if (typeof error === 'string') {
		return error;
	}
	if (error === undefined || error === null) {
		return 'Unknown error';
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/** Returns true when the error was caused by an aborted operation. */
export function isAbortError(error: unknown): boolean {
	if (error instanceof CancelledError) {
		return true;
	}
	if (error instanceof Error) {
		if (error.name === 'AbortError') {
			return true;
		}
		const cause = (error as { cause?: unknown }).cause;
		if (cause !== undefined && cause !== error && isAbortError(cause)) {
			return true;
		}
	}
	return false;
}

/** `20260612-134501`, matching the `date +%Y%m%d-%H%M%S` format of switch.sh. */
export function compactTimestamp(date: Date = new Date()): string {
	const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
	return [
		pad(date.getFullYear(), 4),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		'-',
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join('');
}
