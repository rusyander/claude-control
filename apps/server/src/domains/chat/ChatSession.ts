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
 * Состояние заводится на КАЖДЫЙ сервер, а не на модуль: два сервера в одном
 * процессе (так поднимаются тесты) не должны видеть чужие висящие запросы и
 * чужие тумблеры. Один сервер держит ОДИН объект на все маршруты чата:
 * продолжение в чистой сессии заводит прогоны мимо маршрута отправки, и
 * тумблеры у них должны быть те же.
 *
 * Ключи — канонические (`registry.resolveKey`): один разговор приходит и как
 * временный `new-…`, и как sessionId, а тумблер, щёлкнутый во вкладке, знающей
 * разговор по sessionId, обязан достать прогон, поднятый под `new-…`. Иначе
 * запрос прав искал состояние по одному написанию, а щелчок клал его под
 * другое — и тумблер «не действовал». Исключение — `armAutoApprove`: он идёт
 * ДО регистрации прогона, и его ключ — тот, под которым прогон будет заведён.
 */

/**
 * Сколько разговоров помнится тумблерами. Карта живёт в памяти процесса, растёт
 * по строке на прогон и читается только по ключу — предел нужен ей от
 * бесконечного роста, а не ради свежести: запись законченного прогона обязана
 * пережить паузу, пока человек думает над карточкой разделения.
 */
const MAX_TOGGLES = 200;

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
    this.autoApprove.set(chatId, state);
    // Раньше здесь выбрасывались записи всех незапущенных прогонов. Чистило это
    // и родителя, чьё разделение человек ещё не подтвердил: достаточно было
    // написать в соседний чат — и дети веера заводились без тумблера. Карте
    // хватает предела: она не растёт, а память о законченном прогоне живёт
    // столько, сколько человек думает над карточкой.
    for (const key of this.autoApprove.keys()) {
      if (this.autoApprove.size <= MAX_TOGGLES) break;
      this.autoApprove.delete(key);
    }
  }

  /**
   * Тумблер автоподтверждения, щёлкнутый во время прогона. Права на правки
   * берём из уже идущего прогона: их задаёт другой тумблер.
   */
  toggleAutoApprove(chatId: string, enabled: boolean): void {
    const key = this.registry.resolveKey(chatId);
    const current = this.autoApprove.get(key);
    this.autoApprove.set(key, { enabled, allowEdits: current?.allowEdits ?? false });
  }

  /** Положение тумблеров идущего прогона; нет записи — прогон не наш. */
  autoApproveFor(chatId: string): AutoApproveState | undefined {
    return this.autoApprove.get(this.registry.resolveKey(chatId));
  }

  /**
   * Унаследовать тумблеры закрытого разговора новым — продолжение в чистой
   * сессии. Иначе цепочка, начатая с автоподтверждением, на первом же запросе
   * прав в новом чате вставала ждать человека, который её как раз и не смотрит.
   * Ключей закрытого разговора может быть два (см. выше) — берём первый живой.
   */
  inherit(fromKeys: string[], to: string): void {
    for (const key of fromKeys) {
      const state = this.autoApprove.get(this.registry.resolveKey(key));
      if (!state) continue;
      this.autoApprove.set(to, { ...state });
      return;
    }
  }

  /**
   * Остановка разговора: висящие запросы прав отклоняем (иначе агент ждал бы
   * решения зря) и снимаем автоподтверждение.
   */
  abort(chatId: string): void {
    const key = this.registry.resolveKey(chatId);
    this.permissions.cancelRun(key);
    this.autoApprove.delete(key);
  }

  /** Запросить решение пользователя; ждёт клика в интерфейсе. */
  requestPermission(request: PermissionRequest): Promise<ChatPermissionReply> {
    return this.permissions.request(request);
  }

  /** Ответить на запрос (клик пользователя). false — если запрос уже снят. */
  decidePermission(runId: string, toolUseId: string, reply: ChatPermissionReply): boolean {
    return this.permissions.decide(this.registry.resolveKey(runId), toolUseId, reply);
  }
}
