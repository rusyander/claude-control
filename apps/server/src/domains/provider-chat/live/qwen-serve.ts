import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnCliProcess } from '../../../lib/cli-spawn/cli-spawn.ts';
import { killChildTree } from '../../../lib/process-tree/process-tree.ts';
import { freePort } from '../../opencode-serve/opencode-serve.ts';
import { decidePermission, pickOption, type PermissionOption } from './permission.ts';
import type { LivePermissionPolicy, LiveTurn, LiveTurnOptions, LiveTurnResult } from './types.ts';

/**
 * Qwen Code через `qwen serve` (локальный HTTP-демон) — на один ответ.
 *
 * Пути и события сняты с самого CLI (0.25.0) живым прогоном на заглушке модели:
 * `POST /session` → `POST /session/:id/prompt` (202, ход идёт в фоне) → поток
 * `GET /session/:id/events` (`agent_message_chunk` — текст, `turn_complete` —
 * конец, `turn_error` — провал). Вход посреди хода — `POST
 * /session/:id/mid-turn-message`: пока идёт инструмент, сообщение встаёт в тот же
 * ход (`mid_turn_message_injected`); пришедшее во время последнего ответа модели
 * CLI начинает следующим запросом той же сессии (`pending_prompt_started`), и
 * прогон панели ждёт и его — процесс один и тот же. Бездействующая сессия
 * отвечает `{accepted:false}` — сообщение уходит в очередь панели.
 *
 * Права — по переключателю чата (`permission`): правки разрешены — просьба
 * `permission_request` получает «да»; нет — вопрос человеку, его ответ уходит
 * в `POST /session/:id/permission/:rid`. Без политики — отказ, как у `qwen -p`.
 * Сессия открывается и поднимается с `approvalMode: 'default'`: без него 0.25
 * берёт `auto`, и правка файла идёт вовсе без `permission_request` — переключатель
 * чата тогда ничего не решает (живой прогон 21.10 на локальной модели).
 *
 * С `session` (E2b) сессия переживает процесс: следующий ход поднимает её
 * `POST /session/:id/resume` в новом `qwen serve`; события её прежних ходов, если
 * поток их отдаст, в ответ не идут — ход слушает только свои запросы. Ход,
 * кончившийся не ответом, сессию закрывает и убирает в архив Qwen (`POST
 * /sessions/archive`, файл переезжает в `chats/archive/`), как и сменённую
 * (`discard`, не поднявшийся `resume`). Не стирает: журнал сессии — единственный
 * источник расхода Qwen для аналитики, стёртый уносил потраченные токены.
 */

/** Сколько ждать архивации сессии, прежде чем снять процесс. */
const DELETE_MS = 3_000;

/**
 * Режим одобрения сессии qwen. Только `default` шлёт `permission_request` на каждую
 * правку и команду — решает тогда одна панель (`decidePermission`): правки
 * разрешены — «да» без вопроса, нет — вопрос человеку. `auto` (умолчание 0.25)
 * правит файлы молча, мимо переключателя.
 */
const APPROVAL_MODE = 'default';

/** Ошибка хода, оборванного отказом в разрешении; `what` — инструмент и цель, если CLI их назвал. */
function refusedText(what: string): string {
  const base = 'Qwen остановил ход после отказа в разрешении';
  return what ? `${base}: ${what}` : base;
}

const HEALTH_MS = 20_000;
/** Сколько ждать подхвата принятого сообщения после конца хода (на деле — доли секунды). */
const STEER_GRACE_MS = 5_000;
/**
 * Потолок ожидания серверов MCP перед промптом. Переходник Jira поднимается за
 * ~0,35 с, сервер через npx — за секунды; зависший стоит каждому ходу ровно столько.
 */
const MCP_WAIT_MS = 10_000;
const MCP_POLL_MS = 150;

interface QwenEvent {
  readonly type?: string;
  readonly promptId?: string;
  readonly data?: Record<string, unknown>;
}

