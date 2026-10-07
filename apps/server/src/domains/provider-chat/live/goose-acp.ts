import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnCliProcess } from '../../../lib/cli-spawn.ts';
import { killChildTree } from '../../../lib/process-tree.ts';
import { StdioRpc, type RpcIncoming } from './stdio-rpc.ts';
import { decidePermission, pickOption, type PermissionOption } from './permission.ts';
import type { LiveTurn, LiveTurnOptions, LiveTurnResult } from './types.ts';

/**
 * Goose через `goose acp` (Agent Client Protocol, JSON-RPC по stdio) — на один ответ.
 *
 * Сняты с самого CLI (1.53.0) живым прогоном на заглушке модели: `initialize` →
 * `session/new` → `session/prompt`, ответ на который приходит концом хода
 * (`stopReason`); текст — уведомления `session/update` с `agent_message_chunk`.
 * Второй `session/prompt` в идущий ход Goose отклоняет и сам называет вход
 * посреди хода — `_goose/unstable/session/steer` с `expectedRunId` (id хода из
 * `session_info_update`). Принятое встаёт в ТОТ ЖЕ ход, даже пришедшее во время
 * последнего ответа модели; устаревший id — отказ, и сообщение уходит в очередь.
 * Метод помечен unstable: пропал — `steer` отвечает `false`, ответ не страдает.
 *
 * Как у `goose run --no-session`: разговор держит панель, поэтому сессия Goose
 * по концу хода удаляется (`session/delete`) и в его списке не копится. Права —
 * режим из настроек самого Goose; его просьба `session/request_permission`
 * решается переключателем чата (`permission`): правки разрешены — «да», нет —
 * вопрос человеку. Без политики — отказ, как у неинтерактивного запуска.
 *
 * Но в режиме `auto` (у Goose он по умолчанию) просьб нет ВОВСЕ — инструмент
 * правки выполняется молча (снято на 1.53). Поэтому без разрешённых правок
 * сессия переводится в `approve` (ACP `session/set_mode`; режим живёт в сессии,
 * config.yaml человека не меняется — тоже снято). `approve` и `chat` строже —
 * их не трогаем. Сменить не удалось — ход не начинается (`unavailable`), и
 * разговор идёт одиночным запуском с `GOOSE_MODE=chat`.
 */

const HANDSHAKE_MS = 20_000;
/** Сколько ждать удаления сессии и мягкой отмены, прежде чем снять процесс. */
const CLOSE_MS = 3_000;
const STEER_METHOD = '_goose/unstable/session/steer';
/** Режимы, в которых правка без вопроса невозможна: `approve` спрашивает, `chat` не зовёт инструменты. */
const GUARDED_MODES = new Set(['approve', 'chat']);

export class GooseAcpTurn implements LiveTurn {
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: StdioRpc;
  private sessionId?: string;
  private runId?: string;
  private active = false;
  private stopped = false;

