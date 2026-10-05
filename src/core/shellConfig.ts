import * as fs from 'node:fs';
import * as path from 'node:path';

import { SwitcherError } from './errors';

/**
 * Minimal reader for the `switch.config.sh` file used by the original shell
 * script, so both tools can share one configuration file. This module must not
 * import `vscode`.
 */

export type ShellConfigValues = Record<string, string>;

export interface ShellConfigFile {
	path: string;
	dir: string;
	values: ShellConfigValues;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parses `KEY=value`, `export KEY=value` and quoted values, ignoring comments. */
export function parseShellConfig(contents: string): ShellConfigValues {
	const values: ShellConfigValues = {};

	for (const rawLine of contents.split(/\r?\n/)) {
		const line = stripComment(rawLine).trim().replace(/^export\s+/, '').trim();
		if (line === '' || line.startsWith('#')) {
			continue;
		}
		const match = ASSIGNMENT.exec(line);
		if (!match) {
			continue;
		}
		values[match[1]] = parseValue(match[2]);
	}

	return values;
}

/** Removes an unquoted trailing `# comment`. */
function stripComment(line: string): string {
	let quote: string | undefined;

	for (let index = 0; index < line.length; index++) {
		const character = line[index];

		if (quote) {
			if (character === '\\' && quote === '"') {
				index++;
				continue;
			}
			if (character === quote) {
				quote = undefined;
			}
			continue;
		}

		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}

		if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
			return line.slice(0, index);
		}
	}

	return line;
}

function parseValue(raw: string): string {
	const value = raw.trim();
	const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : undefined;

	if (quote) {
		const end = value.indexOf(quote, 1);
		if (end !== -1) {
			const inner = value.slice(1, end);
			return quote === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
		}
	}

	// Concatenated or unquoted values, for example `"$HOME"/repos`.
	return value.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1').trim();
}

/** Reads and parses a `switch.config.sh` file. */
export function readShellConfig(file: string): ShellConfigFile {
	let contents: string;

	try {
		contents = fs.readFileSync(file, 'utf8');
	} catch (error) {
		throw new SwitcherError(`Could not read the configuration file: ${file}`, { cause: error });
	}

	return { path: file, dir: path.dirname(path.resolve(file)), values: parseShellConfig(contents) };
}
