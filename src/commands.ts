import * as vscode from 'vscode';

import {
	getRawSettings,
	readStoredToken,
	storeToken,
	updateSetting,
} from './config';
import { SwitcherController } from './controller';
import { RepoInfo } from './core/repos';
import { maskSecret } from './core/redact';
import { Logger } from './logger';
import { flashStatus, runWithTask } from './progress';
import { findBackupDirectories, removeBackup } from './replace';
import {
	confirmDestructive,
	confirmReplacement,
	pickDirectory,
	pickRepository,
	promptString,
	promptToken,
	showInfo,
	showWarning,
} from './ui';

/** Registers every command of the extension. */
export function registerCommands(context: vscode.ExtensionContext, controller: SwitcherController, logger: Logger): void {
	const register = (command: string, handler: (...args: unknown[]) => Promise<void>): void => {
		context.subscriptions.push(
			vscode.commands.registerCommand(command, async (...args: unknown[]) => {
				await controller.safe(() => handler(...args));
			}),
		);
	};

	register('githubSwitcher.switchRepository', (arg) => switchRepository(controller, logger, arg));
	register('githubSwitcher.saveCurrentWork', () => saveCurrentWork(controller, logger));
	register('githubSwitcher.refreshRepositories', () => refreshRepositories(controller, logger));
	register('githubSwitcher.setup', () => runSetup(context, controller, logger));
	register('githubSwitcher.setToken', () => setToken(context, controller, logger));
	register('githubSwitcher.setUsername', () => setUsername(controller, logger));
	register('githubSwitcher.setWorkspaceDirectory', () => setWorkspaceDirectory(controller, logger));
	register('githubSwitcher.cleanupBackups', () => cleanupBackups(controller, logger));
}

/** Picks a repository when the command was invoked without an argument. */
async function switchRepository(controller: SwitcherController, logger: Logger, arg: unknown): Promise<void> {
	const preselected = repositoryFromArgument(arg);

	const result = await runWithTask(logger, preselected ? `Switch to ${preselected.fullName}` : 'Switch Repository', async (task) => {
		const session = await controller.getSession();

		if (!(await session.git.isAvailable())) {
			throw new Error(`The git executable "${session.config.gitPath}" is not available.`);
		}

		const current = await controller.currentRepository();
		const target =
			preselected ??
			(await pickRepository(await controller.listRepositories({ signal: task.signal }), current.fullName));

		if (!target) {
			task.step('Cancelled.');
			return undefined;
		}

		const switchResult = await session.switcher.switchTo(target, task, (summary) =>
			confirmReplacement(summary),
		);

		return switchResult;
	});

	if (!result) {
		return;
	}

	await controller.announceResult(result);
}

async function saveCurrentWork(controller: SwitcherController, logger: Logger): Promise<void> {
	const saved = await runWithTask(logger, 'Save Current Work', async (task) => {
		const session = await controller.getSession();
		return session.switcher.saveCurrentWork(task);
	});

	if (!saved) {
		return;
	}

	if (!saved.saved) {
		void vscode.window.showInformationMessage('GitHub Switcher: nothing to save.');
		return;
	}

	flashStatus(`Saved ${saved.fromBranch} to origin/${saved.branch}`);
	void vscode.window.showInformationMessage(`Saved ${saved.fromBranch} to origin/${saved.branch}.`);
}

async function refreshRepositories(controller: SwitcherController, logger: Logger): Promise<void> {
	controller.invalidateCache();

	const repositories = await runWithTask(logger, 'Refreshing Repositories', async (task) =>
		controller.listRepositories({ force: true, signal: task.signal }),
	);

	if (repositories) {
		flashStatus(`${repositories.length} repositories loaded`);
		await controller.refreshStatusBar();
	}
}

/** Wizard that makes the extension usable from scratch. */
async function runSetup(
	context: vscode.ExtensionContext,
	controller: SwitcherController,
	logger: Logger,
): Promise<void> {
	const settings = getRawSettings();
	const storedToken = await readStoredToken(context);

	if (storedToken === '') {
		const answer = await showWarning(
			'No access token is stored. Create a token with the "repo" scope at https://github.com/settings/tokens/new.',
			'Paste token',
			'Use GitHub CLI',
			'Cancel',
		);

		if (answer === 'Paste token') {
			const token = await promptToken();
			if (token) {
				await storeToken(context, token);
				logger.trackSecret(token);
				logger.info(`Stored an access token (${maskSecret(token)}) in SecretStorage.`);
				controller.resetSession();
			}
		} else if (answer === 'Use GitHub CLI') {
			const terminal = vscode.window.createTerminal({ name: 'GitHub CLI', hideFromUser: false });
			terminal.show();
			terminal.sendText('gh auth login');
			void vscode.window.showInformationMessage('Finish "gh auth login" in the terminal, then run Setup again.');
			return;
		} else {
			return;
		}
	}

	// Verifying the token now also yields the login for temporary branch names.
	let login: string | undefined;
	try {
		const credentials = await controller.getSession();
		login = credentials.credentials.login;
		flashStatus(`Authenticated as ${credentials.credentials.login}`);
	} catch (error) {
		await vscode.window.showErrorMessage(
			`Setup could not verify the credentials: ${error instanceof Error ? error.message : String(error)}`,
		);
		controller.resetSession();
		return;
	}

	if (settings.githubUsername === '' && login) {
		await updateSetting('githubUsername', login);
		logger.info(`Set githubSwitcher.githubUsername to ${login}.`);
	}

	if (settings.workspaceDirectory === '' && settings.configFile === '') {
		const folder = await pickDirectory({
			title: 'Select the folder that gets switched between repositories',
			defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
		});

		if (folder) {
			await updateSetting('workspaceDirectory', folder);
			logger.info(`Set githubSwitcher.workspaceDirectory to ${folder}.`);
		}
	}

	controller.resetSession();
	await controller.refreshStatusBar();

	await showInfo(
		`Setup complete. Sign in as ${login ?? 'your account'}.`,
		'Switch Repository',
		'githubSwitcher.switchRepository',
	);
}

