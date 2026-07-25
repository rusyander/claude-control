import {
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import type { ModelInfo } from '@claude-control/contracts';
import type { ConfigProvider } from '../providers/types.ts';
import { providerCliCommand } from '../providers/cli.ts';
import { resolveRunner, getRawKey, type RunnerMode } from './provider-keys.ts';
import { resolveAssistantModel } from './models/model-defaults.ts';
import { opencodeServe, type OpencodeServe } from './opencode-serve.ts';

/**
 * Реальный запуск ассистента активного провайдера (Ф6b) — мультимодельная ветка
 * ЧЕРЕЗ switch по провайдеру. НЕЗЫБЛЕМОЕ ПРАВИЛО: ветка Claude не переписывается —
 * `runAssistant` для claude делегирует существующему CLI-пути (print-режим), а
 * богатый стриминговый чат Claude (ChatRunner/chat-routes) этот модуль НЕ трогает.
 *
 * Прочие провайдеры:
 *  - `cli` → one-shot CLI-раннер: spawn `provider.cli` с НЕинтерактивным флагом из
 *    метаданных `assistant.oneShotArgs` (argv-массив, промпт ОТДЕЛЬНЫМ элементом,
 *    БЕЗ интерполяции в shell; таймаут; stdout → ответ, stderr → ошибка). Basic-
 *    режим — простой текст, помечается `experimental`.
 *  - `api` → прямой вызов модельного API через нативный `fetch` (без новых
 *    зависимостей) по `apiKind`. Ключ берётся из `getRawKey` и НЕ логируется.
 *  - `none` → не вызываем, возвращаем структурную причину для модалки.
 *
 * ПРИОРИТЕТ — ПОДПИСКА: режим резолвится `resolveRunner` (cli → api → none).
 */

/** Роль реплики в мультимодельном чате. */
export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Причина итога запуска (совпадает с contracts `AssistantRunReason`). */
export type AssistantRunReason =
  'ok' | 'no_key_no_cli' | 'unsupported' | 'cli_not_scriptable' | 'cli_error' | 'api_error';

export interface AssistantRunResult {
  ok: boolean;
  providerId: string;
  mode: RunnerMode;
  reply: string;
  experimental: boolean;
  reason: AssistantRunReason;
  error?: string;
  /** Как отработал CLI: отдельный процесс на вопрос или сессия локального сервера. */
  transport?: 'one-shot' | 'session';
  /** Id сессии CLI, если диалог шёл сессией. */
  sessionId?: string;
}

/** Внедряемые зависимости (для тестов: без реальной сети и без реального spawn). */
export interface RunAssistantDeps {
  appDataDir: string;
  detect?: (command: string) => boolean;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof nodeSpawn;
  /** Таймаут CLI one-shot, мс (по умолчанию 180000). */
  timeoutMs?: number;
  /**
   * Каталог моделей провайдера (из кэша, без похода в сеть). Нужен ровно затем,
   * чтобы зашитая в код модель ассистента не устаревала молча: при совпадении
   * семейства берётся её актуальное поколение. Пусто — остаёмся на зашитой.
   */
  models?: ModelInfo[];
  /**
   * Идентификатор диалога панели. Нужен ровно сессионному режиму (IDEA-8): по
   * нему находится уже открытая сессия CLI. Не задан → сессионный режим не
   * пробуется вовсе, всё идёт one-shot как раньше.
   */
  conversationId?: string;
  /** Локальный сервер CLI (подменяется в тестах, чтобы ничего не запускалось). */
  sessionServe?: OpencodeServe;
  /** Сколько ждать готовности локального сервера CLI, мс. */
  serveReadyTimeoutMs?: number;
}

const DEFAULT_TIMEOUT = 180_000;

/**
 * Платформа — ФУНКЦИЯ, а не константа модуля: константа замерла бы на импорте, и
 * подменить `process.platform` в кроссплатформенном тесте было бы нечем.
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Снять зависший one-shot ЦЕЛИКОМ. На Windows мы запускаем CLI через `cmd.exe /c`,
 * поэтому `child.kill()` убивает только сам cmd.exe, а настоящий процесс CLI
 * остаётся жить и держать порты/файлы. `taskkill /T /F` валит всё дерево; на POSIX
 * достаточно обычного сигнала. Ошибки глушим — снятие процесса не должно ронять ответ.
 */
function killSpawned(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  try {
    if (isWindows() && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    }
  } catch {
    // taskkill может отсутствовать/отказать — падаем на обычный kill ниже.
  }
  try {
    child.kill();
  } catch {
    // Процесс уже завершился — это не ошибка.
  }
}

/** Собрать один текстовый промпт из истории (basic-режим — простой текст). */
function flattenPrompt(messages: AssistantMessage[]): string {
  return messages
    .map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
    .join('\n\n')
    .trim();
}

// --- CLI one-shot ------------------------------------------------------------

interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

/**
 * Запуск CLI безопасно, БЕЗ shell-интерполяции: argv-массив передаётся как есть.
 * На Windows команда-обёртка (`*.cmd`) исполняется через `cmd.exe /c` с argv-
 * массивом (Node сам корректно квотит аргументы для cmd.exe) — промпт остаётся
 * отдельным элементом и никогда не склеивается со строкой команды.
 */
function spawnCli(
  command: string,
  args: string[],
  deps: RunAssistantDeps,
  stdin?: string,
): Promise<SpawnOutcome> {
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT;

  let child: ChildProcessWithoutNullStreams;
  try {
    if (isWindows()) {
      const comspec = process.env.ComSpec || 'cmd.exe';
      child = spawnImpl(comspec, ['/d', '/s', '/c', command, ...args], {
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } else {
      child = spawnImpl(command, args, { windowsHide: true }) as ChildProcessWithoutNullStreams;
    }
  } catch (error) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: error instanceof Error ? error : new Error(String(error)),
    });
  }

  return new Promise<SpawnOutcome>((resolve) => {
    // Куски копим БУФЕРАМИ и декодируем один раз в конце. Декодировать каждый
    // chunk отдельно нельзя: граница чтения рвёт многобайтовую UTF-8
    // последовательность — русский ответ CLI превращался бы в «крокозябры».
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const decode = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8');

    const finish = (outcome: Omit<SpawnOutcome, 'stdout' | 'stderr'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, stdout: decode(outChunks), stderr: decode(errChunks) });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killSpawned(child);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.on('error', (error) => finish({ code: null, timedOut, spawnError: error }));
    child.on('close', (code) => finish({ code, timedOut }));

    if (stdin !== undefined) {
      // Обработчик ошибки ОБЯЗАТЕЛЕН: если CLI закрылся раньше, чем мы дописали
      // промпт, поток отдаёт EPIPE отдельным событием `error`, а необработанное
      // `error` у потока роняет весь процесс сервера. Тут это просто «не успели».
      child.stdin?.on('error', () => {});
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

/** Превратить исход spawn в результат ассистента (общее для claude и прочих CLI). */
function outcomeToResult(
  providerId: string,
  outcome: SpawnOutcome,
  experimental: boolean,
): AssistantRunResult {
  if (outcome.spawnError) {
    return {
      ok: false,
      providerId,
      mode: 'cli',
      reply: '',
      experimental,
      reason: 'cli_error',
      error: outcome.spawnError.message,
    };
  }
  if (outcome.timedOut) {
    return {
      ok: false,
      providerId,
      mode: 'cli',
      reply: '',
      experimental,
      reason: 'cli_error',
      error: 'CLI не ответил за отведённое время',
    };
  }
  const reply = outcome.stdout.trim();
  if (outcome.code !== 0 || !reply) {
    return {
      ok: false,
      providerId,
      mode: 'cli',
      reply: '',
      experimental,
      reason: 'cli_error',
      error: outcome.stderr.trim().slice(0, 500) || `CLI завершился с кодом ${outcome.code}`,
    };
  }
  return {
    ok: true,
    providerId,
    mode: 'cli',
    reply,
    experimental,
    reason: 'ok',
    transport: 'one-shot',
  };
}

/**
 * Делегация Claude его СУЩЕСТВУЮЩЕМУ CLI-пути (print-режим `claude -p`, промпт
 * через stdin — многострочный текст с кавычками не рвётся). ChatRunner и богатый
 * стриминговый чат НЕ трогаются; это просто вызов уже установленного `claude`.
 */
async function runClaudeDelegate(
  provider: ConfigProvider,
  messages: AssistantMessage[],
  deps: RunAssistantDeps,
  cliCommand?: string,
): Promise<AssistantRunResult> {
  // Имя берём то, которое детект РЕАЛЬНО нашёл в PATH (на Windows это `claude.cmd`,
  // как и раньше; но если стоит только `claude.exe` — запустится он).
  const command = cliCommand ?? providerCliCommand(provider);
  const outcome = await spawnCli(command, ['-p'], deps, flattenPrompt(messages));
  // Claude — verified-путь, не помечаем experimental.
  return outcomeToResult(provider.id, outcome, false);
}

/** One-shot CLI прочих провайдеров по задокументированному print-флагу. */
async function runProviderCli(
  provider: ConfigProvider,
  prompt: string,
  deps: RunAssistantDeps,
  cliCommand?: string,
): Promise<AssistantRunResult> {
  const command = cliCommand ?? providerCliCommand(provider);
  const args = provider.assistant?.oneShotArgs?.(prompt);
  if (!args) {
    // CLI установлен, но неинтерактивный флаг не задокументирован → программно
    // не запускаем (fail-closed). Вызывающий попробует api/none.
    return {
      ok: false,
      providerId: provider.id,
      mode: 'cli',
      reply: '',
      experimental: true,
      reason: 'cli_not_scriptable',
      error: `Для «${provider.name}» не задан неинтерактивный флаг запуска CLI.`,
    };
  }
  const outcome = await spawnCli(command, args, deps);
  return outcomeToResult(provider.id, outcome, true);
}

// --- Сессионный режим CLI (IDEA-8) -------------------------------------------

/**
 * Сессионный запуск через локальный сервер CLI. Отличие от one-shot одно, но
 * важное: контекст диалога держит САМ CLI, поэтому наружу уходит только
 * последнее сообщение пользователя, а не склеенная история.
 *
 * `undefined` = «не получилось, иди дальше»: вызывающий молча падает на one-shot.
 * Своих ошибок наружу этот путь не даёт — он не должен уметь сломать то, что
 * работало до него.
 */
async function runSessionServer(
  provider: ConfigProvider,
  messages: AssistantMessage[],
  deps: RunAssistantDeps,
  cliCommand?: string,
): Promise<AssistantRunResult | undefined> {
  const conversationId = deps.conversationId;
  if (!conversationId || provider.assistant?.sessionServer !== 'opencode') return undefined;

  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const text = lastUser?.content.trim();
  if (!text) return undefined;

  const serve = deps.sessionServe ?? opencodeServe;
  const result = await serve.ask(conversationId, text, {
    command: cliCommand ?? providerCliCommand(provider),
    spawnImpl: deps.spawnImpl,
    fetchImpl: deps.fetchImpl,
    readyTimeoutMs: deps.serveReadyTimeoutMs,
    requestTimeoutMs: deps.timeoutMs,
  });
  if (!result) return undefined;

  return {
    ok: true,
    providerId: provider.id,
    mode: 'cli',
    reply: result.reply,
    // Путь всё ещё экспериментальный: живым прогоном не проверен (CLI здесь не
    // установлен), форма запросов — из документации.
    experimental: true,
    reason: 'ok',
    transport: 'session',
    sessionId: result.sessionId,
  };
}

// --- API fetch ---------------------------------------------------------------

const OPENAI_BASE = 'https://api.openai.com/v1';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Зашитый минимум: скромные модели, которых хватает на заполнение формы.
 * Каталог поколений (`deps.models`) поднимает каждую до её актуальной версии
 * ВНУТРИ семейства — класс модели и порядок цены остаются те же.
 */
const MODELS = {
  anthropic: 'claude-3-5-sonnet-latest',
  openai: 'gpt-4o-mini',
  google: 'gemini-1.5-flash',
} as const;

/** Актуальное поколение зашитой модели — или она сама, если каталога нет. */
function assistantModel(deps: RunAssistantDeps, fallback: string): string {
  return resolveAssistantModel(deps.models ?? [], fallback);
}

function apiError(providerId: string, message: string): AssistantRunResult {
  return {
    ok: false,
    providerId,
    mode: 'api',
    reply: '',
    experimental: false,
    reason: 'api_error',
    error: message,
  };
}

/**
 * Прямой вызов модельного API провайдера через нативный `fetch` по `apiKind`.
 * БЕЗОПАСНОСТЬ: ключ идёт только в заголовок/квери исходящего запроса и НИКОГДА
 * не попадает в текст ошибки или лог (URL с ключом наружу не отдаём).
 */
async function runProviderApi(
  provider: ConfigProvider,
  messages: AssistantMessage[],
  key: string,
  deps: RunAssistantDeps,
): Promise<AssistantRunResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const apiKind = provider.assistant?.apiKind ?? 'none';

  try {
    if (apiKind === 'anthropic') {
      const res = await fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: assistantModel(deps, MODELS.anthropic),
          max_tokens: 2048,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok) return apiError(provider.id, await describeHttpError(res));
      const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
      const reply = (data.content ?? [])
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join('')
        .trim();
      return finalizeApi(provider.id, reply);
    }

    if (apiKind === 'google') {
      // Ключ — в квери; URL с ключом в ошибки/логи НЕ включаем.
      const model = assistantModel(deps, MODELS.google);
      const url = `${GOOGLE_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
        }),
      });
      if (!res.ok) return apiError(provider.id, await describeHttpError(res));
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const reply = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();
      return finalizeApi(provider.id, reply);
    }

    // openai + openai-compat → chat/completions (base URL: OpenAI по умолчанию).
    const base =
      apiKind === 'openai-compat' ? (process.env.OPENAI_BASE_URL ?? OPENAI_BASE) : OPENAI_BASE;
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? assistantModel(deps, MODELS.openai),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) return apiError(provider.id, await describeHttpError(res));
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = (data.choices?.[0]?.message?.content ?? '').trim();
    return finalizeApi(provider.id, reply);
  } catch (error) {
    return apiError(provider.id, error instanceof Error ? error.message : String(error));
  }
}

function finalizeApi(providerId: string, reply: string): AssistantRunResult {
  if (!reply) return apiError(providerId, 'Модель вернула пустой ответ.');
  return { ok: true, providerId, mode: 'api', reply, experimental: false, reason: 'ok' };
}

/** Краткое описание HTTP-ошибки API без раскрытия секретов. */
async function describeHttpError(res: Response): Promise<string> {
  let detail: string;
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  return `API ответил ${res.status}${detail ? `: ${detail}` : ''}`;
}

// --- Публичный switch --------------------------------------------------------

/**
 * Запуск ассистента активного провайдера по switch. Claude → делегирует своему
 * существующему CLI-пути (не через раннеры прочих); остальные — по режиму раннера.
 */
export async function runAssistant(
  provider: ConfigProvider,
  messages: AssistantMessage[],
  deps: RunAssistantDeps,
): Promise<AssistantRunResult> {
  const resolution = resolveRunner(provider, deps.appDataDir, deps.detect);

  // Claude — ОТДЕЛЬНАЯ ветка: делегируем существующему пути, не переписываем.
  if (provider.id === 'claude') {
    if (resolution.mode === 'cli')
      return runClaudeDelegate(provider, messages, deps, resolution.cliCommandFound);
    // Claude без CLI, но с ключом → его же Anthropic API как фолбэк.
    if (resolution.mode === 'api') {
      const key = getRawKey(provider, deps.appDataDir);
      if (key) return runProviderApi(provider, messages, key, deps);
    }
    return noneResult(
      provider.id,
      resolution.reason === 'unsupported' ? 'unsupported' : 'no_key_no_cli',
    );
  }

  if (resolution.mode === 'cli') {
    // IDEA-8: сначала сессионный режим (если провайдер его заявил и диалог
    // опознан), при любой заминке — привычный one-shot.
    const session = await runSessionServer(provider, messages, deps, resolution.cliCommandFound);
    if (session) return session;

    const cliResult = await runProviderCli(
      provider,
      flattenPrompt(messages),
      deps,
      resolution.cliCommandFound,
    );
    // CLI без задокументированного флага → пробуем платный API как фолбэк.
    if (cliResult.reason === 'cli_not_scriptable') {
      const key = getRawKey(provider, deps.appDataDir);
      if (provider.assistant?.apiKind !== 'none' && provider.assistant?.apiKind && key) {
        return runProviderApi(provider, messages, key, deps);
      }
      return noneResult(provider.id, 'no_key_no_cli');
    }
    return cliResult;
  }

  if (resolution.mode === 'api') {
    const key = getRawKey(provider, deps.appDataDir);
    if (!key) return noneResult(provider.id, 'no_key_no_cli');
    return runProviderApi(provider, messages, key, deps);
  }

  return noneResult(
    provider.id,
    resolution.reason === 'unsupported' ? 'unsupported' : 'no_key_no_cli',
  );
}

function noneResult(
  providerId: string,
  reason: 'no_key_no_cli' | 'unsupported',
): AssistantRunResult {
  return { ok: false, providerId, mode: 'none', reply: '', experimental: false, reason };
}
