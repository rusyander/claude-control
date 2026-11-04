import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_EXIT_FILE } from '@agentdeck/contracts/core/supervisor';

/**
 * Итог выхода ядра (этап 10): `<core home>/core.exit.json` — `{pid, code, signal, at}`.
 * Панель поднимает ядро на Windows через скрытый PowerShell, ядро ей не ребёнок, и код выхода
 * панель не видит; карточка сбоя берёт его отсюда (надзор сверяет pid — чужой итог не годится).
 *
 * Пишется синхронно в `process.on('exit')`: там работает только синхронный код. Снятое
 * принудительно (`taskkill /F`, SIGKILL) ядро ничего не напишет — тогда кода нет, причина в журнале.
 */

export interface CoreExitRecord {
  pid: number;
  code: number | null;
  signal: string | null;
  at: string;
}

export interface ExitRecorder {
  /** Сигнал, по которому ядро останавливается само (SIGINT/SIGTERM), — войдёт в итог. */
  noteSignal(signal: string): void;
}

export interface ExitRecorderDeps {
  pid?: number;
  now?: () => Date;
  onExit?: (handler: (code: number) => void) => void;
  write?: (file: string, text: string) => void;
}

function writeRecord(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

export function recordExit(home: string, deps: ExitRecorderDeps = {}): ExitRecorder {
  const file = join(home, CORE_EXIT_FILE);
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? (() => new Date());
  const write = deps.write ?? writeRecord;
  const onExit = deps.onExit ?? ((handler) => process.on('exit', handler));
  let signal: string | null = null;
  onExit((code) => {
    const record: CoreExitRecord = { pid, code, signal, at: now().toISOString() };
    try {
      write(file, `${JSON.stringify(record)}\n`);
    } catch {
      // Дом недоступен на выходе — итога не будет; карточка покажет журнал без кода.
    }
  });
  return {
    noteSignal(name) {
      signal = name;
    },
  };
}
