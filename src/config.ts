import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { SwitcherError } from './core/errors';
import { resolveWorkspacePath, tempBranchFor } from './core/paths';
import { readShellConfig, ShellConfigValues } from './core/shellConfig';

/**
 * Configuration resolution.
 *
 * Precedence for every value: an explicitly set VS Code setting, then the
 * `switch.config.sh` file, then a built-in fallback. `inspect()` tells "set by
 * the user" apart from "still at the package.json default", so an untouched
 * setting does not shadow the config file.
 */

export const CONFIG_SECTION = 'githubSwitcher';
export const TOKEN_SECRET_KEY = 'githubSwitcher.accessToken';
export const DEFAULT_CONFIG_FILE_NAME = 'switch.config.sh';

export type TokenSource = 'secret storage' | 'config file' | 'github cli';

export interface ResolvedConfig {
	username: string;
	token: string;
	tokenSource: TokenSource;
	workspaceDir: string;
	defaultBranch: string;
	tempBranchPrefix: string;
	repoLimit: number;
	affiliation: string;
	apiBaseUrl: string;
	gitHost: string;
	gitPath: string;
	ghPath: string;
	useGitHubCli: boolean;
	storeCredentials: boolean;
	confirmBeforeSwitch: boolean;
	reloadAfterSwitch: boolean;
	showStatusBarItem: boolean;
	listCacheMinutes: number;
	configFilePath?: string;
}

/** Settings as declared in package.json, before any fallback is applied. */
export interface RawSettings {
	configFile: string;
	githubUsername: string;
	workspaceDirectory: string;
	defaultBranch: string;
	tempBranchPrefix: string;
	repoLimit: number;
	affiliation: string;
	apiBaseUrl: string;
	gitHost: string;
	gitPath: string;
	ghPath: string;
	useGitHubCli: boolean;
	storeCredentials: boolean;
	confirmBeforeSwitch: boolean;
	reloadAfterSwitch: boolean;
	showStatusBarItem: boolean;
	listCacheMinutes: number;
}

export function getRawSettings(scope?: vscode.ConfigurationScope): RawSettings {
	const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION, scope);

	return {
		configFile: explicitString(configuration, 'configFile'),
		githubUsername: explicitString(configuration, 'githubUsername'),
		workspaceDirectory: explicitString(configuration, 'workspaceDirectory'),
		defaultBranch: explicitString(configuration, 'defaultBranch'),
		tempBranchPrefix: explicitString(configuration, 'tempBranchPrefix'),
		repoLimit: explicitNumber(configuration, 'repoLimit') ?? 1000,
		affiliation: explicitString(configuration, 'affiliation') || 'owner,collaborator,organization_member',
		apiBaseUrl: explicitString(configuration, 'apiBaseUrl') || 'https://api.github.com',
		gitHost: explicitString(configuration, 'gitHost') || 'github.com',
		gitPath: explicitString(configuration, 'gitPath') || 'git',
		ghPath: explicitString(configuration, 'ghPath') || 'gh',
		useGitHubCli: explicitBoolean(configuration, 'useGitHubCli') ?? true,
		storeCredentials: explicitBoolean(configuration, 'storeCredentials') ?? true,
		confirmBeforeSwitch: explicitBoolean(configuration, 'confirmBeforeSwitch') ?? true,
		reloadAfterSwitch: explicitBoolean(configuration, 'reloadAfterSwitch') ?? true,
		showStatusBarItem: explicitBoolean(configuration, 'showStatusBarItem') ?? true,
		listCacheMinutes: explicitNumber(configuration, 'listCacheMinutes') ?? 5,
	};
}

function explicitString(configuration: vscode.WorkspaceConfiguration, key: string): string {
	const value = explicitValue<string>(configuration, key);
	return typeof value === 'string' ? value.trim() : '';
}

