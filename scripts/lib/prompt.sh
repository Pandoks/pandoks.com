# shellcheck shell=sh

# NOTE: hides typed input, shows live masked feedback on a TTY, trims whitespace, and prints on stdout
prompt_secret() {
  prompt_secret_label=$1

  if [ -t 0 ]; then
    node -e '
      const label = process.argv[1];
      const dim = "\x1b[2m";
      const reset = "\x1b[0m";
      let value = "";
      const render = () => {
        const trimmed = value.trim();
        const mask = trimmed.length >= 8 ? `••••${trimmed.slice(-4)}` : "•".repeat(trimmed.length);
        process.stderr.write(`\r${label}${dim}${mask}${reset}\x1b[K`);
      };
      const done = (code) => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write("\n");
        if (code === 0) process.stdout.write(`${value.trim()}\n`);
        process.exit(code);
      };
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      render();
      process.stdin.on("data", (chunk) => {
        for (const ch of chunk.replace(/\x1b\[20[01]~/g, "")) {
          if (ch === "\x03") done(130);
          if (ch === "\x04") done(0);
          if (ch === "\r" || ch === "\n") {
            if (value.trim()) {
              render();
              done(0);
            }
            continue;
          }
          if (ch === "\x7f" || ch === "\x08") value = value.slice(0, -1);
          else if (ch === "\x15") value = "";
          else if (ch >= " " || ch === "\t") value += ch;
        }
        render();
      });
    ' "${prompt_secret_label}"
    return $?
  fi

  prompt_secret_value=''
  printf '%s' "${prompt_secret_label}" >&2
  if IFS= read -r prompt_secret_line; then
    prompt_secret_value=$(printf '%s' "${prompt_secret_line}" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  fi
  printf '%s\n' "${prompt_secret_value}"
}
