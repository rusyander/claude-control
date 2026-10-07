import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnCliProcess } from '../../../lib/cli-spawn.ts';
import { killChildTree } from '../../../lib/process-tree.ts';
import {
  openCodexThread,
  startCodexTurn,
  steerCodexTurn,
} from '../../provider-chat/live/codex-session.ts';
import { StdioRpc, type RpcIncoming } from '../../provider-chat/live/stdio-rpc.ts';
import type { PermissionDecision } from '../run-permissions.ts';
import type { TestsAgentEvent, TestsAgentRun, TestsAgentStartOptions } from './agent-run.types.ts';
import {
  codexChangesOf,
  codexLegacyChangesOf,
  codexVerdict,
  decideCodexChanges,
  decideCodexCommand,
} from './foreign-gate.ts';

/**
 * Агент тестов на Codex: `codex app-server` с `approvalPolicy:'untrusted'` и
 * `sandbox:'read-only'` на любой ОС. Каждую правку файла и каждую команду
 * Codex сперва спрашивает — отвечает панель по границам прогона, тем же
 * правилам, что у Claude (`foreign-gate.ts`).
 *
 * Пути правки в самой просьбе (`item/fileChange/requestApproval`) не названы —
 * они в элементе `item/started` с тем же id, и он всегда приходит раньше
 * (проба P6). Незнакомый id — отказ.
 *
 * Отказ у Codex без текста: модель видит только «rejected by user» и не знает
 * почему. Поэтому причина уходит в ход сообщением (`turn/steer`) ДО ответа
 * «нет» — тогда она ложится в ближайший же запрос модели (после ответа — на
 * запрос позже, проба P6).
 *
 * `acceptForSession` не отправляется никогда: он разрешил бы следующие правки
 * тех же файлов без вопроса, то есть без проверки.
 */

/** Сколько ждать ответа на `turn/steer`, прежде чем всё равно ответить «нет». */
const STEER_WAIT_MS = 5000;

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: unknown;
  changes?: unknown;
}

interface UsageBreakdown {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

export interface CodexTestsRunDeps {
  kill?: (child: ChildProcessWithoutNullStreams) => void;
  handshakeMs?: number;
  steerWaitMs?: number;
}

export class CodexTestsRun implements TestsAgentRun {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopped = false;

  private readonly deps: CodexTestsRunDeps;

  constructor(deps: CodexTestsRunDeps = {}) {
    this.deps = deps;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child) (this.deps.kill ?? killChildTree)(this.child);
  }

