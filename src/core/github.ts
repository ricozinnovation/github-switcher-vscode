import { SwitcherError } from './errors';
import { compareRepos, RawRepo, RepoInfo, toRepoInfo } from './repos';

/**
 * Small GitHub REST client. Only the endpoints needed by the switcher are
 * implemented. This module must not import `vscode`.
 */

export interface HttpResponse {
	ok: boolean;
	status: number;
	statusText: string;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}

export interface HttpRequestInit {
	method?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

export interface GitHubClientOptions {
	token: string;
	apiBaseUrl?: string;
	userAgent?: string;
	fetchImpl?: FetchLike;
	onLog?: (message: string) => void;
}

export interface ListRepositoriesOptions {
	limit: number;
	affiliation: string;
	signal?: AbortSignal;
}

const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'vscode-github-switcher';

const nodeFetch: FetchLike = (url, init) => {
	const impl = (globalThis as { fetch?: unknown }).fetch;
	if (typeof impl !== 'function') {
		throw new SwitcherError('This extension requires Node.js 18 or newer (global fetch is missing).');
	}
	return (impl as (input: string, options?: unknown) => Promise<HttpResponse>)(url, init);
};

export class GitHubClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly fetchImpl: FetchLike;

	constructor(private readonly options: GitHubClientOptions) {
		this.baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
		this.token = options.token;
		this.fetchImpl = options.fetchImpl ?? nodeFetch;
	}

	/** Returns the login the token belongs to. */
	async getAuthenticatedUser(signal?: AbortSignal): Promise<string> {
		const payload = await this.request<{ login?: string }>('/user', signal);
		const login = payload?.login?.trim();
		if (!login) {
			throw new SwitcherError('GitHub did not return a login for the access token.');
		}
		return login;
	}

	/** Lists repositories the token can reach, sorted alphabetically. */
	async listRepositories(options: ListRepositoriesOptions): Promise<RepoInfo[]> {
		const limit = Math.max(1, Math.floor(options.limit));
		const perPage = Math.min(100, limit);
		const collected: RepoInfo[] = [];

		for (let page = 1; collected.length < limit; page++) {
			const query = new URLSearchParams({
				per_page: String(perPage),
				page: String(page),
				affiliation: options.affiliation,
				sort: 'full_name',
				direction: 'asc',
			});

			const payload = await this.request<RawRepo[]>(`/user/repos?${query.toString()}`, options.signal);
			if (!Array.isArray(payload)) {
				throw new SwitcherError('Unexpected response shape from the GitHub repositories endpoint.');
			}

			collected.push(...payload.map(toRepoInfo));
			this.options.onLog?.(`Fetched ${payload.length} repositories from page ${page}.`);

			// A short page means the last page was reached.
			if (payload.length < perPage || page >= 50) {
				break;
			}
		}

		return collected.sort(compareRepos).slice(0, limit);
	}

	private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		let response: HttpResponse;

		try {
			response = await this.fetchImpl(url, {
				method: 'GET',
				headers: {
					accept: 'application/vnd.github+json',
					authorization: `Bearer ${this.token}`,
					'user-agent': this.options.userAgent ?? DEFAULT_USER_AGENT,
					'x-github-api-version': '2022-11-28',
				},
				signal,
			});
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
			throw new SwitcherError(`Could not reach the GitHub API (${url}).`, {
				cause: error,
				hint: 'Check the network connection, proxy settings and githubSwitcher.apiBaseUrl.',
			});
		}

		const body = await response.text().catch(() => '');

		if (!response.ok) {
			throw toApiError(response, body, url);
		}

		if (body.trim() === '') {
			return undefined as T;
		}

		try {
			return JSON.parse(body) as T;
		} catch (error) {
			throw new SwitcherError(`Could not parse the GitHub API response from ${url}.`, { cause: error });
		}
	}
}

function toApiError(response: HttpResponse, body: string, url: string): SwitcherError {
	const message = extractApiMessage(body) ?? response.statusText;
	const remaining = response.headers.get('x-ratelimit-remaining');
	const reset = Number(response.headers.get('x-ratelimit-reset') ?? '0') * 1000;

	if (response.status === 401) {
		return new SwitcherError('GitHub rejected the access token (401 Unauthorized).', {
			hint: 'Run "GitHub Switcher: Set GitHub Token" and enter a token with the repo scope.',
		});
	}

	if (response.status === 403 && remaining === '0') {
		const resetText = reset > Date.now() ? ` Try again after ${new Date(reset).toLocaleTimeString()}.` : '';
		return new SwitcherError(`GitHub API rate limit exceeded.${resetText}`, {
			hint: 'Use a personal access token with a higher limit or wait for the limit to reset.',
		});
	}

	if (response.status === 403) {
		return new SwitcherError(`GitHub denied the request (403 Forbidden): ${message}`, {
			hint: 'The token is missing a scope, or the SSO authorization for an organization is missing.',
		});
	}

	if (response.status === 404) {
		return new SwitcherError(`GitHub returned 404 Not Found for ${url}.`, {
			hint: 'Check githubSwitcher.apiBaseUrl and githubSwitcher.gitHost, especially for GitHub Enterprise.',
		});
	}

	return new SwitcherError(`GitHub API request failed (${response.status} ${message}).`);
}

function extractApiMessage(body: string): string | undefined {
	if (body.trim() === '') {
		return undefined;
	}
	try {
		const parsed = JSON.parse(body) as { message?: unknown };
		return typeof parsed.message === 'string' ? parsed.message : undefined;
	} catch {
		return body.slice(0, 200);
	}
}