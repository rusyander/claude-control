// Подмена процесса ядра для проверки самой обвязки `runCore` (stand.test.ts), без ядра и CLI.
// Режим — в `request` настройки: что процесс оставит после себя (записи, итог, оборванный хвост).
import { Buffer } from 'node:buffer';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const cfg = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8'));
const out = join(cfg.home, '..');
const notes = join(out, 'conduct.jsonl');
const line = (event) =>
  `${JSON.stringify({ at: Date.now(), pid: process.pid, runId: cfg.runId, event })}\n`;

switch (cfg.request) {
  case 'torn-tail':
    // Целая запись, затем половина следующей — процесс убит посреди записи.
    appendFileSync(notes, line('boot'));
    appendFileSync(notes, line('task').slice(0, 20));
    writeFileSync(join(out, `result-${cfg.runId}.json`), JSON.stringify({ outcome: 'ok' }));
    break;
  case 'garbage-result':
    appendFileSync(notes, line('boot'));
    writeFileSync(join(out, `result-${cfg.runId}.json`), '{"outcome":');
    break;
  case 'no-result':
    appendFileSync(notes, line('boot'));
    break;
  default:
    throw new Error(`fake core child: unknown mode ${cfg.request}`);
}
