/**
 * Ход со стола глазами телефона (1b, 28.09): человек ведёт разговор в панели на
 * компьютере, телефон смотрит на тот же прогон.
 *
 * Прогон заводится так же, как его заводит вкладка панели: `POST /chat/send` с
 * временным ключом `new-…`, поток читается до конца. Фальшивый CLI в ходе
 * ASKTASK ведёт себя как настоящий 2.1.282 (замерено стабом модели): вопрос
 * `AskUserQuestion` с отказом брокера, фоновый субагент и его итог — репликой
 * `<task-notification>` строкой от имени пользователя, после чего ход идёт
 * дальше.
 *
 * Что проверяется на экранах телефона:
 * - (a) вопрос виден во «Вопросах» и в самом чате — и остаётся там после итога
 *   субагента, пока на него не ответили;
 * - (b) чат, открытый из списка разговоров (по сессии) и с главной (по ключу
 *   прогона), видит идущий прогон: «Стоп» на месте, история сессии на экране;
 * - (c) субагент хода виден в чате;
 * - итог субагента после конца хода — строкой события, а не XML в пузыре человека.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wait } from './throwaway-stand.mjs';

const PROMPT = 'ASKTASK desk work';
const PROMPT_ROW = /^ASKTASK desk work$/;
const QUESTION = /^Which stack for the desk task\?$/;
// Карточка вопроса — по её варианту: текст вопроса есть и в строке вызова
// AskUserQuestion, а вариант ответа рисует только карточка.
const CARD_OPTION = /^Keep React$/;
/** Сколько раз лента рисует вызов AskUserQuestion: история и поток не должны его двоить. */
const askLines = (texts) =>
  texts.filter((text) => text.split(' | ')[0] === 'AskUserQuestion').length;

/** Кадр экрана одной строкой — в подробности провала. */
async function seen(phone) {
  return (await phone.texts()).slice(0, 40).join(' ¦ ');
}

