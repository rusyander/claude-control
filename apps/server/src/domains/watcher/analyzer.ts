import type { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WATCH_SEVERITIES, WATCH_VERDICTS } from '@agentdeck/contracts/watcher';
import type { WatchSeverity } from '@agentdeck/contracts';
import { spawnCliProcess } from '../../lib/cli-spawn.ts';
import { killChildTree } from '../../lib/process-tree.ts';
import { lightWindowLayers } from '../platform/layers.ts';
import { panelAgentEnv } from '../panel-agent/runner.ts';
import type { AnalysisOutcome, WatchEvent, WatchFinding, WatchRemark } from './types.ts';
import type { ReportLanguage } from './report-texts.ts';

/**
 * Один разбор пачки сбоев процессом `claude -p` на дешёвой ступени.
 *
 * Модель только ЧИТАЕТ исходники панели: `--tools Read,Grep,Glob` оставляет из
 * встроенных инструментов ровно эти три, `--allowedTools` пускает их без
 * вопроса (спрашивать в `-p` некого), рабочий каталог — корень приложения, так
 * что поиск идёт по коду панели, а не по чужим проектам. Наши слои сняты теми
 * же флагами, что у агента панели (`lightWindowLayers`): личные хуки, права,
 * MCP и скиллы человека в разбор не едут. Сессия не сохраняется — разбор не
 * всплывает в чатах. Окружение — список агента панели (`panelAgentEnv`): ключ
 * API, переменные контура и интеграций процессу не нужны.
 *
 * Вывод `--output-format json` — один объект с ответом и расходом токенов;
 * находки модель кладёт в блок ```agentdeck-watch с массивом JSON. Там же —
 * замечания (дефект рядом, замеченный при сверке) и «это та же причина, что
 * WR-n»: модели показывают, какие разделы уже есть в отчёте, чтобы она не
 * плодила дубли, а ссылалась.
 */

/** Раздел, уже лежащий в отчёте, — модель ссылается на него, а не пишет новый. */
export interface KnownSection {
  ref: string;
  entryClass: 'failure' | 'remark';
  title: string;
  location?: string;
}

/** Сколько известных разделов показывать модели: дальше — дорого и бесполезно. */
export const WATCH_KNOWN_MAX = 30;

export const WATCH_TOOLS = ['Read', 'Grep', 'Glob'] as const;
/** Потолок одного разбора: дальше процесс снимается деревом. */
export const WATCH_ANALYSIS_TIMEOUT_MS = 5 * 60_000;
const BLOCK = 'agentdeck-watch';

export function watchSystemPrompt(lang: ReportLanguage = 'ru'): string {
  return [
    'You are the background watcher of the AgentDeck panel (a local web app over Claude Code configuration: Fastify server apps/server, React web apps/web, shared packages/contracts).',
    'You receive problems the panel observed about ITSELF: server 5xx and client-bug 4xx, log errors and warnings, slow requests, failed or non-zero CLI runs, page errors, console errors and warnings, failed requests, wrong-shaped API replies, stuck loading. For each one, check the panel source code in the current directory with Read/Grep/Glob only and decide:',
    '- confirmed: a real defect in the panel code; name the file:line where it originates;',
    '- not-in-code: the code is fine, the cause is the environment (missing CLI, network, permissions, user data) or it cannot be reproduced from the code;',
    '- unclear: you could not decide.',
    'Never edit anything. Never guess a location you did not read. Be brief: a few targeted searches per problem.',
    `Reply with ONE fenced block \`\`\`${BLOCK} holding a JSON array. One object per problem id you were given:`,
    '{"id": "<id>", "title": "...", "happened": "...", "rootCause": "...", "steps": "...", "verdict": "confirmed|not-in-code|unclear", "severity": "critical|high|medium|low", "location": "path/to/file.ts:123", "fix": "...", "sameAs": ""}',
    'sameAs: the ref (WR-n) of a section already in the report, or another id of this batch, when you can PROVE from the code that both share one root cause; otherwise "".',
    'While reading code you may notice a nearby logic defect nobody hit yet (inconsistent state handling, missing error branch, wrong condition). Add it as a separate object:',
    '{"kind": "remark", "title": "...", "explanation": "...", "severity": "critical|high|medium|low", "location": "path/to/file.ts:123", "fix": "...", "relatedTo": "<id or WR-n>", "sameAs": "<WR-n of an existing remark or empty>"}',
    'Only remarks you verified in the code, at most 3 per reply; do not repeat a remark already listed as known — use its ref in sameAs.',
    `title/happened/rootCause/steps/explanation/fix are for another developer or agent reading the report cold and MUST be written in ${lang === 'en' ? 'English' : 'Russian'}; location is a repo-relative path with a line, or "" when none. steps = what the user was doing (route, request) and how to reproduce.`,
  ].join('\n');
}

