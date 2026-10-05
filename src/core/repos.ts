/**
 * Repository helpers shared by the GitHub API client, the tree view and the
 * switcher. This module must not import `vscode`.
 */

export interface RepoInfo {
	/** `owner/name`. */
	fullName: string;
	owner: string;
	name: string;
	defaultBranch: string;
	isPrivate: boolean;
	updatedAt?: string;
}

export interface RawRepo {
	full_name: string;
	name?: string | null;
	owner?: { login?: string } | string | null;
	default_branch?: string | null;
	private?: boolean;
	updated_at?: string;
}

export interface OwnerGroup {
	owner: string;
	repositories: RepoInfo[];
}

export function toRepoInfo(raw: RawRepo): RepoInfo {
	const fullName = String(raw.full_name ?? '').trim();
	const separator = fullName.indexOf('/');
	const owner =
		(typeof raw.owner === 'string' ? raw.owner : raw.owner?.login) ?? (separator === -1 ? '' : fullName.slice(0, separator));

	return {
		fullName,
		owner,
		name: raw.name ?? (separator === -1 ? fullName : fullName.slice(separator + 1)),
		defaultBranch: raw.default_branch?.trim() || 'main',
		isPrivate: raw.private === true,
		...(raw.updated_at ? { updatedAt: raw.updated_at } : {}),
	};
}

export function compareRepos(left: RepoInfo, right: RepoInfo): number {
	return left.fullName.localeCompare(right.fullName, undefined, { sensitivity: 'base' });
}

/** Groups repositories by owner so the tree view stays readable. */
export function groupByOwner(repositories: readonly RepoInfo[]): OwnerGroup[] {
	const groups = new Map<string, OwnerGroup>();

	for (const repository of repositories) {
		// Owner logins are case insensitive, `Alpha` and `alpha` are one owner.
		const key = repository.owner.toLowerCase();
		const existing = groups.get(key);

		if (existing) {
			existing.repositories.push(repository);
		} else {
			groups.set(key, { owner: repository.owner, repositories: [repository] });
		}
	}

	return [...groups.values()]
		.map((group) => ({ owner: group.owner, repositories: [...group.repositories].sort(compareRepos) }))
		.sort((left, right) => left.owner.localeCompare(right.owner, undefined, { sensitivity: 'base' }));
}

/**
 * Reduces a git remote to `host/owner/name` so remotes in different notations
 * can be compared.
 *
 * `git@github.com:owner/name.git` -> `github.com/owner/name`
 * `https://github.com/owner/name` -> `github.com/owner/name`
 */
export function normalizeRemoteUrl(url: string): string {
	let value = url.trim();
	if (value === '') {
		return '';
	}

	if (!value.includes('://')) {
		// scp-like syntax, for example `git@github.com:owner/name.git`.
		const scp = /^(?:[^@/\\]+@)?([^:/\\]+):(?!\\)(.+)$/.exec(value);
		if (scp) {
			value = `${scp[1]}/${scp[2]}`;
		}
	}

	value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
	value = value.replace(/^[^@/]+@/, '');
	value = value.replace(/[\\/]+$/, '');
	value = value.replace(/\.git$/i, '');
	return value.toLowerCase();
}

/**
 * True when a remote points at `fullName`. The host is ignored so the check
 * also works for GitHub Enterprise remotes and for local mirrors.
 */
export function remoteMatchesRepo(remoteUrl: string | undefined | null, fullName: string): boolean {
	if (!remoteUrl) {
		return false;
	}
	const remote = normalizeRemoteUrl(remoteUrl);
	const target = fullName.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase();
	if (remote === '' || target === '') {
		return false;
	}
	return remote === target || remote.endsWith(`/${target}`);
}

/** Splits `owner/name` into its parts. */
export function splitFullName(fullName: string): { owner: string; name: string } {
	const separator = fullName.indexOf('/');
	return separator === -1
		? { owner: '', name: fullName }
		: { owner: fullName.slice(0, separator), name: fullName.slice(separator + 1) };
}