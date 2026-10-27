import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Улика своего временного файла (D-10/D-11, 26.10): рецензент группы снял копию
 * `cp f /tmp/b1r10-c.bak`, правил `f`, вернул его и убирал `rm /tmp/b1r10-*.bak`
 * — удаление уходило человеку: своим в `/tmp` считался только свежий `mktemp`
 * этой же команды (F-77).
 *
 * Своё — путь, который ЗАПИСАЛ прошлый удавшийся вызов того же файла
 * транскрипта (разговор или субагент — у каждого свой файл), раньше этого
 * вызова, и с тех пор файл никто не переписывал: время правки файла — внутри
 * окна того вызова. Что вызов пишет во временное, решает тот же разбор, что
 * судит команду (`writesOf` = `tempWritesOf`), — не поиск имени в тексте.
 */

/** Допуск вокруг окна вызова: время записи транскрипта и время файла — разные часы. */
const SLACK_MS = 1000;

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: { command?: unknown };
  tool_use_id?: string;
  is_error?: boolean;
}

interface Line {
  type?: string;
  timestamp?: string;
  cwd?: string;
  message?: { content?: unknown };
}

interface PastCall {
  command: string;
  cwd?: string;
  at: number;
  done?: number;
}

const blocksOf = (line: Line): Block[] =>
  Array.isArray(line.message?.content) ? (line.message.content as Block[]) : [];

function parsed(text: string): Line | undefined {
  try {
    return JSON.parse(text) as Line;
  } catch {
    return undefined;
  }
}

/**
 * Временные пути, что прошлые вызовы этого файла записали и не тронули с тех пор.
 * Читаются только строки, где есть одно из `names` (имена удаляемого,
 * `tempDeleteNames`), этот вызов или результат найденного прошлого. Самого вызова
 * в файле нет — порядок не известен, своего нет.
 */
export function ownTempWrites(
  file: string,
  toolUseId: string,
  names: readonly string[],
  writesOf: (command: string, cwd: string | undefined) => string[],
): Set<string> {
  const own = new Set<string>();
  if (names.length === 0) return own;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return own;
  }
  const calls = new Map<string, PastCall>();
  let reached = false;
  for (const raw of text.split('\n')) {
    const relevant =
      raw.includes(toolUseId) ||
      names.some((name) => raw.includes(name)) ||
      [...calls.keys()].some((id) => raw.includes(id));
    if (!relevant) continue;
    const line = parsed(raw.trim());
    if (!line) continue;
    const at = Date.parse(line.timestamp ?? '');
    if (line.type === 'assistant') {
      for (const block of blocksOf(line)) {
        if (block.type !== 'tool_use' || !block.id) continue;
        if (block.id === toolUseId) reached = true;
        const command = block.input?.command;
        if (block.name !== 'Bash' || typeof command !== 'string' || Number.isNaN(at)) continue;
        if (names.some((name) => command.includes(name))) {
          calls.set(block.id, { command, ...(line.cwd ? { cwd: line.cwd } : {}), at });
        }
      }
      if (reached) break;
    } else if (line.type === 'user') {
      for (const block of blocksOf(line)) {
        const call = block.type === 'tool_result' ? calls.get(block.tool_use_id ?? '') : undefined;
        if (call && block.is_error !== true && !Number.isNaN(at)) call.done = at;
      }
    }
  }
  if (!reached) return own;
  return writtenBy(calls.values(), writesOf);
}

/** Пути, что записали удавшиеся прошлые вызовы, — время файла внутри окна вызова. */
function writtenBy(
  calls: Iterable<PastCall>,
  writesOf: (command: string, cwd: string | undefined) => string[],
): Set<string> {
  const own = new Set<string>();
  for (const call of calls) {
    if (call.done === undefined) continue;
    for (const path of writesOf(call.command, call.cwd)) {
      if (writtenWithin(path, call.at - SLACK_MS, call.done + SLACK_MS)) own.add(path);
    }
  }
  return own;
}

/** Предел строки команды в журнале набора (`items.mjs` `callDetail`): длиннее — обрезана. */
const KIT_CMD_MAX = 400;

/**
 * Журнал сессии набора у чужого CLI (P-26, D-10): транскрипта Claude у Codex и Qwen Code нет,
 * а хук набора пишет каждый пропущенный вызов оболочки (`call`, PreToolUse, с текстом команды) и
 * каждый исполненный (`ran`, PostToolUse) в `<состояние набора>/sessions/<session_id>.jsonl`.
 * `session_id` хука — id сессии самого CLI: у Qwen Code `config.getSessionId()` (= `sessionId`
 * qwen serve, ACP сравнивает его без регистра), у Codex — id потока app-server. Состояние набора —
 * `AGENTDECK_KIT_STATE` или `<temp>/agentdeck-kit-state` (`kit-paths.mjs`): CLI наследует окружение
 * панели. Нет набора, сессии или файла — `undefined`, и своего нет.
 */
export function kitSessionLogFile(
  session: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = String(session ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  if (key.length < 4) return undefined;
  const dir = join(env.AGENTDECK_KIT_STATE || join(tmpdir(), 'agentdeck-kit-state'), 'sessions');
  try {
    const name = readdirSync(dir).find(
      (file) => file.toLowerCase() === `${key.toLowerCase()}.jsonl`,
    );
    return name ? join(dir, name) : undefined;
  } catch {
    return undefined;
  }
}

interface KitEvent {
  ts?: number;
  kind?: string;
  tool?: string;
  key?: string;
  cmd?: string;
}

/**
 * Временные пути, что записали прошлые вызовы оболочки сессии набора и не тронули с тех пор, —
 * тот же вывод, что `ownTempWrites` из транскрипта Claude: окно вызова — от `call` до его `ran`
 * (тот же ключ вызова, ближайший следующий). Вызов без `ran` (отказан, не исполнен, ещё идёт —
 * как удаление, что судится сейчас) улики не даёт. Обрезанная журналом команда не судится.
 */
export function kitOwnTempWrites(
  file: string | undefined,
  names: readonly string[],
  writesOf: (command: string, cwd: string | undefined) => string[],
): Set<string> {
  if (!file || names.length === 0) return new Set();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  const open = new Map<string, PastCall[]>();
  const calls: PastCall[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.includes('"call"') && !raw.includes('"ran"')) continue;
    let event: KitEvent;
    try {
      event = JSON.parse(raw) as KitEvent;
    } catch {
      continue;
    }
    if (typeof event.ts !== 'number' || !event.key) continue;
    if (event.kind === 'call') {
      const command = event.cmd;
      if (event.tool !== 'Bash' || typeof command !== 'string') continue;
      if (command.length >= KIT_CMD_MAX || !names.some((name) => command.includes(name))) continue;
      const call: PastCall = { command, at: event.ts };
      calls.push(call);
      open.set(event.key, [...(open.get(event.key) ?? []), call]);
    } else if (event.kind === 'ran') {
      const call = open.get(event.key)?.shift();
      if (call) call.done = event.ts;
    }
  }
  return writtenBy(calls, writesOf);
}

function writtenWithin(path: string, from: number, to: number): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.mtimeMs >= from && stat.mtimeMs <= to;
  } catch {
    return false;
  }
}
