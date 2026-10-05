import * as path from 'node:path';

import { compactTimestamp, SwitcherError } from './core/errors';
import { GitStatus, parseGitStatus } from './core/gitStatus';
import { GitCredential, hostFromUrl, injectCredentials } from './core/gitUrl';
import { Git, RunOptions, RunResult } from './git';
import { Logger } from './logger';

/** Identity used for the automatic "save work" commit. */
const COMMIT_NAME = 'GitHub Switcher';
const COMMIT_EMAIL = 'github-switcher@users.noreply.github.com';
const COMMIT_MESSAGE = 'chore: save work before repository switch';

export interface PushResult {
	created: boolean;
}

/** Run options for every command that talks to a remote. */
export interface RemoteOptions extends RunOptions {
	/** Credentials injected into the URL for this call only. */
	credential?: GitCredential;
}

/**
 * Repository level git operations. Every method takes the directory it works
 * in, so the same instance can touch several clones during a switch.
 */
export class RepositoryGit {
	constructor(
		private readonly git: Git,
		private readonly logger: Logger,
	) {}

	async isRepository(dir: string): Promise<boolean> {
		const result = await this.git.run(['rev-parse', '--is-inside-work-tree'], { cwd: dir, allowFailure: true });
		return result.code === 0 && result.stdout.trim() === 'true';
	}

	/** True when `dir` itself is the root of a repository, not a subdirectory. */
	async isRepositoryRoot(dir: string): Promise<boolean> {
		const result = await this.git.run(['rev-parse', '--show-toplevel'], { cwd: dir, allowFailure: true });
		return result.code === 0 && path.resolve(result.stdout.trim()) === path.resolve(dir);
	}

	async originUrl(dir: string): Promise<string | undefined> {
		const result = await this.git.run(['remote', 'get-url', 'origin'], { cwd: dir, allowFailure: true });
		const url = result.stdout.trim();
		return url === '' ? undefined : url;
	}

	async status(dir: string): Promise<GitStatus> {
		const result = await this.git.run(['status', '--porcelain=v1', '--branch'], { cwd: dir, allowFailure: true });
		if (result.code !== 0) {
			return parseGitStatus('');
		}
		return parseGitStatus(result.stdout);
	}

	/** Empty string when HEAD is detached. */
	async currentBranch(dir: string): Promise<string> {
		const result = await this.git.run(['branch', '--show-current'], { cwd: dir, allowFailure: true });
		return result.stdout.trim();
	}

