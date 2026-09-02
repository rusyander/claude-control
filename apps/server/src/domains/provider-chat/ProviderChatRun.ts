import type { spawn as nodeSpawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AssistantRunReason,
  ModelInfo,
  ProviderChatMessage,
  ProviderChatTransport,
} from '@claude-control/contracts';
import { spawnCliProcess } from '../../lib/cli-spawn.ts';
import { killChildTree } from '../../lib/process-tree.ts';
import type { ConfigProvider } from '../../providers/types.ts';
import { providerCliCommand } from '../../providers/cli.ts';
import { resolveRunner, getRawKey } from '../provider-keys.ts';
import { runProviderApi } from '../assistant-runner/api.ts';
import { opencodeServe, type OpencodeServe } from '../opencode-serve.ts';
import { buildPrompt } from './prompt.ts';

/**
 * Один ответ чужого провайдера.
 *
 * Три пути дают одну и ту же ленту событий, поэтому чат наверху про них не
 * знает:
 *  - `stream` — CLI запускается на один вопрос, и текст отдаётся по мере того,
 *    как CLI его печатает. Ничего чужого здесь не разбирается: показывается
 *    ровно то, что процесс вывел в stdout. Именно это и делает чат «живым» у
 *    всех восьми CLI сразу — задокументированного потокового ФОРМАТА нет ни у
 *    кого, а поток байтов есть у всех.
 *  - `session` — диалог держит локальный сервер CLI (сейчас только OpenCode).
 *    Ответ приходит целиком, зато контекст не пересылается заново.
 *  - `api` — прямой вызов модельного API по ключу, когда CLI не установлен.
 *
 * Claude сюда не попадает никогда: у него свой богатый чат, и эта ветка его не
 * касается.
 */

const DEFAULT_TIMEOUT_MS = 300_000;

export type ProviderChatRunEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; reply: string; transport: ProviderChatTransport }
  | { type: 'error'; error: string; reason: AssistantRunReason };

export interface ProviderChatRunOptions {
  provider: ConfigProvider;
  /** Переписка вместе с новым вопросом — из неё собирается промпт. */
  history: ProviderChatMessage[];
  /** Идентификатор разговора: по нему находится сессия CLI. */
  chatId: string;
  appDataDir: string;
  /** Рабочий каталог CLI. Не задан — каталог сервера. */
  workdir?: string;
  /**
   * Указание, которое дописывается к переписке ПЕРЕД первой репликой, — у чужого
   * CLI это единственный способ передать что-то вроде системного промпта:
   * отдельного флага для него нет ни у одного из них, а контекст всё равно
   * собирает панель. В переписку не пишется и человеку не показывается.
   */
  systemPrefix?: string;
  timeoutMs?: number;
  models?: ModelInfo[];
  /** Подменяемые зависимости: в тестах ничего настоящего не запускается. */
  spawnImpl?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  detect?: (command: string) => boolean;
  sessionServe?: OpencodeServe;
}

export interface ProviderChatRunLike {
  start(
    options: ProviderChatRunOptions,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void>;
  stop(): void;
}

/** Синтетическая реплика с указанием: в файл разговора она не попадает. */
function prefixMessage(content: string): ProviderChatMessage {
  return { id: 'system-prefix', role: 'user', content, at: new Date().toISOString() };
}

export class ProviderChatRun implements ProviderChatRunLike {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  /** Отмена HTTP-путей (`api`, `session`): у них нет процесса, который можно снять. */
  private readonly abort = new AbortController();

  async start(
    options: ProviderChatRunOptions,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    const { provider, appDataDir } = options;

    if (provider.id === 'claude') {
      onEvent({
        type: 'error',
        error: 'Claude ведёт свой собственный чат — этот путь для него не используется.',
        reason: 'unsupported',
      });
      return;
    }

    // Указание встаёт первой репликой и дальше живёт как часть переписки: все
    // пути ниже строят промпт из `history`, поэтому подмешать его надо ровно
    // здесь — иначе про него пришлось бы помнить в каждом из них по отдельности.
    if (options.systemPrefix) {
      options = { ...options, history: [prefixMessage(options.systemPrefix), ...options.history] };
    }

    const resolution = resolveRunner(provider, appDataDir, options.detect);

    if (resolution.mode === 'cli') {
      const session = await this.runSession(options, resolution.cliCommandFound);
      // Остановили, пока сессия отвечала: разговор закрыт тем, что успело
      // прийти (обычно ничем), и ни к одиночному запуску, ни к API дальше не идём.
      if (this.stopped) {
        onEvent({ type: 'done', reply: session ?? '', transport: 'session' });
        return;
      }
      if (session) {
        onEvent({ type: 'delta', text: session });
        onEvent({ type: 'done', reply: session, transport: 'session' });
        return;
      }

      const args = provider.assistant?.oneShotArgs?.(buildPrompt(options.history).text);
      if (args) {
        await this.runStreaming(options, args, resolution.cliCommandFound, onEvent);
        return;
      }
      // CLI есть, но неинтерактивный флаг не задокументирован — придумывать его
      // нельзя, поэтому пробуем ключ, а не «угадаем аргументы».
    }

    const key = getRawKey(provider, appDataDir);
    if (key && provider.assistant?.apiKind && provider.assistant.apiKind !== 'none') {
      await this.runApi(options, key, onEvent);
      return;
    }

    onEvent({
      type: 'error',
      error:
        resolution.mode === 'cli'
          ? `Для «${provider.name}» не задан неинтерактивный флаг запуска CLI.`
          : 'Нужен вход в CLI провайдера или API-ключ.',
      reason: resolution.mode === 'cli' ? 'cli_not_scriptable' : 'no_key_no_cli',
    });
  }