function explicitNumber(configuration: vscode.WorkspaceConfiguration, key: string): number | undefined {
	const value = explicitValue<number>(configuration, key);
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function explicitBoolean(configuration: vscode.WorkspaceConfiguration, key: string): boolean | undefined {
	const value = explicitValue<boolean>(configuration, key);
	return typeof value === 'boolean' ? value : undefined;
}

/** Returns the most specific value the user actually configured. */
function explicitValue<T>(configuration: vscode.WorkspaceConfiguration, key: string): T | undefined {
	const info = configuration.inspect<T>(key);
	if (!info) {
		return undefined;
	}

	const candidates = [
		info.workspaceFolderLanguageValue,
		info.workspaceLanguageValue,
		info.workspaceFolderValue,
		info.workspaceValue,
		info.globalValue,
		info.defaultLanguageValue,
	];

	for (const candidate of candidates) {
		if (candidate !== undefined) {
			return candidate;
		}
	}
	return undefined;
}

/** Finds the config file: explicit setting, then the open folder, then its parent. */
export function discoverConfigFile(settings: RawSettings): string | undefined {
	if (settings.configFile !== '') {
		return path.isAbsolute(settings.configFile)
			? settings.configFile
			: path.resolve(firstFolderPath() ?? process.cwd(), settings.configFile);
	}

	for (const base of candidateSearchDirs()) {
		const candidate = path.join(base, DEFAULT_CONFIG_FILE_NAME);
		if (isFile(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

function candidateSearchDirs(): string[] {
	const dirs: string[] = [];
	const folder = firstFolderPath();

	if (folder) {
		dirs.push(folder);
		const parent = path.dirname(folder);
		if (parent !== folder) {
			dirs.push(parent);
		}
	}

	return dirs;
}

export function firstFolderPath(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

export interface ResolveOptions {
	/** Token from VS Code SecretStorage. */
	secretToken?: string;
	/** Overrides the workspace directory, for example with the folder open in VS Code. */
	workspaceDirOverride?: string;
	scope?: vscode.ConfigurationScope;
}

/**
 * Builds the configuration used by every command. The workspace directory is
 * required, so the setup wizard asks for it before anything else runs.
 */
export async function resolveConfig(options: ResolveOptions = {}): Promise<ResolvedConfig> {
	const settings = getRawSettings(options.scope);
	const configFilePath = discoverConfigFile(settings);
	const shell: ShellConfigValues = configFilePath ? readShellConfig(configFilePath).values : {};

	const secretToken = (options.secretToken ?? '').trim();
	const shellToken = (shell.GITHUB_PAT ?? '').trim();
	const token = secretToken || shellToken;
	const tokenSource: TokenSource = secretToken !== '' ? 'secret storage' : token !== '' ? 'config file' : 'github cli';

	const firstFolder = firstFolderPath();
	const baseDir = configFilePath ? path.dirname(configFilePath) : firstFolder;

	const workspaceRaw =
		(options.workspaceDirOverride ?? '').trim() || settings.workspaceDirectory || shell.WORKSPACE_DIR || firstFolder || '';

	if (workspaceRaw.trim() === '') {
		throw new SwitcherError('No workspace directory is configured.', {
			hint: 'Open the folder you want to switch between, or run "GitHub Switcher: Set Workspace Directory".',
		});
	}

	const repoLimitFromShell = Number(shell.REPO_LIMIT);

	return {
		username: settings.githubUsername || (shell.GITHUB_USERNAME ?? '').trim(),
		token,
		tokenSource,
		workspaceDir: resolveWorkspacePath(workspaceRaw, baseDir),
		defaultBranch: settings.defaultBranch || shell.DEFAULT_BRANCH?.trim() || 'develop',
		tempBranchPrefix: settings.tempBranchPrefix || shell.TEMP_BRANCH_PREFIX?.trim() || 'temp',
		repoLimit: repoLimitFromShell > 0 ? repoLimitFromShell : settings.repoLimit,
		affiliation: settings.affiliation,
		apiBaseUrl: settings.apiBaseUrl,
		gitHost: settings.gitHost,
		gitPath: settings.gitPath,
		ghPath: settings.ghPath,
		useGitHubCli: settings.useGitHubCli,
		storeCredentials: settings.storeCredentials,
		confirmBeforeSwitch: settings.confirmBeforeSwitch,
		reloadAfterSwitch: settings.reloadAfterSwitch,
		showStatusBarItem: settings.showStatusBarItem,
		listCacheMinutes: settings.listCacheMinutes,
		...(configFilePath ? { configFilePath } : {}),
	};
}

/** Temporary branch that holds the saved work for `branch`. */
export function tempBranchForBranch(config: ResolvedConfig, branch: string): string {
	return tempBranchFor(config.tempBranchPrefix, config.username || 'me', branch);
}

export async function storeToken(context: vscode.ExtensionContext, token: string): Promise<void> {
	await context.secrets.store(TOKEN_SECRET_KEY, token);
}

export async function readStoredToken(context: vscode.ExtensionContext): Promise<string> {
	const token = await context.secrets.get(TOKEN_SECRET_KEY);
	return token?.trim() ?? '';
}

export async function clearToken(context: vscode.ExtensionContext): Promise<void> {
	await context.secrets.delete(TOKEN_SECRET_KEY);
}

/** Updates a setting in the given target scope. */
export async function updateSetting(
	key: string,
	value: unknown,
	target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
): Promise<void> {
	await vscode.workspace.getConfiguration(CONFIG_SECTION).update(key, value, target);
}