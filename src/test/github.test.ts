import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FetchLike, GitHubClient, HttpResponse } from '../core/github';
import { hostFromUrl, httpsCloneUrl, injectCredentials } from '../core/gitUrl';

interface StubResponse {
	status?: number;
	body?: unknown;
	headers?: Record<string, string>;
}

function stubFetch(pages: StubResponse[]): { impl: FetchLike; calls: string[] } {
	const calls: string[] = [];
	let index = 0;

	const impl: FetchLike = async (url) => {
		calls.push(url);
		const page = pages[Math.min(index, pages.length - 1)];
		index++;

		const response: HttpResponse = {
			ok: (page.status ?? 200) < 400,
			status: page.status ?? 200,
			statusText: 'stub',
			headers: {
				get: (name: string) => page.headers?.[name.toLowerCase()] ?? null,
			},
			text: async () => (typeof page.body === 'string' ? page.body : JSON.stringify(page.body)),
		};

		return response;
	};

	return { impl, calls };
}

function repo(fullName: string): Record<string, unknown> {
	const [owner, name] = fullName.split('/');
	return { full_name: fullName, name, owner: { login: owner }, default_branch: 'develop', private: false };
}

describe('GitHubClient.listRepositories', () => {
	it('sends the token and the expected query parameters', async () => {
		const { impl, calls } = stubFetch([{ body: [] }]);
		const client = new GitHubClient({ token: 'ghp_secret123456', fetchImpl: impl });

		await client.listRepositories({ limit: 1000, affiliation: 'owner,collaborator' });

		assert.equal(calls.length, 1);
		assert.ok(calls[0].startsWith('https://api.github.com/user/repos?'));
		assert.match(calls[0], /per_page=100/);
		assert.match(calls[0], /affiliation=owner%2Ccollaborator/);
		assert.match(calls[0], /sort=full_name/);
	});

	it('follows pagination until a short page arrives', async () => {
		const first = Array.from({ length: 100 }, (_unused, index) => repo(`owner/repo-${String(index).padStart(3, '0')}`));
		const second = [repo('owner/repo-999')];
		const { impl, calls } = stubFetch([{ body: first }, { body: second }]);

		const client = new GitHubClient({ token: 'ghp_secret123456', fetchImpl: impl });
		const repositories = await client.listRepositories({ limit: 1000, affiliation: 'owner' });

		assert.equal(calls.length, 2);
		assert.equal(repositories.length, 101);
		assert.match(calls[1], /page=2/);
	});

	it('stops at the configured limit', async () => {
		const { impl, calls } = stubFetch([{ body: [repo('a/b'), repo('a/c')] }]);
		const client = new GitHubClient({ token: 'ghp_secret123456', fetchImpl: impl });

		const repositories = await client.listRepositories({ limit: 1, affiliation: 'owner' });

		assert.equal(calls.length, 1);
		assert.equal(repositories.length, 1);
	});

	it('sorts the result alphabetically', async () => {
		const { impl } = stubFetch([{ body: [repo('zeta/a'), repo('alpha/b')] }]);
		const client = new GitHubClient({ token: 'ghp_secret123456', fetchImpl: impl });

		const repositories = await client.listRepositories({ limit: 10, affiliation: 'owner' });

		assert.deepEqual(
			repositories.map((entry) => entry.fullName),
			['alpha/b', 'zeta/a'],
		);
	});

	it('explains a rejected token', async () => {
		const { impl } = stubFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
		const client = new GitHubClient({ token: 'ghp_secret123456', fetchImpl: impl });

		await assert.rejects(() => client.listRepositories({ limit: 10, affiliation: 'owner' }), (error: Error) => {
			assert.match(error.message, /401/);
			assert.match(String((error as { hint?: string }).hint), /Set GitHub Token/);
			return true;
		});
	});

	it('reports the rate limit reset time', async () => {
		const reset = Math.floor(Date.now() / 1000) + 600;
		const { impl } = stubFetch([
			{ status: 403, body: { message: 'rate limit' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } },
		]);
		const client = new GitHubClient({ token: 'ghp_secret123456', fetchImpl: impl });

		await assert.rejects(() => client.listRepositories({ limit: 10, affiliation: 'owner' }), /rate limit/);
	});

	it('rejects an unexpected payload shape', async () => {
		const { impl } = stubFetch([{ body: { message: 'nope' } }]);
		const client = new GitHubClient({ token: 'ghp_secret123456', fetchImpl: impl });

		await assert.rejects(() => client.listRepositories({ limit: 10, affiliation: 'owner' }), /Unexpected response shape/);
	});
});

