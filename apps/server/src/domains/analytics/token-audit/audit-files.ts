import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { readChat } from '../../provider-chat/store/store.ts';
import { collectForeignFiles, entriesOf, foreignHomes } from '../scanner/foreign.ts';
import type { ForeignSource } from '../scanner/types.ts';
import { auditClaudeRows, parseTranscript } from './claude-audit.ts';
import { auditForeignLines } from './foreign-audit.ts';
import type { SessionAudit } from './token-audit.types.ts';

/**
 * Файлы сессий для измерителя: транскрипт Claude по id, его вложенные агенты,
 * дети разделения по `state.json` панели и журналы Codex/Qwen по пути.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Транскрипт сессии: `<config>/projects/<проект>/<id>.jsonl`. */
export function findClaudeTranscript(configDir: string, id: string): string | undefined {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return undefined;
  for (const dir of readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = join(projects, dir.name, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** Сессия Claude вместе с вложенными агентами из `<id>/subagents/*.jsonl`. */
export function auditClaudeFile(file: string, id = basename(file, '.jsonl')): SessionAudit {
  const audit = auditClaudeRows(id, parseTranscript(readFileSync(file, 'utf8')));
  const sub = join(file.slice(0, -'.jsonl'.length), 'subagents');
  if (existsSync(sub)) {
    for (const name of readdirSync(sub)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()) {
      try {
        audit.subagents.push(auditClaudeFile(join(sub, name)));
      } catch {
        // Агент, убитый до первого ответа, расхода не несёт — пропускаем, а не роняем отчёт.
      }
    }
  }
  return audit;
}

/** Журнал Codex (`rollout-*.jsonl`) или Qwen Code (`chats/*.jsonl`). */
export async function auditForeignFile(
  file: string,
  kind: 'codex' | 'qwen',
): Promise<SessionAudit> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  return auditForeignLines(basename(file, '.jsonl'), kind, lines);
}

interface ChatLink {
  parentChatId?: string;
}

/**
 * Сессии разделения: родитель и все потомки по `chatLinks` панели, с
 * внуками (ревью и правки группы заводятся детьми группы). Ключи `new-…` —
 * черновики до первого ответа CLI, у них нет транскрипта; настоящий id у
 * той же записи лежит под своим ключом, поэтому берутся только UUID.
 */
export function splitSessionIds(state: unknown, parentId: string): string[] {
  return splitChats(state, parentId).claude;
}

/** Разговор чужого CLI в разделении: ключ `<cli>:<id>` панели. */
export interface ForeignChatRef {
  providerId: string;
  chatId: string;
}

/**
 * Разделение целиком, Claude и чужие CLI порознь (6.4): группа в Codex или Qwen
 * связана с родителем ключом `codex:<id>`, транскрипта Claude у неё нет — её
 * расход лежит в журналах самого CLI. Родитель тоже может быть чужим.
 */
export function splitChats(
  state: unknown,
  parentKey: string,
): { claude: string[]; foreign: ForeignChatRef[] } {
  const panel = (state ?? {}) as {
    chatLinks?: Record<string, ChatLink>;
    chatKeyAliases?: Record<string, string>;
  };
  const links = panel.chatLinks ?? {};
  const aliases = panel.chatKeyAliases ?? {};
  // Внук мог запомнить родителя по ключу черновика — он переводится в id сессии.
  const parentOf = (link: ChatLink): string | undefined =>
    link?.parentChatId ? (aliases[link.parentChatId] ?? link.parentChatId) : undefined;
  const found = [parentKey];
  const known = new Set(found);
  for (let i = 0; i < found.length; i += 1) {
    for (const [key, link] of Object.entries(links)) {
      const real = UUID.test(key) || parseForeignChatKey(key) !== undefined;
      if (parentOf(link) === found[i] && real && !known.has(key)) {
        known.add(key);
        found.push(key);
      }
    }
  }
  const foreign = found.flatMap((key) => {
    const ref = UUID.test(key) ? undefined : parseForeignChatKey(key);
    return ref ? [ref] : [];
  });
  return { claude: found.filter((key) => UUID.test(key)), foreign };
}

/** Запас на часы: журнал пишет CLI, реплику — панель, это разные процессы. */
const SLACK_MS = 5_000;

/** Ходы разговора: от реплики человека до ответа CLI; неотвеченный — до сих пор. */
function turnWindows(messages: readonly { role: string; at: string }[]): Array<[number, number]> {
  const windows: Array<[number, number]> = [];
  let open: number | undefined;
  for (const message of messages) {
    const at = Date.parse(message.at);
    if (Number.isNaN(at)) continue;
    if (message.role === 'user') open ??= at;
    else if (message.role === 'assistant' && open !== undefined) {
      windows.push([open - SLACK_MS, at + SLACK_MS]);
      open = undefined;
    }
  }
  if (open !== undefined) windows.push([open - SLACK_MS, Infinity]);
  return windows;
}

function samePath(a: string, b: string): boolean {
  // `resolve` сам снимает хвостовой разделитель; регистр путей Windows не различает.
  return process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
}

/** Каталог и время первого ответа модели — по ним журнал узнаёт свой разговор. */
async function firstStamp(
  file: string,
  kind: ForeignSource['kind'],
): Promise<{ cwd: string; at: number } | undefined> {
  const input = createReadStream(file, 'utf8');
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const entry of entriesOf({ kind, homes: [] })(lines)) {
      if (entry.cwd && entry.timestamp) return { cwd: entry.cwd, at: Date.parse(entry.timestamp) };
    }
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }
}