/** Пачка сбоев одним текстом в stdin. Секреты замаскированы ещё при записи сбоя. */
export function watchPrompt(
  events: readonly WatchEvent[],
  known: readonly KnownSection[] = [],
): string {
  const blocks = events.map((event) =>
    [
      `id: ${event.id}`,
      `source: ${event.source}; kind: ${event.kind}; seen ${event.count}x (first ${event.firstSeen}, last ${event.lastSeen})`,
      ...(event.method || event.path
        ? [
            `request: ${[event.method, event.path].filter(Boolean).join(' ')}${event.status !== undefined ? ` -> ${event.status}` : ''}`,
          ]
        : []),
      ...(event.route ? [`panel route: ${event.route}`] : []),
      ...(event.durationMs !== undefined ? [`duration: ${event.durationMs} ms`] : []),
      `message: ${event.message}`,
      ...(event.stack ? [`stack:\n${event.stack}`] : []),
      ...(event.output ? [`cli stderr (tail):\n${event.output}`] : []),
    ].join('\n'),
  );
  const knownBlock =
    known.length === 0
      ? ''
      : `\n\nAlready in the report (refer by ref in sameAs, do not duplicate):\n${known
          .slice(0, WATCH_KNOWN_MAX)
          .map(
            (section) =>
              `- ${section.ref} [${section.entryClass}] ${section.title}${section.location ? ` @ ${section.location}` : ''}`,
          )
          .join('\n')}`;
  return `Problems to check (${events.length}):\n\n${blocks.join('\n\n---\n\n')}${knownBlock}\n`;
}

export function watchArgs(model: string | undefined, systemPromptFile: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
    ...lightWindowLayers().args,
    '--tools',
    WATCH_TOOLS.join(','),
    '--allowedTools',
    ...WATCH_TOOLS,
    // Флаг-значение последним: вариадические `--tools`/`--allowedTools` съели
    // бы следующий голый аргумент.
    '--append-system-prompt-file',
    systemPromptFile,
  ];
}

