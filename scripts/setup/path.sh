# shellcheck shell=sh

nvm_node_path() {
  # shellcheck disable=SC2012
  ls -d "${HOME}"/.nvm/versions/node/v"$(tr -d '[:space:]' < "${REPO_ROOT}/.nvmrc")".*/bin \
    2> /dev/null | sort -V | tail -n1
}

# needed for non-interactive shells (CI / wrappers / Claude Code Cloud)
populate_proper_pathing() {
  activate_now_node=$(nvm_node_path)
  [ -n "${activate_now_node}" ] && PATH="${activate_now_node}:${PATH}"
  [ -x "${HOME}/.local/bin/uv" ] && PATH="${HOME}/.local/bin:${PATH}"
  command -v go > /dev/null 2>&1 && PATH="$(go env GOPATH)/bin:${PATH}"
  export PATH
}