	async hasLocalBranch(dir: string, branch: string): Promise<boolean> {
		const result = await this.git.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
			cwd: dir,
			allowFailure: true,
		});
		return result.code === 0;
	}

	/** Checks the remote-tracking refs that a fresh clone provides. */
	async hasFetchedBranch(dir: string, branch: string): Promise<boolean> {
		const result = await this.git.run(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
			cwd: dir,
			allowFailure: true,
		});
		return result.code === 0;
	}

	/** Asks the remote whether a branch exists. */
	async hasRemoteBranch(dir: string, remoteUrl: string, branch: string, options: RemoteOptions = {}): Promise<boolean> {
		const result = await this.git.run(['ls-remote', '--exit-code', '--heads', injectCredentials(remoteUrl, options.credential), branch], {
			cwd: dir,
			allowFailure: true,
			...options,
		});
		return result.code === 0;
	}

	/** Any unstaged, staged or untracked change, ignoring ignored files. */
	async hasChanges(dir: string): Promise<boolean> {
		const unstaged = await this.git.run(['diff', '--quiet'], { cwd: dir, allowFailure: true });
		const staged = await this.git.run(['diff', '--cached', '--quiet'], { cwd: dir, allowFailure: true });
		if (unstaged.code !== 0 || staged.code !== 0) {
			return true;
		}
		const untracked = await this.git.run(['ls-files', '--others', '--exclude-standard'], { cwd: dir });
		return untracked.stdout.trim() !== '';
	}

	async stashPush(dir: string, message: string, options: RunOptions = {}): Promise<void> {
		await this.git.run(['stash', 'push', '--include-untracked', '-m', message], { cwd: dir, ...options });
	}

	async stashPop(dir: string, options: RunOptions = {}): Promise<RunResult> {
		return this.git.run(['stash', 'pop'], { cwd: dir, allowFailure: true, ...options });
	}

	/** `git switch` when the branch exists, `git switch -c` otherwise. */
	async switchToOrCreate(dir: string, branch: string, options: RunOptions = {}): Promise<void> {
		if (await this.hasLocalBranch(dir, branch)) {
			await this.git.run(['switch', branch], { cwd: dir, ...options });
			return;
		}
		await this.git.run(['switch', '-c', branch], { cwd: dir, ...options });
	}

	async stageAll(dir: string): Promise<void> {
		await this.git.run(['add', '-A'], { cwd: dir });
	}

	/** Commits everything that is staged. Returns false when there was nothing to commit. */
	async commitStaged(dir: string, message: string = COMMIT_MESSAGE): Promise<boolean> {
		const clean = await this.git.run(['diff', '--cached', '--quiet'], { cwd: dir, allowFailure: true });
		if (clean.code === 0) {
			return false;
		}
		await this.git.run(['-c', `user.name=${COMMIT_NAME}`, '-c', `user.email=${COMMIT_EMAIL}`, 'commit', '-m', message], {
			cwd: dir,
		});
		return true;
	}

	/**
	 * Pushes a branch without touching the stored remote URL. Credentials are
	 * added per command so they never end up in `.git/config`, and
	 * `--force-with-lease` guards the remote branch against concurrent writes.
	 */
	async pushBranch(
		dir: string,
		remoteUrl: string,
		branch: string,
		options: RemoteOptions = {},
	): Promise<PushResult> {
		const authUrl = injectCredentials(remoteUrl, options.credential);
		const existing = await this.remoteBranchSha(dir, authUrl, branch);
		const args = ['push'];

		if (existing) {
			args.push(`--force-with-lease=${branch}:${existing}`);
		}
		args.push(authUrl, `refs/heads/${branch}:refs/heads/${branch}`);

		await this.git.run(args, { cwd: dir, ...options });

		// Keep the remote-tracking ref and the upstream configuration in sync.
		const sha = await this.remoteBranchSha(dir, authUrl, branch);
		if (sha) {
			await this.git.run(['update-ref', `refs/remotes/origin/${branch}`, sha], { cwd: dir, allowFailure: true });
			await this.git.run(['branch', `--set-upstream-to=origin/${branch}`, branch], { cwd: dir, allowFailure: true });
		}

		return { created: !existing };
	}

	async clone(dir: string, url: string, options: RemoteOptions = {}): Promise<void> {
		await this.git.run(['clone', injectCredentials(url, options.credential), dir], options);
	}

	/** Fetches one branch into `refs/remotes/origin/<branch>` and returns its sha. */
	async fetchBranch(dir: string, remoteUrl: string, branch: string, options: RemoteOptions = {}): Promise<string | undefined> {
		const authUrl = injectCredentials(remoteUrl, options.credential);
		await this.git.run(
			['fetch', authUrl, `+refs/heads/${branch}:refs/remotes/origin/${branch}`, '--no-tags'],
			{ cwd: dir, ...options },
		);
		const result = await this.git.run(['rev-parse', `refs/remotes/origin/${branch}`], { cwd: dir });
		return result.stdout.trim() || undefined;
	}

	/**
	 * Checks out a branch that has a remote-tracking ref. Falls back to a plain
	 * switch when the local branch already exists, for example when the clone
	 * already checked out the default branch.
	 */
	async checkoutTracked(dir: string, branch: string, options: RunOptions = {}): Promise<void> {
		const tracked = await this.git.run(['switch', '--track', '-c', branch, `origin/${branch}`], {
			cwd: dir,
			allowFailure: true,
			...options,
		});

		if (tracked.code === 0) {
			return;
		}

		const fallback = await this.git.run(['switch', branch], { cwd: dir, allowFailure: true, ...options });
		if (fallback.code !== 0) {
			throw new SwitcherError(`Could not check out branch "${branch}".`, {
				hint: `${firstLine(fallback.stderr) || firstLine(tracked.stderr)}`,
			});
		}
	}

	/**
	 * Hands the token to the git credential store of this repository so plain
	 * `git pull` and `git push` keep working after a switch.
	 */
	async storeCredential(dir: string, credential: GitCredential): Promise<void> {
		const helper = await this.credentialHelper(dir);
		if (!helper) {
			this.logger.info('No git credential helper found, skipping credential storage.');
			return;
		}

		await this.git.run(['config', '--local', `credential.${helper}.username`, credential.username], {
			cwd: dir,
			allowFailure: true,
		});

		const payload = [
			'protocol=https',
			`host=${credential.host}`,
			`username=${credential.username}`,
			`password=${credential.password}`,
			'',
			'',
		].join('\n');

		const approved = await this.git.run(['credential', 'approve'], { cwd: dir, input: payload, allowFailure: true });
		this.logger.info(
			approved.code === 0
				? `Stored the access token in the "${helper}" credential helper.`
				: `Could not store the access token in the "${helper}" credential helper: ${firstLine(approved.stderr)}`,
		);
	}

	private async remoteBranchSha(dir: string, url: string, branch: string): Promise<string | undefined> {
		const result = await this.git.run(['ls-remote', '--heads', url, `refs/heads/${branch}`], {
			cwd: dir,
			allowFailure: true,
		});
		const [sha] = result.stdout.trim().split(/\s+/);
		return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
	}

	private async credentialHelper(dir: string): Promise<string | undefined> {
		const local = await this.git.run(['config', '--local', '--get', 'credential.helper'], {
			cwd: dir,
			allowFailure: true,
		});
		const inherited = await this.git.run(['config', '--get', 'credential.helper'], { allowFailure: true });
		const configured = (local.stdout.trim() || inherited.stdout.trim()).split(/\r?\n/)[0]?.trim();

		if (configured) {
			return configured;
		}
		if (process.platform === 'win32') {
			return 'manager';
		}
		if (process.platform === 'darwin') {
			return 'osxkeychain';
		}
		return undefined;
	}
}

/** Builds the credential used for https remotes. */
export function tokenCredential(token: string, remoteUrl: string): GitCredential {
	return { host: hostFromUrl(remoteUrl), username: 'x-access-token', password: token };
}

/** Stash message used by the save step, mirroring switch.sh. */
export function stashMessage(date: Date = new Date()): string {
	return `github-switcher-${compactTimestamp(date)}`;
}

function firstLine(value: string): string {
	return value.trim().split(/\r?\n/, 1)[0] ?? '';
}