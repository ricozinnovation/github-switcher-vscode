# GitHub Switcher for VS Code

A VS Code port of `switch.sh`: switch the workspace folder between your GitHub
repositories from a quick pick, without losing uncommitted work.

Switching to another repository:

1. saves the current work to `temp/<user>/<branch>` (stash, commit, push),
2. clones the selected repository into a staging directory,
3. checks out `develop`, or the repository default branch when it does not exist,
4. restores `temp/<user>/<branch>` when the remote has one for that branch,
5. replaces the workspace folder only after every step above succeeded.

## Features

- Quick pick of every repository the token can reach, grouped by owner in the
  Activity Bar view.
- Status bar entry with the current repository, branch and a warning marker when
  the working tree is dirty.
- Cancellable progress notifications with a full log in the **GitHub Switcher**
  output channel; secrets are masked there.
- Uncommitted work is never discarded: a failed stash pop aborts the switch and
  tells you exactly what to resolve.
- The clone is prepared completely before the workspace is touched. The previous
  folder is renamed to a `*.github-switcher-backup-*` sibling instead of being
  deleted, so a locked file cannot destroy your work.
- Reads your existing `switch.config.sh`, so both tools share one configuration.

## Requirements

- VS Code 1.85 or newer
- `git` on the `PATH`
- Credentials, either:
  - a personal access token with the `repo` scope, or
  - a signed-in GitHub CLI (`gh auth login`), which is detected automatically

## Setup

Run **GitHub Switcher: Run Setup** from the command palette. The wizard stores the
token in VS Code SecretStorage, fills in your GitHub login and asks for the
workspace directory. The tree view shows *Setup required* until this is done.

## Commands

| Command | Description |
| --- | --- |
| `GitHub Switcher: Switch Repository` | Pick a repository and switch to it |
| `GitHub Switcher: Save Current Work to Temporary Branch` | Only run the save step |
| `GitHub Switcher: Refresh Repository List` | Bypass the list cache |
| `GitHub Switcher: Run Setup` | Guided setup |
| `GitHub Switcher: Set GitHub Token` | Store or replace the token |
| `GitHub Switcher: Set GitHub Username` | Login used for temporary branch names |
| `GitHub Switcher: Set Workspace Directory` | Directory that gets replaced |
| `GitHub Switcher: Clean Up Leftover Backups` | Remove `*.github-switcher-backup-*` folders |

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `githubSwitcher.configFile` | `""` | Path to `switch.config.sh`; discovered next to the open folder when empty |
| `githubSwitcher.githubUsername` | `""` | Login for `temp/<user>/<branch>`; defaults to the authenticated account |
| `githubSwitcher.workspaceDirectory` | `""` | Directory that is replaced; defaults to the open folder |
| `githubSwitcher.defaultBranch` | `develop` | Branch to check out after cloning |
| `githubSwitcher.tempBranchPrefix` | `temp` | Prefix of temporary branches |
| `githubSwitcher.repoLimit` | `1000` | Upper bound on repositories fetched |
| `githubSwitcher.affiliation` | `owner,collaborator,organization_member` | API filter |
| `githubSwitcher.apiBaseUrl` | `https://api.github.com` | Change for GitHub Enterprise |
| `githubSwitcher.gitHost` | `github.com` | Host used for clone URLs |
| `githubSwitcher.gitPath` / `githubSwitcher.ghPath` | `git` / `gh` | Executables |
| `githubSwitcher.useGitHubCli` | `true` | Use `gh auth setup-git` when available |
| `githubSwitcher.storeCredentials` | `true` | Put the token in the OS credential store of the new clone |
| `githubSwitcher.confirmBeforeSwitch` | `true` | Ask before the folder is replaced |
| `githubSwitcher.reloadAfterSwitch` | `true` | Reload the window after a successful switch |
| `githubSwitcher.showStatusBarItem` | `true` | Status bar entry |
| `githubSwitcher.listCacheMinutes` | `5` | How long the repository list is reused |

### Using switch.config.sh

A `switch.config.sh` next to the open folder is picked up automatically, and
`GITHUB_USERNAME`, `GITHUB_PAT`, `WORKSPACE_DIR`, `DEFAULT_BRANCH`,
`TEMP_BRANCH_PREFIX` and `REPO_LIMIT` are read from it. A relative `WORKSPACE_DIR`
is resolved against the directory of that file.

Precedence is: **an explicitly set VS Code setting, then the config file, then
the built-in default.** Settings you never touched do not shadow the file, so
`switch.sh` and the extension stay in sync.

Only `KEY=value` lines are parsed. Command substitution, variables and other
shell features are ignored rather than executed.

## Differences from switch.sh

| Behaviour | `switch.sh` | This extension |
| --- | --- | --- |
| Authentication | `GH_TOKEN` + `gh auth setup-git` | Same, with a token-only fallback when `gh` is missing |
| Token source | `GITHUB_PAT` in the config file | SecretStorage, then the config file, then `gh` |
| Replacing the workspace | `rm -rf` then `mv` | Rename the old folder aside, `mv` the clone in, delete the backup after reload |
| Push | `git push -u origin <branch>` | `--force-with-lease` against a verified remote sha, credentials never stored in `.git/config` |
| Cancellation | not available | Progress notification cancels the running git process |
| Where it runs | terminal | VS Code, with the same log messages |

## Development

```bash
npm install
npm run compile          # tsc -p ./
npm test                 # unit tests for the pure logic
npm run test:integration # real git repositories in a temp directory
npm run package          # produces a .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host. Install it
permanently with **Extensions: Install from VSIX**, or symlink the folder into
`~/.vscode/extensions` while developing.

Unit tests cover the parts where a mistake is silent: `switch.config.sh`
parsing, temporary branch naming, protected directory checks, remote URL
matching and `git status` parsing. The integration check builds throwaway
repositories and verifies the whole save, clone, restore and replace sequence.

## Safety notes

- The extension never deletes a directory that is not the configured workspace
  folder, and refuses to replace the filesystem root, your home directory, the
  temp directory or a directory containing the extension itself.
- Cloning happens before anything is removed, so a failed clone cannot cost you
  the current repository.
- `git push` uses `--force-with-lease` with the remote sha that was just read, so
  a concurrent push to the temporary branch is rejected instead of overwritten.
- Interactive credential prompts are disabled, so a command fails fast rather
  than hanging the extension host.

## API

```ts
const switcher = vscode.extensions.getExtension('ricozinnovation.github-switcher');
const api = await switcher?.activate();

await api?.listRepositories();
await api?.switchRepository('owner/repo');
```