function asText(value: unknown, max = 4000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asSeverity(value: unknown): WatchSeverity | undefined {
  const text = asText(value, 16) as WatchSeverity;
  return WATCH_SEVERITIES.includes(text) ? text : undefined;
}

export interface ParsedReply {
  findings: Map<string, WatchFinding>;
  remarks: WatchRemark[];
  /** Сбой → раздел той же причины (id пачки или `WR-n` отчёта). */
  merges: Map<string, string>;
}

/** Замечаний за один ответ — не больше: дешёвая модель любит «на всякий случай». */
export const WATCH_REMARKS_PER_REPLY = 3;

/**
 * JSON блока ответа. Конец блока — первая тройная кавычка, ДО которой текст
 * разбирается: ограда кода внутри строки `fix` (```ts … ```) раньше обрывала
 * JSON, и вся пачка получала запасной вердикт без повторного разбора.
 */
function blockJson(reply: string): unknown {
  const start = new RegExp('```' + BLOCK + '[^\\S\\n]*\\n').exec(reply);
  if (!start) return undefined;
  const body = start.index + start[0].length;
  for (let end = reply.indexOf('```', body); end >= 0; end = reply.indexOf('```', end + 3)) {
    try {
      return JSON.parse(reply.slice(body, end));
    } catch {
      // Ограда внутри строки — ищем следующую.
    }
  }
  return undefined;
}

/**
 * Ответ модели. Чужие id, битые объекты и неизвестный вердикт молча
 * отбрасываются; `sameAs` принимается, только если указывает на id этой
 * пачки или на известный номер — выдуманная ссылка не сольёт ничего.
 */
export function parseReply(
  reply: string,
  ids: ReadonlySet<string>,
  knownRefs: ReadonlySet<string> = new Set(),
): ParsedReply {
  const out: ParsedReply = {
    findings: new Map(),
    remarks: [],
    merges: new Map(),
  };
  const parsed = blockJson(reply);
  if (parsed === undefined) return out;
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'remark') {
      const title = asText(item.title, 200);
      const explanation = asText(item.explanation);
      if (!title || !explanation || out.remarks.length >= WATCH_REMARKS_PER_REPLY) continue;
      const location = asText(item.location, 300);
      const fix = asText(item.fix);
      const relatedTo = asText(item.relatedTo, 64);
      const sameAs = asText(item.sameAs, 64);
      out.remarks.push({
        title,
        explanation,
        severity: asSeverity(item.severity) ?? 'low',
        ...(location ? { location } : {}),
        ...(fix ? { fix } : {}),
        ...(relatedTo ? { relatedTo } : {}),
        ...(sameAs && knownRefs.has(sameAs) ? { sameAs } : {}),
      });
      continue;
    }
    const id = asText(item.id, 64);
    const verdict = asText(item.verdict, 32) as WatchFinding['verdict'];
    if (!ids.has(id) || !WATCH_VERDICTS.includes(verdict) || (verdict as string) === 'pending') {
      continue;
    }
    const location = asText(item.location, 300);
    const fix = asText(item.fix);
    const rootCause = asText(item.rootCause);
    const steps = asText(item.steps) || asText(item.context);
    const severity = asSeverity(item.severity);
    out.findings.set(id, {
      title: asText(item.title, 200) || id,
      happened: asText(item.happened),
      context: asText(item.context),
      verdict,
      ...(location ? { location } : {}),
      ...(fix ? { fix } : {}),
      ...(rootCause ? { rootCause } : {}),
      ...(steps ? { steps } : {}),
      ...(severity ? { severity } : {}),
    });
    const sameAs = asText(item.sameAs, 64);
    if (sameAs && sameAs !== id && (ids.has(sameAs) || knownRefs.has(sameAs))) {
      out.merges.set(id, sameAs);
    }
  }
  return out;
}

/** Только находки — прежний вход, им пользуются проверки разбора. */
export function parseFindings(reply: string, ids: ReadonlySet<string>): Map<string, WatchFinding> {
  return parseReply(reply, ids).findings;
}

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ResultJson {
  type?: string;
  is_error?: boolean;
  result?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, ModelUsageEntry>;
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** Расход из объекта результата: по моделям, если CLI их назвал, иначе общий. */
export function usageOf(result: ResultJson): AnalysisOutcome['usage'] {
  const models = Object.entries(result.modelUsage ?? {});
  if (models.length > 0) {
    const sum = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const [, entry] of models) {
      sum.input += num(entry.inputTokens);
      sum.output += num(entry.outputTokens);
      sum.cacheRead += num(entry.cacheReadInputTokens);
      sum.cacheCreation += num(entry.cacheCreationInputTokens);
    }
    return { ...sum, model: models[0]![0] };
  }
  return {
    input: num(result.usage?.input_tokens),
    output: num(result.usage?.output_tokens),
    cacheRead: num(result.usage?.cache_read_input_tokens),
    cacheCreation: num(result.usage?.cache_creation_input_tokens),
  };
}

/**
 * Последний JSON-объект с `type: result` в выводе (CLI может напечатать и
 * предупреждения — в том числе строкой JSON ПОСЛЕ результата). Объекта с `type`
 * нет вовсе — последний разобранный: так отвечал CLI до поля `type`.
 */
export function resultOf(stdout: string): ResultJson | undefined {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  let fallback: ResultJson | undefined;
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as ResultJson;
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.type === 'result') return parsed;
      if (parsed.type === undefined) fallback ??= parsed;
    } catch {
      // Не JSON — пропускаем строку.
    }
  }
  if (fallback) return fallback;
  try {
    return JSON.parse(stdout) as ResultJson;
  } catch {
    return undefined;
  }
}

export interface AnalysisOptions {
  command: string;
  cwd: string;
  model?: string;
  events: readonly WatchEvent[];
  /** Разделы, уже лежащие в отчёте, — для ссылок вместо дублей. */
  known?: readonly KnownSection[];
  spawnImpl?: typeof nodeSpawn;
  timeoutMs?: number;
  onSpawn?: (pid: number) => void;
  onExit?: () => void;
  /** Язык интерфейса панели: на нём модель пишет тексты разделов отчёта. */
  language?: ReportLanguage;
}

