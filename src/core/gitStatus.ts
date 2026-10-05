/**
 * Parsers for `git status --porcelain=v1 --branch` output.
 * This module must not import `vscode`.
 */

export interface GitStatus {
	/** Empty when HEAD is detached. */
	branch: string;
	detached: boolean;
	upstream?: string;
	ahead: number;
	behind: number;
	/** Files reported by git, including untracked ones. */
	changedFiles: number;
	staged: number;
	unstaged: number;
	untracked: number;
}

const BRANCH_LINE = /^(?<branch>\S+?)(?:\.\.\.(?<upstream>\S+))?(?:\s+\[(?<counts>[^\]]*)\])?$/;

export function parseGitStatus(output: string): GitStatus {
	const status: GitStatus = {
		branch: '',
		detached: false,
		ahead: 0,
		behind: 0,
		changedFiles: 0,
		staged: 0,
		unstaged: 0,
		untracked: 0,
	};

	for (const line of output.split('\n')) {
		if (line.startsWith('##')) {
			parseBranchHeader(line.slice(2).trim(), status);
			continue;
		}

		if (line.trim() === '') {
			continue;
		}

		status.changedFiles++;
		const index = line[0] ?? ' ';
		const worktree = line[1] ?? ' ';

		if (index === '?' && worktree === '?') {
			status.untracked++;
			continue;
		}
		if (index !== ' ' && index !== '?') {
			status.staged++;
		}
		if (worktree !== ' ' && worktree !== '?') {
			status.unstaged++;
		}
	}

	return status;
}

function parseBranchHeader(header: string, status: GitStatus): void {
	if (header === '' || header === 'HEAD (no branch)' || header === '(no branch)') {
		status.detached = header !== '';
		return;
	}

	if (header.startsWith('No commits yet on ')) {
		status.branch = header.slice('No commits yet on '.length).trim();
		return;
	}

	const match = BRANCH_LINE.exec(header);
	if (!match?.groups) {
		status.branch = header;
		return;
	}

	const { branch, upstream, counts } = match.groups;
	status.branch = branch ?? '';

	if (upstream) {
		status.upstream = upstream;
	}

	if (counts) {
		const ahead = /ahead (\d+)/.exec(counts);
		const behind = /behind (\d+)/.exec(counts);
		status.ahead = ahead ? Number(ahead[1]) : 0;
		status.behind = behind ? Number(behind[1]) : 0;
	}
}