export interface ForeignChatLogs {
  key: string;
  kind?: ForeignSource['kind'];
  /** Название разговора — у группы её заголовок. */
  title?: string;
  files: string[];
  /** Почему журналов нет — строкой в отчёт. */
  missing?: string;
  /**
   * Журналы, на которые этот разговор претендовал вместе с другим, а текст спора
   * не решил: в счёт не идут ни у кого, но называются (ревью A2-F11) — иначе
   * группа без своих журналов читалась бы «журналов нет», хотя они были.
   */
  contested?: string[];
}

/** Строка реплики короче — общая у многих разговоров («дальше»), по ней не узнать. */
const MIN_LINE = 12;

/**
 * Строки каждой реплики человека в том виде, в каком они стоят внутри JSON
 * журнала. Реплика без заметной строки не узнаёт ничего — её нет.
 */
function userTurns(messages: readonly { role: string; content: string }[]): string[][] {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      message.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length >= MIN_LINE)
        .map((line) => JSON.stringify(line).slice(1, -1)),
    )
    .filter((lines) => lines.length > 0);
}

interface Candidate {
  result: ForeignChatLogs;
  kind: ForeignSource['kind'];
  workdir: string;
  windows: Array<[number, number]>;
  turns: string[][];
}

/**
 * Журналы разговоров чужих CLI. Какие сессии CLI открывал разговор, панель не
 * хранит (отметка `<id>.live.json` — только последняя, и её стирают), поэтому
 * журнал узнаётся по каталогу разговора и ходам: его первый ответ модели
 * пришёлся на ход этого разговора. Группы в общем каталоге, разбор и родитель
 * идут почти одновременно — спор о журнале решает его текст (`byContent`).
 */
export async function foreignChatLogs(options: {
  appData: string;
  refs: readonly ForeignChatRef[];
  homes?: Partial<Record<ForeignSource['kind'], string[]>>;
}): Promise<ForeignChatLogs[]> {
  const { appData } = options;
  const results: ForeignChatLogs[] = [];
  const candidates: Candidate[] = [];
  for (const ref of options.refs) {
    const key = `${ref.providerId}:${ref.chatId}`;
    if (ref.providerId !== 'codex' && ref.providerId !== 'qwen') {
      results.push({ key, files: [], missing: `журналы ${ref.providerId} измеритель не читает` });
      continue;
    }
    const kind: ForeignSource['kind'] = ref.providerId === 'codex' ? 'codex' : 'qwen';
    const chat = readChat(appData, kind, ref.chatId);
    if (!chat) {
      const missing = `разговора нет в ${join(appData, 'provider-chats')}`;
      results.push({ key, kind, files: [], missing });
      continue;
    }
    const result: ForeignChatLogs = { key, kind, title: chat.title, files: [] };
    results.push(result);
    const windows = turnWindows(chat.messages);
    if (!chat.workdir) result.missing = 'у разговора нет каталога';
    else if (windows.length === 0) result.missing = 'ни одного хода';
    else {
      const turns = userTurns(chat.messages);
      candidates.push({ result, kind, workdir: chat.workdir, windows, turns });
    }
  }
  for (const kind of ['codex', 'qwen'] as const) {
    const own = candidates.filter((candidate) => candidate.kind === kind);
    if (own.length === 0) continue;
    const since = Math.min(...own.flatMap((candidate) => candidate.windows.map(([from]) => from)));
    const homes = options.homes?.[kind] ?? foreignHomes(kind, appData);
    const files = collectForeignFiles({ kind, homes }, since).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { path } of files) {
      const stamp = await firstStamp(path, kind);
      if (!stamp) continue;
      const fits = own.filter(
        (candidate) =>
          samePath(stamp.cwd, candidate.workdir) &&
          candidate.windows.some(([from, to]) => stamp.at >= from && stamp.at <= to),
      );
      const owner = fits.length > 1 ? byContent(readFileSync(path, 'utf8'), fits) : fits[0];
      if (owner) owner.result.files.push(path);
      else for (const fit of fits) (fit.result.contested ??= []).push(path);
    }
  }
  for (const { result, kind, workdir } of candidates) {
    if (result.files.length === 0 && !result.contested) {
      result.missing = `журналов ${kind} из ${workdir} за время ходов нет`;
    }
  }
  return results;
}

/**
 * Свой журнал несёт реплику, которую CLI получил, целиком. Претендует тот, чья
 * реплика стоит в журнале вся; из них — с самой длинной такой репликой (задание
 * группы цитирует слова человека из родителя, и родитель стоит в журнале группы
 * тоже целиком, но короче). Никто или поровну — журнал ничей.
 */
function byContent(text: string, fits: Candidate[]): Candidate | undefined {
  const scored = fits
    .map((candidate) => ({
      candidate,
      score: Math.max(
        0,
        ...candidate.turns
          .filter((lines) => lines.every((line) => text.includes(line)))
          .map((lines) => lines.reduce((sum, line) => sum + line.length, 0)),
      ),
    }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  return best && best.score > 0 && best.score !== second?.score ? best.candidate : undefined;
}
