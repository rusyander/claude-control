// Сценарий-функция для процесса заглушки: фабрика с данными-аргументами (как `scriptFor(task)`
// задач-заглушек). Ответ — `<приставка>:<последняя реплика>:<номер запроса>`.
import type { StepFn } from '@agentdeck/stub-model';

export function echoScript(prefix: string): StepFn {
  let calls = 0;
  return (ctx) => {
    calls += 1;
    const messages = (ctx.request.body.messages ?? []) as { content?: unknown }[];
    const last = messages.at(-1)?.content;
    return { text: `${prefix}:${String(last)}:${calls}` };
  };
}
