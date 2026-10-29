import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { usageOf } from '../../../analytics/scanner/foreign.ts';
import { continueHome } from '../../../../providers/catalog/config-dirs.ts';
import { MAX_TIMEOUT_MS, toolOutcome } from '../watch/tool-outcome.ts';
import type { WatchEvent } from '../watch/watch.types.ts';
import type { ForeignDocumentReader, ForeignDocumentSource } from './foreign.types.ts';
import { opencodeDocumentSource, sqliteDriver } from './opencode-db.ts';
import { opencodeWatchEvents } from './opencode-session.ts';

/**
 * Переписка чужого CLI одним документом, который CLI переписывает целиком (не
 * дописывает строками, как Codex и Qwen Code). Таких CLI два: OpenCode — сессия в
 * базе SQLite (`opencode-db.ts`, читатель `opencode-session.ts`) и Continue
 * (`cn`): `<CONTINUE_GLOBAL_DIR | ~/.continue>/sessions/<id>.json`. Форма сверена с
 * файлом НАСТОЯЩЕГО `cn` 1.5.47 на подменной модели (`__fixtures__/continue-1.5-list.json`),
 * тексты отказа, ошибки и срока — с его исходником (`dist/index.js`):
 *
 * - `history[].message` — `{role, content, toolCalls?, usage?}`; `usage` OpenAI-формы,
 *   `prompt_tokens` включает кэш (`prompt_tokens_details.cached_tokens`);
 * - `history[].toolCallStates[]` — `{toolCallId, toolCall, status, parsedArgs, output[]}`;
 *   `status`: `generating` → `generated` → `calling` → `done` | `errored` | `canceled`.
 *   Ответа инструмента отдельной записью нет — он в `output` состояния;
 * - времени в документе нет: событие получает время чтения.
 *
 * Отдельно от `foreign-transcript.ts` нарочно: холодный план, кэш и расход группы
 * читают переписку строками — документ им не подходит.
 */

export type ForeignDocumentKind = 'continue' | 'opencode';

export type { ForeignDocumentReader } from './foreign.types.ts';

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Чей документ читать по id провайдера. OpenCode — запись базы SQLite: без драйвера
 * (`node:sqlite`) документа нет, и охват честно говорит «только текст хода».
 */
export function foreignDocumentKind(providerId: string): ForeignDocumentKind | undefined {
  if (providerId === 'continue') return 'continue';
  return providerId === 'opencode' && sqliteDriver() ? 'opencode' : undefined;
}

/** Читатель по роду документа. */
export function foreignDocumentReader(kind: ForeignDocumentKind): ForeignDocumentReader {
  return kind === 'continue' ? continueWatchEvents() : opencodeWatchEvents();
}

/** Документ — файл JSON: отпечаток и рождение — по файлу. */
export const fileDocumentSource: ForeignDocumentSource = {
  stamp: (path) => {
    try {
      const { mtimeMs, size } = statSync(path);
      return { mtimeMs, size };
    } catch {
      return undefined;
    }
  },
  bornAt: (path) => {
    try {
      const { birthtimeMs } = statSync(path);
      return birthtimeMs > 0 ? birthtimeMs : undefined;
    } catch {
      return undefined;
    }
  },
  load: (path) => readDocument(path),
};

/** Откуда документ рода `kind`. */
export function foreignDocumentSource(kind: ForeignDocumentKind): ForeignDocumentSource {
  return kind === 'continue' ? fileDocumentSource : opencodeDocumentSource;
}

/** Каталог сессий `cn`: `CONTINUE_GLOBAL_DIR` он чтит (`continue-args.ts`), иначе `~/.continue`. */
export function continueSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CONTINUE_GLOBAL_DIR || continueHome(), 'sessions');
}

/** Путь для сравнения: косые одинаково, без хвостовой косой, на Windows без учёта регистра. */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (path: string) => {
    const flat = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? flat.toLowerCase() : flat;
  };
  return norm(a) === norm(b);
}

/** Документ целиком; недописанный (CLI пишет его прямо сейчас) или чужой — `undefined`. */
function readDocument(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Сессия `cn` копии, тронутая не раньше `since`: каждый ответ — свой запуск `cn -p`
 * и свой файл, id сессии панели не сообщается. Копия звена своя — свежий файл с её
 * `workspaceDirectory` и есть нынешний ход. `sessions.json` — список, не сессия.
 */
export function newestContinueSession(
  dir: string,
  cwd: string,
  since: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { path: string; mtimeMs: number } | undefined;
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'sessions.json') continue;
    const path = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < since || (best && mtimeMs <= best.mtimeMs)) continue;
    const workspace = str(obj(readDocument(path))?.workspaceDirectory);
    if (workspace && samePath(workspace, cwd, platform)) best = { path, mtimeMs };
  }
  return best?.path;
}

