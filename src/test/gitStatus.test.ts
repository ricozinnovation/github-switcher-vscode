import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGitStatus } from '../core/gitStatus';

describe('parseGitStatus', () => {
	it('parses a clean branch with an upstream', () => {
		const status = parseGitStatus('## develop...origin/develop\n');

		assert.equal(status.branch, 'develop');
		assert.equal(status.upstream, 'origin/develop');
		assert.equal(status.ahead, 0);
		assert.equal(status.behind, 0);
		assert.equal(status.changedFiles, 0);
		assert.equal(status.detached, false);
	});

	it('parses ahead and behind counts', () => {
		const status = parseGitStatus('## main...origin/main [ahead 2, behind 3]\n');

		assert.equal(status.ahead, 2);
		assert.equal(status.behind, 3);
	});

	it('counts staged, unstaged and untracked files', () => {
		const status = parseGitStatus(
			[
				'## develop',
				'M  staged.ts',
				' M unstaged.ts',
				'MM both.ts',
				'?? new.ts',
				'A  added.ts',
				' D deleted.ts',
			].join('\n'),
		);

		assert.equal(status.changedFiles, 6);
		assert.equal(status.staged, 3);
		assert.equal(status.unstaged, 3);
		assert.equal(status.untracked, 1);
	});

	it('detects a detached HEAD', () => {
		const status = parseGitStatus('## HEAD (no branch)\n');

		assert.equal(status.detached, true);
		assert.equal(status.branch, '');
	});

	it('parses an unborn branch', () => {
		const status = parseGitStatus('## No commits yet on main\n');

		assert.equal(status.branch, 'main');
		assert.equal(status.detached, false);
	});

	it('handles an empty output', () => {
		const status = parseGitStatus('');

		assert.equal(status.branch, '');
		assert.equal(status.detached, false);
		assert.equal(status.changedFiles, 0);
	});
});