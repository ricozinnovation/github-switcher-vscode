import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { AuthStrategy, createAuthStrategy, Credentials } from './auth';
import {
	CONFIG_SECTION,
	firstFolderPath,
	getRawSettings,
	readStoredToken,
	resolveConfig,
	ResolvedConfig,
} from './config';
import { CancelledError, errorText, SwitcherError } from './core/errors';
import { GitHubClient } from './core/github';
import { RepoInfo } from './core/repos';
import { Git } from './git';
import { RepositoryGit } from './gitOps';
import { Logger } from './logger';
import { findBackupDirectories, findStagingDirectories, removeBackup } from './replace';
import { RepositorySwitcher, SwitchResult } from './switcher';
import { showError } from './ui';

export interface Session {
	config: ResolvedConfig;
	credentials: Credentials;
	auth: AuthStrategy;
	git: Git;
	repository: RepositoryGit;
	switcher: RepositorySwitcher;
}

export interface CurrentRepository {
	fullName?: string;
	branch: string;
	dirty: number;
	url?: string;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Owns the runtime state of the extension: resolved configuration and
 * credentials, the repository list cache, the status bar entry and the
 * implementation of every command.
 */
export class SwitcherController implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly statusBar: vscode.StatusBarItem;
	private readonly changeEmitter = new vscode.EventEmitter<void>();

	private session: Session | undefined;
	private cache: { repositories: RepoInfo[]; fetchedAt: number } | undefined;
	private statusTimer: NodeJS.Timeout | undefined;
	private initialising: Promise<void> | undefined;

