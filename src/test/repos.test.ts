import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupByOwner, normalizeRemoteUrl, remoteMatchesRepo, toRepoInfo } from '../core/repos';

describe('toRepoInfo', () => {
	it('maps the API payload', () => {
		const repo = toRepoInfo({
			full_name: 'ricozinnovation/hifi-ai',
			name: 'hifi-ai',
			owner: { login: 'ricozinnovation' },
			default_branch: 'develop',
			private: true,
			updated_at: '2026-01-01T00:00:00Z',
		});

		assert.deepEqual(repo, {
			fullName: 'ricozinnovation/hifi-ai',
			owner: 'ricozinnovation',
			name: 'hifi-ai',
			defaultBranch: 'develop',
			isPrivate: true,
			updatedAt: '2026-01-01T00:00:00Z',
		});
	});

	it('falls back to main and derives owner and name', () => {
		const repo = toRepoInfo({ full_name: 'acme/tools', default_branch: null });

		assert.equal(repo.owner, 'acme');
		assert.equal(repo.name, 'tools');
		assert.equal(repo.defaultBranch, 'main');
		assert.equal(repo.isPrivate, false);
	});
});

describe('normalizeRemoteUrl', () => {
	it('reduces the usual remote notations', () => {
		assert.equal(normalizeRemoteUrl('https://github.com/owner/name.git'), 'github.com/owner/name');
		assert.equal(normalizeRemoteUrl('https://github.com/owner/name'), 'github.com/owner/name');
		assert.equal(normalizeRemoteUrl('git@github.com:owner/name.git'), 'github.com/owner/name');
		assert.equal(normalizeRemoteUrl('ssh://git@github.com/owner/name.git'), 'github.com/owner/name');
		assert.equal(normalizeRemoteUrl('git://github.com/owner/name/'), 'github.com/owner/name');
	});

	it('returns an empty string for empty input', () => {
		assert.equal(normalizeRemoteUrl('   '), '');
	});
});

describe('remoteMatchesRepo', () => {
	it('matches the same repository across notations', () => {
		const expected = 'owner/name';

		assert.equal(remoteMatchesRepo('https://github.com/owner/name.git', expected), true);
		assert.equal(remoteMatchesRepo('git@github.com:owner/name.git', expected), true);
		assert.equal(remoteMatchesRepo('https://github.com/Owner/Name', expected), true);
		assert.equal(remoteMatchesRepo('https://github.enterprise.dev/owner/name.git', expected), true);
	});

	it('does not match a different repository', () => {
		assert.equal(remoteMatchesRepo('https://github.com/owner/name-extra', 'owner/name'), false);
		assert.equal(remoteMatchesRepo('https://github.com/other/name', 'owner/name'), false);
		assert.equal(remoteMatchesRepo(undefined, 'owner/name'), false);
		assert.equal(remoteMatchesRepo('', 'owner/name'), false);
	});
});

describe('groupByOwner', () => {
	it('merges owners that differ in case and keeps the first spelling', () => {
		const groups = groupByOwner([
			toRepoInfo({ full_name: 'beta/b', default_branch: 'main' }),
			toRepoInfo({ full_name: 'Alpha/a2', default_branch: 'main' }),
			toRepoInfo({ full_name: 'alpha/a1', default_branch: 'main' }),
		]);

		assert.deepEqual(
			groups.map((group) => [group.owner, group.repositories.map((repo) => repo.name)]),
			[
				['Alpha', ['a1', 'a2']],
				['beta', ['b']],
			],
		);
	});

	it('sorts repositories inside a group by full name', () => {
		const groups = groupByOwner([
			toRepoInfo({ full_name: 'acme/zebra', default_branch: 'main' }),
			toRepoInfo({ full_name: 'acme/Alpha', default_branch: 'main' }),
		]);

		assert.deepEqual(
			groups[0].repositories.map((repo) => repo.name),
			['Alpha', 'zebra'],
		);
	});
});