import type { ContentBlock, Record } from './ChatRecords/ChatRecords.ts';
import { readAllRecords } from './ChatTranscriptFile/ChatTranscriptFile.ts';

/**
 * Номера процессов, которые разговор группы сам напечатал о СВОЁМ запуске (D-8,
 * 25.10). Группа подняла dev-серверы `npm … run dev -- --port 5180`, увидела их
 * номера в своём `netstat` и погасила по номеру; при старте панели процессов уже
 * нет, дерева и метки не прочесть — погашение судилось чужим.
 *
 * Своим считается номер:
 * - строки `netstat -ano` (`LISTENING <pid>`) или `ss -ltnp` (`pid=<pid>`) для
 *   порта, на котором разговор раньше этой печати сам запускал (`--port N`,
 *   `PORT=N`): порт владельца в той же таблице своим не становится;
 * - эха `$!` после фонового запуска (`… & echo "pid $!"`): единственное число строки.
 *
 * Строки `tasklist` и прочие таблицы процессов в счёт не идут: в них все процессы
 * машины, и кто завёл процесс, из строки не узнать.
 *
 * `notBeforeMs`..`notAfterMs` — от записи вызова-запуска до записи печати: живой
 * процесс с этим номером, заведённый вне окна, — номер занят заново (`provenOwn`).
 */
export interface PrintedPid {
  notBeforeMs: number;
  notAfterMs: number;
}

/** Порт запуска в тексте команды: `--port 5180`, `--port=5180`, `PORT=5180`. */
const LAUNCH_PORT = /(?:--port[= ]|\bPORT=)(\d{2,5})\b/g;
/** `netstat -ano`: `TCP  [::1]:5180  [::]:0  LISTENING  6968`. */
const NETSTAT_LINE = /^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/gim;
/** `ss -ltnp`: `LISTEN 0 511 *:5300 *:* users:(("node",pid=5151,fd=23))`. */
const SS_LINE = /^LISTEN\s+\d+\s+\d+\s+\S*:(\d+)\s+\S+\s+users:\(\(.*?pid=(\d+)/gm;
/** Эхо номера фонового звена: `echo $!`, `echo "pid $!"`, `printf '%s' $!`. */
const ECHO_BANG = /\b(echo|printf)\b[^;&|\n]*\$!/;
/** Строка вывода с одним числом. */
const ONE_NUMBER = /^\D*?(\d+)\D*$/;

function textOf(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n');
}

function commandOf(block: ContentBlock): string | undefined {
  const command = (block.input as { command?: unknown } | null | undefined)?.command;
  return typeof command === 'string' ? command : undefined;
}

/** Номера, напечатанные о своём запуске, по уже прочитанным записям разговора. */
function printedPids(records: readonly Record[]): Map<number, PrintedPid> {
  const calls = new Map<string, { command: string; atMs: number }>();
  /** Порт → самый ранний запуск на нём. */
  const launched = new Map<number, number>();
  const printed = new Map<number, PrintedPid>();
  const add = (pid: number, notBeforeMs: number, notAfterMs: number): void => {
    const known = printed.get(pid);
    printed.set(
      pid,
      known
        ? {
            notBeforeMs: Math.min(known.notBeforeMs, notBeforeMs),
            notAfterMs: Math.max(known.notAfterMs, notAfterMs),
          }
        : { notBeforeMs, notAfterMs },
    );
  };
  for (const record of records) {
    const atMs = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
    const content = record.message?.content;
    if (!Number.isFinite(atMs) || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) {
        const command = commandOf(block);
        if (command === undefined) continue;
        calls.set(block.id, { command, atMs });
        for (const match of command.matchAll(LAUNCH_PORT)) {
          const port = Number(match[1]);
          if (!launched.has(port)) launched.set(port, atMs);
        }
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        const text = textOf(block.content);
        for (const match of [...text.matchAll(NETSTAT_LINE), ...text.matchAll(SS_LINE)]) {
          const since = launched.get(Number(match[1]));
          if (since !== undefined && since <= call.atMs) add(Number(match[2]), since, atMs);
        }
        if (ECHO_BANG.test(call.command)) {
          for (const line of text.split('\n')) {
            const number = ONE_NUMBER.exec(line)?.[1];
            if (number !== undefined) add(Number(number), call.atMs, atMs);
          }
        }
      }
    }
  }
  return printed;
}

/** То же по файлу разговора; не прочесть — пусто: доказательства нет. */
export function printedPidsIn(file: string): Map<number, PrintedPid> {
  try {
    return printedPids(readAllRecords(file));
  } catch {
    return new Map();
  }
}