/** Ход со стола: ключ `new-…`, поток читается, как во вкладке. */
function startDeskRun(stand, project) {
  const chatId = `new-${Date.now()}`;
  const controller = new AbortController();
  const done = fetch(`${stand.apiUrl}/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, prompt: PROMPT, projectPath: project }),
    signal: controller.signal,
  })
    .then(async (res) => {
      for await (const _chunk of res.body ?? []) {
        // Читаем до конца: вкладка панели держит поток открытым весь ход.
      }
    })
    .catch(() => undefined);
  return { chatId, controller, done };
}

async function sessionOf(stand, chatId) {
  for (let i = 0; i < 60; i += 1) {
    const active = (await stand.api('/chat/active')).body;
    const run = Array.isArray(active) ? active.find((item) => item.chatId === chatId) : undefined;
    if (run?.sessionId && run.status === 'running') return run.sessionId;
    await wait(250);
  }
  return undefined;
}

/** Открытый чат: признаки идущего прогона, вопроса, субагента и истории. */
async function chatFacts(phone) {
  // Лента подгружается опросами (прогоны 5 с, сводка 5 с, прогресс 5 с).
  await phone.waitFor(/^Stop$/, 12_000);
  await wait(1500);
  const texts = await phone.texts();
  return {
    running: texts.some((text) => /^Stop$/.test(text.split(' | ')[0])),
    question: texts.some((text) => CARD_OPTION.test(text.split(' | ')[0])),
    askLines: askLines(texts),
    // Шапка прогресса говорит, работает ли субагент, а не только сколько их.
    subagent: texts.some((text) => /Subagents: \d+ running/.test(text)),
    subagentLine: texts.find((text) => /^Subagents:/.test(text)) ?? '',
    notice: texts.some((text) => /Background task finished/.test(text)),
    history: texts.some((text) => text.startsWith(PROMPT)),
    // Пустой экран — не «нет на экране»: причина дампа идёт в подробность.
    texts: texts.length ? texts.slice(0, 40).join(' ¦ ') : `пустой дамп: ${phone.dumpError()}`,
  };
}

const deskDone = (ctx) => ctx.calls().some((call) => call.done?.startsWith(PROMPT));

/**
 * Конец хода: телефон перечитывает транскрипт, итог субагента — строкой
 * события. Узлы экрана пишутся рядом со снимком: строка, видимая на снимке,
 * но не в дампе, отличается от строки, которой нет.
 */
async function afterEnd(ctx) {
  const { phone, check, shot } = ctx;
  const until = Date.now() + 200_000;
  while (Date.now() < until && !deskDone(ctx)) await wait(500);
  check('ход со стола закончился', deskDone(ctx));
  await wait(6000);
  await phone.tap(/^Projects & chats$/);
  await phone.tap(PROMPT_ROW, 15_000);
  await phone.waitFor(/Background task|<task-notification>/, 15_000);
  const nodes = await phone.screen();
  // Сырой XML рядом: строка, которую дамп отдал пустой, разбирается по нему.
  const raw = phone.run(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { encoding: 'utf8' });
  writeFileSync(join(ctx.shots, 'b1-chat-after-end-en.xml'), raw.stdout ?? '');
  writeFileSync(
    join(ctx.shots, 'b1-chat-after-end-en.nodes.json'),
    JSON.stringify(
      nodes.map((node) => ({ text: node.text, desc: node.desc, cls: node.cls })),
      null,
      1,
    ),
  );
  const texts = nodes.map((node) => [node.text, node.desc].filter(Boolean).join(' | '));
  shot('b1-chat-after-end-en');
  check(
    'итог субагента в чате — строкой события, а не XML в пузыре человека',
    texts.some((line) => /Background task finished/.test(line)) &&
      !texts.some((line) => line.includes('<task-notification>')),
    texts.filter(Boolean).slice(0, 40).join(' ¦ '),
  );
  check(
    'вызов AskUserQuestion в ленте один раз (история и хвост потока не двоят его)',
    askLines(texts) === 1,
    `строк вызова: ${askLines(texts)}`,
  );
  // Карточку после конца хода держит только сводка сервера (правка S1 в
  // M-server.patch): без неё она уходит — запись, а не проверка.
  const kept = texts.some((line) => CARD_OPTION.test(line.split(' | ')[0]));
  ctx.notes.push(`вопрос в чате после конца хода: ${kept ? 'виден' : 'не виден'}`);
}

export async function runDeskLive(ctx) {
  const { phone, check, shot, stand, project } = ctx;
  phone.stopApp();
  phone.launch();
  await phone.tap(/^Home$/, 30_000);

  const desk = startDeskRun(stand, project);
  try {
    const sessionId = await sessionOf(stand, desk.chatId);
    check('ход со стола идёт под ключом new-… и уже знает сессию', Boolean(sessionId));
    // Телефон узнаёт о чужом ходе опросом `/chat/active` и сводки — раз в 5 с.
    await wait(7000);

    // (a) «Вопросы» — пока субагент работает.
    await phone.tap(/^Questions$/);
    const live = await phone.waitFor(QUESTION, 15_000);
    shot('b1-questions-live-en');
    check('(a) «Вопросы»: вопрос хода со стола виден', Boolean(live), await seen(phone));

    // (b) Чат с главной: строка «Проекты и чаты» открывает прогон по его ключу.
    await phone.tap(/^Projects & chats$/);
    await phone.tap(PROMPT_ROW, 15_000);
    const fromHome = await chatFacts(phone);
    shot('b1-chat-from-home-en');
    check('(b) чат с главной: агент работает («Stop»)', fromHome.running, fromHome.texts);
    check('(b) чат с главной: история сессии на экране', fromHome.history, fromHome.texts);
    check('(a) вопрос виден в самом чате (с главной)', fromHome.question, fromHome.texts);
    check('(c) шапка чата (с главной): субагент работает', fromHome.subagent, fromHome.texts);
    phone.back();
    await wait(800);

    // (b) Чат из списка разговоров: он назван сессией, а прогон — ключом new-….
    await phone.tap(/^All conversations$/, 15_000);
    await phone.tap(PROMPT_ROW, 20_000);
    const fromList = await chatFacts(phone);
    shot('b1-chat-from-list-en');
    check(
      '(b) чат из списка: агент работает («Stop»), а не «молчит»',
      fromList.running,
      fromList.texts,
    );
    check('(a) вопрос виден в самом чате (из списка)', fromList.question, fromList.texts);
    check('(c) шапка чата (из списка): субагент работает', fromList.subagent, fromList.texts);
    check(
      'вызов AskUserQuestion в ленте идущего хода один раз (история и поток не двоят его)',
      fromList.askLines === 1,
      `строк вызова: ${fromList.askLines}`,
    );

    // Итог фонового субагента приходит репликой — ход при этом идёт дальше.
    // Субагент фальшивого CLI отчитывается через 170 с (FAKE_SUB_MS): весь осмотр
    // чата до этого идёт, пока ход работает, — иначе «Stop» проверялся бы у законченного.
    const until = Date.now() + 240_000;
    while (Date.now() < until && !ctx.calls().some((call) => call.notice === 'toolu_desk_task')) {
      await wait(500);
    }
    check(
      'итог фонового субагента записан в транскрипт',
      ctx.calls().some((call) => call.notice === 'toolu_desk_task'),
    );
    await wait(8000);
    const inbox = (await stand.api('/chat/inbox')).body;
    const row = inbox?.chats?.find((chat) => chat.sessionId === sessionId);
    ctx.notes.push(
      `сводка сервера после итога субагента: статус ${row?.status}, вопросов ${row?.asks?.length ?? 0}`,
    );
    const progress = (await stand.api(`/chat/${sessionId}/progress`)).body;
    ctx.notes.push(
      `прогресс сервера после итога субагента: ${JSON.stringify(progress?.agents?.map((agent) => agent.status))}`,
    );
    const afterNotice = await chatFacts(phone);
    shot('b1-chat-after-notice-en');
    ctx.notes.push(
      `шапка прогресса на телефоне после итога субагента: «${afterNotice.subagentLine}»`,
    );
    // Итог пишется ТОЛЬКО в транскрипт (в поток CLI его нет), а транскрипт
    // идущего прогона телефон перечитывает лишь по его концу — строка события
    // проверяется в afterEnd.
    ctx.notes.push(
      `итог субагента в чате, пока ход идёт: ${afterNotice.notice ? 'виден' : 'ещё не виден'}`,
    );
    check(
      '(a) после итога субагента вопрос всё ещё в чате (он не отвечен)',
      afterNotice.question,
      afterNotice.texts,
    );
    phone.back();
    await wait(800);
    await phone.tap(/^Questions$/);
    const kept = await phone.waitFor(QUESTION, 12_000);
    shot('b1-questions-after-notice-en');
    check(
      '(a) после итога субагента вопрос всё ещё во «Вопросах» (он не отвечен)',
      Boolean(kept),
      await seen(phone),
    );

    await afterEnd(ctx);
  } finally {
    await stand.api(`/chat/${encodeURIComponent(desk.chatId)}/stop`, { method: 'POST' });
    desk.controller.abort();
    await desk.done;
  }
}