  start(options: TestsAgentStartOptions, onEvent: (event: TestsAgentEvent) => void): Promise<void> {
    const spawned = spawnCliProcess(options.command, ['app-server'], {
      spawnImpl: options.spawnImpl,
      cwd: options.cwd,
      ...(Object.keys(options.env).length > 0 ? { env: options.env } : {}),
    });
    const unavailable = (why: string): TestsAgentEvent => ({
      kind: 'error',
      message: `Codex не поднял app-server (нужен Codex 0.160 или новее): ${why}. Прогон не запущен.`,
      messageCode: 'tests-agent-codex-app-server-unavailable',
      params: { why },
    });
    if (spawned.error) {
      onEvent(unavailable(spawned.error.message));
      return Promise.resolve();
    }
    const child = spawned.child;
    this.child = child;
    const startedAt = Date.now();

    return new Promise((resolve) => {
      let settled = false;
      let turnStarted = false;
      let threadId: string | undefined;
      let turnId: string | undefined;
      let lastError = '';
      let stderr = '';
      /** Правки по id элемента — пути для решения по просьбе. */
      const changes = new Map<string, unknown>();
      /** Текст сообщения модели копится до конца элемента: затирание секрета не режется по кускам. */
      const texts = new Map<string, string>();

      const settle = (event?: TestsAgentEvent): void => {
        if (settled) return;
        settled = true;
        if (event && !this.stopped) onEvent(event);
        (this.deps.kill ?? killChildTree)(child);
        resolve();
      };

      /** Причина отказа — в ход, затем «нет». Ход уже кончился — причина остаётся в логе. */
      const explain = async (decision: PermissionDecision, tool: string): Promise<void> => {
        const message = decision.message ?? 'Refused by the panel for this test run.';
        options.onDeny?.(tool, message);
        if (!threadId || !turnId) return;
        await steerCodexTurn(
          rpc,
          threadId,
          turnId,
          `The panel refused the ${tool} you just asked for: ${message}`,
          this.deps.steerWaitMs ?? STEER_WAIT_MS,
        );
      };

      const answer = async (message: RpcIncoming & { id: number | string }): Promise<void> => {
        const params = (message.params ?? {}) as Record<string, unknown>;
        switch (message.method) {
          case 'item/fileChange/requestApproval': {
            const itemId = typeof params.itemId === 'string' ? params.itemId : '';
            const decision = decideCodexChanges(options.scope, codexChangesOf(changes.get(itemId)));
            if (decision.behavior === 'deny') await explain(decision, 'apply_patch');
            return rpc.respond(message.id, { result: { decision: codexVerdict(decision) } });
          }
          case 'applyPatchApproval': {
            const decision = decideCodexChanges(
              options.scope,
              codexLegacyChangesOf(params.fileChanges),
            );
            if (decision.behavior === 'deny') await explain(decision, 'apply_patch');
            return rpc.respond(message.id, {
              result: {
                decision:
                  decision.behavior === 'allow'
                    ? 'approved'
                    : { denied: { rejection: decision.message ?? 'refused by the panel' } },
              },
            });
          }
          case 'item/commandExecution/requestApproval': {
            const decision = decideCodexCommand(options.scope, params);
            if (decision.behavior === 'deny') await explain(decision, 'shell command');
            return rpc.respond(message.id, { result: { decision: codexVerdict(decision) } });
          }
          case 'execCommandApproval': {
            const decision = decideCodexCommand(options.scope, params);
            if (decision.behavior === 'deny') await explain(decision, 'shell command');
            return rpc.respond(message.id, {
              result: {
                decision:
                  decision.behavior === 'allow'
                    ? 'approved'
                    : { denied: { rejection: decision.message ?? 'refused by the panel' } },
              },
            });
          }
          case 'mcpServer/elicitation/request': {
            // Инструменты MCP прогону тестов у чужого CLI не положены: что они
            // трогают, панель проверить не может (так же, как у Qwen).
            await explain(
              {
                behavior: 'deny',
                message:
                  'MCP tools are not available in this test run: the panel cannot check what they touch.',
              },
              'MCP tool',
            );
            return rpc.respond(message.id, { result: { action: 'decline' } });
          }
          case 'item/permissions/requestApproval':
            // Форма просьбы живьём не снята (проба P9): пустой набор — ничего сверх.
            return rpc.respond(message.id, { result: { permissions: {}, scope: 'turn' } });
          case 'item/tool/requestUserInput':
            return rpc.respond(message.id, {
              error: {
                code: -32000,
                message:
                  'Nobody to ask: this is an unattended test run. Decide yourself and note the doubt in the case note.',
              },
            });
          default:
            return rpc.respond(message.id, {
              error: { code: -32601, message: 'not supported by agentdeck' },
            });
        }
      };

      const onNotification = (message: RpcIncoming): void => {
        const params = message.params ?? {};
        switch (message.method) {
          case 'item/started': {
            const item = (params.item ?? {}) as CodexItem;
            if (!item.id) return;
            if (item.type === 'fileChange') {
              changes.set(item.id, item.changes);
              const paths = (codexChangesOf(item.changes) ?? []).map((change) => change.path);
              onEvent({ kind: 'tool', name: 'apply_patch', input: { paths }, id: item.id });
            }
            if (item.type === 'commandExecution') {
              const command = typeof item.command === 'string' ? item.command : '';
              onEvent({ kind: 'tool', name: 'shell', input: { command }, id: item.id });
            }
            return;
          }
          case 'item/agentMessage/delta': {
            const itemId = typeof params.itemId === 'string' ? params.itemId : '';
            const delta = typeof params.delta === 'string' ? params.delta : '';
            if (delta) texts.set(itemId, (texts.get(itemId) ?? '') + delta);
            return;
          }
          case 'item/completed': {
            const item = (params.item ?? {}) as CodexItem;
            if (item.type !== 'agentMessage') return;
            const text = (typeof item.text === 'string' && item.text) || texts.get(item.id ?? '');
            texts.delete(item.id ?? '');
            if (text) onEvent({ kind: 'text', text: `${text}\n` });
            return;
          }
          case 'thread/tokenUsage/updated': {
            const usage = params.tokenUsage as { last?: UsageBreakdown } | undefined;
            const last = usage?.last;
            if (!last) return;
            const cached = count(last.cachedInputTokens);
            onEvent({
              kind: 'usage',
              // Вход Codex считает ВМЕСТЕ с кэшем — иначе кэш посчитался бы дважды.
              input: Math.max(0, count(last.inputTokens) - cached),
              output: count(last.outputTokens),
              cacheRead: cached,
              cacheCreation: 0,
            });
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
              return settle({
                kind: 'error',
                message: turn.error?.message || lastError || 'Codex завершил ход ошибкой.',
              });
            }
            return settle({
              kind: 'done',
              costUsd: 0,
              durationMs: Date.now() - startedAt,
              sessionId: '',
            });
          }
          default:
            return;
        }
      };

      const rpc = new StdioRpc(
        child,
        { onNotification, onRequest: (message) => void answer(message) },
        { jsonrpcField: false },
      );

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });
      child.on('error', (error) =>
        settle(
          turnStarted ? { kind: 'error', message: error.message } : unavailable(error.message),
        ),
      );
      child.on('close', (code) => {
        if (settled) return;
        if (this.stopped) return settle();
        const why = lastError || stderr.trim().slice(-500) || `код ${code ?? '?'}`;
        settle(turnStarted ? { kind: 'error', message: why } : unavailable(why));
      });
      // Ошибка записи в stdin — CLI закрылся раньше; необработанная роняла бы сервер.
      child.stdin.on('error', () => {});

      void (async () => {
        const opened = await openCodexThread(rpc, {
          ...(this.deps.handshakeMs ? { handshakeMs: this.deps.handshakeMs } : {}),
          thread: {
            cwd: options.cwd,
            // На ЛЮБОЙ ОС: `workspace-write` писал бы без вопроса, а вопрос здесь —
            // единственное место, где панель видит путь правки.
            approvalPolicy: 'untrusted',
            sandbox: 'read-only',
            ephemeral: true,
          },
        });
        if (settled) return;
        if (!opened.ok) return settle(unavailable(opened.why));
        threadId = opened.threadId;
        const turn = await startCodexTurn(rpc, threadId, options.prompt);
        if (settled) return;
        if (!turn.ok) {
          return settle({ kind: 'error', message: turn.error ?? 'Codex не начал ход.' });
        }
        turnId = turn.turnId;
        turnStarted = true;
      })();
    });
  }
}
