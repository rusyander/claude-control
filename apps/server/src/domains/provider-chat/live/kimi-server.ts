import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnCliProcess } from '../../../lib/cli-spawn.ts';
import { killChildTree } from '../../../lib/process-tree.ts';
import { freePort } from '../../opencode-serve.ts';
import { decidePermission } from './permission.ts';
import type { LivePermissionPolicy, LiveTurn, LiveTurnOptions, LiveTurnResult } from './types.ts';

/**
 * Kimi Code через `kimi web` (локальный HTTP-сервер) — на один ответ.
 *
 * Пути сняты с самого CLI (2.1.1) живым прогоном на заглушке модели; ответы в
 * конверте `{code, msg, data}`, `code ≠ 0` — ошибка при HTTP 200. Токен сервер
 * печатает в stdout (`#token=…`), дальше — `Authorization: Bearer`.
 * `POST /sessions` → `POST /sessions/:id/prompts` (модель — в КАЖДОМ запросе:
 * `default_model` из конфига сервер сам не подставляет, берём его из
 * `GET /config`). Сообщение посреди хода — тот же `POST …/prompts`: занятая
 * сессия ставит его в очередь, а `POST …/prompts:steer` вливает в идущий ход —
 * модель видит его в этом же ходе, второго хода нет. Ход успел кончиться — CLI
 * начинает сообщение следующим ходом той же сессии, и прогон ждёт и его.
 *
 * У ACP (`kimi acp`) входа посреди хода нет: второй `session/prompt` получает
 * `turn.agent_busy`. Потому — серверный режим.
 *
 * Конец хода — `busy: false` и пустая очередь; ответ — тексты ассистента этой
 * (свежей) сессии по порядку. Права — по переключателю чата (`permission`):
 * ждущее разрешение (`pending_interaction: approval`) получает `approved`, если
 * правки разрешены, иначе ответ человека; без политики — `rejected`, как у
 * неинтерактивного запуска. Сессия по концу удаляется — переписку держит панель.
 */

const READY_MS = 30_000;
const POLL_MS = 300;
/** Удаление сессии по концу прогона — своим сроком: сигнал прогона к нему уже оборван. */
const DELETE_MS = 2_000;
const STOP_KILL_MS = DELETE_MS + 1_000;

interface KimiMessage {
  readonly id?: string;
  readonly role?: string;
  readonly content?: { type?: string; text?: string }[];
}

interface KimiSession {
  readonly busy?: boolean;
  readonly pending_interaction?: string;
  readonly last_turn_reason?: string;
}

export class KimiServerTurn implements LiveTurn {
  private child?: ChildProcessWithoutNullStreams;
  private base?: string;
  private token?: string;
  private sessionId?: string;
  private model?: string;
  private active = false;
  private timedOut = false;
  /** Отправка сообщения посреди хода ещё не получила ответа — конец хода ждёт её. */
  private inflight = 0;
  /** Тексты ассистента по id сообщения — в порядке появления. */
  private readonly texts = new Map<string, string>();
  private readonly abort = new AbortController();
  private fetchImpl: typeof fetch = fetch;
  private readonly pollMs: number;
  private permission?: LivePermissionPolicy;
  /** Разрешения, по которым ответ уже в пути (вопрос человеку ждёт) — второй раз не спрашиваем. */
  private readonly answering = new Set<string>();

