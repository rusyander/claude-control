import { killChildTree } from '../../lib/process-tree/process-tree.ts';
import { spawnCliProcess } from '../../lib/cli-spawn/cli-spawn.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { withCodexKit } from '../kit/codex.ts';
import {
  readStreamJsonResult,
  STREAM_JSON_INPUT_ARGS,
  streamJsonUserLine,
  writeAgentImages,
  type AgentImage,
} from '../../lib/agent-images/agent-images.ts';
import type { ConfigProvider } from '../../providers/types/types.ts';
import { providerCliCommand } from '../../providers/cli/cli.ts';
import { opencodeServe } from '../opencode-serve/opencode-serve.ts';
import { DEFAULT_TIMEOUT } from './constants.ts';
import { lightWindowArgs, lightWindowDir } from '../assistant/assistant.ts';
import type {
  AssistantMessage,
  AssistantRunResult,
  RunAssistantDeps,
  SpawnOutcome,
} from './types.ts';

/**
 * Снять зависший one-shot ЦЕЛИКОМ. На Windows мы запускаем CLI через `cmd.exe /c`,
 * поэтому `child.kill()` убивает только сам cmd.exe, а настоящий процесс CLI
 * остаётся жить и держать порты/файлы. `killChildTree` валит всё дерево (обход по
 * времени создания, без `taskkill /T`); на POSIX достаточно обычного сигнала.
 * Ошибки глушим — снятие процесса не должно ронять ответ.
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
 * `lib/cli-spawn/cli-spawn.ts`; здесь только ожидание, таймаут и сбор вывода.
 */
function spawnCli(
  command: string,
  args: string[],
  deps: RunAssistantDeps,
  stdin?: string,
  cwd?: string,
  runEnv?: Record<string, string>,
): Promise<SpawnOutcome> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT;
  // Набор панели в Codex (`domains/kit/codex.ts`) — без переменной наложения ничего не меняет.
  const kit = withCodexKit(args, deps.env, 'exec');
  // Окружение прогона от провайдера (`assistant.oneShotEnv`) — поверх набора.
  const env = { ...kit.env, ...runEnv };
  const spawned =
    kit.missing || kit.refusal
      ? { error: new Error(kit.refusal ?? serverText('kit-compose-failed')) }
      : spawnCliProcess(command, kit.args, {
          spawnImpl: deps.spawnImpl,
          ...(cwd ? { cwd } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        });

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
    } else {
      // Промпт в argv — stdin всё равно закрываем: CLI, читающий его, когда это
      // не терминал (`opencode run`, проверено 1.18.34), иначе ждёт конца вечно.
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    }
  });
}

/** Текст сбоя «CLI не ответил вовремя» — по нему обнаружение групп узнаёт таймаут. */
export const CLI_TIMEOUT_ERROR = 'CLI не ответил за отведённое время';

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
      error: CLI_TIMEOUT_ERROR,
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
 *
 * ЛЁГКОЕ ОКНО (U6, 28.09) — как у помощника формы: окно ассистента и вызовы
 * групп — текст на вход, текст на выход, всё нужное модели уже в задании. До
 * правки `claude -p [--model haiku]` шёл со всеми слоями человека (правила,
 * хуки, скиллы, MCP), с инструментами, копил транскрипт на каждый служебный
 * вызов и запускался в каталоге сервера (правила репозитория через CLAUDE.md).
 * Хвост `lightWindowArgs()` — последним: `--tools ""` съел бы следующий аргумент.
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
  // Модель — только когда её попросили явно (дешёвая ступень для служебных вызовов групп).
  const head = deps.model ? ['-p', '--model', deps.model] : ['-p'];
  const images = userImages(messages);
  // Переключатель на локальную модель: без его переменных лёгкое окно ушло бы в облако.
  const switchEnv = deps.claudeEnv?.() ?? {};
  const { dir, cleanup } = lightWindowDir();
  try {
    if (images.length === 0) {
      const outcome = await spawnCli(
        command,
        [...head, ...lightWindowArgs()],
        deps,
        flattenPrompt(messages),
        dir,
        switchEnv,
      );
      // Claude — verified-путь, не помечаем experimental.
      return outcomeToResult(provider.id, outcome, false);
    }
    // С картинками — потоковый ввод: текстом stdin картинку не передать, а блок
    // `image` модель видит в этом же ответе. Итог читается из события `result`.
    const outcome = await spawnCli(
      command,
      [...head, ...STREAM_JSON_INPUT_ARGS, ...lightWindowArgs()],
      deps,
      streamJsonUserLine(flattenPrompt(messages), images),
      dir,
      switchEnv,
    );
    return outcomeToResult(provider.id, fromStreamJson(outcome), false);
  } finally {
    cleanup();
  }
}

