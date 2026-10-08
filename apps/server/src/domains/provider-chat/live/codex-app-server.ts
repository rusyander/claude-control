import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnCliProcess } from '../../../lib/cli-spawn/cli-spawn.ts';
import { killChildTree } from '../../../lib/process-tree/process-tree.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { withCodexKit } from '../../kit/codex.ts';
import { openCodexThread, startCodexTurn, steerCodexTurn } from './codex-session.ts';
import { decidePermission } from './permission.ts';
import { StdioRpc, type RpcIncoming } from './stdio-rpc.ts';
import type { LivePermissionPolicy, LiveTurn, LiveTurnOptions, LiveTurnResult } from './types.ts';

/**
 * Codex через `codex app-server` (JSON-RPC строками по stdio) — на один ответ.
 *
 * Форма протокола взята из привязок, которые печатает сам CLI
 * (`codex app-server generate-ts`, 0.160.0): `initialize` → `thread/start` →
 * `turn/start`; текст идёт уведомлениями `item/agentMessage/delta`, конец —
 * `turn/completed`. Вход посреди хода — `turn/steer` с `expectedTurnId`: ход,
 * успевший кончиться, отвечает ошибкой «no active turn to steer», и сообщение
 * уходит в очередь панели. Проверено живым прогоном настоящего CLI на заглушке
 * модели (`tools/qa/check-foreign-steer.mjs`).
 *
 * Права — по «Разрешить правки» разговора (`permission`), параметрами
 * `thread/start` из привязок 0.160 (`sandbox`, `approvalPolicy`): включено —
 * `workspace-write` без вопросов (на Windows — `untrusted`, и «да» отвечает
 * панель, см. `codexThreadRights`); выключено — `read-only` + `untrusted`, и
 * каждая просьба сервера (`item/commandExecution|fileChange|permissions/
 * requestApproval`) идёт человеку. Без политики — как `codex exec`: песочница
 * из настроек, вопросов нет. Поток ephemeral — на диск Codex разговор не пишет.
 */

/** Параметры прав `thread/start` под политику хода; без политики — `never`, как раньше. */
export function codexThreadRights(
  policy: LivePermissionPolicy | undefined,
  platform: NodeJS.Platform = process.platform,
): { approvalPolicy: 'never' | 'untrusted'; sandbox?: 'workspace-write' | 'read-only' } {
  if (!policy) return { approvalPolicy: 'never' };
  // Windows: `workspace-write` без настроенной песочницы Windows (`windowsSandbox/
  // setupStart`, нужен администратор) отклоняет любую команду — «rejected: blocked
  // by policy», а `windows.sandbox = "unelevated"` отказывает «cannot enforce split
  // writable root sets» (оба — живой прогон 0.160). Поэтому там «включено» = тот же
  // `untrusted`, что и «выключено», а «да» на каждую просьбу отвечает сама панель
  // (`decidePermission`): правки идут, карточек нет.
  if (policy.allowEdits && platform !== 'win32') {
    return { approvalPolicy: 'never', sandbox: 'workspace-write' };
  }
  return { approvalPolicy: 'untrusted', sandbox: 'read-only' };
}

/** Убрать `null` из профиля прав: в ответе поля необязательные, `null` там не предусмотрен. */
function grantedProfile(requested: unknown): Record<string, unknown> {
  if (!requested || typeof requested !== 'object') return {};
  return Object.fromEntries(
    Object.entries(requested as Record<string, unknown>).filter(([, value]) => value != null),
  );
}

/**
 * Ответ на вопрос сервера о разрешении — форма по методу (привязки 0.160).
 * `undefined` — метод не о разрешении: на него отвечает отказ «не поддержано».
 */