/** Файл сессии `cn` по её id; нет — `undefined`. */
export function continueSessionFile(dir: string, sessionId: string): string | undefined {
  const path = join(dir, `${sessionId}.json`);
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Имя и аргументы инструмента `cn` → Claude: правила о проверках, чтениях и сроках их узнают. */
export function continueToolOf(
  name: string,
  args: Json,
): { name: string; input: Record<string, unknown> } {
  const file = str(args.filepath) ?? str(args.file_path);
  switch (name) {
    case 'Bash': {
      const command = str(args.command);
      // Срок у `cn` — в секундах, у Claude — в мс.
      const timeout = Math.min(num(args.timeout) * 1000, MAX_TIMEOUT_MS);
      return { name, input: { ...(command ? { command } : {}), ...(timeout ? { timeout } : {}) } };
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return { name, input: file ? { file_path: file } : {} };
    case 'Search': {
      const pattern = str(args.pattern);
      const path = str(args.path);
      return {
        name: 'Grep',
        input: { ...(pattern ? { pattern } : {}), ...(path ? { path } : {}) },
      };
    }
    default:
      return { name, input: args };
  }
}

/** Отказ `cn`: человек или правило прав «нет» (`canceled`), текст — его собственный. */
const POLICY_DENIAL = /^Command blocked by security policy/;
/** Срок оболочки: `cn` убивает команду без вывода и дописывает пометку (ответ — `done`). */
const TIMED_OUT = /\[Command timed out after (\d+(?:\.\d+)?) seconds of no output\]\s*$/;
/** Ошибка инструмента (`errored`): `cn` оборачивает её; ненулевой выход оболочки со stderr — внутри. */
const TOOL_ERROR = /^Error executing tool [^:]+: /;
const BASH_EXIT = /^Error \(exit code (-?\d+)\): /;

function resultOf(id: string, t: number, status: string, text: string): WatchEvent {
  const base = { kind: 'toolResult' as const, t, id, chars: text.length };
  if (status === 'canceled') {
    return { ...base, denied: POLICY_DENIAL.test(text) ? 'policy' : 'permission' };
  }
  const timed = TIMED_OUT.exec(text);
  if (timed?.[1]) {
    const ms = Math.min(Number(timed[1]) * 1000, MAX_TIMEOUT_MS);
    if (ms > 0) return { ...base, timedOutMs: ms };
  }
  if (status !== 'errored') return base;
  // Голова — к форме Claude («Exit code N»): род ошибки и её повтор (R24) узнаются тем же разбором.
  const inner = text.replace(TOOL_ERROR, '');
  const exit = BASH_EXIT.exec(inner);
  const content = exit ? `Exit code ${exit[1]}\n${inner.slice(exit[0].length)}` : inner;
  const outcome = toolOutcome({ is_error: true, content });
  return { ...base, ...outcome };
}

const SETTLED = new Set(['done', 'errored', 'canceled']);
/** Сколько ключей отданных записей помнить: сессия `cn` — один ход, это с большим запасом. */
const FED_CAP = 5000;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map((part) => str(obj(part)?.text) ?? '')
    .join('');
}

/**
 * Читатель документов Continue. Документ переписывается целиком — каждая
 * устоявшаяся запись получает ключ (id сессии + место или id вызова) и отдаётся
 * один раз: вызов модели — когда записан его расход, инструмент — когда его
 * аргументы готовы, ответ — когда вызов кончился. Реплику хода (`user`) читатель
 * не отдаёт: ход Continue — один запуск `cn -p`, и его начало сторож уже получил
 * от панели; второе начало посреди хода сбило бы счёт хода.
 */
export function continueWatchEvents(): ForeignDocumentReader {
  const fed = new Set<string>();
  const once = (key: string): boolean => {
    if (fed.has(key)) return false;
    fed.add(key);
    if (fed.size > FED_CAP) fed.delete(fed.values().next().value as string);
    return true;
  };
  return (doc, now) => {
    const root = obj(doc);
    const sid = str(root?.sessionId) ?? '?';
    const out: WatchEvent[] = [];
    arr(root?.history).forEach((raw, index) => {
      const item = obj(raw);
      const message = obj(item?.message);
      if (message?.role !== 'assistant') return;
      const usage = obj(message.usage);
      if (usage && once(`${sid}:a:${index}`)) {
        const counted = usageOf(
          usage.prompt_tokens,
          obj(usage.prompt_tokens_details)?.cached_tokens,
          usage.completion_tokens,
          obj(usage.prompt_tokens_details)?.cache_write_tokens,
        );
        const model = str(usage.model);
        out.push({
          kind: 'call',
          t: now,
          ...(model ? { model } : {}),
          input: counted.input_tokens ?? 0,
          cacheRead: counted.cache_read_input_tokens ?? 0,
          cacheWrite: counted.cache_creation_input_tokens ?? 0,
          cacheWrite1h: 0,
          output: counted.output_tokens ?? 0,
        });
      }
      if (usage && textOf(message.content) && once(`${sid}:s:${index}`)) {
        out.push({ kind: 'activity', t: now });
      }
      for (const rawState of arr(item?.toolCallStates)) {
        const state = obj(rawState);
        const call = obj(state?.toolCall);
        const id = str(state?.toolCallId) ?? str(call?.id);
        const status = str(state?.status);
        if (!id || !status || status === 'generating') continue;
        if (once(`${sid}:t:${id}`)) {
          const fn = obj(call?.function);
          let args = obj(state?.parsedArgs);
          if (!args) {
            try {
              args = obj(JSON.parse(str(fn?.arguments) ?? '{}'));
            } catch {
              args = undefined;
            }
          }
          const tool = continueToolOf(str(fn?.name) ?? '?', args ?? {});
          out.push({ kind: 'tool', t: now, id, ...tool });
        }
        if (SETTLED.has(status) && once(`${sid}:r:${id}`)) {
          const text = arr(state?.output)
            .map((part) => String(obj(part)?.content ?? ''))
            .join('\n');
          out.push(resultOf(id, now, status, text));
        }
      }
    });
    return out;
  };
}
