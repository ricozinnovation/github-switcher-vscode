import * as os from 'node:os';
import * as path from 'node:path';

import { SwitcherError } from './errors';

/** This module must not import `vscode`. */

/** Expands a leading `~` to the home directory. */
export function expandHome(input: string): string {
	if (input === '~') {
		return os.homedir();
	}
	if (input.startsWith('~/') || input.startsWith('~\\')) {
		return path.join(os.homedir(), input.slice(2));
	}
	return input;
}

/**
 * Resolves the directory that gets replaced when switching repositories.
 * Relative paths are resolved against `baseDir`, which is the directory of the
 * config file or the folder that is open in VS Code.
 */
export function resolveWorkspacePath(input: string, baseDir: string | undefined): string {
	const expanded = expandHome(input.trim());
	if (expanded === '') {
		throw new SwitcherError('No workspace directory is configured.');
	}
	// resolve() also keeps the drive letter of a rooted path on Windows, which
	// normalize() would drop.
	return path.resolve(baseDir ?? process.cwd(), expanded);
}

/**
 * Converts a branch name into the temporary branch that holds saved work.
 *
 * `temp/alice` + `develop` -> `temp/alice/develop`
 * `temp/alice` + `temp/alice/develop` -> `temp/alice/develop`
 */
export function tempBranchFor(prefix: string, username: string, branch: string): string {
	const base = `${trimSlashes(prefix)}/${trimSlashes(username)}`;
	return branch === base || branch.startsWith(`${base}/`) ? branch : `${base}/${branch}`;
}

function trimSlashes(value: string): string {
	return value.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
}

/** True when `parent` is `candidate` itself or one of its ancestors. */
export function containsPath(parent: string, candidate: string): boolean {
	const normalizedParent = path.resolve(parent);
	const normalizedCandidate = path.resolve(candidate);
	if (normalizedParent === normalizedCandidate) {
		return true;
	}
	const relative = path.relative(normalizedParent, normalizedCandidate);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Guards against deleting something important when the workspace directory is
 * replaced. `extra` typically holds the extension install directory.
 */
export function isProtectedPath(target: string, extra: readonly string[] = []): boolean {
	const resolved = path.resolve(target);
	if (resolved === path.parse(resolved).root) {
		return true;
	}
	if (resolved === path.resolve(os.homedir())) {
		return true;
	}
	if (resolved === path.resolve(os.tmpdir())) {
		return true;
	}
	return extra.filter(Boolean).some((candidate) => containsPath(resolved, path.resolve(candidate)));
}

/** Throws a descriptive error when the workspace directory must not be replaced. */
export function assertReplaceableWorkspaceDir(target: string, extra: readonly string[] = []): void {
	if (!isProtectedPath(target, extra)) {
		return;
	}
	throw new SwitcherError(`Refusing to replace a protected directory: ${path.resolve(target)}`, {
		hint: 'Set githubSwitcher.workspaceDirectory to a dedicated directory that only contains the repository you want to switch between.',
	});
}
