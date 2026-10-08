/**
 * Состояние потокового ответа Claude.
 *
 * Тип живёт в shared, а не в entity Chat, намеренно: им пользуются и лента чата
 * (features/ChatMessages через стор agent-runs), и витрина (@shared/lib/mocks).
 * Держать определение в entity значило бы тянуть shared → entities, что ломает
 * границы слоёв. Поэтому определение здесь, а entity его переэкспортирует.
 */

/**
 * Вопрос, который ждёт человека: `AskUserQuestion`, не закрытый автовыбором.
 * Одно определение на ленту, пульт, слоты потоков и вопросы детей у родителя —
 * иначе где-то закрытый автономией вопрос продолжал бы звать человека.
 *
 * Закрыт по САМОМУ факту автовыбора, как на сервере (метка в результате вызова):
 * `autoPicks` появляется только с меткой, а пустой список — выбор, который прогон
 * не смог разобрать (не видел самого вызова), а не открытый вопрос (F-132).
 */
export function isOpenAsk(tool: { name: string; autoPicks?: readonly unknown[] }): boolean {
  return tool.name === 'AskUserQuestion' && tool.autoPicks === undefined;
}

export { isStreamShown, type StreamState, type StreamedTool } from './isStreamShown';
