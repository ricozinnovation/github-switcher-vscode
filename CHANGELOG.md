# Changelog

## 0.1.0

- Switch the workspace to any repository of the authenticated GitHub account.
- Save the current work to `temp/<user>/<branch>` before switching
  (stash, commit and push, mirroring `switch.sh`).
- Restore the saved temporary branch when the same branch exists on the remote.
- Repository picker in the Activity Bar view and in the command palette.
- Status bar entry with the current repository, branch and working tree state.
- Reads `switch.config.sh` when present, stores the token in VS Code SecretStorage.
- Authenticate through the GitHub CLI when it is signed in, otherwise use the token directly.
- Replaces the workspace directory through a rename, keeps a backup until the window reloads.
