/**
 * Integration check for the git facing logic of the switcher, without VS Code.
 *
 * Builds two throwaway repositories, saves work on one of them, clones the
 * other, restores the temporary branch and replaces the workspace directory
 * through a rename. Run with: npm run test:integration
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Redirect `require('vscode')` to the stub before loading anything that uses
 * it. TypeScript emits `require` calls in import order, so this has to run
 * first and every module below is loaded lazily.
 */
function installVscodeStub(): void {
	const moduleInternals = Module as unknown as {
		_resolveFilename(request: string, ...args: unknown[]): string;
	};
	const original = moduleInternals._resolveFilename.bind(moduleInternals);

	moduleInternals._resolveFilename = function (request: string, ...args: unknown[]): string {
		if (request === 'vscode') {
			return require.resolve('./vscodeStub');
		}
		return original(request, ...args);
	};
}

installVscodeStub();

/* eslint-disable @typescript-eslint/no-var-requires */
type GitModule = typeof import('../git');
type GitOpsModule = typeof import('../gitOps');
type LoggerModule = typeof import('../logger');
type ReplaceModule = typeof import('../replace');
type ReposModule = typeof import('../core/repos');
type PathsModule = typeof import('../core/paths');
type StatusModule = typeof import('../core/gitStatus');

const { Git } = require('../git') as GitModule;
const { RepositoryGit } = require('../gitOps') as GitOpsModule;
const { Logger } = require('../logger') as LoggerModule;
const { replaceDirectory, findBackupDirectories, removeBackup } = require('../replace') as ReplaceModule;
const { normalizeRemoteUrl, remoteMatchesRepo } = require('../core/repos') as ReposModule;
const { tempBranchFor } = require('../core/paths') as PathsModule;
const { parseGitStatus } = require('../core/gitStatus') as StatusModule;

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function assert(condition: unknown, message: string): void {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
	console.log(`  ok  ${message}`);
}

/** Creates a working repository plus a bare remote, and returns the remote path. */
function createRepository(root: string, name: string, branch: string): string {
	const work = path.join(root, `remote-${name}`);
	fs.mkdirSync(work, { recursive: true });
	git(work, 'init', '--initial-branch', branch);
	git(work, 'config', 'user.email', 'test@example.com');
	git(work, 'config', 'user.name', 'Test');
	fs.writeFileSync(path.join(work, 'README.md'), `# ${name}\n`);
	git(work, 'add', '-A');
	git(work, 'commit', '-m', 'initial commit');

	const remote = path.join(root, `remote-${name}.git`);
	git(root, 'clone', '--bare', work, remote);
	return remote;
}

async function main(): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-switcher-integration-'));
	const logger = new Logger('GitHub Switcher Integration');
	const gitClient = new Git('git', logger);
	const repo = new RepositoryGit(gitClient, logger);

	try {
		const remoteA = createRepository(root, 'alpha', 'develop');
		const remoteB = createRepository(root, 'beta', 'main');
		const workspace = path.join(root, 'workspace');

		console.log('1. save work on the current repository');
		await gitClient.run(['clone', remoteA, workspace], { timeoutMs: 120_000 });
		await repo.checkoutTracked(workspace, 'develop');

		fs.writeFileSync(path.join(workspace, 'feature.txt'), 'work in progress\n');
		assert(await repo.hasChanges(workspace), 'detects uncommitted changes');

		const status = await repo.status(workspace);
		assert(status.branch === 'develop', 'reads the current branch');
		assert(status.changedFiles === 1 && status.untracked === 1, 'counts the untracked file');
		assert(parseGitStatus('## main...origin/main [ahead 1]').ahead === 1, 'status parser understands ahead/behind');

		const tempBranch = tempBranchFor('temp', 'tester', 'develop');
		await repo.stashPush(workspace, 'github-switcher-test');
		await repo.switchToOrCreate(workspace, tempBranch);
		assert((await repo.stashPop(workspace)).code === 0, 'stash pop succeeds on the temporary branch');

		await repo.stageAll(workspace);
		assert(await repo.commitStaged(workspace), 'commits the saved work');

		const push = await repo.pushBranch(workspace, remoteA, tempBranch);
		assert(push.created, 'pushes a new remote branch');
		assert((await repo.originUrl(workspace)) === remoteA, 'origin still holds the clean remote URL');
		assert(
			git(workspace, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', `${tempBranch}@{upstream}`) ===
				`origin/${tempBranch}`,
			'sets the upstream of the temporary branch',
		);

		const secondPush = await repo.pushBranch(workspace, remoteA, tempBranch);
		assert(!secondPush.created, 'recognises an existing remote branch');

		console.log('2. clone the other repository and restore the saved branch');
		const staging = path.join(root, '.github-switcher.stage');
		await repo.clone(staging, remoteB);
		await repo.checkoutTracked(staging, (await repo.hasFetchedBranch(staging, 'develop')) ? 'develop' : 'main');

		const branch = git(staging, 'branch', '--show-current');
		assert(branch === 'main', 'falls back to the repository default branch when develop is absent');

		const tempBranchB = tempBranchFor('temp', 'tester', branch);
		assert(
			(await repo.hasRemoteBranch(staging, remoteB, tempBranchB)) === (branch === 'develop'),
			'ls-remote finds the saved branch only on the matching repository',
		);

		// Clone the alpha repository again to prove the restore path works.
		const stagingAlpha = path.join(root, '.github-switcher.alpha');
		await repo.clone(stagingAlpha, remoteA);
		await repo.checkoutTracked(stagingAlpha, 'develop');
		assert(await repo.hasRemoteBranch(stagingAlpha, remoteA, tempBranch), 'finds the pushed temporary branch');
		await repo.fetchBranch(stagingAlpha, remoteA, tempBranch);
		await repo.checkoutTracked(stagingAlpha, tempBranch);
		assert(git(stagingAlpha, 'branch', '--show-current') === tempBranch, 'restores the temporary branch');
		assert(fs.existsSync(path.join(stagingAlpha, 'feature.txt')), 'the saved work is present after restoring');

		console.log('3. replace the workspace directory through a rename');
		const { backupPath } = await replaceDirectory(workspace, stagingAlpha, logger);
		assert(Boolean(backupPath), 'keeps a backup of the previous directory');
		assert(fs.existsSync(path.join(workspace, 'feature.txt')), 'the restored work survived the replacement');

		const backups = await findBackupDirectories(workspace);
		assert(backups.length === 1, 'the backup is discoverable afterwards');
		assert(await removeBackup(backups[0], logger), 'the backup can be removed again');
		assert((await findBackupDirectories(workspace)).length === 0, 'no backup is left behind');

		console.log('4. remote URL matching');
		assert(remoteMatchesRepo('https://github.com/owner/name.git', 'owner/name'), 'matches an https remote');
		assert(remoteMatchesRepo('git@github.com:owner/name.git', 'owner/name'), 'matches an ssh remote');
		assert(!remoteMatchesRepo('https://github.com/owner/name-2.git', 'owner/name'), 'ignores a lookalike name');
		assert(normalizeRemoteUrl('git@github.com:Owner/Name.git') === 'github.com/owner/name', 'normalizes to lower case');

		console.log('\nAll integration checks passed.');
	} finally {
		logger.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error('\nIntegration checks failed:', error);
	process.exitCode = 1;
});