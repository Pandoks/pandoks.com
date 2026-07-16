# Bootstrap global tools design

## Goal

Allow the existing bootstrap entrypoint to install the repository's mise tools either with repository-local activation or with current-user global activation.

```sh
./scripts/bootstrap/main.sh all
./scripts/bootstrap/main.sh all --global
```

## Behavior

- `all` preserves the current behavior. It installs `[tools]` from the repository `mise.toml` without changing the user's global mise configuration.
- `all --global` runs the same machine bootstrap, then adds every repository `[tools]` declaration to the current user's global mise configuration.
- Global installation means the tools are available from every directory for the user who ran bootstrap. It does not configure other Unix users.
- Existing unrelated entries and settings in `~/.config/mise/config.toml` must be preserved.
- `--global` and `--reload` may be used together.
- Other commands must reject `--global` rather than silently ignore it.

## Version behavior

The repository `mise.toml` remains the source of truth for tool versions.

- Exact declarations are installed globally at that exact version.
- `latest` declarations are resolved when bootstrap runs and written to the global mise config as the resolved exact version.
- `jq`, `claude-code`, `codex`, and `aws-cli` will change from exact declarations to `latest`.
- Other tool declarations remain unchanged.

This means rerunning `all --global` advances the four `latest` tools while retaining reproducible global versions for tools that remain exact in the repository.

## Implementation

1. Extend bootstrap option parsing and usage text with `--global`.
2. Keep the existing `mise bootstrap` path so system packages, shell activation, and local tool installation continue to converge normally.
3. After the local tool step succeeds, read the repository-local requested tool versions from mise, convert them to `tool@version` specifications, and invoke `mise use --global --pin --yes` with those specifications.
4. Do not overwrite or copy the entire global config; let mise merge only the selected tool entries.
5. Update the bootstrap README documentation and version descriptions to explain local versus global activation.

Mise uses one user-level installation store regardless of config scope, so globalizing an already-installed matching version should not duplicate its payload.

## Failure handling

- Failure to enumerate repository tools or update the global config fails bootstrap with a targeted error.
- An empty repository tool set is a successful no-op.
- The global config is changed only after the ordinary bootstrap succeeds.

## Verification

- Add a shell regression test that first fails without `--global` support.
- Verify default `all` does not invoke global mise configuration writes.
- Verify `all --global` writes every tool with its requested version and preserves existing unrelated global configuration.
- Verify `latest` entries are passed through for fresh resolution and exact entries remain exact.
- Verify `--global --reload` parses successfully and unsupported command/flag combinations fail.
- Run shell syntax checks, ShellCheck, the focused regression test, and the repository's existing validation commands relevant to bootstrap.
