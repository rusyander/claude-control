/**
 * Курсор потока принадлежит ХОДУ — на одноразовой панели, по живому проводу.
 *
 * Телефон переподключается к потоку чата адресом `/api/chat/<id>/stream?from=<seq>`.
 * Новый ход под тем же ключом нумерует кадры с нуля, и курсор прошлого хода
 * (`from` больше последнего кадра нового хода) отдавал пустой поток: телефон не
 * видел ни начала нового хода, ни его конца и показывал его только после
 * перезапуска приложения. Исправление: телефон шлёт `startedAt` своего хода, и
 * сервер, видя другой ход, отдаёт его с начала (`ChatRunRegistry.attach`).
 *
 * Подменена только модель — фальшивый `claude` (`fake-cli-chat-basics.mjs`): ход
 * «ПИНГ» длинный (кусочки текста потоком), ход «ещё» короткий («Готово.»). Всё
 * остальное настоящее: процесс сервера `apps/server/src/index.ts`, реестр
 * прогонов, маршрут потока, SSE по HTTP.
 *
 * Строки:
 *  1. второй ход короче первого — без этого курсор прошлого хода ничего не прячет;
 *  2. `/chat/active` называет второй ход его `startedAt` — его телефон и шлёт;
 *  3. курсор прошлого хода БЕЗ `startedAt` (прежний клиент) — пустой поток: так
 *     телефон терял ход;
 *  4. курсор прошлого хода С `startedAt` первого хода — второй ход целиком,
 *     кадр в кадр с тем, что он отдал при отправке: сессия, конец;
 *  5. курсор своего хода — только пропущенное, без повтора сессии;
 *  6. (отрицательный) `startedAt` не числом — прежний договор, ход с начала не
 *     отдаётся.
 *
 * Запуск: node tools/qa/check-mobile-chat-sync.mjs
 * Выход 0 — всё сошлось, 1 — расхождения, 2 — стенд не поднялся.
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_BASICS_CLI } from './fake-cli-chat-basics.mjs';

/** Кадры SSE из тела ответа. */
const framesOf = (text) =>
  String(text ?? '')
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)));

const describe = (frames) =>
  frames
    .map((frame) => `${frame.seq}:${frame.kind}${frame.text ? `(${frame.text})` : ''}`)
    .join(' ');

const textOf = (frames) =>
  frames
    .filter((frame) => frame.kind === 'text')
    .map((frame) => frame.text)
    .join('');

await runOnStand(
  { label: 'mobile-chat-sync', web: false, fakeCli: { claude: FAKE_BASICS_CLI } },
  async (stand, check) => {
    const chatId = randomUUID();
    const projectPath = join(stand.root, 'qa-sync');
    mkdirSync(projectPath, { recursive: true });

    const send = async (prompt, extra = {}) => {
      const sent = await stand.api('/chat/send', {
        method: 'POST',
        body: { chatId, prompt, projectPath, ...extra },
      });
      return { status: sent.status, frames: framesOf(sent.text) };
    };
    const stream = async (query) =>
      framesOf((await stand.api(`/chat/${chatId}/stream?${query}`)).text);

    const first = await send('ПИНГ');
    const firstSession = first.frames.find((frame) => frame.kind === 'session');
    const lastA = Math.max(...first.frames.map((frame) => frame.seq ?? 0));
    console.log(`ход 1: ${describe(first.frames)}`);
    check(
      'ход 1: сессия, «Понг», конец',
      first.status === 200 &&
        Boolean(firstSession?.startedAt) &&
        textOf(first.frames).includes('Понг') &&
        first.frames.at(-1)?.kind === 'done',
      `статус ${first.status}`,
    );

    // Живой ход длится секунды; здесь ходы идут подряд — разводим их отметки.
    await wait(20);
    const second = await send('ещё', { sessionId: firstSession?.sessionId });
    const secondSession = second.frames.find((frame) => frame.kind === 'session');
    const lastB = Math.max(...second.frames.map((frame) => frame.seq ?? 0));
    console.log(`ход 2: ${describe(second.frames)}`);
    check(
      '1. ход 2 короче хода 1: курсор хода 1 дальше последнего кадра хода 2',
      second.status === 200 && lastB < lastA && second.frames.at(-1)?.kind === 'done',
      `последний кадр хода 1 = ${lastA}, хода 2 = ${lastB}`,
    );
    check(
      '   ход 2 — другой ход: его startedAt больше',
      (secondSession?.startedAt ?? 0) > (firstSession?.startedAt ?? 0),
      `${firstSession?.startedAt} → ${secondSession?.startedAt}`,
    );

    const active = (await stand.api('/chat/active')).body;
    const listed = Array.isArray(active) ? active.find((run) => run.chatId === chatId) : undefined;
    check(
      '2. /chat/active называет ход 2 его startedAt',
      listed?.startedAt === secondSession?.startedAt,
      JSON.stringify(listed ?? null),
    );

    const legacy = await stream(`from=${lastA}`);
    console.log(`курсор хода 1 без startedAt: ${describe(legacy) || '(пусто)'}`);
    check(
      '3. курсор хода 1 без startedAt (прежний клиент): поток пуст — ход 2 не виден',
      legacy.length === 0,
      describe(legacy),
    );

    const replay = await stream(`from=${lastA}&startedAt=${firstSession?.startedAt}`);
    console.log(`курсор хода 1 со startedAt хода 1: ${describe(replay) || '(пусто)'}`);
    // Сверка с тем, что ход 2 отдал своему отправителю: кадр в кадр. Текст «Готово.»
    // фальшивый CLI шлёт одним сообщением без кусочков, и в поток он кадром не
    // выходит — настоящий CLI с `--include-partial-messages` шлёт кусочки.
    check(
      '4. курсор хода 1 со startedAt хода 1: ход 2 с начала — кадр в кадр, сессия хода 2, конец',
      replay.length > 0 &&
        describe(replay) === describe(second.frames) &&
        replay[0]?.kind === 'session' &&
        replay[0]?.startedAt === secondSession?.startedAt &&
        replay.at(-1)?.kind === 'done',
      `${describe(replay)} | ход 2: ${describe(second.frames)}`,
    );

    const mid = secondSession?.seq ?? 0;
    const tail = await stream(`from=${mid}&startedAt=${secondSession?.startedAt}`);
    console.log(`курсор хода 2 после сессии: ${describe(tail) || '(пусто)'}`);
    check(
      '5. курсор своего хода: только кадры после курсора, сессия не повторена, конец',
      tail.length > 0 &&
        tail.every((frame) => frame.seq > mid) &&
        !tail.some((frame) => frame.kind === 'session') &&
        tail.at(-1)?.kind === 'done',
      describe(tail),
    );

    const garbled = await stream(`from=${lastA}&startedAt=abc`);
    check(
      '6. (отрицательный) startedAt не числом: прежний договор, ход с начала не отдан',
      garbled.length === 0,
      describe(garbled),
    );
  },
);
