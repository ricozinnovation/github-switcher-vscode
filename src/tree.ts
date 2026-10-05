import * as vscode from 'vscode';

import { SwitcherController } from './controller';
import { groupByOwner, RepoInfo } from './core/repos';
import { Logger } from './logger';

/** Tree items of the repository view. */
export type RepositoryNode = OwnerNode | RepoNode | MessageNode;

export interface OwnerNode {
	kind: 'owner';
	owner: string;
	repositories: RepoInfo[];
}

export interface RepoNode {
	kind: 'repository';
	repository: RepoInfo;
	isCurrent: boolean;
	dirty: number;
	branch: string;
}

export interface MessageNode {
	kind: 'message';
	label: string;
	detail?: string;
	command?: { command: string; title: string; arguments?: unknown[] };
}

/**
 * Repository picker in the Activity Bar. Repositories are grouped by owner and
 * the checked out repository is marked with a checkmark.
 */
export class RepositoryTreeProvider implements vscode.TreeDataProvider<RepositoryNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<RepositoryNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(
		private readonly controller: SwitcherController,
		private readonly logger: Logger,
	) {
		controller.onDidChange(() => this.refresh());
	}

	refresh(): void {
		this.emitter.fire(undefined);
	}

	getTreeItem(node: RepositoryNode): vscode.TreeItem {
		switch (node.kind) {
			case 'owner':
				return this.ownerItem(node);
			case 'repository':
				return this.repositoryItem(node);
			case 'message':
				return this.messageItem(node);
		}
	}

	async getChildren(node?: RepositoryNode): Promise<RepositoryNode[]> {
		if (node?.kind === 'owner') {
			const current = await this.controller.currentRepository();
			return node.repositories.map((repository) => toRepoNode(repository, current, repository.defaultBranch));
		}

		if (node) {
			return [];
		}

		// Check the session first: an unconfigured workspace needs the wizard,
		// not an error message about loading repositories.
		try {
			await this.controller.getSession();
		} catch (error) {
			this.logger.info(`Repository view is waiting for setup: ${error instanceof Error ? error.message : String(error)}`);
			return [
				{
					kind: 'message',
					label: 'Setup required',
					detail: 'Set a GitHub token, or sign in with the GitHub CLI.',
					command: { command: 'githubSwitcher.setup', title: 'Run Setup' },
				},
			];
		}

		const repositories = await this.controller.tryListRepositories();
		if (repositories === undefined) {
			return [
				{
					kind: 'message',
					label: 'Could not load repositories',
					detail: 'Check the output channel, or run Setup again.',
					command: { command: 'githubSwitcher.refreshRepositories', title: 'Refresh Repository List' },
				},
			];
		}

		if (repositories.length === 0) {
			return [{ kind: 'message', label: 'No repositories found for this account.' }];
		}

		const current = await this.controller.currentRepository();
		this.logger.debug(`Rendering ${repositories.length} repositories for ${current.fullName ?? 'no current repository'}.`);

		return groupByOwner(repositories).map((group) => ({
			kind: 'owner' as const,
			owner: group.owner,
			repositories: group.repositories,
		}));
	}

	dispose(): void {
		this.emitter.dispose();
	}

	private ownerItem(node: OwnerNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.owner, vscode.TreeItemCollapsibleState.Collapsed);
		item.contextValue = 'owner';
		item.iconPath = new vscode.ThemeIcon('organization');
		item.description = `${node.repositories.length}`;
		item.tooltip = `${node.repositories.length} repository(ies) of ${node.owner}`;
		return item;
	}

	private repositoryItem(node: RepoNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.repository.fullName, vscode.TreeItemCollapsibleState.None);
		const branch = node.branch || node.repository.defaultBranch;
		const dirty = node.dirty > 0 ? ` \u00b7 ${node.dirty} change(s)` : '';

		item.label = `${node.isCurrent ? '$(check) ' : ''}${node.repository.name}`;
		item.description = `${branch}${dirty}`;
		item.iconPath = new vscode.ThemeIcon(node.repository.isPrivate ? 'lock' : 'repo');
		item.contextValue = node.isCurrent ? 'repository current' : 'repository';
		item.tooltip = [
			`$(repo) **${node.repository.fullName}**`,
			'',
			`Default branch: \`${node.repository.defaultBranch}\``,
			`Current branch: \`${branch}\``,
			`Visibility: ${node.repository.isPrivate ? 'private' : 'public'}`,
			node.dirty > 0 ? `Uncommitted changes in ${node.dirty} file(s).` : '',
			'',
			'Click to switch the workspace to this repository.',
		]
			.filter((line) => line !== '')
			.join('\n\n');

		item.command = {
			command: 'githubSwitcher.switchRepository',
			title: 'Switch Repository',
			arguments: [node.repository],
		};

		return item;
	}

	private messageItem(node: MessageNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('info');
		item.tooltip = node.detail;

		if (node.command) {
			item.command = node.command;
		}

		return item;
	}
}

function toRepoNode(repository: RepoInfo, current: { fullName?: string; dirty: number; branch: string }, fallbackBranch: string): RepoNode {
	return {
		kind: 'repository',
		repository,
		isCurrent: current.fullName === repository.fullName,
		dirty: current.fullName === repository.fullName ? current.dirty : 0,
		branch: current.fullName === repository.fullName ? current.branch : fallbackBranch,
	};
}