  /** `pollMs` — подмена шага опроса для тестов; в работе — `POLL_MS`. */
  constructor(options: { pollMs?: number } = {}) {
    this.pollMs = options.pollMs ?? POLL_MS;
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
    const spawned = spawnCliProcess(options.command, ['web', '--port', String(port), '--no-open'], {
      spawnImpl: options.spawnImpl,
      cwd: workspace,
      ...(options.env && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
      ...(options.portableEnv ? { portableEnv: options.portableEnv } : {}),
    });
    if (spawned.error) return { kind: 'unavailable', why: spawned.error.message };
    this.child = spawned.child;
    let exited = false;
    let output = '';
    const collect = (chunk: Buffer): void => {
      if (!this.token) output += chunk.toString('utf8');
    };
    this.child.stdout?.on('data', collect);
    this.child.stderr?.on('data', collect);
    this.child.on('close', () => {
      exited = true;
    });
    this.child.on('error', () => {
      exited = true;
    });
    this.base = `http://127.0.0.1:${port}/api/v1`;

    const timer = setTimeout(() => {
      this.timedOut = true;
      this.abort.abort();
    }, options.timeoutMs);
    try {
      if (
        !(await this.waitReady(
          () => output,
          () => exited,
        ))
      ) {
        return await this.close({ kind: 'unavailable', why: 'kimi web не поднялся' });
      }
      const config = await this.call('GET', '/config');
      this.model =
        options.model ??
        (typeof config?.default_model === 'string' && config.default_model
          ? config.default_model
          : undefined);
      if (!this.model) {
        return await this.close({ kind: 'unavailable', why: 'в конфиге Kimi нет default_model' });
      }
      const created = await this.call('POST', '/sessions', { metadata: { cwd: workspace } });
      const sessionId = typeof created?.id === 'string' ? created.id : undefined;
      if (!sessionId) return await this.close({ kind: 'unavailable', why: 'сессия без id' });
      this.sessionId = sessionId;

      await this.prompt(options.prompt);
      this.active = true;
      onSteerable?.();

      return await this.close(await this.follow(onDelta));
    } catch (error) {
      if (this.timedOut) {
        return await this.close({ kind: 'error', error: 'CLI не ответил за отведённое время' });
      }
      if (this.abort.signal.aborted && !this.active) {
        return await this.close({ kind: 'done', reply: this.reply() });
      }
      const text = error instanceof Error ? error.message : String(error);
      return await this.close(
        this.active ? { kind: 'error', error: text } : { kind: 'unavailable', why: text },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async steer(text: string): Promise<boolean> {
    if (!this.active || !this.sessionId) return false;
    this.inflight += 1;
    try {
      const sent = await this.prompt(text);
      // В очереди — вливаем в идущий ход. Отказ здесь значит, что ход кончился
      // между двумя запросами: тогда CLI начнёт сообщение следующим ходом сам.
      if (sent.status === 'queued') {
        await this.call('POST', `/sessions/${this.sessionId}/prompts:steer`, {
          prompt_ids: [sent.promptId],
        }).catch(() => undefined);
      }
      return true;
    } catch {
      return false;
    } finally {
      this.inflight -= 1;
    }
  }

  /**
   * Отмена обрывает запросы прогона; сам прогон по ней удаляет сессию и гасит
   * сервер (`close`), напечатанное остаётся ответом. Сервер, не отпущенный за
   * `STOP_KILL_MS`, гасится отсюда.
   */
  stop(): void {
    this.active = false;
    this.abort.abort();
    const child = this.child;
    if (child) setTimeout(() => killChildTree(child), STOP_KILL_MS).unref();
  }

  private async prompt(text: string): Promise<{ promptId: string; status: string }> {
    const data = await this.call('POST', `/sessions/${this.sessionId}/prompts`, {
      content: [{ type: 'text', text }],
      model: this.model,
    });
    const promptId = typeof data?.prompt_id === 'string' ? data.prompt_id : undefined;
    if (!promptId) throw new Error('prompt без prompt_id');
    return { promptId, status: String(data?.status ?? '') };
  }

  /** Опрос сессии до конца ВСЕХ ходов прогона: исходного и начатых из сообщений. */
  private async follow(onDelta: (text: string) => void): Promise<LiveTurnResult> {
    const id = this.sessionId!;
    for (;;) {
      await this.sleep(this.pollMs);
      const session = (await this.call('GET', `/sessions/${id}`)) as KimiSession | undefined;
      await this.collect(onDelta);
      if (session?.pending_interaction === 'approval') await this.answerApprovals();
      if (session?.busy) continue;
      const prompts = await this.call('GET', `/sessions/${id}/prompts`);
      const queued = Array.isArray(prompts?.queued) ? prompts.queued.length : 0;
      // Отправка в пути: сессия уже простаивает, а сообщение ещё не дошло.
      if (prompts?.active || queued > 0 || this.inflight > 0) continue;
      await this.collect(onDelta);
      this.active = false;
      if (session?.last_turn_reason === 'failed' && !this.reply()) {
        return { kind: 'error', error: (await this.failure()) ?? 'Ход завершился ошибкой' };
      }
      return { kind: 'done', reply: this.reply() };
    }
  }

  /** Новые и дописанные тексты ассистента → дельты; между сообщениями — пустая строка. */
  private async collect(onDelta: (text: string) => void): Promise<void> {
    const data = await this.call(
      'GET',
      `/sessions/${this.sessionId}/messages?role=assistant&page_size=100`,
    );
    const items = Array.isArray(data?.items) ? (data.items as KimiMessage[]) : [];
    // Сервер отдаёт новые первыми.
    for (const message of [...items].reverse()) {
      if (!message.id) continue;
      const text = (message.content ?? [])
        .filter((part) => part.type === 'text' && part.text)
        .map((part) => part.text)
        .join('');
      if (!text) continue;
      const before = this.texts.get(message.id);
      if (before === undefined) {
        const lead = this.reply() ? '\n\n' : '';
        this.texts.set(message.id, text);
        onDelta(lead + text);
      } else if (text.length > before.length && text.startsWith(before)) {
        this.texts.set(message.id, text);
        onDelta(text.slice(before.length));
      }
    }
  }

  private reply(): string {
    return [...this.texts.values()].join('\n\n').trim();
  }

  /**
   * Ответ на ждущие разрешения — по политике хода. Вопрос человеку не держит
   * опрос: текст ответа продолжает приходить, пока человек думает.
   */
  private async answerApprovals(): Promise<void> {
    // `status=pending` обязателен (Server API; без него 2.1.1 отвечает конвертом
    // с ошибкой, и ход падал на первой же просьбе о разрешении).
    const data = await this.call('GET', `/sessions/${this.sessionId}/approvals?status=pending`);
    const items = Array.isArray(data?.items)
      ? (data.items as { approval_id?: string; tool_name?: string }[])
      : [];
    for (const item of items) {
      const id = item.approval_id;
      if (!id || this.answering.has(id)) continue;
      this.answering.add(id);
      void decidePermission(this.permission, {
        cli: 'kimi',
        requestId: id,
        ...(item.tool_name ? { tool: item.tool_name } : {}),
      })
        .then((decision) =>
          this.call('POST', `/sessions/${this.sessionId}/approvals/${id}`, {
            decision: decision === 'allow' ? 'approved' : 'rejected',
          }),
        )
        .catch(() => undefined);
    }
  }

  /** Текст провала хода — последнее системное сообщение сессии, если оно есть. */
  private async failure(): Promise<string | undefined> {
    const data = await this.call(
      'GET',
      `/sessions/${this.sessionId}/messages?role=system&page_size=1`,
    ).catch(() => undefined);
    const item = Array.isArray(data?.items)
      ? (data.items[0] as KimiMessage | undefined)
      : undefined;
    const text = (item?.content ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    return text || undefined;
  }

  private async waitReady(output: () => string, exited: () => boolean): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < READY_MS && !exited() && !this.abort.signal.aborted) {
      this.token ??= /#token=([A-Za-z0-9_-]+)/.exec(output())?.[1];
      if (this.token) {
        try {
          await this.call('GET', '/healthz');
          return true;
        } catch {
          // Ещё не слушает.
        }
      }
      await this.sleep(250);
    }
    return false;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    signal: AbortSignal = this.abort.signal,
  ): Promise<Record<string, unknown> | undefined> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token ?? ''}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const parsed = (await res.json().catch(() => undefined)) as
      { code?: number; msg?: string; data?: unknown } | undefined;
    if (!res.ok || !parsed || parsed.code !== 0) {
      // Сервер жив, но отказал: ошибки идут HTTP 200 с `code ≠ 0`.
      throw new Error(`${method} ${path}: ${parsed?.msg ?? `HTTP ${res.status}`}`);
    }
    return parsed.data && typeof parsed.data === 'object'
      ? (parsed.data as Record<string, unknown>)
      : undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.abort.signal.aborted) return reject(new Error('aborted'));
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }

  /** Сессию удаляем (переписку держит панель), сервер гасим — ответ уже собран. */
  private async close(result: LiveTurnResult): Promise<LiveTurnResult> {
    this.active = false;
    this.abort.abort();
    if (this.sessionId) {
      await this.call(
        'POST',
        `/sessions/${this.sessionId}:delete`,
        undefined,
        AbortSignal.timeout(DELETE_MS),
      ).catch(() => undefined);
    }
    if (this.child) killChildTree(this.child);
    return result;
  }
}
