import * as vscode from 'vscode';

import { CancelledError, isAbortError } from './core/errors';
import { Logger } from './logger';

/** Handle passed to long running operations so they can report progress. */
export interface Task {
	readonly token: vscode.CancellationToken;
	/** Update the notification message. */
	report(message: string): void;
	/** Log a step and update the notification message. */
	step(message: string): void;
	/** Aborted when the notification is cancelled, for child processes. */
	readonly signal: AbortSignal;
}

/**
 * Runs `work` behind a cancellable notification. Cancellation throws
 * `CancelledError` so callers can exit quietly instead of showing an error.
 */
export async function runWithTask<T>(logger: Logger, title: string, work: (task: Task) => Promise<T>): Promise<T> {
	const controller = new AbortController();

	try {
		return await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title, cancellable: true },
			async (progress, token) => {
				const subscription = token.onCancellationRequested(() => controller.abort());

				const task: Task = {
					token,
					signal: controller.signal,
					report: (message: string) => {
						progress.report({ message });
						logger.debug(message);
					},
					step: (message: string) => {
						progress.report({ message });
						logger.info(message);
					},
				};

				try {
					return await work(task);
				} catch (error) {
					// A killed child process reports a non-zero exit code, so
					// cancellation has to be detected from the signal.
					if (controller.signal.aborted || isAbortError(error)) {
						throw new CancelledError();
					}
					throw error;
				} finally {
					subscription.dispose();
				}
			},
		);
	} finally {
		// Stop any child process that outlived the notification.
		controller.abort();
	}
}

/** Shows a short lived confirmation message in the status bar. */
export function flashStatus(message: string, timeoutMs = 5000): void {
	void vscode.window.setStatusBarMessage(`$(check) ${message}`, timeoutMs);
}