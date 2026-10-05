/**
 * Secret masking for log output. This module must not import `vscode`.
 */

/**
 * Shortens a secret so it can be identified in a log line without leaking it.
 * `ghp_0123…cdef`
 */
export function maskSecret(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return '';
	}
	if (trimmed.length <= 8) {
		return '***';
	}
	return `${trimmed.slice(0, 4)}\u2026${trimmed.slice(-4)}`;
}

/** Replaces every known secret inside `text` with its masked form. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
	let result = text;
	for (const secret of secrets) {
		if (!secret || secret.length < 8) {
			continue;
		}
		result = result.split(secret).join(maskSecret(secret));
	}
	return result;
}

/** URL-encodes a secret for use in the userinfo part of a git remote URL. */
export function encodeSecret(value: string): string {
	return encodeURIComponent(value);
}
