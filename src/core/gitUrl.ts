import { encodeSecret } from './redact';

/**
 * Git URL construction and credential injection. This module must not import
 * `vscode`.
 */

export interface GitCredential {
	host: string;
	username: string;
	password: string;
}

/** HTTPS clone URL without any credentials in it. */
export function httpsCloneUrl(fullName: string, host: string): string {
	return `https://${host}/${fullName}.git`;
}

/** SSH clone URL, useful as a fallback when no HTTPS token is available. */
export function sshCloneUrl(fullName: string, host: string): string {
	return `git@${host}:${fullName}.git`;
}

/**
 * Inserts credentials into a git URL so a single command can authenticate.
 *
 * - `https://host/owner/name.git` -> `https://user:token@host/owner/name.git`
 * - `git@host:owner/name.git` -> unchanged, https is required
 * - `file:///tmp/mirror` and relative paths are returned unchanged.
 *
 * Calling this on a URL that already carries credentials is a no-op, so every
 * git operation can safely normalise its own URL.
 */
export function injectCredentials(url: string, credential: GitCredential | undefined): string {
	if (!credential) {
		return url;
	}

	const trimmed = url.trim();

	// Only https remotes can carry credentials without breaking the remote, and
	// credentials that are already present are left alone.
	if (!/^https?:\/\//i.test(trimmed) || /^https?:\/\/[^/@]+@/i.test(trimmed)) {
		return url;
	}

	return trimmed.replace(/^(https?:)\/\//i, (_match, scheme: string) => {
		return `${scheme}//${encodeSecret(credential.username)}:${encodeSecret(credential.password)}@`;
	});
}

/** Host part of a git URL, for example `github.com`. */
export function hostFromUrl(url: string, fallback = 'github.com'): string {
	const normalized = url
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
		.replace(/^[^@/]+@/, '')
		.trim();
	const host = normalized.split(/[/:]/)[0];
	return host || fallback;
}