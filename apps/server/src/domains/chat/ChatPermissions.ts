/**
 * Брокер интерактивных прав. Мини-MCP-сервер (permission-prompt-server.mjs) по
 * запросу агента дёргает `/api/chat/permission-request`; тот держит ответ здесь,
 * пока человек не нажмёт «Разрешить»/«Запретить» в интерфейсе. Ключ — пара
 * «разговор + tool_use_id»: в одном ходе агент может спросить не раз.
 *
 * Безопасный дефолт — «запретить»: по таймауту или остановке разговора висящие
 * запросы отклоняются, а не зависают навсегда.
 */

export interface PermissionRequest {
  runId: string;
  toolName: string;
  input: unknown;
  toolUseId: string;
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
}

interface Pending {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Полчаса на раздумье — агент честно ждёт человека, но не вечно. */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export class PermissionBroker {
  private pending = new Map<string, Pending>();

  private key(runId: string, toolUseId: string): string {
    return `${runId}::${toolUseId}`;
  }

  /** Запросить решение пользователя. Ждёт клика; по таймауту — «запретить». */
  request(request: PermissionRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const key = this.key(request.runId, request.toolUseId);
      // Дубль по тому же tool_use — прежний снимаем (не должно случаться).
      this.pending.get(key)?.resolve({ behavior: 'deny', message: 'Заменён новым запросом.' });

      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve({ behavior: 'deny', message: 'Время ожидания решения истекло.' });
      }, timeoutMs);

      this.pending.set(key, { resolve, timer });
    });
  }

  /** Ответить на запрос (клик пользователя). false — если запрос уже снят. */
  decide(runId: string, toolUseId: string, decision: PermissionDecision): boolean {
    const key = this.key(runId, toolUseId);
    const pending = this.pending.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    pending.resolve(decision);
    return true;
  }

  /** Есть ли по разговору висящие запросы. */
  hasPending(runId: string): boolean {
    const prefix = `${runId}::`;
    for (const key of this.pending.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  /** Снять все висящие запросы разговора (остановка) — как «запретить». */
  cancelRun(runId: string): void {
    const prefix = `${runId}::`;
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.resolve({ behavior: 'deny', message: 'Разговор остановлен.' });
    }
  }
}
