import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { killChildTree } from '../../lib/process-tree.ts';
import { shellArgs } from '../../lib/cli-args.ts';
import { resolveWindowsExecutable, cmdWouldTruncate } from '../../lib/win-exec.ts';
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
 * Запуск CLI без shell-интерполяции. На POSIX это буквально argv-массив: оболочки
 * нет, метасимволы разбирать некому.
 *
 * На Windows иначе: команда-обёртка (`*.cmd`) запускается только через `cmd.exe`,
 * а он РАЗБИРАЕТ полученную строку заново. Раньше сюда уходил argv-массив в
 * расчёте на то, что квотирует Node, — но libuv берёт в кавычки только аргументы
 * с пробелом, табом или кавычкой. Промпт без пробелов, зато с `&`, `|`, `>` или
 * `^` доходил до cmd.exe голым: `2+2>4?` перенаправлялся в файл, а `a&whoami`
 * запускал вторую команду правами сервера. Промпт попадает в argv у всех
 * провайдеров, кроме claude (у него — через stdin), так что случай не редкий.
 *
 * Поэтому строку командной строки собираем сами — тем же `shellArgs`, что и
 * ChatRunner: правило проекта гласит, что через оболочку идёт либо ОДНА строка,
 * либо `shellArgs`, но не сырой массив. Внешняя пара кавычек и
 * `windowsVerbatimArguments` нужны в паре: без флага libuv заквотировал бы уже
 * заквотированное по второму разу, а `/s` снимает ровно эту внешнюю пару.
 * `/v:off` добивает `!ИМЯ!`: при включённом отложенном разворачивании оно
 * подставляется даже внутри кавычек.
 *
 * Но и с идеальными кавычками cmd.exe остаётся плохим посредником: `%ИМЯ%` он
 * подставит из окружения, а на первом переводе строки ОБРЕЖЕТ команду и молча
 * (код 0) выполнит только первую строку — промпт склеен из истории через
 * «\n\n», так что обрезание ловил почти каждый второй вопрос подряд. Поэтому
 * сперва ищем настоящий `.exe` и запускаем его БЕЗ оболочки: argv уходит как
 * есть. Обёртка `.cmd` без `.exe` рядом — единственный случай, когда cmd.exe
 * всё ещё нужен, и там мы лучше откажемся с внятной ошибкой, чем отправим
 * обрубок промпта и выдадим ответ на него за полный.
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
      const direct = resolveWindowsExecutable(command);
      if (direct) {
        child = spawnImpl(direct, args, { windowsHide: true }) as ChildProcessWithoutNullStreams;
      } else if (cmdWouldTruncate(args)) {
        return Promise.resolve({
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: new Error(
            `«${command}» установлен как .cmd-обёртка, а через неё Windows обрезает команду ` +
              'на первом переводе строки — многострочный запрос дошёл бы обрубком. ' +
              'Поставьте нативный исполняемый файл CLI или задайте запрос одной строкой.',
          ),
        });
      } else {
        const comspec = process.env.ComSpec || 'cmd.exe';
        const line = shellArgs([command, ...args]).join(' ');
        child = spawnImpl(comspec, ['/d', '/s', '/v:off', '/c', `"${line}"`], {
          windowsHide: true,
          windowsVerbatimArguments: true,
        }) as ChildProcessWithoutNullStreams;
      }
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
