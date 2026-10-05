import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseShellConfig } from '../core/shellConfig';

describe('parseShellConfig', () => {
	it('reads quoted and unquoted assignments', () => {
		const values = parseShellConfig(
			[
				'#!/usr/bin/env bash',
				'',
				'# credentials',
				'GITHUB_USERNAME="ricozinnovation"',
				'GITHUB_PAT=ghp_0123456789abcdef',
				"DEFAULT_BRANCH='main'",
				'REPO_LIMIT=250',
			].join('\n'),
		);

		assert.equal(values.GITHUB_USERNAME, 'ricozinnovation');
		assert.equal(values.GITHUB_PAT, 'ghp_0123456789abcdef');
		assert.equal(values.DEFAULT_BRANCH, 'main');
		assert.equal(values.REPO_LIMIT, '250');
	});

	it('ignores comments but keeps hashes inside quotes', () => {
		const values = parseShellConfig(
			['GITHUB_PAT="abc#123" # trailing comment', 'WORKSPACE_DIR=./workspace # here too'].join('\n'),
		);

		assert.equal(values.GITHUB_PAT, 'abc#123');
		assert.equal(values.WORKSPACE_DIR, './workspace');
	});

	it('supports export and empty values', () => {
		const values = parseShellConfig(['export TEMP_BRANCH_PREFIX="temp"', 'GITHUB_USERNAME=', '# only a comment'].join('\n'));

		assert.equal(values.TEMP_BRANCH_PREFIX, 'temp');
		assert.equal(values.GITHUB_USERNAME, '');
	});

	it('does not evaluate expansions', () => {
		const values = parseShellConfig('WORKSPACE_DIR="$HOME/repos/workspace"');

		assert.equal(values.WORKSPACE_DIR, '$HOME/repos/workspace');
	});

	it('ignores lines that are not assignments', () => {
		const values = parseShellConfig(['set -Eeuo pipefail', 'echo hello', 'if true; then', 'fi'].join('\n'));

		assert.deepEqual(values, {});
	});
});