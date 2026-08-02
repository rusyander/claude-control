import { killChildTree } from '../../lib/process-tree.ts';
import { spawnCliProcess } from '../../lib/cli-spawn.ts';
import type { ConfigProvider } from '../../providers/types.ts';
import { providerCliCommand } from '../../providers/cli.ts';
import { opencodeServe } from '../opencode-serve.ts';
import { DEFAULT_TIMEOUT } from './constants.ts';
import type {
  AssistantMessage,
  AssistantRunResult,
  RunAssistantDeps,
  SpawnOutcome,
} from './types.ts';

/**
 * Снять зависший one-shot ЦЕЛИКОМ. На Windows мы запускаем CLI через `cmd.exe /c`,
 * поэтому `child.kill()` убивает только сам cmd.exe, а настоящий процесс CLI
 * остаётся жить и держать порты/файлы. `taskkill /T /F` валит всё дерево; на POSIX
 * достаточно обычного сигнала. Ошибки глушим — снятие процесса не должно ронять ответ.
 */
const killSpawned = killChildTree;

/** Собрать один текстовый промпт из истории (basic-режим — простой текст). */
export function flattenPrompt(messages: AssistantMessage[]): string {
  return messages
    .map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
    .join('\n\n')
    .trim();
}

// --- CLI one-shot ------------------------------------------------------------

/**
 * One-shot: дождаться конца работы CLI и отдать вывод целиком. Как именно
 * процесс запускается (и почему на Windows это отдельная история) — в
 * `lib/cli-spawn.ts`; здесь только ожидание, таймаут и сбор вывода.
 */
function spawnCli(
  command: string,
  args: string[],
  deps: RunAssistantDeps,
  stdin?: string,
): Promise<SpawnOutcome> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT;
  const spawned = spawnCliProcess(command, args, { spawnImpl: deps.spawnImpl });

  if (spawned.error) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: spawned.error,
    });
  }

  const child = spawned.child;

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
export async function runClaudeDelegate(
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
export async function runProviderCli(
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
export async function runSessionServer(
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