/**
 * Картинки всех реплик человека по порядку. Запрос one-shot несёт историю
 * целиком, и снимок первого хода нужен модели и на втором — так же шлют все
 * ходы пути API; раньше уходили только картинки последней реплики (F-148).
 */
export function userImages(messages: AssistantMessage[]): readonly AgentImage[] {
  return messages.flatMap((message) => (message.role === 'user' ? (message.images ?? []) : []));
}

/** Исход потокового вывода в форму текстового: ответ — текст события `result`. */
function fromStreamJson(outcome: SpawnOutcome): SpawnOutcome {
  if (outcome.spawnError || outcome.timedOut) return outcome;
  const result = readStreamJsonResult(outcome.stdout);
  if (!result) return { ...outcome, stdout: '' };
  if (result.isError)
    return { ...outcome, code: outcome.code || 1, stdout: '', stderr: result.text };
  return { ...outcome, stdout: result.text };
}

/**
 * Реплики для чужого CLI, у которого нет входа для картинки в запросе: картинки
 * ложатся файлами в `dir`, а текст каждой реплики называет пути своих — CLI
 * читает файлы своими инструментами, как вложения чата. Суффикс пишется в той
 * же строке, но однострочности запроса это не обещает: история склеена через
 * пустые строки, а обрезку на переводе строки под `.cmd` ловит `cli-spawn`.
 */
export function withImagePaths(messages: AssistantMessage[], dir: string): AssistantMessage[] {
  const paths = writeAgentImages(dir, userImages(messages));
  if (paths.length === 0) return messages;
  // Путь — у той реплики, к которой картинку приложили: файлы пишутся одним
  // списком по порядку реплик, и каждая забирает свою долю.
  let next = 0;
  return messages.map((message) => {
    const count = message.role === 'user' ? (message.images?.length ?? 0) : 0;
    const own = paths.slice(next, next + count);
    next += count;
    return own.length === 0
      ? { role: message.role, content: message.content }
      : {
          role: message.role,
          content: `${message.content} (Attached images, read them from disk: ${own.join(', ')})`,
        };
  });
}

/** One-shot CLI прочих провайдеров по задокументированному print-флагу. */
export async function runProviderCli(
  provider: ConfigProvider,
  prompt: string,
  deps: RunAssistantDeps,
  cliCommand?: string,
  cwd?: string,
): Promise<AssistantRunResult> {
  const command = cliCommand ?? providerCliCommand(provider);
  // Каталог запуска — тоже часть прогона: Aider вне репозитория сам делает `git init`.
  const run =
    deps.model || cwd
      ? { ...(deps.model ? { model: deps.model } : {}), ...(cwd ? { workdir: cwd } : {}) }
      : undefined;
  const args = provider.assistant?.oneShotArgs?.(prompt, run);
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
  // То же окружение прогона, что у чата (Aider: UTF-8 в трубе вместо cp1251).
  const outcome = await spawnCli(
    command,
    args,
    deps,
    undefined,
    cwd,
    provider.assistant?.oneShotEnv?.(run),
  );
  // Тот же разбор stdout, что у чата: argv один, значит, и вывод один (у Goose — поток JSON).
  const parser = provider.assistant?.parseStdout?.();
  const stdout = parser ? `${parser.push(outcome.stdout)}${parser.end()}` : outcome.stdout;
  // CLI сам сказал «ход удался» — ненулевой код после этого сбой выхода, не ответа.
  const parsed = parser
    ? { ...outcome, stdout, code: parser.settled?.() ? 0 : outcome.code }
    : outcome;
  return outcomeToResult(provider.id, parsed, true);
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
  // Сервер сессий общий на все разговоры и поднят со своим окружением: адрес
  // контура этого прогона (`OPENCODE_CONFIG_CONTENT`) до него не дошёл бы, и ход
  // ушёл бы провайдером человека. Прогон с окружением — только одиночным запуском.
  if (deps.env && Object.keys(deps.env).length > 0) return undefined;

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
  // Ход начался и упал — причина CLI; one-shot повторил бы ход заново.
  if ('error' in result) {
    return {
      ok: false,
      providerId: provider.id,
      mode: 'cli',
      reply: '',
      experimental: true,
      reason: 'cli_error',
      transport: 'session',
      sessionId: result.sessionId,
      error: result.error,
    };
  }

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
