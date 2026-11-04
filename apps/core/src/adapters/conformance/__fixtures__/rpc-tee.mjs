#!/usr/bin/env node
// Запись живого CLI JSON-RPC по stdio для набора соответствия: запускает настоящий CLI
// (RPC_TEE_REAL — путь к его .js или исполняемому файлу), передаёт stdin/stdout как есть и
// пишет каждую строку в файл записи RPC_TEE_OUT: {"d":"in"|"out","line":"..."}. Запись затем
// проигрывает replay-rpc.mjs — без CLI, без модели, без сети.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const real = process.env.RPC_TEE_REAL;
const out = process.env.RPC_TEE_OUT;
if (!real || !out) {
  process.stderr.write('rpc-tee: RPC_TEE_REAL and RPC_TEE_OUT are required\n');
  process.exit(2);
}
const isJs = /\.(c|m)?js$/i.test(real);
const child = spawn(
  isJs ? process.execPath : real,
  [...(isJs ? [real] : []), ...process.argv.slice(2)],
  {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  },
);
const log = (d, line) => appendFileSync(out, `${JSON.stringify({ d, line })}\n`);

// Строки целиком: запись хранит границы сообщений протокола, а не куски буфера.
const lines = (stream, d, sink) => {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).replace(/\r$/, '');
      buf = buf.slice(at + 1);
      if (line.trim()) log(d, line);
      sink(`${line}\n`);
    }
  });
};
lines(process.stdin, 'in', (l) => child.stdin.write(l));
lines(child.stdout, 'out', (l) => process.stdout.write(l));
process.stdin.on('end', () => child.stdin.end());
child.on('exit', (code) => process.exit(code ?? 1));