describe('GitHubClient.getAuthenticatedUser', () => {
	it('returns the login', async () => {
		const { impl } = stubFetch([{ body: { login: 'ricozinnovation' } }]);
		const client = new GitHubClient({ token: 'ghp_secret123456', fetchImpl: impl });

		assert.equal(await client.getAuthenticatedUser(), 'ricozinnovation');
	});

	it('fails when the login is missing', async () => {
		const { impl } = stubFetch([{ body: {} }]);
		const client = new GitHubClient({ token: 'ghp_secret123456', fetchImpl: impl });

		await assert.rejects(() => client.getAuthenticatedUser(), /did not return a login/);
	});

	it('reports an unreachable API', async () => {
		const impl: FetchLike = async () => {
			throw new Error('ECONNREFUSED');
		};
		const client = new GitHubClient({ token: 'ghp_secret123456', fetchImpl: impl });

		await assert.rejects(() => client.getAuthenticatedUser(), /Could not reach the GitHub API/);
	});

	it('supports a custom API base url for GitHub Enterprise', async () => {
		const { impl, calls } = stubFetch([{ body: { login: 'acme' } }]);
		const client = new GitHubClient({
			token: 'ghp_secret123456',
			apiBaseUrl: 'https://github.enterprise.dev/api/v3/',
			fetchImpl: impl,
		});

		await client.getAuthenticatedUser();

		assert.equal(calls[0], 'https://github.enterprise.dev/api/v3/user');
	});
});

describe('git url helpers', () => {
	it('builds a clean clone url', () => {
		assert.equal(httpsCloneUrl('owner/name', 'github.com'), 'https://github.com/owner/name.git');
	});

	it('injects credentials into an https url', () => {
		const url = injectCredentials('https://github.com/owner/name.git', {
			host: 'github.com',
			username: 'x-access-token',
			password: 'ghp_secret123456',
		});

		assert.equal(url, 'https://x-access-token:ghp_secret123456@github.com/owner/name.git');
	});

	it('leaves non https urls untouched', () => {
		const credential = { host: 'github.com', username: 'x-access-token', password: 'ghp_secret123456' };

		assert.equal(injectCredentials('git@github.com:owner/name.git', credential), 'git@github.com:owner/name.git');
		assert.equal(injectCredentials('https://github.com/owner/name.git', undefined), 'https://github.com/owner/name.git');
	});

	it('is idempotent so git operations can normalise their own url', () => {
		const credential = { host: 'github.com', username: 'x-access-token', password: 'ghp_secret123456' };
		const once = injectCredentials('https://github.com/owner/name.git', credential);

		assert.equal(injectCredentials(once, credential), once);
	});

	it('encodes credentials that contain url characters', () => {
		const url = injectCredentials('https://github.com/owner/name.git', {
			host: 'github.com',
			username: 'user name',
			password: 'p@ss/word',
		});

		assert.equal(url, 'https://user%20name:p%40ss%2Fword@github.com/owner/name.git');
	});

	it('extracts the host', () => {
		assert.equal(hostFromUrl('https://github.com/owner/name.git'), 'github.com');
		assert.equal(hostFromUrl('git@github.enterprise.dev:owner/name.git'), 'github.enterprise.dev');
	});
});