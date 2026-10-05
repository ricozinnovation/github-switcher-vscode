import { GitCredential, hostFromUrl, httpsCloneUrl, injectCredentials } from './core/gitUrl';
import { ResolvedConfig } from './config';
import { Logger } from './logger';

/**
 * Decides how git authenticates.
 *
 * - `github-cli`: `gh auth setup-git` installs the gh credential helper, so the
 *   remote URL stays clean. This mirrors switch.sh, which exports GH_TOKEN and
 *   calls `gh auth setup-git`.
 * - `token`: credentials are injected per command, so nothing is written to
 *   `.git/config` and the OS credential store gets the token instead.
 */
export interface AuthStrategy {
	readonly kind: 'github-cli' | 'token';
	readonly description: string;
	/** URL stored in `.git/config` as `origin`, never containing the token. */
	publicUrl(fullName: string): string;
	/** Same URL but able to authenticate a single command. */
	authenticatedUrl(url: string): string;
	/** Credential to persist in the OS credential store, when applicable. */
	readonly credential?: GitCredential;
	/** Extra environment for git child processes. */
	readonly gitEnv?: NodeJS.ProcessEnv;
}

export interface Credentials {
	token: string;
	login: string;
	source: 'secret storage' | 'config file' | 'github cli';
}

export interface AuthDependencies {
	runGh: (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export async function createAuthStrategy(
	config: ResolvedConfig,
	credentials: Credentials,
	logger: Logger,
	deps: AuthDependencies,
): Promise<AuthStrategy> {
	const publicUrlFor = (fullName: string): string => httpsCloneUrl(fullName, config.gitHost);
	const credential: GitCredential = {
		host: hostFromUrl(publicUrlFor('owner/repo')),
		username: 'x-access-token',
		password: credentials.token,
	};

	if (config.useGitHubCli) {
		const setup = await setupGitHubCli(config, credentials, logger, deps);
		if (setup) {
			return {
				kind: 'github-cli',
				description: 'GitHub CLI credential helper',
				publicUrl: publicUrlFor,
				authenticatedUrl: (url) => url,
				gitEnv: gitHubCliEnv(config, credentials),
			};
		}
	}

	logger.info(`Authenticating git with the access token from ${credentials.source}.`);

	return {
		kind: 'token',
		description: 'access token in the remote URL',
		publicUrl: publicUrlFor,
		authenticatedUrl: (url) => injectCredentials(url, credential),
		credential,
		gitEnv: { GCM_INTERACTIVE: 'never' },
	};
}

/**
 * Runs `gh auth setup-git` and verifies the CLI can act as the expected user.
 * Returns undefined when the CLI is missing, broken or signed in elsewhere.
 */
async function setupGitHubCli(
	config: ResolvedConfig,
	credentials: Credentials,
	logger: Logger,
	deps: AuthDependencies,
): Promise<boolean> {
	const login = await ghLogin(config, credentials, logger, deps);
	if (!login) {
		logger.warn(`GitHub CLI not usable for authentication, falling back to the access token.`);
		return false;
	}

	if (config.username && login.toLowerCase() !== config.username.toLowerCase()) {
		logger.warn(
			`GitHub CLI is signed in as ${login} but githubSwitcher.githubUsername is ${config.username}. ` +
				'Fix the setting to avoid writing temporary branches under the wrong name.',
		);
	}

	const setup = await deps.runGh(['auth', 'setup-git'], gitHubCliEnv(config, credentials));
	if (setup.code !== 0) {
		logger.warn(`gh auth setup-git failed (${setup.code}). Falling back to the access token.`);
		return false;
	}

	logger.info(`Using the GitHub CLI credential helper for ${login}.`);
	return true;
}

async function ghLogin(
	config: ResolvedConfig,
	credentials: Credentials,
	logger: Logger,
	deps: AuthDependencies,
): Promise<string | undefined> {
	const result = await deps.runGh(['api', 'user', '--jq', '.login'], gitHubCliEnv(config, credentials));
	if (result.code !== 0) {
		logger.debug(`gh api user failed: ${result.stderr.trim()}`);
		return undefined;
	}
	return result.stdout.trim() || undefined;
}

function gitHubCliEnv(config: ResolvedConfig, credentials: Credentials): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { GH_TOKEN: credentials.token, GIT_TERMINAL_PROMPT: '0' };

	// GH_HOST only accepts host[:port], not a full API URL.
	if (config.gitHost && config.gitHost !== 'github.com') {
		env.GH_HOST = config.gitHost;
	}

	return env;
}