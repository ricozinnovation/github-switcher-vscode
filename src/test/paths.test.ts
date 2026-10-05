import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { assertReplaceableWorkspaceDir, containsPath, expandHome, isProtectedPath, resolveWorkspacePath, tempBranchFor } from '../core/paths';

describe('tempBranchFor', () => {
	it('prefixes plain branches', () => {
		assert.equal(tempBranchFor('temp', 'alice', 'develop'), 'temp/alice/develop');
	});

	it('keeps an already prefixed branch unchanged', () => {
		assert.equal(tempBranchFor('temp', 'alice', 'temp/alice/develop'), 'temp/alice/develop');
	});

	it('does not prefix the account itself', () => {
		assert.equal(tempBranchFor('temp', 'alice', 'temp/alice'), 'temp/alice');
	});

	it('handles slashes in the prefix', () => {
		assert.equal(tempBranchFor('/wip/', 'alice', 'main'), 'wip/alice/main');
	});
});

describe('expandHome', () => {
	it('expands a lone tilde', () => {
		assert.equal(expandHome('~'), os.homedir());
	});

	it('expands a tilde prefix', () => {
		assert.equal(expandHome('~/repos/workspace'), path.join(os.homedir(), 'repos', 'workspace'));
	});

	it('leaves other input alone', () => {
		assert.equal(expandHome('/srv/workspace'), '/srv/workspace');
	});
});

describe('resolveWorkspacePath', () => {
	it('resolves relative paths against the config directory', () => {
		assert.equal(
			resolveWorkspacePath('./workspace', path.join(os.tmpdir(), 'repo')),
			path.resolve(os.tmpdir(), 'repo', 'workspace'),
		);
	});

	it('normalizes absolute paths', () => {
		assert.equal(resolveWorkspacePath(`${path.sep}srv${path.sep}work${path.sep}..${path.sep}work`, undefined), path.resolve('/srv/work'));
	});

	it('rejects empty input', () => {
		assert.throws(() => resolveWorkspacePath('   ', undefined), /No workspace directory/);
	});
});

describe('protected paths', () => {
	it('detects containment', () => {
		assert.equal(containsPath(path.resolve('/a/b'), path.resolve('/a/b/c')), true);
		assert.equal(containsPath(path.resolve('/a/b'), path.resolve('/a/b')), true);
		assert.equal(containsPath(path.resolve('/a/b'), path.resolve('/a/c')), false);
	});

	it('protects the root and the home directory', () => {
		assert.equal(isProtectedPath(path.parse(process.cwd()).root), true);
		assert.equal(isProtectedPath(os.homedir()), true);
		assert.equal(isProtectedPath(path.join(os.tmpdir(), 'workspace')), false);
	});

	it('protects directories that contain the extension', () => {
		assert.equal(isProtectedPath(path.join(os.tmpdir(), 'ws'), [path.join(os.tmpdir(), 'ws', 'ext')]), true);
		assert.equal(isProtectedPath(path.join(os.tmpdir(), 'ws'), [path.join(os.tmpdir(), 'other', 'ext')]), false);
	});

	it('throws with a hint for protected directories', () => {
		assert.throws(() => assertReplaceableWorkspaceDir(os.homedir()), /Refusing to replace a protected directory/);
	});
});