export interface AnalysisHandle {
  done: Promise<AnalysisOutcome>;
  /** Выключили тумблер: процесс снимается деревом сразу. */
  stop: () => void;
}

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/**
 * Своя причина неудачного разбора — на языке панели, как тексты отчёта: она
 * уходит в `detail` состояния наблюдателя, а тот показывается как есть, без
 * перевода (он же несёт сырой вывод CLI). Русская строка в английском окне —
 * тот самый дефект, что в отчёте уже исправлен.
 */
function failureText(
  language: ReportLanguage | undefined,
  kind: 'timeout' | 'no-reply',
  code?: number | null,
): string {
  const en = language === 'en';
  if (kind === 'timeout') {
    return en
      ? 'The analysis did not finish in the allotted time.'
      : 'Разбор не уложился в отведённое время.';
  }
  return en
    ? `The CLI exited with code ${code ?? '?'} without a reply.`
    : `CLI завершился с кодом ${code ?? '?'} без ответа.`;
}

export function startAnalysis(options: AnalysisOptions): AnalysisHandle {
  const dir = mkdtempSync(join(tmpdir(), 'cc-watcher-'));
  const systemPrompt = join(dir, 'system-prompt.txt');
  writeFileSync(systemPrompt, watchSystemPrompt(options.language), 'utf8');
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Во временной папке только промпт — не повод ронять разбор.
    }
  };

  const spawned = spawnCliProcess(options.command, watchArgs(options.model, systemPrompt), {
    spawnImpl: options.spawnImpl,
    cwd: options.cwd,
    inheritEnv: false,
    env: panelAgentEnv(process.env, {}),
  });
  if (spawned.error) {
    cleanup();
    return {
      done: Promise.resolve({
        ok: false,
        findings: new Map(),
        remarks: [],
        merges: new Map(),
        usage: EMPTY_USAGE,
        error: spawned.error.message,
      }),
      stop: () => {},
    };
  }

  const child = spawned.child;
  if (child.pid !== undefined) options.onSpawn?.(child.pid);
  const ids = new Set(options.events.map((event) => event.id));
  let stopped = false;

  const done = new Promise<AnalysisOutcome>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (outcome: AnalysisOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      killChildTree(child);
      finish({
        ok: false,
        findings: new Map(),
        remarks: [],
        merges: new Map(),
        usage: EMPTY_USAGE,
        error: failureText(options.language, 'timeout'),
      });
    }, options.timeoutMs ?? WATCH_ANALYSIS_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      options.onExit?.();
      finish({
        ok: false,
        findings: new Map(),
        remarks: [],
        merges: new Map(),
        usage: EMPTY_USAGE,
        error: error.message,
      });
    });
    child.on('close', (code) => {
      options.onExit?.();
      if (stopped) {
        return finish({
          ok: false,
          stopped: true,
          findings: new Map(),
          remarks: [],
          merges: new Map(),
          usage: EMPTY_USAGE,
        });
      }
      // Буферы склеиваются до декодирования: граница чтения рвёт UTF-8.
      const stdout = Buffer.concat(out).toString('utf8');
      const result = resultOf(stdout);
      const usage = result ? usageOf(result) : EMPTY_USAGE;
      const reply = typeof result?.result === 'string' ? result.result : '';
      if (!result || result.is_error || code !== 0) {
        const stderr = Buffer.concat(err).toString('utf8').trim().slice(0, 500);
        return finish({
          ok: false,
          findings: new Map(),
          remarks: [],
          merges: new Map(),
          usage,
          error:
            (result?.is_error ? reply.slice(0, 500) : '') ||
            stderr ||
            failureText(options.language, 'no-reply', code),
        });
      }
      const knownRefs = new Set((options.known ?? []).map((section) => section.ref));
      const parsed = parseReply(reply, ids, knownRefs);
      finish({ ok: true, ...parsed, usage });
    });
    // CLI закрылся раньше, чем дописали промпт, — необработанный EPIPE ронял бы сервер.
    child.stdin.on('error', () => {});
    child.stdin.end(watchPrompt(options.events, options.known));
  });

  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      killChildTree(child);
    },
  };
}
