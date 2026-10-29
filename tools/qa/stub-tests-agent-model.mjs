// Сценарий заглушки модели для живой проверки агента тестов на чужом CLI
// (`check-tests-agent-foreign.mjs`) поверх общей `packages/stub-model`. Каждый запрос
// берёт СЛЕДУЮЩИЙ шаг, а шаг строит функция проверки — она видит тела прошлых
// запросов (так шаг узнаёт id прогона из задания и текущее содержимое файла группы).
//
// Шаг: { tool: { name, args } } — вызов функции; { custom: { name, input } } —
// свободный инструмент responses (apply_patch у Codex); { text } — итоговый текст.
// Шаг не дан — итог «DONE»; функция упала — текст «STUB SCRIPT FAILED: …». Протокол
// (chat/completions у Qwen Code, responses у Codex) и поток — дело пакета. Каждое
// тело запроса сохраняется: по ним проверка судит, что дошло до модели (причина
// отказа, значение секрета), — рассуждения модели здесь доказательством не служат.
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

/**
 * `script(index, bodies)` → шаг для запроса номер `index` (с нуля); `bodies` —
 * сырые тела всех запросов, включая текущий. Может быть асинхронным: проверка
 * успевает сделать своё (например, уронить приёмник) до ответа модели.
 */
export async function startScriptedModel(script) {
  const stub = await startStubModel({
    script: (ctx) => script(ctx.index, ctx.bodies),
  });
  return { port: stub.port, base: stub.baseUrl, bodies: stub.bodies, close: stub.close };
}
