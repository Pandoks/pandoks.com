# Shell Style Guide

This style guide is heavily inspired by the
[Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html) but adapted for
**`POSIX sh`** compatibility. We use `sh` exclusively to ensure maximum portability across different
systems and for simplicity.

## Table of Contents

- [Tools](#tools)
- [Introduction](#introduction)
  - [Which Shell to Use](#which-shell-to-use)
  - [When to Use Shell](#when-to-use-shell)
- [Shell Files and Interpreter Invocation](#shell-files-and-interpreter-invocation)
  - [File Extensions](#file-extensions)
  - [Shebang](#shebang)
  - [Set Options](#set-options)
- [Comments](#comments)
  - [File Header](#file-header)
  - [Function Comments](#function-comments)
  - [Implementation Comments](#implementation-comments)
- [Formatting](#formatting)
  - [Indentation](#indentation)
  - [Line Length](#line-length)
  - [Pipelines](#pipelines)
  - [Control Flow](#control-flow)
  - [Case Statements](#case-statements)
  - [Variable Expansion](#variable-expansion)
  - [Quoting](#quoting)
- [Features and Limitations](#features-and-limitations)
  - [What Works in POSIX sh](#what-works-in-posix-sh)
  - [What Does NOT Work in POSIX sh](#what-does-not-work-in-posix-sh)
  - [Test Operators](#test-operators)
  - [Command Substitution](#command-substitution)
  - [Arithmetic](#arithmetic)
- [Naming Conventions](#naming-conventions)
  - [Function Names](#function-names)
  - [Variable Names](#variable-names)
  - [Constants and Environment Variables](#constants-and-environment-variables)
  - [Source Filenames](#source-filenames)
- [Best Practices](#best-practices)
  - [Use Readonly for Constants](#use-readonly-for-constants)
  - [Check Return Values](#check-return-values)
  - [Error Messages to STDERR](#error-messages-to-stderr)
  - [Wildcard Expansion of Filenames](#wildcard-expansion-of-filenames)
  - [Eval](#eval)
  - [Use Functions for Reusable Code](#use-functions-for-reusable-code)
  - [`main` Function](#main-function)
  - [Avoid Global Variable Pollution](#avoid-global-variable-pollution)
  - [Use `set -eu` for Safety](#use-set--eu-for-safety)
  - [Prefer Builtins Over External Commands](#prefer-builtins-over-external-commands)
  - [Use Meaningful Exit Codes](#use-meaningful-exit-codes)
  - [Validate Input Early](#validate-input-early)
  - [Use Trap for Cleanup](#use-trap-for-cleanup)
  - [Awk](#awk)
  - [Function Arguments](#function-arguments)
- [Example Script](#example-script)
- [Testing Your Scripts](#testing-your-scripts)
  - [Test with Different Shells](#test-with-different-shells)
  - [Use ShellCheck](#use-shellcheck)
- [When in Doubt](#when-in-doubt)
- [References](#references)

## Tools

These are the tools that help maintain the style of this codebase:

- [shfmt](https://github.com/mvdan/sh)
- [shellcheck](https://github.com/koalaman/shellcheck)
- [bash-language-server](https://github.com/mads-hartmann/bash-language-server) (supports
  integration with `shfmt` and `shellcheck`)

You should install these tools in your editor of choice and your OS' package manager.

> [!TIP]
> The repo already sets up most of the config files (`.editorconfig`, `.shellcheckrc`) to follow
> these best practices, but you should still read through the guide as things like sentimental style
> can't be enforced by these.

## Introduction

### Which Shell to Use

**`POSIX sh` is the only shell scripting language permitted.**

All _executable_ shell scripts must start with `#!/bin/sh` and use only POSIX-compliant features.

#### Why sh instead of bash?

- **Maximum portability** - Works on all UNIX-like systems (Linux, BSD, macOS, Alpine, busybox, etc.)
- **Minimal dependencies** - sh is guaranteed to be present on every POSIX system
- **Lightweight** - Smaller footprint, faster startup
- **Constraint-driven quality** - Forces simpler, more maintainable code
- **Simiplicity** - If you need `bash` features, use a full fledged language (e.g., `go`, `python`, etc)

#### What this means

- ❌ No bash-specific features (`[[`, `local`, arrays, `(( ))`, etc.)
- ✅ Only POSIX sh features (`[ ]`, `case`, `$(( ))`, functions, etc.)
- ✅ Test scripts with `/bin/sh` or `dash` to ensure compatibility

### When to Use Shell

Shell should only be used for small utilities or simple wrapper scripts.

#### Use Shell When

- You're mostly calling other utilities and doing relatively little data manipulation
- Performance is not critical
- The logic is straightforward

#### Don't use shell when:

- You need complex data structures and features (use `go`, `python`, etc.)
- Performance matters

## Shell Files and Interpreter Invocation

### File Extensions

- Executables should have **no extension** or a `.sh` extension
- Libraries must have a `.sh` extension and should not be executable

### Shebang

All _executable_ scripts must start with:

```sh
#!/bin/sh
```

All _library_ scripts must start with:

```sh
# shellcheck shell=sh
```

### Set Options

Use `set` to configure shell behavior at the top of your _executable_ script:

```sh
#!/bin/sh

set -eu
```

**Note:** Do NOT use `set -o pipefail` as it is not POSIX-compliant.

Options:

- `-e` - Exit immediately if a command exits with a non-zero status
- `-u` - Treat unset variables as an error

You do **NOT** need to `set` for `lib` scripts.

## Comments

### File Header

Default to not having a top-level comment with a description of its contents. Only if the file isn't
obviously clear on what it does should you add a comment.

Example:

```sh
#!/bin/sh
#
# Perform hot backups of Oracle databases.
set -eu
```

```sh
# shellcheck shell=sh
# shellcheck disable=SC2034
#
# Library for hot backups of Oracle databases.
```

### Function Comments

Any function that is not obvious or isn't easily parsable for inputs and outputs must have a header
comment:

```sh
#######################################
# Cleanup files from the backup directory.
# Globals:
#   BACKUP_DIR
#   ORACLE_SID
# Arguments:
#   None
# Outputs:
#   Writes status messages to stdout
#   Writes error messages to stderr
# Returns:
#   0 on success, 1 on failure
#######################################
cleanup() {
  ...
}
```

### Implementation Comments

Comment tricky, non-obvious, or important parts of your code:

```sh
# Parse the subnet from docker network (format: "172.18.0.0/16")
subnet=$(docker network inspect "${network}" | jq -r '.[0].IPAM.Config[0].Subnet')
```

**Note:** Code should generally be easily followable by a human, so add comments sparingly.

## Formatting

### Indentation

- **2 spaces** for indentation
- **No tabs** (except in heredoc bodies with `<<-`)

### Line Length

Maximum line length is **100 characters**.

For long strings, use here documents or embedded newlines:

```sh
# Use here documents for long strings
cat <<EOF
This is a very long string that would
exceed 100 characters on a single line.
EOF

# Or embedded newlines
long_string="This is a very long string
that spans multiple lines."
```

### Pipelines

Split pipelines one per line if they don't fit:

```sh
# All fits on one line
command1 | command2

# Long pipelines
command1 \
  | command2 \
  | command3 \
  | command4
```

### Control Flow

Put `; then` and `; do` on the same line as `if`, `for`, or `while`:

```sh
for dir in "${dirs_to_cleanup}"; do
  if [ -d "${dir}/${SESSION_ID}" ]; then
    log_date "Cleaning up old files in ${dir}/${SESSION_ID}"
    rm "${dir}/${SESSION_ID}/"* || error_message
  else
    mkdir -p "${dir}/${SESSION_ID}" || error_message
  fi
done
```

### Case Statements

- Indent alternatives by 2 spaces
- Pattern, actions, and `;;` on separate lines for complex cases
- Simple one-liners can stay on one line

```sh
case "${expression}" in
  a)
    variable="value"
    some_command "${variable}"
    ;;
  b) other_command ;;
  *) error "Unexpected expression '${expression}'" ;;
esac
```

### Variable Expansion

Always use `"${var}"` for normal variable expansion:

```sh
# Preferred
echo "PATH=${PATH}, PWD=${PWD}, mine=${some_var}"

echo "many parameters: ${10}"
```

Don't brace single character shell specials or positional parameters:

```sh
echo "Positional: $1" "$5" "$3"
echo "Specials: !=$!, -=$-, _=$_, #=$#, *=$*, @=$@, \$=$$ ..."
```

### Quoting

**Always quote** strings containing variables, command substitutions, spaces, or shell meta characters:

```sh
# Quote variables
echo "${flag}"

# Quote command substitutions
flag="$(some_command and its args "$@")"

# Quote strings with spaces
message="Hello, world!"

# Don't quote literal integers
value=32

# Don't quote in arithmetic context
result=$((value + 10))
```

## Features and Limitations

### What Works in POSIX sh

✅ **`[ ]` tests**

```sh
if [ -f "${file}" ]; then
  echo "File exists"
fi
```

✅ **`case` statements**

```sh
case "${var}" in
  pattern) action ;;
esac
```

✅ **`$(( ))` arithmetic**

```sh
result=$((x + y))
i=$((i + 1))
```

✅ **`$( )` command substitution**

```sh
output=$(command)
```

✅ **`readonly` variables**

```sh
readonly CONSTANT="value"
```

✅ **Functions**

```sh
my_function() {
  echo "Hello"
}
```

### What Does NOT Work in POSIX sh

❌ **`local` keyword**

```sh
# Does NOT work in sh
my_func() {
  local var="value"  # ERROR
}

# Workaround: Accept that variables are global
my_func() {
  var="value"  # This is global
}
```

❌ **`declare` keyword**

```sh
# Does NOT work in sh
declare var="value"

# Workaround: export in different line
readonly var="value"
export var
```

❌ **`[[ ]]` tests**

```sh
# Does NOT work in sh
if [[ "${var}" == "value" ]]; then  # ERROR

# Use [ ] instead
if [ "${var}" = "value" ]; then  # OK
```

❌ **`==` operator (use `=`)**

```sh
# Does NOT work in sh
[ "${var}" == "value" ]  # ERROR

# Use = instead
[ "${var}" = "value" ]  # OK
```

❌ **`(( ))` arithmetic tests**

```sh
# Does NOT work in sh
if (( i > 5 )); then  # ERROR

# Use [ ] with -gt, -lt, etc.
if [ ${i} -gt 5 ]; then  # OK
```

❌ **Arrays**

```sh
# Does NOT work in sh
arr=(one two three)  # ERROR

# Workaround: Use space-separated strings or multiple variables
```

❌ **`function` keyword**

```sh
# Does NOT work in sh
function my_func() {  # ERROR
  …
}

# Use standard syntax
my_func() {  # OK
  …
}
```

### Test Operators

Use `[ ]` for all tests. Common operators:

#### File Tests

| Operator                | Description                       |
| ----------------------- | --------------------------------- |
| `[ -f "${file_path}" ]` | File exists and is a regular file |
| `[ -d "${dir_path}" ]`  | Directory exists                  |
| `[ -e "${path}" ]`      | Path exists (file or directory)   |
| `[ -r "${file_path}" ]` | File is readable                  |
| `[ -w "${file_path}" ]` | File is writable                  |
| `[ -x "${file_path}" ]` | File is executable                |

#### String Tests

| Operator                           | Description                                                                |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `[ -z "${string}" ]`               | String is empty                                                            |
| `[ -n "${string}" ]`               | String is not empty                                                        |
| `[ "${string1}" = "${string2}" ]`  | Strings are equal (**Note:** single `=`, `==` isn't supported in POSIX sh) |
| `[ "${string1}" != "${string2}" ]` | Strings are not equal                                                      |

#### Numeric Tests

| Operator              | Description           |
| --------------------- | --------------------- |
| `[ ${n1} -eq ${n2} ]` | Equal                 |
| `[ ${n1} -ne ${n2} ]` | Not equal             |
| `[ ${n1} -lt ${n2} ]` | Less than             |
| `[ ${n1} -le ${n2} ]` | Less than or equal    |
| `[ ${n1} -gt ${n2} ]` | Greater than          |
| `[ ${n1} -ge ${n2} ]` | Greater than or equal |

#### Logical Operators

| Operator         | Description |
| ---------------- | ----------- |
| `! expr`         | Logical NOT |
| `expr1 -a expr2` | Logical AND |
| `expr1 -o expr2` | Logical OR  |

### Command Substitution

Always use `$(command)` instead of backticks:

```sh
# Preferred
var="$(command "$(command1)")"

# Not this
var="`command \`command1\``"
```

### Arithmetic

Use `$(( ))` for arithmetic:

```sh
# Simple calculation
result=$((2 + 2))

# Variable assignment
i=$((i + 1))
count=$((count - 5))

# In conditions, use [ ] with numeric operators
if [ ${count} -gt 10 ]; then
  echo "Count is greater than 10"
fi
```

## Naming Conventions

### Function Names

Lowercase with underscores to separate words:

```sh
my_function() {
  …
}

validate_ip_address() {
  …
}
```

### Variable Names

Lowercase with underscores:

```sh
my_var="value"
file_count=0
user_input=""
```

Loop variables should be descriptive:

```sh
for zone in "${zones}"; do
  something_with "${zone}"
done
```

### Constants and Environment Variables

UPPERCASE with underscores, declared with `readonly`:

```sh
# Constants
readonly MAX_RETRIES=3
readonly DEFAULT_TIMEOUT=30

# Environment variables (exported)
readonly DATABASE_URL="postgres://localhost/mydb"
export DATABASE_URL
```

It's ok to set a constant at runtime or in a conditional, but it should be made readonly immediately
after it's set.

```sh
ZIP_VERSION="$(dpkg --status zip | sed -n 's/^Version: //p')"
if [[ -z "${ZIP_VERSION}" ]]; then
  ZIP_VERSION="$(pacman -Q --info zip | sed -n 's/^Version *: //p')"
fi
if [[ -z "${ZIP_VERSION}" ]]; then
  handle_error_and_quit
fi
readonly ZIP_VERSION
```

### Source Filenames

Lowercase with underscores:

```sh
my_library.sh
database_utils.sh
```

## Best Practices

### Use Readonly for Constants

Declare constants at the top of the file with `readonly`:

```sh
#!/bin/sh

set -eu

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly MAX_RETRIES=3
readonly TIMEOUT=30
```

### Check Return Values

Always check return values and provide informative error messages:

```sh
if ! mv "${file_list}" "${dest_dir}/"; then
  echo "Error: Unable to move ${file_list} to ${dest_dir}" >&2
  exit 1
fi

# Or
mv "${file_list}" "${dest_dir}/"
if [ $? -ne 0 ]; then
  echo "Error: Unable to move ${file_list} to ${dest_dir}" >&2
  exit 1
fi
```

### Error Messages to STDERR

All error messages should go to stderr:

```sh
echo "Error: File not found: ${file}" >&2
printf "Error: Invalid argument: %s\n" "${arg}" >&2
```

### Wildcard Expansion of Filenames

Use an explicit path when doing wildcard expansion of filenames.

As filenames can begin with a `-` and the shell expands the command before execution meaning that
it'll interpret the file as an option, it's a lot safer to expand wildcards with `./*` instead of
`*`.

### Eval

`eval` should be avoided.

Eval munges the input when used for assignment to variables and can set variables without making it
possible to check what those variables were.

### Use Functions for Reusable Code

Break complex scripts into functions:

```sh
#######################################
# Validate IP address format.
# Arguments:
#   IP address to validate
# Returns:
#   0 if valid, 1 otherwise
#######################################
validate_ip() {
  ip="$1"
  # Validation logic here
}

# Use it
if validate_ip "${user_input}"; then
  echo "Valid IP"
else
  echo "Invalid IP" >&2
  exit 1
fi
```

### `main` Function

All _executable_ scripts must have a `main` function that handles the script's logic.

```sh
#!/bin/sh

set -eu

main() {
  echo "Hello, world!"
}

main "$@"
```

### Avoid Global Variable Pollution

Since sh doesn't have `local`, be careful with variable names in functions:

```sh
# Bad - might conflict with global 'result'
calculate() {
  result=$((5 + 5))
}

# Better - use descriptive, unique names
calculate() {
  calculation_result=$((5 + 5))
}

# Or prefix with function name
calculate() {
  calculate_result=$((5 + 5))
}
```

### Use `set -eu` for Safety

Always use at the top of your script:

```sh
#!/bin/sh

set -eu
```

This will:

- Exit on errors (`-e`)
- Treat unset variables as errors (`-u`)

**Note:** Do NOT use `set -o pipefail` as it's not POSIX.

### Prefer Builtins Over External Commands

Use shell builtins when possible for better performance:

```sh
# Preferred - using parameter expansion
base="${filename%.*}"
extension="${filename##*.}"

# Avoid - spawning external process
base="$(echo "${filename}" | sed 's/\.[^.]*$//')"
```

### Use Meaningful Exit Codes

```sh
# Success
exit 0

# General error
exit 1

# Specific errors (optional)
exit 2  # Misuse of command
exit 126  # Command cannot execute
exit 127  # Command not found
```

### Validate Input Early

Check arguments and preconditions at the start:

```sh
#!/bin/sh

set -eu

if [ $# -lt 1 ]; then
  echo "Usage: $0 <filename>" >&2
  exit 1
fi

filename="$1"

if [ ! -f "${filename}" ]; then
  echo "Error: File not found: ${filename}" >&2
  exit 1
fi

# Now proceed with the script
process_file "${filename}"
```

### Use Trap for Cleanup

Clean up temporary files on exit:

```sh
tmp_file=$(mktemp)
trap 'rm -f "${tmp_file}"' EXIT

# Use tmp_file
echo "data" > "${tmp_file}"

# Cleanup happens automatically on exit
```

### Awk

Try not to use `awk` as it makes scripts harder to read and maintain.

### Function Arguments

Function arguments should be parsed at the top of the function for easy readability:

```sh
cleanup() {
  cleanup_arg_1="$1"

  ...
}
```

## Example Script

Here's a complete example following this style guide:

```sh
#!/bin/sh
#
# Backup script for database files.
# Creates timestamped backups and manages retention.

set -eu

readonly BACKUP_DIR="/var/backups/db"
readonly MAX_BACKUPS=7
readonly TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

usage() {
  echo "Usage: $0 <database_name>" >&2
  echo "" >&2
  echo "Creates a backup of the specified database." >&2
  exit 1
}

#######################################
# Create backup of database.
# Arguments:
#   Database name
# Returns:
#   0 on success, 1 on failure
#######################################
create_backup() {
  db_name="$1"
  backup_file="${BACKUP_DIR}/${db_name}_${TIMESTAMP}.sql"

  echo "Creating backup: ${backup_file}"

  if ! pg_dump "${db_name}" > "${backup_file}"; then
    echo "Error: Backup failed for ${db_name}" >&2
    return 1
  fi

  echo "Backup created successfully"
  return 0
}

cleanup_old_backups() {
  db_name="$1"

  # Count backups
  backup_count=$(find "${BACKUP_DIR}" -name "${db_name}_*.sql" | wc -l)

  if [ ${backup_count} -gt ${MAX_BACKUPS} ]; then
    echo "Removing old backups (keeping ${MAX_BACKUPS})"
    find "${BACKUP_DIR}" -name "${db_name}_*.sql" \
      | sort \
      | head -n -${MAX_BACKUPS} \
      | xargs rm -f
  fi
}

main() {
  if [ $# -lt 1 ]; then
    usage
  fi

  db_name="$1"

  # Ensure backup directory exists
  if [ ! -d "${BACKUP_DIR}" ]; then
    mkdir -p "${BACKUP_DIR}"
  fi

  # Create backup
  if ! create_backup "${db_name}"; then
    exit 1
  fi

  # Cleanup old backups
  cleanup_old_backups "${db_name}"

  echo "Backup complete"
}

main "$@" # If arguments are needed
main # If no arguments are needed
```

## Testing Your Scripts

### Test with Different Shells

Test your scripts with different POSIX sh implementations:

```sh
# Test with dash (strict POSIX)
dash your_script.sh

# Test with system sh
/bin/sh your_script.sh

# Test with ash (busybox)
ash your_script.sh
```

### Use ShellCheck

Run [ShellCheck](https://www.shellcheck.net/) on all scripts:

```sh
shellcheck your_script.sh
```

## When in Doubt

1. **Be consistent** with existing code
2. **Prefer simplicity** over cleverness
3. **Test with `/bin/sh`** or `dash` to ensure POSIX compliance
4. **Ask yourself:** "Would this work on Alpine Linux?" (uses busybox sh)

## References

- [POSIX Shell Command Language Specification](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
- [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html)
- [ShellCheck](https://www.shellcheck.net/)
- [Dash Man Page](https://man.archlinux.org/man/dash.1)
