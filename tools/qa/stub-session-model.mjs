// Сценарий заглушки модели для проверки сессии CLI между ходами (`check-foreign-session.mjs`)
// поверх общей `packages/stub-model`: отвечает сразу, без инструментов, любым из трёх
// протоколов. На каждый запрос записывает, есть ли секрет где-нибудь в теле (контекст
// CLI), и тексты всех реплик человека: проверка сама найдёт среди них реплику своего
// хода — CLI добавляют рядом свои (напоминания, подсказки, запрос заголовка).
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

export async function startSessionModel({ secret, port = 0 } = {}) {
  const requests = [];
  const stub = await startStubModel({
    port,
    script: ({ request }) => {
      const entry = {
        n: requests.length + 1,
        path: request.path,
        inBody: request.raw.includes(secret),
        users: request.userTexts,
      };
      requests.push(entry);
      // Ответ называет, видела ли модель секрет: проверка читает его в переписке.
      return { text: entry.inBody ? `REPLY_${entry.n}_SEEN` : `REPLY_${entry.n}_BLIND` };
    },
  });
  return { port: stub.port, requests, close: stub.close };
}
