/**
 * «Чистая сессия» в чате Claude на телефоне — оба ответа настоящего сервера.
 *
 * Разговор свой (`RESTART_SESSION`), а не общий с вопросами: просьба обновить
 * опору дописывает в транскрипт реплику, и сценарии, читающие тот разговор,
 * увидели бы чужое. Опоры нет — сервер отвечает `requested`, телефон отправляет
 * просьбу этим же разговором (фальшивый `claude` получает её с `--resume` той же
 * сессии). Опора свежее последней реплики — `started`: панель сама заводит
 * продолжение новой сессией, телефон переходит в него.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wait } from './throwaway-stand.mjs';
import { PACKAGE } from './android-device.mjs';
import { transcriptDir } from './mobile-device-fixtures.mjs';

const RESTART_SESSION = '5e551011-0000-4000-8000-00000000c1ea';
const TITLE = /^RESTART probe chat$/;
const ANSWER = /^Probe answer\.$/;
const RESTART = /^(Перезапустить в чистой сессии|Restart in a clean session)$/;
const RESTART_YES = /^(Перезапустить|Restart)$/;
/** Ответ фальшивого CLI на любой ход — эхо реплики. */
const ACK = /^ACK: /;
/** Файл-опора по умолчанию (`HANDOFF_DEFAULT_CHECKPOINT`) — от каталога проекта. */
const CHECKPOINT = ['.agent', 'PROGRESS.md'];

export function setupRestart({ stand, project }) {
  const dir = transcriptDir(stand.cfg, project);
  mkdirSync(dir, { recursive: true });
  const at = (offsetMs) => new Date(Date.now() - offsetMs).toISOString();
  const base = { sessionId: RESTART_SESSION, cwd: project };
  const lines = [
    {
      type: 'user',
      uuid: 'r1',
      timestamp: at(120_000),
      message: { role: 'user', content: 'RESTART probe chat' },
    },
    {
      type: 'assistant',
      uuid: 'r2',
      timestamp: at(110_000),
      // Без `stop_reason` ход считается открытым, и сводка видит работу вне
      // панели — тогда ссылки на перезапуск нет, и это верно.
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Probe answer.' }],
        stop_reason: 'end_turn',
      },
    },
  ];
  writeFileSync(
    join(dir, `${RESTART_SESSION}.jsonl`),
    lines.map((line) => JSON.stringify({ ...base, ...line })).join('\n') + '\n',
    'utf8',
  );
}

/** Ход фальшивого CLI с репликой про опору, начатый после `since`. */
async function callAbout(ctx, since, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const call = ctx
      .calls()
      .find((entry) => entry.at >= since && entry.text && /PROGRESS\.md/.test(entry.text));
    if (call) return call;
    await wait(500);
  }
  return undefined;
}

/** Разговоры, чью ленту телефон запрашивал после `since`, — по журналу прокси. */
function feedsReadSince(proxy, since) {
  const ids = proxy.log
    .filter((entry) => entry.at >= since && entry.method === 'GET')
    .map((entry) => /^\/api\/chats\/([^/]+)\/messages$/.exec(entry.path)?.[1])
    .filter(Boolean)
    .map(decodeURIComponent);
  return [...new Set(ids)];
}

async function confirmRestart(phone) {
  await phone.tap(RESTART, 20_000);
  await phone.tap(RESTART_YES, 10_000);
}

export async function runRestart(ctx) {
  const { phone, project, proxy, check, shot } = ctx;
  const checkpoint = join(project, ...CHECKPOINT);
  try {
    phone.stopApp();
    phone.launch();
    await phone.waitFor(/^(Home|Главная)$/, 30_000);
    phone.shell(`am start -a android.intent.action.VIEW -d agentdeck://chats ${PACKAGE}`);
    await phone.tap(TITLE, 20_000);
    check('разговор открыт, его ответ на экране', Boolean(await phone.waitFor(ANSWER, 20_000)));
    shot('restart-1-chat');

    // — опоры нет: просьба обновить её уходит этим же разговором.
    const askedAt = Date.now();
    await confirmRestart(phone);
    const asked = await callAbout(ctx, askedAt);
    const restartCall = proxy.log.find(
      (entry) =>
        entry.at >= askedAt &&
        entry.method === 'POST' &&
        /^\/api\/chat\/[^/]+\/restart$/.test(entry.path),
    );
    check('телефон спросил сервер (POST /chat/:id/restart)', Boolean(restartCall));
    check(
      'опоры нет — просьба её обновить ушла в ЭТУ сессию',
      asked?.sid === RESTART_SESSION,
      JSON.stringify(asked ?? ctx.calls().slice(-3)),
    );
    check('ответ на просьбу виден в том же разговоре', Boolean(await phone.waitFor(ACK, 20_000)));
    // Длинная просьба уносит прежний ответ за край экрана — что телефон остался
    // в этом разговоре, видно по ленте, которую он перечитывает, а не по экрану.
    const readAfterAsk = feedsReadSince(proxy, askedAt);
    check(
      'телефон остался в этом разговоре — читает ленту только его',
      readAfterAsk.includes(RESTART_SESSION) && readAfterAsk.every((id) => id === RESTART_SESSION),
      readAfterAsk.join(', '),
    );
    shot('restart-2-requested');

    // — агент «дописал» опору после последней реплики: продолжение сразу.
    mkdirSync(join(project, CHECKPOINT[0]), { recursive: true });
    writeFileSync(checkpoint, '# PROGRESS\n\nrestart probe\n');
    // Ссылка возвращается, только когда ход кончился и экран это увидел.
    await phone.waitFor(RESTART, 20_000);
    const startedAt = Date.now();
    await confirmRestart(phone);
    const started = await callAbout(ctx, startedAt);
    check(
      'опора свежая — продолжение заведено НОВОЙ сессией со ссылкой на опору',
      Boolean(started) && started.sid !== RESTART_SESSION,
      JSON.stringify(started ?? ctx.calls().slice(-3)),
    );
    // Сначала переход по ленте: телефон начинает читать новую сессию, когда
    // открыл её (ACK на экране был и до перехода — ответ на просьбу). Переход
    // бывает дольше 20 с, поэтому экран смотрится только после него.
    let readAfterStart = feedsReadSince(proxy, startedAt);
    for (let i = 0; i < 80 && started && !readAfterStart.includes(started.sid); i += 1) {
      await wait(500);
      readAfterStart = feedsReadSince(proxy, startedAt);
    }
    // Доказательство перехода — лента новой сессии, которую телефон запросил:
    // её открывает только экран продолжения. Текст на экране не годится — лента
    // показывает реплику не той строкой, какой её получил CLI, а длинная просьба
    // уносит ACK за край экрана; совпадение по началу пишется лишь пометкой.
    const head = started?.text?.trim().split('\n')[0].slice(0, 40);
    const onScreen =
      Boolean(head) &&
      Boolean(
        await phone.waitFor(
          { test: (value) => typeof value === 'string' && value.startsWith(head) },
          5_000,
        ),
      );
    shot('restart-3-started');
    check(
      'телефон перешёл в продолжение: читает ленту новой сессии',
      Boolean(started) && readAfterStart.includes(started.sid),
      `новая сессия ${started?.sid}; ленты: ${readAfterStart.join(', ')}; начало реплики «${head}» на экране: ${onScreen}`,
    );
  } finally {
    // Опора лежит в общем проекте прогона — следующим сценариям она ни к чему.
    rmSync(join(project, CHECKPOINT[0]), { recursive: true, force: true });
  }
}