  /**
   * Снять ответ на полуслове: процесс валится целиком, вместе с детьми, а
   * HTTP-запрос к модели или к сессии обрывается — иначе ответ пришёл бы после
   * остановки и лёг в переписку так, будто её и не было.
   */
  stop(): void {
    this.stopped = true;
    this.abort.abort();
    if (this.child) killChildTree(this.child);
  }

  /**
   * Сессионный режим. `undefined` = «не сложилось, иди дальше»: своих ошибок
   * этот путь не даёт — он не должен уметь сломать то, что работало без него.
   */
  private async runSession(
    options: ProviderChatRunOptions,
    cliCommand?: string,
  ): Promise<string | undefined> {
    const { provider } = options;
    if (provider.assistant?.sessionServer !== 'opencode') return undefined;

    const lastUser = [...options.history].reverse().find((message) => message.role === 'user');
    const text = lastUser?.content.trim();
    if (!text) return undefined;

    const serve = options.sessionServe ?? opencodeServe;
    const result = await serve.ask(options.chatId, text, {
      command: cliCommand ?? providerCliCommand(provider),
      spawnImpl: options.spawnImpl,
      fetchImpl: options.fetchImpl,
      requestTimeoutMs: options.timeoutMs,
      signal: this.abort.signal,
    });

    return result?.reply;
  }

  /** Прямой вызов модельного API: ответ приходит целиком, поток эмулируется одним куском. */
  private async runApi(
    options: ProviderChatRunOptions,
    key: string,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    const result = await runProviderApi(
      options.provider,
      options.history
        .filter((message) => !message.failed)
        .map((message) => ({ role: message.role, content: message.content })),
      key,
      {
        appDataDir: options.appDataDir,
        fetchImpl: options.fetchImpl,
        signal: this.abort.signal,
        ...(options.models ? { models: options.models } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      },
    );

    // Обрыв по кнопке — не ошибка модели: ответа нет, и разговор закрывается пустым.
    if (this.stopped) {
      onEvent({ type: 'done', reply: '', transport: 'api' });
      return;
    }

    if (!result.ok) {
      onEvent({
        type: 'error',
        error: result.error ?? 'Модель не ответила',
        reason: result.reason,
      });
      return;
    }

    onEvent({ type: 'delta', text: result.reply });
    onEvent({ type: 'done', reply: result.reply, transport: 'api' });
  }

  /**
   * Потоковый запуск CLI. Куски stdout декодируются потоковым декодером: граница
   * чтения рвёт многобайтовую последовательность UTF-8, и посимвольная склейка
   * без него превращала бы русский ответ в «крокозябры» ровно на стыках.
   */
  private runStreaming(
    options: ProviderChatRunOptions,
    args: string[],
    cliCommand: string | undefined,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    // Остановили раньше, чем процесс успел стартовать, — стартовать уже незачем.
    if (this.stopped) {
      onEvent({ type: 'done', reply: '', transport: 'stream' });
      return Promise.resolve();
    }

    const command = cliCommand ?? providerCliCommand(options.provider);
    const spawned = spawnCliProcess(command, args, {
      spawnImpl: options.spawnImpl,
      ...(options.workdir ? { cwd: options.workdir } : {}),
    });

    if (spawned.error) {
      onEvent({ type: 'error', error: spawned.error.message, reason: 'cli_error' });
      return Promise.resolve();
    }

    const child = spawned.child;
    this.child = child;

    return new Promise<void>((resolve) => {
      const outDecoder = new TextDecoder('utf8');
      const errDecoder = new TextDecoder('utf8');
      let reply = '';
      let errorText = '';
      let timedOut = false;
      let settled = false;

      const finish = (event: ProviderChatRunEvent): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = undefined;
        onEvent(event);
        resolve();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killChildTree(child);
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = outDecoder.decode(chunk, { stream: true });
        if (!text) return;
        reply += text;
        onEvent({ type: 'delta', text });
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        errorText += errDecoder.decode(chunk, { stream: true });
      });

      child.on('error', (error) =>
        finish({ type: 'error', error: error.message, reason: 'cli_error' }),
      );

      child.on('close', (code) => {
        const tail = outDecoder.decode();
        if (tail) {
          reply += tail;
          onEvent({ type: 'delta', text: tail });
        }

        // Остановка по кнопке — не ошибка: то, что модель успела сказать,
        // остаётся ответом, и разговор им продолжается.
        if (this.stopped) {
          finish({ type: 'done', reply: reply.trim(), transport: 'stream' });
          return;
        }

        if (timedOut) {
          finish({
            type: 'error',
            error: 'CLI не ответил за отведённое время',
            reason: 'cli_error',
          });
          return;
        }

        const text = reply.trim();
        if (code !== 0 || !text) {
          finish({
            type: 'error',
            error: errorText.trim().slice(0, 500) || `CLI завершился с кодом ${code}`,
            reason: 'cli_error',
          });
          return;
        }

        finish({ type: 'done', reply: text, transport: 'stream' });
      });
    });
  }
}
