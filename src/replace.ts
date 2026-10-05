import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { compactTimestamp, errorText, SwitcherError } from './core/errors';
import { Logger } from './logger';

/**
 * Replacement of the workspace directory.
 *
 * The new clone is prepared completely before anything is touched, then the
 * existing directory is renamed out of the way and the clone is moved into its
 * place. A rename is used instead of a recursive delete because VS Code may
 * still have files open in the folder; the renamed directory is removed after
 * the window reloads, or on the next start of the extension.
 */

export const BACKUP_MARKER = '.github-switcher-backup';
export const CLONE_MARKER = '.github-switcher';

export interface ReplaceResult {
	backupPath?: string;
}

export async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

export async function createStagingDirectory(parentDir: string): Promise<string> {
	await fs.mkdir(parentDir, { recursive: true });
	return fs.mkdtemp(path.join(parentDir, CLONE_MARKER));
}

/**
 * Moves `replacement` to `target`. The previous content is renamed to a backup
 * next to it and is never deleted here.
 */
export async function replaceDirectory(
	target: string,
	replacement: string,
	logger: Logger,
): Promise<ReplaceResult> {
	const parentDir = path.dirname(target);
	const backupPath = path.join(parentDir, `${path.basename(target)}${BACKUP_MARKER}-${compactTimestamp()}`);

	if (!(await pathExists(target))) {
		await fs.mkdir(parentDir, { recursive: true });
		await fs.rename(replacement, target);
		return {};
	}

	try {
		await fs.rename(target, backupPath);
		logger.info(`Moved the previous directory to ${backupPath}.`);
	} catch (error) {
		throw new SwitcherError(`Could not move the current workspace directory aside: ${target}`, {
			cause: error,
			hint: 'Close terminals, editors and file watchers that use the folder, then run the command again. The current repository was left untouched.',
		});
	}

	try {
		await fs.rename(replacement, target);
	} catch (error) {
		// Put the original directory back so nothing is lost.
		await fs.rename(backupPath, target).catch((rollbackError: unknown) => {
			logger.error(`Rollback failed, restore ${backupPath} by hand`, rollbackError);
		});
		throw new SwitcherError(`Could not move the cloned repository into place: ${target}`, {
			cause: error,
			hint: 'The previous directory was restored. Try again after closing programs that use the folder.',
		});
	}

	return { backupPath };
}

/** Removes a backup directory created by `replaceDirectory`. */
export async function removeBackup(backupPath: string, logger: Logger): Promise<boolean> {
	if (!(await pathExists(backupPath))) {
		return true;
	}

	try {
		await fs.rm(backupPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
		logger.info(`Removed backup ${backupPath}.`);
		return true;
	} catch (error) {
		logger.warn(`Could not remove ${backupPath}: ${errorText(error)}`);
		return false;
	}
}

/** Backups of `workspaceDir` that a previous switch left behind. */
export async function findBackupDirectories(workspaceDir: string): Promise<string[]> {
	const parentDir = path.dirname(path.resolve(workspaceDir));
	const prefix = `${path.basename(path.resolve(workspaceDir))}${BACKUP_MARKER}-`;

	try {
		const entries = await fs.readdir(parentDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
			.map((entry) => path.join(parentDir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

/** Staging directories that a failed switch left behind. */
export async function findStagingDirectories(workspaceDir: string): Promise<string[]> {
	const parentDir = path.dirname(path.resolve(workspaceDir));

	try {
		const entries = await fs.readdir(parentDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(CLONE_MARKER))
			.map((entry) => path.join(parentDir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

/** Deletes a staging directory without ever throwing. */
export async function discardStaging(dir: string, logger: Logger): Promise<void> {
	try {
		if (await pathExists(dir)) {
			await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
			logger.info(`Removed the unfinished clone at ${dir}.`);
		}
	} catch (error) {
		logger.warn(`Could not remove ${dir}: ${errorText(error)}`);
	}
}