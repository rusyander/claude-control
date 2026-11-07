/**
 * Ход чата ровно тем путём, каким его заводит панель (этап 11, W3-17a): реестр прогонов из сборки
 * сервера (`bootstrap/runtime/chat-wiring.ts` `wireChat`) → исполнитель хода `CoreChatRun` →
 * задача ядра `chat@1`. CLI нового разговора — активный провайдер панели (`settings.provider`),
 * маршрут контура — галочка «Чат» (`coreContourRoutes(store, 'chat', cli)`), отказ ядра — ошибка
 * хода словами панели. Так же идут продолжение в чистой сессии и перенос работы
 * (`continuationStarter`): своего стартера у чата чужого CLI больше нет.
 *
 * Проверке не нужен HTTP-маршрут отправки: он только собирает `RunOptions` и зовёт `runs.start` —
 * здесь тот же вызов. Ядро — то, что подняла проверка; адрес его дома едет в `AGENTDECK_CORE_HOME`,
 * как у сервера (`coreHomeOf`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runErrorCode } from '../../apps/server/src/domains/chat/run-errors/run-errors.ts';

let seq = 0;

/** Реестр чата, собранный сборкой сервера на временном каталоге данных и доме ядра. */
export async function panelChatRuns({ appData, store, coreHome }) {
  process.env.AGENTDECK_CORE_HOME = coreHome;
  const { wireChat } = await import('../../apps/server/src/bootstrap/runtime/chat-wiring.ts');
  return wireChat({ location: { paths: { appData } }, store }).chatRuns;
}

/**
 * Код отказа из текста ошибки хода: «(код X)» панели или «refused (X)» ядра — код ядра; текст
 * панели по смыслу без кода в скобках (контур недоступен, модель не открыта) — его код панели,
 * тот же разбор, каким сервер кладёт код рядом с текстом (`runErrorCode`).
 */
export function refusalCode(message) {
  return (
    /\((?:код|code) ([^)\s]+)\)/.exec(message)?.[1] ??
    /refused[^(]*\(([^)\s]+)\)/.exec(message)?.[1] ??
    runErrorCode(message)?.code ??
    'rejected'
  );
}

/**
 * Новый разговор CLI `cli` в каталоге `cwd`. Ответ — `{ ok: true, key, taskId, sessionId }`, как
 * только у хода есть сеанс ядра (книга чата ядра его записала), или `{ ok: false, code, message }`
 * с ошибкой хода, которую увидел бы человек. `waitMs` — сколько ждать сеанса.
 */
export async function startPanelChat(
  chatRuns,
  { appData, store, cli, cwd, prompt, model, waitMs = 120_000 },
) {
  store.updateSettings({ provider: cli });
  seq += 1;
  const key = `new-${Date.now()}-${seq}`;
  const accepted = chatRuns.start(
    key,
    { prompt, cwd, ...(model ? { model } : {}) },
    { projectPath: cwd, origin: 'chat' },
  );
  if (!accepted) return { ok: false, code: 'run-busy', message: 'реестр не принял прогон' };
  return await new Promise((resolve) => {
    let detach;
    let done = false;
    const settle = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      detach?.();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => settle({ ok: false, code: 'no-session', message: `сеанса нет за ${waitMs} мс` }),
      waitMs,
    );
    detach = chatRuns.attach(key, 0, {
      send: ({ event }) => {
        if (event.kind === 'session') {
          const book = JSON.parse(readFileSync(join(appData, 'core-chat-book.json'), 'utf8'));
          const taskId = book[event.sessionId]?.taskId;
          settle(
            taskId
              ? { ok: true, key, taskId, sessionId: event.sessionId }
              : { ok: false, code: 'no-book', message: `книга без ${event.sessionId}` },
          );
        }
        if (event.kind === 'error') {
          settle({ ok: false, code: refusalCode(event.message), message: event.message });
        }
      },
      close: () => settle({ ok: false, code: 'closed', message: 'прогон кончился без сеанса' }),
    });
    // Буфер прогона отдаётся ещё внутри `attach`: исход мог наступить до того, как отписка пришла.
    if (done) detach?.();
    // Прогон кончился до подписки: события отданы из буфера, слушателя нет — исход уже есть.
    if (!detach && !done) settle({ ok: false, code: 'closed', message: 'прогон уже кончился' });
  });
}
