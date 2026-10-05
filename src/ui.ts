import * as vscode from 'vscode';

import { errorText, SwitcherError } from './core/errors';
import { RepoInfo } from './core/repos';
import { Logger } from './logger';

/** Small wrappers around the VS Code dialogs the switcher needs. */

interface RepositoryItem extends vscode.QuickPickItem {
	repository: RepoInfo;
}

/**
 * Quick pick over the fetched repositories. `currentFullName` gets a checkmark
 * so it is obvious which repository is checked out.
 */
export async function pickRepository(
	repositories: readonly RepoInfo[],
	currentFullName: string | undefined,
	options: { title?: string; placeHolder?: string; excludeCurrent?: boolean } = {},
): Promise<RepoInfo | undefined> {
	const candidates = options.excludeCurrent
		? repositories.filter((repository) => repository.fullName !== currentFullName)
		: repositories;

	if (candidates.length === 0) {
		void vscode.window.showInformationMessage('GitHub Switcher: no repositories to choose from.');
		return undefined;
	}

	const items: RepositoryItem[] = candidates.map((repository) => ({
		label: `${repository.fullName === currentFullName ? '$(check) ' : ''}${shortName(repository)}`,
		description: `${repository.fullName}  \u00b7  ${repository.defaultBranch}  \u00b7  ${
			repository.isPrivate ? 'private' : 'public'
		}`,
		detail: repository.fullName === currentFullName ? 'Currently checked out' : undefined,
		repository,
	}));

	const picked = await vscode.window.showQuickPick(items, {
		title: options.title ?? 'Switch Repository',
		placeHolder: options.placeHolder ?? 'Select the repository to switch to',
		matchOnDescription: true,
		matchOnDetail: true,
		canPickMany: false,
		ignoreFocusOut: true,
	});

	return picked?.repository;
}

function shortName(repository: RepoInfo): string {
	const separator = repository.fullName.indexOf('/');
	return separator === -1 ? repository.fullName : repository.fullName.slice(separator + 1);
}

/** Modal confirmation shown before the workspace directory is replaced. */
export async function confirmReplacement(message: string, confirmLabel = 'Replace and Switch'): Promise<boolean> {
	const keep = 'Cancel';
	const answer = await vscode.window.showWarningMessage(
		message,
		{
			modal: true,
			detail: 'Uncommitted work in the current repository was already saved to a temporary branch.',
		},
		confirmLabel,
		keep,
	);

	return answer === confirmLabel;
}

/** Modal dialog for the access token, masked while typing. */
export async function promptToken(options: { value?: string; prompt?: string } = {}): Promise<string | undefined> {
	const answer = await vscode.window.showInputBox({
		title: 'GitHub Switcher',
		prompt:
			options.prompt ??
			'Paste a personal access token with the "repo" scope. It is stored in VS Code SecretStorage and masked in the log.',
		password: true,
		ignoreFocusOut: true,
		value: options.value ?? '',
		placeHolder: 'ghp_...',
		validateInput: (value: string) => (value.trim() === '' ? 'A token is required.' : undefined),
	});

	return answer?.trim() || undefined;
}

export async function promptString(options: {
	title: string;
	prompt: string;
	value?: string;
	placeHolder?: string;
	validate?: (value: string) => string | undefined;
}): Promise<string | undefined> {
	return vscode.window.showInputBox({
		title: options.title,
		prompt: options.prompt,
		value: options.value ?? '',
		placeHolder: options.placeHolder,
		ignoreFocusOut: true,
		validateInput: options.validate,
	});
}

/** Folder picker used by the setup wizard. */
export async function pickDirectory(options: { title: string; defaultUri?: vscode.Uri }): Promise<string | undefined> {
	const result = await vscode.window.showOpenDialog({
		title: options.title,
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Use this folder',
		defaultUri: options.defaultUri,
	});

	return result?.[0]?.fsPath;
}

export interface ErrorDialogOptions {
	logger: Logger;
	/** Extension commands offered as buttons, for example the setup wizard. */
	actions?: { label: string; command: string }[];
}

/** Error dialog with the hint and a button that reveals the output channel. */
export async function showError(error: unknown, options: ErrorDialogOptions): Promise<void> {
	const { logger } = options;
	const switcherError = error instanceof SwitcherError ? error : undefined;
	const message = switcherError?.message ?? errorText(error);

	logger.error(message, switcherError ? undefined : error);

	const showLog = 'Show Log';
	const actions = options.actions ?? [];
	const buttons = actions.map((action) => action.label).concat(showLog);
	const detail = [switcherError?.hint, 'Details are in the "GitHub Switcher" output channel.']
		.filter(Boolean)
		.join('\n\n');

	const choice = await vscode.window.showErrorMessage(
		message,
		{ modal: detail.length > 0, detail },
		...buttons,
	);

	if (choice === showLog) {
		logger.show();
		return;
	}

	const action = actions.find((candidate) => candidate.label === choice);
	if (action) {
		await vscode.commands.executeCommand(action.command);
	}
}

/** Confirmation for destructive maintenance actions such as removing backups. */
export async function confirmDestructive(message: string, confirmLabel: string): Promise<boolean> {
	const answer = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel, 'Cancel');
	return answer === confirmLabel;
}

/** Information dialog with a single button. */
export async function showInfo(message: string, confirmLabel: string, command?: string): Promise<void> {
	const choice = await vscode.window.showInformationMessage(message, confirmLabel);
	if (choice === confirmLabel && command) {
		await vscode.commands.executeCommand(command);
	}
}

/** Warning dialog with buttons. Returns the label the user picked. */
export async function showWarning(message: string, ...buttons: string[]): Promise<string | undefined> {
	return vscode.window.showWarningMessage(message, ...buttons);
}