async function setToken(
	context: vscode.ExtensionContext,
	controller: SwitcherController,
	logger: Logger,
): Promise<void> {
	const existing = await readStoredToken(context);

	const token = await promptToken({
		value: existing,
		prompt: existing
			? `Replace the stored token (${maskSecret(existing)}). It is saved in VS Code SecretStorage.`
			: 'Paste a personal access token with the "repo" scope. It is saved in VS Code SecretStorage.',
	});

	if (!token) {
		return;
	}

	await storeToken(context, token);
	logger.info(`Stored an access token (${maskSecret(token)}) in SecretStorage.`);
	logger.trackSecret(token);
	controller.resetSession();

	try {
		const session = await controller.getSession();
		flashStatus(`Authenticated as ${session.credentials.login}`);
	} catch (error) {
		logger.warn(`The stored token could not be verified: ${error instanceof Error ? error.message : String(error)}`);
		void vscode.window.showWarningMessage(
			`The token was stored but could not be verified: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function setUsername(controller: SwitcherController, logger: Logger): Promise<void> {
	let suggestion = getRawSettings().githubUsername;

	try {
		suggestion = (await controller.getSession()).credentials.login;
	} catch {
		// Authentication is not available yet, keep whatever is configured.
	}

	const username = await promptString({
		title: 'GitHub Switcher',
		prompt: 'Used for temporary branch names of the form temp/<username>/<branch>.',
		value: suggestion,
		placeHolder: 'octocat',
		validate: (value) => (value.trim() === '' ? 'A username is required.' : undefined),
	});

	if (!username) {
		return;
	}

	await updateSetting('githubUsername', username.trim());
	logger.info(`Set githubSwitcher.githubUsername to ${username.trim()}.`);
	controller.resetSession();
	flashStatus(`Username set to ${username.trim()}`);
}

async function setWorkspaceDirectory(controller: SwitcherController, logger: Logger): Promise<void> {
	const current = (await controller.getSession().catch(() => undefined))?.config.workspaceDir;

	const folder = await pickDirectory({
		title: 'Select the folder that gets replaced when switching repositories',
		defaultUri: current ? vscode.Uri.file(current) : vscode.workspace.workspaceFolders?.[0]?.uri,
	});

	if (!folder) {
		return;
	}

	await updateSetting('workspaceDirectory', folder);
	logger.info(`Set githubSwitcher.workspaceDirectory to ${folder}.`);
	controller.resetSession();
	await controller.refreshStatusBar();
	flashStatus(`Workspace directory set to ${folder}`);
}

async function cleanupBackups(controller: SwitcherController, logger: Logger): Promise<void> {
	const { config } = await controller.getSession();
	const backups = await findBackupDirectories(config.workspaceDir);

	if (backups.length === 0) {
		void vscode.window.showInformationMessage('GitHub Switcher: no leftover backups.');
		return;
	}

	const approved = await confirmDestructive(
		`Delete ${backups.length} leftover backup folder(s)?\n\n${backups.join('\n')}`,
		'Delete Backups',
	);

	if (!approved) {
		return;
	}

	let removed = 0;
	for (const backup of backups) {
		if (await removeBackup(backup, logger)) {
			removed++;
		}
	}

	flashStatus(`Removed ${removed} backup folder(s)`);
}

/** Accepts both a tree node and a plain repository argument. */
function repositoryFromArgument(arg: unknown): RepoInfo | undefined {
	if (!arg) {
		return undefined;
	}

	if (typeof arg === 'object' && 'repository' in arg) {
		const repository = (arg as { repository?: RepoInfo }).repository;
		if (repository?.fullName) {
			return repository;
		}
	}

	if (typeof arg === 'object' && 'fullName' in arg) {
		return arg as RepoInfo;
	}

	if (typeof arg === 'string' && arg.includes('/')) {
		return {
			fullName: arg,
			owner: arg.slice(0, arg.indexOf('/')),
			name: arg.slice(arg.indexOf('/') + 1),
			defaultBranch: 'main',
			isPrivate: false,
		};
	}

	return undefined;
}