export async function answerCodexApproval(
  message: RpcIncoming,
  policy: LivePermissionPolicy | undefined,
): Promise<unknown> {
  const params = (message.params ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const ask = (tool: string, title: string | undefined) =>
    decidePermission(policy, {
      cli: 'codex',
      requestId: String(message.id ?? ''),
      tool,
      ...(title ? { title } : {}),
    });
  switch (message.method) {
    case 'item/commandExecution/requestApproval': {
      const decision = await ask('command', text(params.command) ?? text(params.reason));
      return { decision: decision === 'allow' ? 'accept' : 'decline' };
    }
    case 'item/fileChange/requestApproval': {
      const decision = await ask('fileChange', text(params.reason) ?? text(params.grantRoot));
      return { decision: decision === 'allow' ? 'accept' : 'decline' };
    }
    case 'item/permissions/requestApproval': {
      const decision = await ask('permissions', text(params.reason));
      return decision === 'allow'
        ? { permissions: grantedProfile(params.permissions), scope: 'turn' }
        : { permissions: {}, scope: 'turn' };
    }
    case 'execCommandApproval':
    case 'applyPatchApproval': {
      const command = Array.isArray(params.command) ? params.command.join(' ') : undefined;
      const decision = await ask(
        message.method === 'execCommandApproval' ? 'command' : 'fileChange',
        command ?? text(params.reason),
      );
      return {
        decision:
          decision === 'allow' ? 'approved' : { denied: { rejection: 'declined in agentdeck' } },
      };
    }
    default:
      return undefined;
  }
}

export class CodexAppServerTurn implements LiveTurn {
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: StdioRpc;
  private threadId?: string;
  private turnId?: string;
  private active = false;

  run(
    options: LiveTurnOptions,
    onDelta: (text: string) => void,
    onSteerable?: () => void,
  ): Promise<LiveTurnResult> {
    // Набор панели (В2): правила — ключом запуска, навыки — корнем после рукопожатия.
    const kit = withCodexKit(['app-server'], options.env, 'appServer');
    if (kit.missing || kit.refusal)
      return Promise.resolve({
        kind: 'error',
        error: kit.refusal ?? serverText('kit-compose-failed'),
      });
    const spawned = spawnCliProcess(options.command, kit.args, {
      spawnImpl: options.spawnImpl,
      ...(options.workdir ? { cwd: options.workdir } : {}),
      ...(kit.env && Object.keys(kit.env).length > 0 ? { env: kit.env } : {}),
      ...(options.portableEnv ? { portableEnv: options.portableEnv } : {}),
    });
    if (spawned.error) return Promise.resolve({ kind: 'unavailable', why: spawned.error.message });
    const child = spawned.child;
    this.child = child;

    return new Promise<LiveTurnResult>((resolve) => {
      let settled = false;
      let reply = '';
      let started = false;
      let lastError = '';
      let stderr = '';
      const finish = (result: LiveTurnResult): void => {
        if (settled) return;
        settled = true;
        this.active = false;
        clearTimeout(timer);
        killChildTree(child);
        resolve(result);
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
        if (started) {
          finish(
            reply.trim()
              ? { kind: 'done', reply: reply.trim() }
              : {
                  kind: 'error',
                  error: lastError || stderr.trim().slice(-500) || `CLI завершился с кодом ${code}`,
                },
          );
        } else finish({ kind: 'unavailable', why: stderr.trim().slice(-300) || `код ${code}` });
      });

      const onNotification = (message: RpcIncoming): void => {
        const params = message.params ?? {};
        switch (message.method) {
          case 'item/started': {
            const item = params.item as { type?: string } | undefined;
            // Второе сообщение модели в том же ходе (после подхваченного текста) —
            // с новой строки, а не слитно с первым.
            if (item?.type === 'agentMessage' && reply.trim()) {
              reply += '\n\n';
              onDelta('\n\n');
            }
            return;
          }
          case 'item/agentMessage/delta': {
            const delta = typeof params.delta === 'string' ? params.delta : '';
            if (!delta) return;
            reply += delta;
            onDelta(delta);
            return;
          }
          case 'error': {
            const error = params.error as { message?: string } | undefined;
            lastError = error?.message ?? lastError;
            return;
          }
          case 'turn/completed': {
            const turn = params.turn as
              { status?: string; error?: { message?: string } | null } | undefined;
            if (turn?.status === 'failed') {
              finish({
                kind: 'error',
                error: turn.error?.message || lastError || 'Ход завершился ошибкой',
              });
              return;
            }
            finish({ kind: 'done', reply: reply.trim() });
            return;
          }
          default:
            return;
        }
      };
      const rpc = new StdioRpc(
        child,
        {
          onNotification,
          // Вопрос сервера о разрешении — по политике хода (ответ асинхронный:
          // поток уведомлений не ждёт человека). Прочие вопросы — отказ.
          onRequest: (message) => {
            void answerCodexApproval(message, options.permission).then((result) =>
              rpc.respond(
                message.id,
                result === undefined
                  ? { error: { code: -32601, message: 'not supported by agentdeck' } }
                  : { result },
              ),
            );
          },
        },
        { jsonrpcField: false },
      );
      this.rpc = rpc;

      void (async () => {
        const opened = await openCodexThread(rpc, {
          skillRoots: kit.skillRoots,
          thread: {
            ...(options.workdir ? { cwd: options.workdir } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...codexThreadRights(options.permission),
            ephemeral: true,
          },
        });
        // Не поднялся поток или не приняты корни навыков — уходим на одиночный
        // запуск, где навыки идут списком: ход без навыков набора был бы
        // молчаливой подменой режима.
        if (!opened.ok) {
          finish({ kind: 'unavailable', why: opened.why });
          return;
        }
        const threadId = opened.threadId;
        this.threadId = threadId;
        const turn = await startCodexTurn(rpc, threadId, options.prompt, options.effort);
        if (!turn.ok) {
          // Ход отказан самим CLI (модель, вход) — это ответ человеку, а не повод
          // молча перезапускать одиночным запуском с той же ошибкой.
          finish({ kind: 'error', error: turn.error ?? 'Codex не начал ход' });
          return;
        }
        const turnId = turn.turnId;
        started = true;
        this.turnId = turnId;
        this.active = !settled;
        if (this.active) onSteerable?.();
      })();
    });
  }

  async steer(text: string): Promise<boolean> {
    if (!this.active || !this.threadId || !this.turnId) return false;
    if (!this.rpc) return false;
    return steerCodexTurn(this.rpc, this.threadId, this.turnId, text);
  }

  stop(): void {
    this.active = false;
    if (this.child) killChildTree(this.child);
  }
}
