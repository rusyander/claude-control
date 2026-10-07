import type { StdioRpc } from './stdio-rpc.ts';

/**
 * Рукопожатие `codex app-server` — общее у разговора (`codex-app-server.ts`) и у
 * агента тестов (`project-tests/agent/codex-run.ts`): `initialize` →
 * `initialized` → [`skills/extraRoots/set`] → `thread/start`, затем
 * `turn/start` и `turn/steer` с `expectedTurnId` (привязки 0.160, живые
 * прогоны `check-foreign-steer.mjs`, `check-codex-kit.mjs`). Транспорт и смысл
 * уведомлений — у вызывающего: здесь только порядок вызовов и разбор ответов.
 */

/** Сколько ждать ответа на `initialize`, — дальше считаем, что режима нет. */
export const CODEX_HANDSHAKE_MS = 20_000;

export const CODEX_EFFORTS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export type CodexThreadOpening = { ok: true; threadId: string } | { ok: false; why: string };

/**
 * Поднять поток: рукопожатие и `thread/start` с параметрами вызывающего.
 * Отказ — `why` для человека или для запасного одиночного запуска.
 */
export async function openCodexThread(
  rpc: StdioRpc,
  options: {
    /** Параметры `thread/start` целиком: каталог, модель, права, ephemeral. */
    thread: Record<string, unknown>;
    /** Корни навыков набора панели; пусто — вызов не делается. */
    skillRoots?: readonly string[];
    handshakeMs?: number;
  },
): Promise<CodexThreadOpening> {
  const init = await rpc.call(
    'initialize',
    {
      clientInfo: { name: 'agentdeck', title: null, version: '1' },
      capabilities: null,
    },
    options.handshakeMs ?? CODEX_HANDSHAKE_MS,
  );
  if (!init?.result) {
    return { ok: false, why: init?.error?.message ?? 'initialize не ответил' };
  }
  rpc.notify('initialized');
  if (options.skillRoots && options.skillRoots.length > 0) {
    // Корни навыков живут в процессе сервера и в `config.toml` не пишутся
    // (сверено на 0.160). Не принял — ход без навыков набора был бы молчаливой
    // подменой режима.
    const roots = await rpc.call('skills/extraRoots/set', { extraRoots: options.skillRoots });
    if (!roots?.result) {
      return { ok: false, why: roots?.error?.message ?? 'skills/extraRoots/set gave no result' };
    }
  }
  const thread = await rpc.call('thread/start', options.thread);
  const threadId = (thread?.result?.thread as { id?: string } | undefined)?.id;
  if (!threadId) return { ok: false, why: thread?.error?.message ?? 'thread/start без id' };
  return { ok: true, threadId };
}

/** Начать ход; отказ CLI (модель, вход) — `error` как есть. */
export async function startCodexTurn(
  rpc: StdioRpc,
  threadId: string,
  text: string,
  effort?: string,
): Promise<{ ok: true; turnId: string } | { ok: false; error?: string }> {
  const turn = await rpc.call('turn/start', {
    threadId,
    input: [{ type: 'text', text }],
    ...(effort && CODEX_EFFORTS.has(effort) ? { effort } : {}),
  });
  const turnId = (turn?.result?.turn as { id?: string } | undefined)?.id;
  return turnId ? { ok: true, turnId } : { ok: false, error: turn?.error?.message };
}

/**
 * Сообщение в идущий ход. Кончившийся ход отвечает ошибкой «no active turn to
 * steer» — тогда `false`.
 */
export async function steerCodexTurn(
  rpc: StdioRpc,
  threadId: string,
  turnId: string,
  text: string,
  timeoutMs?: number,
): Promise<boolean> {
  const reply = await rpc.call(
    'turn/steer',
    { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] },
    timeoutMs,
  );
  return Boolean(reply?.result);
}
