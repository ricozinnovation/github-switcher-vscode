import * as path from 'node:path';

import { AuthStrategy } from './auth';
import { ResolvedConfig, tempBranchForBranch } from './config';
import { errorText, SwitcherError } from './core/errors';
import { assertReplaceableWorkspaceDir } from './core/paths';
import { remoteMatchesRepo, RepoInfo } from './core/repos';
import { GitCredential, httpsCloneUrl } from './core/gitUrl';
import { Git } from './git';
import { RepositoryGit, RemoteOptions, stashMessage } from './gitOps';
import { Logger } from './logger';
import { createStagingDirectory, discardStaging, pathExists, replaceDirectory } from './replace';
import { Task } from './progress';

export interface SwitchResult {
	status: 'switched' | 'already-checked-out' | 'cancelled';
	repository: RepoInfo;
	/** Branch that is checked out in the new workspace. */
	branch?: string;
	/** Branch the current work was saved to before switching. */
	savedBranch?: string;
	restored: boolean;
	backupPath?: string;
}

export interface SaveResult {
	saved: boolean;
	branch?: string;
	fromBranch?: string;
}

/** Everything the switcher needs from the extension host. */
export interface SwitcherContext {
	config: ResolvedConfig;
	logger: Logger;
	git: Git;
	repository: RepositoryGit;
	auth: AuthStrategy;
	/** Directories that must never be replaced, such as the extension itself. */
	protectedDirs: readonly string[];
}

/**
 * Reproduces the behaviour of switch.sh inside VS Code:
 * save the current work to `temp/<user>/<branch>`, clone the selected
 * repository, restore the saved branch if the remote has one, and only then
 * replace the workspace directory.
 */
export class RepositorySwitcher {
	constructor(private readonly context: SwitcherContext) {}

	/**
	 * Saves the working tree of the current repository to a temporary branch
	 * and pushes it, mirroring `save_current_repository` in switch.sh.
	 */
	async saveCurrentWork(task: Task): Promise<SaveResult> {
		const { repository: repo, config, logger } = this.context;
		const dir = config.workspaceDir;

		if (!(await pathExists(dir))) {
			logger.info(`Nothing to save: ${dir} does not exist.`);
			return { saved: false };
		}

		if (!(await repo.isRepositoryRoot(dir))) {
			throw new SwitcherError(`${dir} is not the root of a Git repository.`, {
				hint: 'Point githubSwitcher.workspaceDirectory at the clone you want to switch between.',
			});
		}

		const currentBranch = await repo.currentBranch(dir);
		if (currentBranch === '') {
			throw new SwitcherError('Detached HEAD detected. Check out a branch before switching.', {
				hint: `Run "Git: Checkout to..." in ${dir}, then try again.`,
			});
		}

		const tempBranch = tempBranchForBranch(config, currentBranch);
		task.step(`Current branch ${currentBranch}, saving to ${tempBranch}...`);
		logger.phase(`Save ${config.workspaceDir} (${currentBranch} -> ${tempBranch})`);

		const remoteOptions = this.remoteOptions();
		let stashed = false;

		// Only stash when something would be lost. Ignored files stay ignored.
		if (await repo.hasChanges(dir)) {
			task.report('Stashing uncommitted changes...');
			await repo.stashPush(dir, stashMessage(), { signal: task.signal });
			stashed = true;
		}

		task.report(`Switching to ${tempBranch}...`);
		await repo.switchToOrCreate(dir, tempBranch, { signal: task.signal });

		if (stashed) {
			task.report('Restoring the stash on the temporary branch...');
			const popped = await repo.stashPop(dir, { signal: task.signal });

			if (popped.code !== 0) {
				// The repository stays on the temporary branch so the conflicts can
				// be resolved in place. Nothing is deleted from here on.
				throw new SwitcherError('Stash restoration failed after switching branches.', {
					hint:
						`Resolve the working tree in ${dir} (git stash list, git status), then run the command again. ` +
						'The repository was not deleted.',
				});
			}
		}

		task.report('Committing the saved work...');
		await repo.stageAll(dir);
		const committed = await repo.commitStaged(dir);

		if (!committed) {
			task.report('Nothing new to commit.');
		}

		const originUrl = (await repo.originUrl(dir)) ?? '';
		if (originUrl === '') {
			throw new SwitcherError('The current repository has no origin remote.', {
				hint: 'Saved work stays local; add an origin remote before switching repositories.',
			});
		}

		task.report(`Pushing ${tempBranch}...`);
		const push = await repo.pushBranch(dir, originUrl, tempBranch, { ...remoteOptions, signal: task.signal });
		task.step(`Saved work to origin/${tempBranch}${push.created ? '' : ' (updated)'}.`);

		return { saved: true, branch: tempBranch, fromBranch: currentBranch };
	}

