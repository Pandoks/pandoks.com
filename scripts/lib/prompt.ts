import { readSync } from 'node:fs';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CLEAR_TO_EOL = '\x1b[K';
const MAX_MASK_DOTS = 24;

const label = process.argv[2] ?? '';

function readLineFromStdin(): string {
  const bytes: number[] = [];
  const buffer = Buffer.alloc(1);
  while (readSync(0, buffer, 0, 1, null) > 0) {
    if (buffer[0] === 0x0a) {
      break;
    }
    bytes.push(buffer[0]);
  }
  return Buffer.from(bytes).toString('utf8').trim();
}

if (!process.stdin.isTTY) {
  process.stderr.write(label);
  process.stdout.write(`${readLineFromStdin()}\n`);
  process.exit(0);
}

let value = '';

function render() {
  const trimmed = value.trim();
  const mask =
    trimmed.length >= 8
      ? `${'•'.repeat(Math.min(trimmed.length - 4, MAX_MASK_DOTS))}${trimmed.slice(-4)}`
      : '•'.repeat(trimmed.length);
  process.stderr.write(`\r${label}${DIM}${mask}${RESET}${CLEAR_TO_EOL}`);
}

function finish(exitCode: number) {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stderr.write('\n');
  if (exitCode === 0) {
    process.stdout.write(`${value.trim()}\n`);
  }
  process.exit(exitCode);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
render();

process.stdin.on('data', (chunk: string) => {
  for (const char of chunk.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '')) {
    if (char === '\x03') {
      finish(130);
    }
    if (char === '\x04') {
      finish(0);
    }
    if (char === '\r' || char === '\n') {
      if (value.trim()) {
        render();
        finish(0);
      }
      continue;
    }
    if (char === '\x7f' || char === '\x08') {
      value = value.slice(0, -1);
    } else if (char === '\x15') {
      value = '';
    } else if (char >= ' ' || char === '\t') {
      value += char;
    }
  }
  render();
});
