import { spawn } from 'node:child_process';

import { errorText, SwitcherError } from './core/errors';
import { Logger } from './logger';

export interface RunOptions {
	cwd?: string;
	signal?: AbortSignal;
	/** Extra environment variables for this call. */
	env?: NodeJS.ProcessEnv;
	/** Resolve instead of throwing when git exits with a non-zero code. */
	allowFailure?: boolean;
	/** Written to stdin, then stdin is closed. */
	input?: string;
	timeoutMs?: number;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export class GitError extends SwitcherError {
	constructor(
		message: string,
		readonly args: string[],
		readonly code: number,
		readonly stderr: string,
	) {
		super(message);
		this.name = 'GitError';
	}
}

/**
 * Thin wrapper around the `git` executable. Terminal prompts are disabled so a
 * command can never block the extension host waiting for credentials.
 */
export class Git {
	constructor(
		private readonly gitPath: string,
		private readonly logger: Logger,
		private readonly baseEnv: NodeJS.ProcessEnv = {},
	) {}

	get executable(): string {
		return this.gitPath;
	}

	async run(args: string[], options: RunOptions = {}): Promise<RunResult> {
		const result = await this.exec(args, { ...options, allowFailure: true });
		if (result.code !== 0 && !options.allowFailure) {
			throw new GitError(
				`git ${args.join(' ')} failed with exit code ${result.code}${result.stderr ? `: ${firstLine(result.stderr)}` : ''}`,
				args,
				result.code,
				result.stderr,
			);
		}
		return result;
	}

	/** Runs git and returns `undefined` when the command is not available. */
	async tryRun(args: string[], options: RunOptions = {}): Promise<RunResult | undefined> {
		try {
			return await this.exec(args, { ...options, allowFailure: true });
		} catch (error) {
			this.logger.debug(`git ${args.join(' ')} could not start: ${errorText(error)}`);
			return undefined;
		}
	}

	/** True when the git executable can be started. */
	async isAvailable(): Promise<boolean> {
		const result = await this.tryRun(['--version']);
		return result?.code === 0;
	}

	private exec(args: string[], options: RunOptions): Promise<RunResult> {
		this.logger.debug(`$ git ${args.join(' ')}${options.cwd ? ` (cwd: ${options.cwd})` : ''}`);

		return new Promise<RunResult>((resolve, reject) => {
			const child = spawn(this.gitPath, args, {
				cwd: options.cwd,
				windowsHide: true,
				env: {
					...process.env,
					...this.baseEnv,
					...options.env,
					// Never wait for an interactive credential or passphrase prompt.
					GIT_TERMINAL_PROMPT: '0',
				},
			});

			let stdout = '';
			let stderr = '';
			let settled = false;

			child.stdout?.on('data', (chunk: Buffer) => {
				stdout += chunk.toString('utf8');
			});
			child.stderr?.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf8');
			});

			const onAbort = (): void => {
				this.logger.warn(`Aborted: git ${args.join(' ')}`);
				killProcessTree(child);
			};

			options.signal?.addEventListener('abort', onAbort, { once: true });

			const timer =
				options.timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							this.logger.warn(`Timed out after ${options.timeoutMs} ms: git ${args.join(' ')}`);
							killProcessTree(child);
						}, options.timeoutMs);

			const cleanup = (): void => {
				settled = true;
				options.signal?.removeEventListener('abort', onAbort);
				if (timer) {
					clearTimeout(timer);
				}
			};

			child.on('error', (error: NodeJS.ErrnoException) => {
				if (settled) {
					return;
				}
				cleanup();
				reject(
					new SwitcherError(`Could not run "${this.gitPath}": ${error.message}`, {
						cause: error,
						hint: 'Make sure Git is installed and githubSwitcher.gitPath points at the executable.',
					}),
				);
			});

			child.on('close', (code) => {
				if (settled) {
					return;
				}
				cleanup();
				const text = stdout.trim();
				if (text !== '') {
					this.logger.debug(text);
				}
				if (stderr.trim() !== '') {
					this.logger.debug(stderr.trim());
				}
				resolve({ code: code ?? -1, stdout, stderr });
			});

			if (options.input === undefined) {
				child.stdin?.end();
			} else {
				child.stdin?.end(options.input, 'utf8');
			}
		});
	}
}

function firstLine(value: string): string {
	return value.trim().split(/\r?\n/, 1)[0] ?? '';
}

/** Kills the child and, on Windows, everything it spawned. */
function killProcessTree(child: ReturnType<typeof spawn>): void {
	if (child.pid === undefined) {
		return;
	}

	if (process.platform === 'win32') {
		try {
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
			return;
		} catch {
			// Fall through to a plain kill.
		}
	}

	try {
		child.kill('SIGTERM');
	} catch {
		// Ignore, the process is already gone.
	}
}