export class QwenServeTurn implements LiveTurn {
  private child?: ChildProcessWithoutNullStreams;
  private base?: string;
  private sessionId?: string;
  private active = false;
  /** Напечатанное этим прогоном — остаётся ответом и при остановке. */
  private reply = '';
  private timedOut = false;
  private graceOver = false;
  private graceTimer?: ReturnType<typeof setTimeout>;
  /**
   * Отправленные, но ещё не подхваченные сообщения. Ход, кончившийся между
   * «принято» и подхватом, начнёт их следующим запросом — процесс нельзя гасить
   * раньше. Считается с ОТПРАВКИ, а не с ответа: поток событий бежит своим
   * соединением и под нагрузкой обгонял ответ на POST — ход закрывался, POST
   * обрывался, и принятое CLI сообщение уходило человеку как непринятое.
   */
  private awaitingSteers = 0;
  /** Сколько сообщений ход уже подхватил — по нему оборванный POST узнаёт, что его взяли. */
  private pickedTotal = 0;
  private readonly abort = new AbortController();
  private fetchImpl: typeof fetch = fetch;
  private readonly graceMs: number;
  private readonly mcpWaitMs: number;
  private permission?: LivePermissionPolicy;
  /**
   * Что ход получил отказом («edit notes.txt»). Qwen 0.25 после отказа модели слова
   * не даёт — ход кончается пустым, и без этой отметки человек прочёл бы свой же
   * отказ как сбой CLI «без ответа».
   */
  private refused?: string;
  private resumed = false;
  /** Сессию оставить по концу хода: её продолжит следующий ход разговора (E2b). */
  private keep = false;

  /**
   * `graceMs`, `mcpWaitMs` — подмены ожидания подхвата и потолка ожидания MCP для
   * тестов; в работе — `STEER_GRACE_MS`, `MCP_WAIT_MS`.
   */
  constructor(options: { graceMs?: number; mcpWaitMs?: number } = {}) {
    this.graceMs = options.graceMs ?? STEER_GRACE_MS;
    this.mcpWaitMs = options.mcpWaitMs ?? MCP_WAIT_MS;
  }

