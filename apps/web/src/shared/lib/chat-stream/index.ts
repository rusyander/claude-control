/**
 * Состояние потокового ответа Claude.
 *
 * Тип живёт в shared, а не в entity Chat, намеренно: им пользуются и лента чата
 * (features/ChatMessages через стор agent-runs), и витрина (@shared/lib/mocks).
 * Держать определение в entity значило бы тянуть shared → entities, что ломает
 * границы слоёв. Поэтому определение здесь, а entity его переэкспортирует.
 */

export interface StreamedTool {
  name: string;
  input: string;
}

export interface StreamState {
  /** Текст ответа, который набирается на глазах. */
  text: string;
  thinking: string;
  tools: StreamedTool[];
  isRunning: boolean;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  /** Момент сброса окна лимитов, unix-секунды. */
  limitResetsAt?: number;
}
