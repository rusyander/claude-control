import { CLI_TIMEOUT_ERROR, runProviderCli } from '../assistant-runner/cli.ts';
import { MAX_PROMPT_CHARS } from '../provider-chat/prompt/prompt.ts';
import {
  EMPTY_USAGE,
  WATCH_ANALYSIS_TIMEOUT_MS,
  failureText,
  parseReply,
  watchPrompt,
  watchSystemPrompt,
  type AnalysisHandle,
  type AnalysisOptions,
  type KnownSection,
} from './analyzer.ts';
import type { ReportLanguage } from './report-texts.ts';
import type { WatcherForeignRun } from './route.ts';
import type { AnalysisOutcome, WatchEvent } from './types.ts';

/**
 * Разбор пачки сбоев самим чужим CLI (X9, 10.10) — когда активен не Claude и
 * маршрут ассистента вёл бы в облако Claude, куда человек не звал.
 *
 * Отличия от `startAnalysis` (`claude -p`) — от того, что умеет одиночный запуск
 * чужого CLI: системного промпта отдельным файлом у них нет, поэтому правила
 * разбора идут в начале того же задания; задание уходит элементом argv, а
 * командная строка Windows рвётся около 32 тысяч символов, поэтому пачка
 * ужимается до `MAX_PROMPT_CHARS` — не вошедшее ждёт следующего разбора. Режим —
 * без правок (`allowEdits: false`), рабочий каталог — корень приложения, как у
 * Claude. Расхода токенов одиночный запуск не печатает — разбор считается, токены
 * нет.
 */

export function foreignWatchPrompt(
  events: readonly WatchEvent[],
  known: readonly KnownSection[],
  language: ReportLanguage | undefined,
): string {
  return `${watchSystemPrompt(language)}\n\n${watchPrompt(events, known)}`;
}

/**
 * Сколько первых сбоев пачки влезает в одно задание. Хотя бы один — всегда:
 * слишком длинный одиночный сбой режется вместе с заданием (`foreignTask`), а не
 * висит в кольце вечно.
 */
export function fitForeignBatch(
  events: readonly WatchEvent[],
  known: (batch: readonly WatchEvent[]) => readonly KnownSection[],
  language: ReportLanguage | undefined,
  maxChars: number = MAX_PROMPT_CHARS,
): WatchEvent[] {
  for (let size = events.length; size > 1; size -= 1) {
    const batch = events.slice(0, size);
    if (foreignWatchPrompt(batch, known(batch), language).length <= maxChars) return batch;
  }
  return events.slice(0, 1);
}

function foreignTask(
  events: readonly WatchEvent[],
  known: readonly KnownSection[],
  language: ReportLanguage | undefined,
): string {
  return foreignWatchPrompt(events, known, language).slice(0, MAX_PROMPT_CHARS);
}

function failed(error?: string): AnalysisOutcome {
  return {
    ok: false,
    findings: new Map(),
    remarks: [],
    merges: new Map(),
    usage: EMPTY_USAGE,
    ...(error ? { error } : {}),
  };
}

export function startForeignAnalysis(
  options: Omit<AnalysisOptions, 'command'> & { foreign: WatcherForeignRun },
): AnalysisHandle {
  const controller = new AbortController();
  let stopped = false;
  const ids = new Set(options.events.map((event) => event.id));
  const known = options.known ?? [];

  const done = runProviderCli(
    options.foreign.provider,
    foreignTask(options.events, known, options.language),
    {
      // Каталог данных одиночному запуску CLI не нужен: ключи и модели — у маршрута.
      appDataDir: '',
      env: options.env ?? {},
      timeoutMs: options.timeoutMs ?? WATCH_ANALYSIS_TIMEOUT_MS,
      signal: controller.signal,
      ...(options.foreign.model ? { model: options.foreign.model } : {}),
      ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
      ...(options.onSpawn ? { onSpawn: options.onSpawn } : {}),
    },
    options.foreign.command,
    options.cwd,
    false,
  ).then((result): AnalysisOutcome => {
    options.onExit?.();
    if (stopped) return { ...failed(), stopped: true };
    if (!result.ok) {
      return failed(
        result.error === CLI_TIMEOUT_ERROR
          ? failureText(options.language, 'timeout')
          : (result.error ?? failureText(options.language, 'no-reply')),
      );
    }
    const knownRefs = new Set(known.map((section) => section.ref));
    return { ok: true, ...parseReply(result.reply, ids, knownRefs), usage: EMPTY_USAGE };
  });

  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
    },
  };
}