  async run(
    options: LiveTurnOptions,
    onDelta: (text: string) => void,
    onSteerable?: () => void,
  ): Promise<LiveTurnResult> {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.permission = options.permission;
    const port = await freePort();
    const workspace = options.workdir ?? process.cwd();
    const spawned = spawnCliProcess(
      options.command,
      [
        'serve',
        '--port',
        String(port),
        '--hostname',
        '127.0.0.1',
        '--no-web',
        '--workspace',
        workspace,
      ],
      {
        spawnImpl: options.spawnImpl,
        cwd: workspace,
        ...(options.env && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
        ...(options.portableEnv ? { portableEnv: options.portableEnv } : {}),
      },
    );
    if (spawned.error) return { kind: 'unavailable', why: spawned.error.message };
    this.child = spawned.child;
    let exited = false;
    this.child.on('close', () => {
      exited = true;
    });
    this.child.on('error', () => {
      exited = true;
    });
    this.base = `http://127.0.0.1:${port}`;

    try {
      if (!(await this.waitHealthy(() => exited))) {
        return this.close({ kind: 'unavailable', why: 'qwen serve не поднялся' });
      }
      const request = options.session;
      let sessionId: string | undefined;
      if (request?.resume && (await this.resume(request.resume.id, workspace))) {
        sessionId = request.resume.id;
        this.resumed = true;
      } else {
        const created = await this.json('POST', '/session', {
          cwd: workspace,
          approvalMode: APPROVAL_MODE,
        });
        sessionId = typeof created?.sessionId === 'string' ? created.sessionId : undefined;
        if (!sessionId)
          return this.close({ kind: 'unavailable', why: 'POST /session без sessionId' });
        // Сменённую сессию разговора больше никто не продолжит — удаляем, не дожидаясь.
        const stale = request?.resume?.id ?? request?.discard;
        if (stale && stale !== sessionId) void this.remove(stale);
      }
      this.sessionId = sessionId;
      this.keep = request !== undefined;

      const events = await this.fetchImpl(`${this.base}/session/${sessionId}/events`, {
        signal: this.abort.signal,
      });
      if (!events.ok || !events.body) {
        return this.close({ kind: 'unavailable', why: `поток событий ${events.status}` });
      }
      await this.waitMcpDiscovery();

      const prompt = await this.json('POST', `/session/${sessionId}/prompt`, {
        prompt: [
          {
            type: 'text',
            text: this.resumed && request?.resume ? request.resume.prompt : options.prompt,
          },
        ],
      });
      const promptId = typeof prompt?.promptId === 'string' ? prompt.promptId : undefined;
      if (!promptId) return this.close({ kind: 'unavailable', why: 'prompt без promptId' });
      this.active = true;
      onSteerable?.();

      const result = await this.consume(events.body, promptId, options.timeoutMs, onDelta);
      return this.close(result);
    } catch (error) {
      if (this.timedOut)
        return this.close({ kind: 'error', error: 'CLI не ответил за отведённое время' });
      if (this.graceOver || (this.abort.signal.aborted && !this.active)) {
        return this.close({ kind: 'done', reply: this.reply.trim() });
      }
      const text = error instanceof Error ? error.message : String(error);
      return this.close(
        this.active ? { kind: 'error', error: text } : { kind: 'unavailable', why: text },
      );
    }
  }

  async steer(text: string): Promise<boolean> {
    if (!this.active || !this.sessionId) return false;
    this.awaitingSteers += 1;
    const pickedBefore = this.pickedTotal;
    let accepted: boolean;
    try {
      const reply = await this.json('POST', `/session/${this.sessionId}/mid-turn-message`, {
        message: text,
      });
      accepted = reply?.accepted === true;
    } catch {
      // Ход закрылся, пока ответ был в пути: подхвачено — значит, принято.
      return this.pickedTotal > pickedBefore;
    }
    // Отказ снимает ожидание, но окно подхвата не трогает: если ход уже кончился,
    // его закроет окно, а не вечное ожидание потока.
    if (!accepted) this.awaitingSteers = Math.max(0, this.awaitingSteers - 1);
    return accepted;
  }

  stop(): void {
    this.active = false;
    this.abort.abort();
    if (this.child) killChildTree(this.child);
  }

  /** Поток событий до конца ВСЕХ ходов этого прогона: исходного и начатых из подхваченного. */
  private async consume(
    body: ReadableStream<Uint8Array>,
    promptId: string,
    timeoutMs: number,
    onDelta: (text: string) => void,
  ): Promise<LiveTurnResult> {
    const open = new Set([promptId]);
    let lastPrompt = promptId;
    const timer = setTimeout(() => {
      this.timedOut = true;
      this.abort.abort();
    }, timeoutMs);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut = buffer.indexOf('\n');
        while (cut >= 0) {
          const line = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 1);
          cut = buffer.indexOf('\n');
          if (!line.startsWith('data:')) continue;
          let event: QwenEvent;
          try {
            event = JSON.parse(line.slice(5)) as QwenEvent;
          } catch {
            continue;
          }
          const data = event.data ?? {};
          // Продолженная сессия: события её прежних ходов — не ответ этого.
          if (
            this.resumed &&
            event.promptId &&
            !open.has(event.promptId) &&
            event.type !== 'pending_prompt_started'
          ) {
            continue;
          }
          switch (event.type) {
            case 'session_update': {
              const update = data.update as
                { sessionUpdate?: string; content?: { text?: string } } | undefined;
              if (update?.sessionUpdate !== 'agent_message_chunk') break;
              const text = update.content?.text ?? '';
              if (!text) break;
              // Ответ на начатый из подхваченного сообщения — с новой строки.
              if (event.promptId && event.promptId !== lastPrompt && this.reply.trim()) {
                this.reply += '\n\n';
                onDelta('\n\n');
              }
              if (event.promptId) lastPrompt = event.promptId;
              this.reply += text;
              onDelta(text);
              break;
            }
            case 'pending_prompt_started':
              if (event.promptId) open.add(event.promptId);
              this.picked();
              break;
            case 'mid_turn_message_injected':
              this.picked();
              // Подхвачено уже кончившимся ходом и нового запроса нет — ждать нечего.
              if (open.size === 0 && this.awaitingSteers === 0) {
                this.active = false;
                return { kind: 'done', reply: this.reply.trim() };
              }
              break;
            case 'permission_request':
              void this.answerPermission(data);
              break;
            case 'turn_error':
            case 'stream_error':
              return { kind: 'error', error: String(data.message ?? 'Ход завершился ошибкой') };
            case 'turn_complete':
              open.delete(String(data.promptId ?? event.promptId ?? ''));
              if (open.size === 0 && this.awaitingSteers > 0) {
                // Принятое ещё не подхвачено — ждём его недолго, потом закрываемся тем, что есть.
                clearTimeout(this.graceTimer);
                this.graceTimer = setTimeout(() => {
                  this.graceOver = true;
                  this.abort.abort();
                }, this.graceMs);
              }
              if (open.size === 0 && this.awaitingSteers === 0) {
                this.active = false;
                // Пустой ход после отказа — отказ человека, а не молчание CLI. Ошибкой,
                // а не ответом: слов модели не было, и сессия уходит в удаление, а не
                // остаётся на диске Qwen сиротой, которую панель уже не продолжит.
                if (!this.reply.trim() && this.refused !== undefined) {
                  return { kind: 'error', error: refusedText(this.refused) };
                }
                return { kind: 'done', reply: this.reply.trim() };
              }
              break;
            default:
              break;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(this.graceTimer);
    }
    if (this.timedOut) return { kind: 'error', error: 'CLI не ответил за отведённое время' };
    return this.reply.trim()
      ? { kind: 'done', reply: this.reply.trim() }
      : { kind: 'error', error: 'qwen serve закрыл поток' };
  }

  /**
   * Принятое сообщение подхвачено: ожидание по нему снято. Иначе таймер ожидания,
   * взведённый концом прошлого хода, оборвал бы начатый из сообщения ответ.
   */
  private picked(): void {
    this.pickedTotal += 1;
    this.awaitingSteers = Math.max(0, this.awaitingSteers - 1);
    if (this.awaitingSteers === 0) clearTimeout(this.graceTimer);
  }

  /** Ответ на просьбу о разрешении: по политике хода, без политики — отказ. */
  private async answerPermission(data: Record<string, unknown>): Promise<void> {
    const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
    if (!requestId || !this.sessionId) return;
    const options = Array.isArray(data.options) ? (data.options as PermissionOption[]) : [];
    const toolCall = data.toolCall as { title?: string; kind?: string } | undefined;
    const decision = await decidePermission(this.permission, {
      cli: 'qwen',
      requestId,
      ...(toolCall?.kind ? { tool: toolCall.kind } : {}),
      ...(toolCall?.title ? { title: toolCall.title } : {}),
    });
    const optionId = pickOption(options, decision);
    // Нет варианта под решение — `cancelled`: для CLI это отказ, «да» не выдумываем.
    const outcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    if (decision === 'deny' || !optionId) {
      this.refused = [toolCall?.kind, toolCall?.title].filter(Boolean).join(' ');
    }
    try {
      await this.json('POST', `/session/${this.sessionId}/permission/${requestId}`, {
        outcome,
      });
    } catch {
      // Сервер ушёл — ход закончится событием или таймаутом.
    }
  }

  private async waitHealthy(exited: () => boolean): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < HEALTH_MS && !exited() && !this.abort.signal.aborted) {
      try {
        const res = await this.fetchImpl(`${this.base}/health`, { signal: this.abort.signal });
        if (res.ok) return true;
      } catch {
        // Ещё не слушает.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  /**
   * Ждёт, пока qwen поднимет серверы MCP. 0.25 поднимает их фоном ПОСЛЕ ответа на
   * POST /session, а serve живёт один ответ: промпт, ушедший сразу, не видел ни
   * одного медленного сервера (переходник Jira, npx) ни в одном ходе. Сигнал —
   * `discoveryState` в `GET /workspace/mcp`. Зависший сервер держит `in_progress`
   * вечно, поэтому ожидание с потолком: после него ход идёт с поднявшимися.
   * Блокирующее обнаружение (`QWEN_CODE_LEGACY_MCP_BLOCKING=1`) не годится: с
   * зависшим сервером POST /session отвечает 504 и ход теряется целиком.
   */
  private async waitMcpDiscovery(): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < this.mcpWaitMs && !this.abort.signal.aborted) {
      try {
        const res = await this.fetchImpl(`${this.base}/workspace/mcp`, {
          signal: this.abort.signal,
        });
        // Нет маршрута (другая версия CLI) — ждать нечего.
        if (!res.ok) return;
        const state = ((await res.json()) as { discoveryState?: unknown }).discoveryState;
        if (state !== 'in_progress') return;
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, MCP_POLL_MS));
    }
  }

  private async json(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abort.signal,
    });
    const parsed = (await res.json().catch(() => undefined)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  }

  /**
   * Поднять сессию разговора в этом процессе. `false` — сессии нет (удалена,
   * другой дом Qwen) или сервер отказал: ход откроет новую.
   */
  private async resume(id: string, workspace: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/session/${id}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: workspace, approvalMode: APPROVAL_MODE }),
        signal: this.abort.signal,
      });
      await res.body?.cancel().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Закрыть сессию в процессе и убрать в архив Qwen; ошибки — не повод держать ход. */
  private async remove(id: string): Promise<void> {
    const signal = AbortSignal.timeout(DELETE_MS);
    const send = (method: string, path: string, body?: unknown) =>
      this.fetchImpl(`${this.base}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal,
      })
        .then((res) => res.body?.cancel())
        .catch(() => undefined);
    await send('DELETE', `/session/${id}`);
    await send('POST', '/sessions/archive', { sessionIds: [id] });
  }

  /**
   * Конец прогона. Сессию, которую продолжит следующий ход, оставляем; ту же
   * сессию после хода без ответа — удаляем. Одноразовую (без `session`) сервер
   * уносит с собой, как и раньше.
   */
  private async close(result: LiveTurnResult): Promise<LiveTurnResult> {
    this.active = false;
    this.abort.abort();
    const sessionId = this.sessionId;
    const kept = this.keep && sessionId !== undefined && result.kind === 'done';
    if (this.keep && sessionId && !kept) await this.remove(sessionId);
    if (this.child) killChildTree(this.child);
    return kept ? { ...result, session: sessionId, resumed: this.resumed } : result;
  }
}
