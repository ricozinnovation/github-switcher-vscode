import * as vscode from 'vscode';

import { registerCommands } from './commands';
import { SwitcherController } from './controller';
import { Logger } from './logger';
import { RepositoryTreeProvider } from './tree';

/**
 * Public API of the extension, so other extensions can drive a switch.
 */
export interface GitHubSwitcherApi {
	/** Repositories of the authenticated account. */
	listRepositories(): Promise<{ fullName: string; defaultBranch: string; isPrivate: boolean }[]>;
	/** Switches the workspace to `fullName`. */
	switchRepository(fullName: string): Promise<void>;
	/** Absolute path of the directory that is replaced when switching. */
	workspaceDirectory(): Promise<string>;
}

export async function activate(context: vscode.ExtensionContext): Promise<GitHubSwitcherApi> {
	const logger = new Logger('GitHub Switcher');
	const controller = new SwitcherController(context, logger);
	const tree = new RepositoryTreeProvider(controller, logger);

	context.subscriptions.push(
		logger,
		controller,
		tree,
		vscode.window.registerTreeDataProvider('githubSwitcher.repositories', tree),
	);

	registerCommands(context, controller, logger);
	logger.info('GitHub Switcher activated. Output channel is ready.');

	// Never let activation fail: an unconfigured workspace is a valid state.
	void controller.initialize().then(() => controller.offerLeftoverCleanup());

	return {
		async listRepositories() {
			const repositories = await controller.listRepositories();
			return repositories.map((repository) => ({
				fullName: repository.fullName,
				defaultBranch: repository.defaultBranch,
				isPrivate: repository.isPrivate,
			}));
		},
		async switchRepository(fullName: string) {
			await vscode.commands.executeCommand('githubSwitcher.switchRepository', fullName);
		},
		async workspaceDirectory() {
			return (await controller.getSession()).config.workspaceDir;
		},
	};
}

export function deactivate(): void {
	// Everything is registered in context.subscriptions.
}