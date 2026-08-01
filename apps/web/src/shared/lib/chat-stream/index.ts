/**
 * Состояние потокового ответа Claude.
 *
 * Тип живёт в shared, а не в entity Chat, намеренно: им пользуются и лента чата
 * (features/ChatMessages через стор agent-runs), и витрина (@shared/lib/mocks).
 * Держать определение в entity значило бы тянуть shared → entities, что ломает
 * границы слоёв. Поэтому определение здесь, а entity его переэкспортирует.
 */

import type { MessageUsage } from '@claude-control/contracts';

export interface StreamedTool {
  name: string;
  input: string;
  /** Идентификатор вызова — по нему к нему приходит расход шага. */
  id?: string;
  /**
   * Расход шага, породившего этот вызов. Общий на все вызовы одного шага:
   * раздельного счёта модель не даёт (см. ChatEvent.usage на сервере).
   */
  usage?: MessageUsage;
}

export interface StreamState {
  /** Текст ответа, который набирается на глазах. */
  text: string;
  /**
   * Расход шагов, закончившихся одним текстом, — цена самого ответа. Сложен по
   * шагам: в ленте они склеены в один блок, и разделить его обратно нечем.
   */
  textUsage?: MessageUsage;
  thinking: string;
  tools: StreamedTool[];
  isRunning: boolean;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  /** Момент сброса окна лимитов, unix-секунды. */
  limitResetsAt?: number;
}
