/**
 * F-101 D3 на устройстве: ход агента панели переживает уход телефона в фон.
 *
 * Android 15+ режет сеть фоновому приложению через секунды, поток хода рвётся.
 * Сервер с возвратом (`detach`) держит ход, нумерует кадры (`id:`) и отдаёт
 * пропущенное по `GET /api/agent/run/:id/stream?fromSeq`. Здесь этот контракт
 * играет прокси — байт в байт как `seqFrame` сервера (его формат проверен
 * тестом маршрута на настоящем сокете), — а проверяется телефон: просит ли он
 * возврат, возвращается ли с правильного номера и доводит ли ход на экран.
 */
import { wait } from './throwaway-stand.mjs';
import { json, readBody } from './mobile-device-fixtures.mjs';

const CONVERSATION = 'c-reattach';

/** Кадр хода с номером — как `seqFrame` сервера. */
const numbered = (seq, event) => `data: ${JSON.stringify(event)}\nid: ${seq}\n\n`;

/** Ход на «сервере» прокси: кадры копятся, подписчики получают новые. */
function stubTurn() {
  const frames = [];
  const listeners = new Set();
  const turn = {
    frames,
    ended: false,
    push(event) {
      const frame = { seq: frames.length + 1, event };
      frames.push(frame);
      for (const listener of listeners) listener(frame);
    },
    end() {
      turn.ended = true;
      for (const listener of listeners) listener('end');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return turn;
}

function routes(state) {
  const turn = state.turn;
  const serve = (res, frames) => {
    for (const frame of frames) res.write(numbered(frame.seq, frame.event));
    if (turn.ended) {
      res.end();
      return;
    }
    const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 10_000);
    const off = turn.subscribe((frame) => {
      if (frame === 'end') {
        clearInterval(ping);
        res.end();
      } else if (!res.writableEnded) res.write(numbered(frame.seq, frame.event));
    });
    res.on('close', () => {
      clearInterval(ping);
      off();
    });
  };
  return [
    {
      name: 'agent-run-detach',
      match: (method, path) => method === 'POST' && path === '/api/agent/run',
      handle: async (req, res) => {
        state.body = (await readBody(req)) ?? {};
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.on('close', () => {
          if (!turn.ended) state.droppedAt = Date.now();
        });
        turn.push({ kind: 'start', conversationId: CONVERSATION, providerId: 'claude' });
        turn.push({ kind: 'text', text: 'RE-TURN-STARTED' });
        serve(res, [...turn.frames]);
      },
    },
    {
      name: 'agent-run-attach',
      match: (method, path) => method === 'GET' && path === `/api/agent/run/${CONVERSATION}/stream`,
      handle: async (req, res, url) => {
        const fromSeq = Number(url.searchParams.get('fromSeq') ?? '0');
        state.attaches.push({ fromSeq, at: Date.now() });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        serve(
          res,
          turn.frames.filter((frame) => frame.seq > fromSeq),
        );
      },
    },
    {
      name: 'agent-run-stop',
      match: (method, path) => method === 'POST' && path === `/api/agent/run/${CONVERSATION}/stop`,
      handle: async (req, res) => {
        state.stops += 1;
        json(res, 200, { ok: true });
      },
    },
  ];
}

/** Сценарий d3; `askAgent` — общий шаг сценариев (открыть агента и отправить текст). */
export function makeRunReattach({ askAgent }) {
  return async function runReattach(ctx) {
    const { phone, check, shot, proxy } = ctx;
    const state = { turn: stubTurn(), attaches: [], stops: 0 };
    const added = routes(state);
    proxy.routes.unshift(...added);
    try {
      phone.stopApp();
      phone.launch();
      await wait(3000);
      await askAgent(phone, 'long task reattach');
      check('D3: ход начался', Boolean(await phone.waitFor(/^RE-TURN-STARTED$/, 15_000)));
      check('D3: телефон просит ход с возвратом (detach)', state.body?.detach === true);
      shot('d3-started-en');

      const hiddenAt = Date.now();
      phone.home();
      // Ход кончается, пока телефон в фоне и без сети.
      await wait(60_000);
      state.turn.push({ kind: 'text', text: ' RE-TURN-FINISHED' });
      state.turn.push({ kind: 'done', reply: 'RE-TURN-STARTED RE-TURN-FINISHED' });
      state.turn.end();
      await wait(15_000);
      phone.resume();
      const finished = await phone.waitFor(/RE-TURN-FINISHED/, 45_000);
      await wait(1500);
      const cut = await phone.find(/^The connection dropped before the turn ended/);
      shot('d3-after-resume-en');
      const dropped = state.droppedAt
        ? `поток оборван через ${Math.round((state.droppedAt - hiddenAt) / 1000)} с после ухода в фон`
        : 'поток не обрывался';
      ctx.notes.push(
        `D3: ${dropped}; возвраты ${JSON.stringify(state.attaches.map((item) => item.fromSeq))}`,
      );
      if (state.droppedAt) {
        check(
          'D3: после обрыва телефон вернулся к ходу с номера последнего кадра',
          state.attaches.some((item) => item.fromSeq === 2),
          JSON.stringify(state.attaches),
        );
      }
      check(
        'D3: ход доведён до конца на экране, без «связь оборвалась»',
        Boolean(finished) && cut.length === 0,
        dropped,
      );
      check('D3: «Стоп» не посылался', state.stops === 0);
    } finally {
      for (const route of added) proxy.routes.splice(proxy.routes.indexOf(route), 1);
    }
  };
}
