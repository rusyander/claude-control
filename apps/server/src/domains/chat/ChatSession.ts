import type { ChatRunRegistry } from './ChatRunRegistry.ts';
import {
  PermissionBroker,
  type PermissionRequest,
  type ChatPermissionReply,
} from './ChatPermissions.ts';

/**
 * Живое состояние прав в разговорах: брокер интерактивных запросов плюс
 * автоподтверждение по прогонам.
 *
 * Состояние заводится на КАЖДУЮ регистрацию маршрутов, а не на модуль: два
 * сервера в одном процессе (так поднимаются тесты) не должны видеть чужие
 * висящие запросы и чужие тумблеры.
 */

/** Положение тумблеров разговора на время прогона. */
export interface AutoApproveState {
  enabled: boolean;
  /** Правки файлов в настоящем проекте разрешены. */
  allowEdits: boolean;
}

export class ChatSession {
  private readonly permissions = new PermissionBroker();

  /**
   * Автоподтверждение прав по разговорам: ключ тот же, под которым прогон
   * зарегистрирован у брокера прав (chatId из запроса на отправку). Состояние
   * живёт в памяти прогона: тумблер в шапке чата присылают и при отправке, и
   * отдельным запросом, когда его щёлкнули на ходу.
   */
  private readonly autoApprove = new Map<string, AutoApproveState>();

  private readonly registry: ChatRunRegistry;

  constructor(registry: ChatRunRegistry) {
    this.registry = registry;
  }

  /**
   * Положение тумблеров на этот прогон. Заодно выбрасываем записи прогонов,
   * которые уже не идут: иначе карта копила бы по строчке на каждый разговор.
   */
  armAutoApprove(chatId: string, state: AutoApproveState): void {
    for (const key of this.autoApprove.keys())
      if (!this.registry.isRunning(key)) this.autoApprove.delete(key);
    this.autoApprove.set(chatId, state);
  }

  /**
   * Тумблер автоподтверждения, щёлкнутый во время прогона. Права на правки
   * берём из уже идущего прогона: их задаёт другой тумблер.
   */
  toggleAutoApprove(chatId: string, enabled: boolean): void {
    const current = this.autoApprove.get(chatId);
    this.autoApprove.set(chatId, { enabled, allowEdits: current?.allowEdits ?? false });
  }

  /** Положение тумблеров идущего прогона; нет записи — прогон не наш. */
  autoApproveFor(chatId: string): AutoApproveState | undefined {
    return this.autoApprove.get(chatId);
  }

  /**
   * Остановка разговора: висящие запросы прав отклоняем (иначе агент ждал бы
   * решения зря) и снимаем автоподтверждение.
   */
  abort(chatId: string): void {
    this.permissions.cancelRun(chatId);
    this.autoApprove.delete(chatId);
  }

  /** Запросить решение пользователя; ждёт клика в интерфейсе. */
  requestPermission(request: PermissionRequest): Promise<ChatPermissionReply> {
    return this.permissions.request(request);
  }

  /** Ответить на запрос (клик пользователя). false — если запрос уже снят. */
  decidePermission(runId: string, toolUseId: string, reply: ChatPermissionReply): boolean {
    return this.permissions.decide(runId, toolUseId, reply);
  }
}