	/** Switches the workspace directory to `target`, saving current work first. */
	async switchTo(
		target: RepoInfo,
		task: Task,
		confirm: (summary: string) => Promise<boolean>,
	): Promise<SwitchResult> {
		const { config, logger, auth } = this.context;
		const workspaceDir = config.workspaceDir;
		const fullName = target.fullName;

		logger.phase(`Switch to ${fullName}`);
		task.step(`Selected repository: ${fullName}`);

		let savedBranch: string | undefined;

		if (await pathExists(workspaceDir)) {
			if (await this.context.repository.isRepositoryRoot(workspaceDir)) {
				const origin = await this.context.repository.originUrl(workspaceDir);

				if (remoteMatchesRepo(origin, fullName)) {
					task.step('This repository is already checked out.');
					return { status: 'already-checked-out', repository: target, restored: false };
				}

				task.step('Saving work in the current repository...');
				const saved = await this.saveCurrentWork(task);

				if (!saved.saved || !saved.branch) {
					throw new SwitcherError(`Could not save the current work in ${workspaceDir}.`);
				}
				savedBranch = saved.branch;
			} else {
				logger.warn(`${workspaceDir} is not a Git repository, replacing it without saving.`);
			}
		}

		const parentDir = path.dirname(workspaceDir);
		const stagingDir = await createStagingDirectory(parentDir);
		let replaced = false;

		try {
			// Clone first. Nothing is removed when cloning fails.
			task.step(`Cloning ${fullName}...`);
			const remoteOptions = this.remoteOptions();
			await this.context.repository.clone(stagingDir, auth.publicUrl(fullName), {
				...remoteOptions,
				signal: task.signal,
			});

			let branch = config.defaultBranch;
			if (!(await this.context.repository.hasFetchedBranch(stagingDir, branch))) {
				branch = target.defaultBranch || 'main';
				task.report(`Branch '${config.defaultBranch}' does not exist, using '${branch}'.`);
				logger.info(`Branch '${config.defaultBranch}' not found in ${fullName}, using '${branch}'.`);
			}

			await this.context.repository.checkoutTracked(stagingDir, branch, { signal: task.signal });

			// Restore this user's saved work for that branch, if it was pushed.
			let restored = false;
			const tempBranch = tempBranchForBranch(config, branch);
			const remoteUrl = httpsCloneUrl(fullName, config.gitHost);

			if (await this.context.repository.hasRemoteBranch(stagingDir, remoteUrl, tempBranch, remoteOptions)) {
				task.step(`Restoring saved work from ${tempBranch}...`);
				await this.context.repository.fetchBranch(stagingDir, remoteUrl, tempBranch, {
					...remoteOptions,
					signal: task.signal,
				});
				await this.context.repository.checkoutTracked(stagingDir, tempBranch, { signal: task.signal });
				restored = true;
				branch = tempBranch;
				task.step(`Restored temporary branch ${tempBranch}.`);
			} else {
				task.report(`No saved work for ${tempBranch}, starting on ${branch}.`);
			}

			if (config.storeCredentials && auth.credential) {
				await this.storeCredential(stagingDir, auth.credential);
			}

			// Only now is the existing directory touched.
			if (await pathExists(workspaceDir)) {
				assertReplaceableWorkspaceDir(workspaceDir, this.context.protectedDirs);

				if (config.confirmBeforeSwitch) {
					const approved = await confirm(this.confirmationSummary(target, branch, workspaceDir));
					if (!approved) {
						task.step('Switch cancelled.');
						return { status: 'cancelled', repository: target, restored, ...(savedBranch ? { savedBranch } : {}) };
					}
				}
			}

			const { backupPath } = await replaceDirectory(workspaceDir, stagingDir, logger);
			replaced = true;

			const currentBranch = await this.context.repository.currentBranch(workspaceDir);
			task.step(`Switched to ${fullName} on ${currentBranch || branch}.`);
			logger.info(`Repository switched: ${fullName} in ${workspaceDir} on ${currentBranch || branch}.`);

			return {
				status: 'switched',
				repository: target,
				branch: currentBranch || branch,
				restored,
				...(savedBranch ? { savedBranch } : {}),
				...(backupPath ? { backupPath } : {}),
			};
		} catch (error) {
			throw this.describeFailure(error, stagingDir, replaced);
		} finally {
			// A cancelled or failed switch must not leave a clone behind.
			if (!replaced) {
				await discardStaging(stagingDir, logger);
			}
		}
	}

	/** Text shown in the confirmation dialog before the workspace is replaced. */
	confirmationSummary(target: RepoInfo, branch: string, workspaceDir: string): string {
		const { config, logger } = this.context;

		if (config.username && target.owner && target.owner.toLowerCase() !== config.username.toLowerCase()) {
			logger.info(`${target.owner} is not ${config.username}; work will not be restored for this repository.`);
		}

		return [
			`Replace the workspace folder with ${target.fullName}?`,
			'',
			`Folder:   ${workspaceDir}`,
			`Branch:   ${branch}`,
			'',
			'Uncommitted work in the current repository has already been saved to a temporary branch.',
			'The previous folder is kept as a backup next to it until the window reloads.',
		].join('\n');
	}

	/** Credential options applied to every remote git command of a switch. */
	private remoteOptions(): RemoteOptions {
		const { auth, logger } = this.context;

		// The GitHub CLI kind authenticates through the credential helper that
		// `gh auth setup-git` installed, so no URL credentials are needed.
		if (auth.kind === 'token' && auth.credential) {
			logger.debug('Remote operations authenticate with the access token in the URL.');
			return { credential: auth.credential };
		}

		logger.debug('Remote operations authenticate through the GitHub CLI credential helper.');
		return {};
	}

	private async storeCredential(dir: string, credential: GitCredential): Promise<void> {
		try {
			await this.context.repository.storeCredential(dir, credential);
		} catch (error) {
			this.context.logger.warn(`Could not store the access token in the credential helper: ${errorText(error)}`);
		}
	}

	/** Adds context to failures that happen before the workspace was replaced. */
	private describeFailure(error: unknown, stagingDir: string, replaced: boolean): unknown {
		if (replaced || error instanceof SwitcherError) {
			return error;
		}
		return new SwitcherError(`Switch failed: ${errorText(error)}`, {
			cause: error,
			hint: `The clone in ${stagingDir} was discarded. Your current repository was not deleted.`,
		});
	}
}