	/** Fires when the repository list or the current repository changed. */
	readonly onDidChange = this.changeEmitter.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: Logger,
	) {
		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.statusBar.command = 'githubSwitcher.switchRepository';
		this.statusBar.name = 'GitHub Switcher: current repository';
		this.disposables.push(this.statusBar, this.changeEmitter);
	}

	/**
	 * Builds the session: configuration, credentials, git and the switcher.
	 * The result is cached, so repeated calls are cheap.
	 */
	async getSession(): Promise<Session> {
		if (this.session) {
			return this.session;
		}

		const secretToken = await readStoredToken(this.context);
		const config = await resolveConfig({ secretToken });
		this.logger.trackSecret(secretToken);
		this.logger.trackSecret(config.token);

		if (config.configFilePath) {
			this.logger.info(`Reading defaults from ${config.configFilePath}.`);
		}

		const credentials = await this.resolveCredentials(config);

		// Temporary branch names carry the login, so it has to be known first.
		if (config.username === '') {
			config.username = credentials.login;
			this.logger.info(`Using the authenticated account ${config.username} for temporary branch names.`);
		} else if (config.username.toLowerCase() !== credentials.login.toLowerCase()) {
			this.logger.warn(
				`The access token belongs to ${credentials.login} but githubSwitcher.githubUsername is ${config.username}. ` +
					'Run "GitHub Switcher: Set GitHub Username" to fix it.',
			);
		}

		const git = new Git(config.gitPath, this.logger, gitEnvironment(config, credentials));
		const repository = new RepositoryGit(git, this.logger);
		const auth = await createAuthStrategy(config, credentials, this.logger, {
			runGh: (args, env) => this.runGh(config, args, env),
		});

		const session: Session = {
			config,
			credentials,
			auth,
			git,
			repository,
			switcher: new RepositorySwitcher({
				config,
				logger: this.logger,
				git,
				repository,
				auth,
				protectedDirs: [this.context.extensionPath],
			}),
		};

		this.session = session;
		return session;
	}

	/** Repositories of the authenticated account, cached for `listCacheMinutes`. */
	async listRepositories(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<RepoInfo[]> {
		const session = await this.getSession();
		const { config, credentials } = session;
		const now = Date.now();
		const ttlMs = config.listCacheMinutes * 60_000;

		if (!options.force && this.cache && now - this.cache.fetchedAt < ttlMs) {
			return this.cache.repositories;
		}

		this.logger.info(`Fetching repositories for ${config.username}...`);
		const repositories = await this.client(session).listRepositories({
			limit: config.repoLimit,
			affiliation: config.affiliation,
			...(options.signal ? { signal: options.signal } : {}),
		});

		this.cache = { repositories, fetchedAt: now };
		this.logger.info(`Loaded ${repositories.length} repositories using the ${credentials.source} token.`);
		this.fireChanged();

		return repositories;
	}

	/** Repository list without throwing, for views that render a message instead. */
	async tryListRepositories(options: { force?: boolean } = {}): Promise<RepoInfo[] | undefined> {
		try {
			return await this.listRepositories(options);
		} catch (error) {
			this.logger.warn(`Could not load repositories: ${errorText(error)}`);
			return undefined;
		}
	}

	invalidateCache(): void {
		this.cache = undefined;
		this.fireChanged();
	}

	/** Repository currently checked out in the workspace directory. */
	async currentRepository(): Promise<CurrentRepository> {
		try {
			const { config, repository } = await this.getSession();

			if (!(await repository.isRepositoryRoot(config.workspaceDir))) {
				return { branch: '', dirty: 0 };
			}

			const url = await repository.originUrl(config.workspaceDir);
			const status = await repository.status(config.workspaceDir);

			return {
				...(url ? { url, fullName: fullNameFromUrl(url) } : {}),
				branch: status.detached ? 'detached HEAD' : status.branch,
				dirty: status.changedFiles,
			};
		} catch (error) {
			this.logger.debug(`Status lookup failed: ${errorText(error)}`);
			return { branch: '', dirty: 0 };
		}
	}

	/** Runs a command body and reports any failure in one place. */
	async safe(operation: () => Promise<void>): Promise<void> {
		try {
			await operation();
		} catch (error) {
			if (error instanceof CancelledError) {
				this.logger.info('Operation cancelled.');
				void vscode.window.showInformationMessage('GitHub Switcher: cancelled.');
				return;
			}
			await showError(error, {
				logger: this.logger,
				actions: [{ label: 'Run Setup', command: 'githubSwitcher.setup' }],
			});
		}
	}

	/** Wires up the event listeners and the first status bar update. */
	async initialize(): Promise<void> {
		this.initialising ??= this.doInitialize().catch((error: unknown) => {
			// The workspace may be empty or unconfigured, which is not fatal.
			this.logger.debug(`Initialisation skipped: ${errorText(error)}`);
		});

		return this.initialising;
	}

	resetSession(): void {
		this.session = undefined;
		this.cache = undefined;
		this.fireChanged();
	}

	dispose(): void {
		if (this.statusTimer) {
			clearTimeout(this.statusTimer);
		}
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	fireChanged(): void {
		this.changeEmitter.fire();
	}

	async refreshStatusBar(): Promise<void> {
		try {
			if (!getRawSettings().showStatusBarItem) {
				this.statusBar.hide();
				return;
			}

			const current = await this.currentRepository();
			if (!current.url && current.branch === '') {
				this.statusBar.hide();
				return;
			}

			const label = current.fullName ?? (current.url ? path.basename(current.url) : 'repository');
			const branch = current.branch === '' ? 'no branch' : current.branch;

			this.statusBar.text = `$(repo) ${label}: ${branch}${current.dirty > 0 ? ' $(warning)' : ''}`;
			this.statusBar.tooltip = new vscode.MarkdownString(
				[
					`**${label}**`,
					`Branch: \`${branch}\``,
					...(current.dirty > 0 ? [`Uncommitted changes in ${current.dirty} file(s).`] : []),
					...(current.url ? [`Remote: \`${current.url}\``] : []),
					'',
					'Click to switch to another repository.',
				].join('\n\n'),
			);
			this.statusBar.show();
		} catch (error) {
			this.logger.debug(`Status bar update failed: ${errorText(error)}`);
		}
	}

	/** Reports directories that an earlier run left behind and offers to clean them. */
	async offerLeftoverCleanup(): Promise<void> {
		try {
			const { config } = await this.getSession();

			for (const dir of await findStagingDirectories(config.workspaceDir)) {
				this.logger.warn(`Found an unfinished clone from an earlier run: ${dir}`);
			}

			const backups = await findBackupDirectories(config.workspaceDir);
			if (backups.length === 0) {
				return;
			}

			const answer = await vscode.window.showWarningMessage(
				`Found ${backups.length} leftover backup folder(s) from an earlier switch.`,
				{ modal: true, detail: backups.join('\n') },
				'Delete Backups',
				'Keep',
			);

			if (answer !== 'Delete Backups') {
				return;
			}

			for (const backup of backups) {
				if (!(await removeBackup(backup, this.logger))) {
					void vscode.window.showWarningMessage(`Could not delete ${backup}. Please delete it manually.`);
				}
			}
		} catch (error) {
			this.logger.debug(`Leftover cleanup skipped: ${errorText(error)}`);
		}
	}

	/** Shows the outcome of a switch and offers the sensible follow up action. */
	async announceResult(result: SwitchResult): Promise<void> {
		if (result.status === 'cancelled') {
			this.logger.info('Switch cancelled by the user.');
			// The work was already saved, so the user still gets a fresh clone.
			await this.refreshStatusBar();
			return;
		}

		if (result.status === 'already-checked-out') {
			void vscode.window.showInformationMessage(
				`GitHub Switcher: ${result.repository.fullName} is already checked out.`,
			);
			return;
		}

		const { config } = await this.getSession();
		this.invalidateCache();
		await this.refreshStatusBar();

		const detail = [
			`Repository: ${result.repository.fullName}`,
			`Location:   ${config.workspaceDir}`,
			`Branch:     ${result.branch ?? 'unknown'}`,
			result.savedBranch ? `Saved work: origin/${result.savedBranch}` : '',
			result.backupPath ? `Backup: ${result.backupPath}` : '',
		]
			.filter((line) => line !== '')
			.join('\n');

		this.logger.info(`Switch finished \u2014 ${detail.replace(/\n/g, ' | ')}`);

		if (config.reloadAfterSwitch) {
			// Reloading reopens the same folder, which now contains the new
			// repository. The backup is removed by offerLeftoverCleanup afterwards.
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
			return;
		}

		const reload = 'Reload Window';
		const choice = await vscode.window.showInformationMessage(
			`Switched to ${result.repository.fullName} on ${result.branch ?? 'the default branch'}.`,
			{ detail },
			reload,
		);

		if (choice === reload) {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	}

	private async doInitialize(): Promise<void> {
		this.registerGitWatchers();

		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration(CONFIG_SECTION)) {
					return;
				}
				this.logger.info('Settings changed.');
				this.resetSession();
				void this.refreshStatusBar();
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.resetSession();
				void this.refreshStatusBar();
			}),
			vscode.workspace.onDidGrantWorkspaceTrust(() => {
				void this.refreshStatusBar();
			}),
		);

		await this.refreshStatusBar();
	}

	/** Watches `.git/HEAD` and `.git/index` so the status bar follows git. */
	private registerGitWatchers(): void {
		const folder = firstFolderPath();
		if (!folder) {
			return;
		}

		for (const file of ['.git/HEAD', '.git/index']) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, file));
			const onChange = (): void => this.scheduleStatusBarRefresh();
			watcher.onDidChange(onChange);
			watcher.onDidCreate(onChange);
			watcher.onDidDelete(onChange);
			this.disposables.push(watcher);
		}
	}

	private scheduleStatusBarRefresh(): void {
		if (this.statusTimer) {
			clearTimeout(this.statusTimer);
		}

		this.statusTimer = setTimeout(() => {
			this.statusTimer = undefined;
			void this.refreshStatusBar();
		}, 400);
	}

	private client(session: Session): GitHubClient {
		return new GitHubClient({
			token: session.credentials.token,
			apiBaseUrl: session.config.apiBaseUrl,
			onLog: (message: string) => this.logger.debug(message),
		});
	}

	/**
	 * Resolves the access token and verifies it against the GitHub API, which
	 * also yields the login used for temporary branch names.
	 */
	private async resolveCredentials(config: ResolvedConfig): Promise<Credentials> {
		const token = config.token || (await this.tokenFromGitHubCli(config));

		if (token === '') {
			throw new SwitcherError('No GitHub credentials were found.', {
				hint: 'Run "GitHub Switcher: Run Setup", or sign in with "gh auth login".',
			});
		}

		this.logger.trackSecret(token);

		const source: Credentials['source'] = config.token === '' ? 'github cli' : config.tokenSource;
		const login = await new GitHubClient({
			token,
			apiBaseUrl: config.apiBaseUrl,
		}).getAuthenticatedUser();

		this.logger.info(`Authenticated as ${login} using the ${source} token.`);

		return { token, login, source };
	}

	/** Reads a token from an already authenticated GitHub CLI. */
	private async tokenFromGitHubCli(config: ResolvedConfig): Promise<string> {
		if (!config.useGitHubCli) {
			return '';
		}

		const result = await this.runGh(config, ['auth', 'token']);
		return result.code === 0 ? result.stdout.trim() : '';
	}

	private async runGh(config: ResolvedConfig, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
		this.logger.debug(`$ ${config.ghPath} ${args.join(' ')}`);

		return new Promise<RunResult>((resolve) => {
			const child = spawn(config.ghPath, args, {
				windowsHide: true,
				env: { ...process.env, ...env },
			});

			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
			child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

			child.on('error', (error: Error) => {
				this.logger.debug(`${config.ghPath} could not start: ${error.message}`);
				resolve({ code: -1, stdout, stderr: error.message });
			});
			child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
		});
	}
}

function gitEnvironment(config: ResolvedConfig, credentials: Credentials): NodeJS.ProcessEnv {
	if (!config.useGitHubCli) {
		return { GCM_INTERACTIVE: 'never' };
	}

	// Mirrors `export GH_TOKEN=...` and `gh auth setup-git` in switch.sh.
	const env: NodeJS.ProcessEnv = { GH_TOKEN: credentials.token, GCM_INTERACTIVE: 'never' };
	if (config.gitHost !== 'github.com') {
		env.GH_HOST = config.gitHost;
	}
	return env;
}

/** Extracts `owner/name` from a git remote URL. */
function fullNameFromUrl(url: string): string {
	const normalized = url
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
		.replace(/^[^@/]+@/, '')
		.replace(/[\\/]+$/, '')
		.replace(/\.git$/i, '');

	const segments = normalized.split(/[/:]/).filter(Boolean);

	return segments.length >= 2 ? `${segments[segments.length - 2]}/${segments[segments.length - 1]}` : normalized;
}