  run(
    options: LiveTurnOptions,
    onDelta: (text: string) => void,
    onSteerable?: () => void,
  ): Promise<LiveTurnResult> {
    const workdir = options.workdir ?? process.cwd();
    const spawned = spawnCliProcess(options.command, ['acp'], {
      spawnImpl: options.spawnImpl,
      cwd: workdir,
      ...(options.env && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
      ...(options.portableEnv ? { portableEnv: options.portableEnv } : {}),
    });
    if (spawned.error) return Promise.resolve({ kind: 'unavailable', why: spawned.error.message });
    const child = spawned.child;
    this.child = child;

    return new Promise<LiveTurnResult>((resolve) => {
      let settled = false;
      let started = false;
      let reply = '';
      // Подхваченное сообщение человека: ответ на него — с новой строки.
      let separate = false;
      let stderr = '';
      const finish = (result: LiveTurnResult): void => {
        if (settled) return;
        settled = true;
        this.active = false;
        clearTimeout(timer);
        void this.close(child).then(() => resolve(result));
      };
      const timer = setTimeout(
        () => finish({ kind: 'error', error: 'CLI не ответил за отведённое время' }),
        options.timeoutMs,
      );

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });
      child.on('error', (error) =>
        finish(
          started
            ? { kind: 'error', error: error.message }
            : { kind: 'unavailable', why: error.message },
        ),
      );
      child.on('close', (code) => {
        if (!started) {
          finish({ kind: 'unavailable', why: stderr.trim().slice(-300) || `код ${code}` });
          return;
        }
        finish(
          reply.trim()
            ? { kind: 'done', reply: reply.trim() }
            : {
                kind: 'error',
                error: stderr.trim().slice(-500) || `CLI завершился с кодом ${code}`,
              },
        );
      });

      const onNotification = (message: RpcIncoming): void => {
        if (message.method !== 'session/update') return;
        const update = message.params?.update as
          | {
              sessionUpdate?: string;
              content?: { type?: string; text?: string };
              _meta?: { goose?: { activeRunId?: string | null } };
            }
          | undefined;
        switch (update?.sessionUpdate) {
          case 'session_info_update': {
            const runId = update._meta?.goose?.activeRunId;
            // `null` — ход кончился: сообщение больше некуда подхватывать.
            if (runId === null) this.active = false;
            if (typeof runId !== 'string' || settled) return;
            this.runId = runId;
            if (!this.active && started && !this.stopped) {
              this.active = true;
              onSteerable?.();
            }
            return;
          }
          case 'user_message_chunk':
            separate = true;
            return;
          case 'agent_message_chunk': {
            const text = update.content?.type === 'text' ? (update.content.text ?? '') : '';
            if (!text) return;
            if (separate && reply.trim()) {
              reply += '\n\n';
              onDelta('\n\n');
            }
            separate = false;
            reply += text;
            onDelta(text);
            return;
          }
          default:
            return;
        }
      };

      const rpc = new StdioRpc(child, {
        onNotification,
        onRequest: (message) => {
          if (message.method === 'session/request_permission') {
            const choices = Array.isArray(message.params?.options)
              ? (message.params.options as PermissionOption[])
              : [];
            const toolCall = message.params?.toolCall as
              { toolCallId?: string; title?: string; kind?: string } | undefined;
            void decidePermission(options.permission, {
              cli: 'goose',
              requestId: toolCall?.toolCallId ?? String(message.id),
              ...(toolCall?.kind ? { tool: toolCall.kind } : {}),
              ...(toolCall?.title ? { title: toolCall.title } : {}),
            }).then((decision) => {
              const optionId = pickOption(choices, decision);
              rpc.respond(message.id, {
                result: {
                  outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
                },
              });
            });
            return;
          }
          // Файлы и терминал клиента мы не объявляли — Goose их и не спросит.
          rpc.respond(message.id, {
            error: { code: -32601, message: 'not supported by agentdeck' },
          });
        },
      });
      this.rpc = rpc;

      void (async () => {
        const init = await rpc.call(
          'initialize',
          {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          },
          HANDSHAKE_MS,
        );
        if (!init?.result) {
          finish({ kind: 'unavailable', why: init?.error?.message ?? 'initialize не ответил' });
          return;
        }
        const session = await rpc.call('session/new', { cwd: workdir, mcpServers: [] });
        const sessionId = session?.result?.sessionId;
        if (typeof sessionId !== 'string') {
          finish({ kind: 'unavailable', why: session?.error?.message ?? 'session/new без id' });
          return;
        }
        this.sessionId = sessionId;
        if (!options.permission?.allowEdits) {
          const modes = session?.result?.modes as { currentModeId?: unknown } | undefined;
          const current = typeof modes?.currentModeId === 'string' ? modes.currentModeId : '';
          if (!GUARDED_MODES.has(current)) {
            const set = await rpc.call('session/set_mode', { sessionId, modeId: 'approve' });
            if (!set?.result) {
              finish({
                kind: 'unavailable',
                why: set?.error?.message ?? 'session/set_mode не ответил',
              });
              return;
            }
          }
        }
        started = true;
        // Ход мог объявить свой id раньше, чем вернулся session/new: вход открываем здесь.
        if (this.runId && !this.stopped && !settled) {
          this.active = true;
          onSteerable?.();
        }
        const prompt = await rpc.call(
          'session/prompt',
          { sessionId, prompt: [{ type: 'text', text: options.prompt }] },
          options.timeoutMs,
        );
        if (prompt?.error) {
          finish({ kind: 'error', error: prompt.error.message ?? 'Goose не начал ход' });
          return;
        }
        if (!prompt) return; // таймаут или процесс ушёл — итог скажут timer/close
        const stopReason = prompt.result?.stopReason;
        if (reply.trim() || this.stopped || stopReason === 'cancelled') {
          finish({ kind: 'done', reply: reply.trim() });
          return;
        }
        finish({ kind: 'error', error: `Goose закончил ход без ответа (${String(stopReason)})` });
      })();
    });
  }

  async steer(text: string): Promise<boolean> {
    if (!this.active || !this.sessionId || !this.runId || !this.rpc) return false;
    const reply = await this.rpc.call(STEER_METHOD, {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
      expectedRunId: this.runId,
    });
    return Boolean(reply?.result);
  }

  /** Мягкая отмена: ход кончается `cancelled`, сессия удаляется, процесс снимается. */
  stop(): void {
    this.stopped = true;
    this.active = false;
    if (this.sessionId) this.rpc?.notify('session/cancel', { sessionId: this.sessionId });
    const child = this.child;
    if (child) setTimeout(() => killChildTree(child), CLOSE_MS).unref?.();
  }

  private async close(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.sessionId && this.rpc && child.exitCode === null) {
      await this.rpc.call('session/delete', { sessionId: this.sessionId }, CLOSE_MS);
    }
    killChildTree(child);
  }
}
