#!/usr/bin/env node
/**
 * Живое доказательство отложенных вопросов D-n на настоящем пути.
 *
 * Владелец уходит от панели на часы; вызов, который решает только человек
 * (публикация пакета, запись в БД…), не имеет права держать работу. Он
 * отбивается текстом «поставлено человеку как D-n», агент доводит ход, запись
 * переживает перезапуск панели, человек отвечает из списка — и ровно этот вызов
 * проходит один раз. Юнит- и интеграционные тесты проверяют части; здесь —
 * одноразовая панель (`throwaway-stand.mjs`: свой дом, свой каталог Claude, свой
 * порт) и фальшивый `claude` на PATH, который спрашивает права через НАСТОЯЩИЙ
 * мост `permission-prompt-server.mjs` из своего `--mcp-config`.
 *
 * Сценарии:
 *   G. группа разделения (план и связь чата разложены в состояние до старта):
 *      вызов откладывается СРАЗУ, без карточки; агент получает текст D-n и
 *      доводит ход; попытка ответить за человека изнутри прогона — 403 у
 *      маршрута и отказ моста; жёсткий перезапуск; запись жива; человек
 *      разрешает; тот же вызов проходит один раз; второй такой же — нет;
 *      чуть другой — нет.
 *   C. одиночный чат при человеке: карточка, срок `deferAfterMinutes` (1 мин)
 *      истёк — карточка стала D-n, агент дошёл до конца хода.
 *
 * Запуск: node tools/qa/check-group-deferred-asks.mjs [--only G|C]
 * `DEFERRED_SERVER_DIR` — каталог копии `apps/server` вместо рабочего (мутанты).
 * `DEFERRED_UI=1` — ещё и Vite стенда и три зрителя (светлая, тёмная, английский):
 * плашка и раздел хаба у группы, живая карточка и она же, ставшая D-n, у чата
 * (`deferred-asks-ui.mjs`); `SHOTS=<папка>` — их снимки.
 * Выход 0 — всё сошлось, 1 — расхождения, 2 — стенд не поднялся.
 * Настоящий `~/.claude` и стенд человека (:5178/:8888) не трогаются; после себя
 * не оставляет процессов (стенд снимается деревом в `finally`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotChecked, reporter, startStand, wait } from './throwaway-stand.mjs';
import { FAKE_CLI } from './deferred-asks.fake-cli.mjs';
import {
  checkChatUi,
  checkGroupUi,
  openChatUi,
  openViewers,
  shotLiveCard,
} from './deferred-asks-ui.mjs';

const ONLY = (() => {
  const at = process.argv.indexOf('--only');
  return at >= 0 ? String(process.argv[at + 1] ?? '').toUpperCase() : '';
})();

/** Вызов, который решает только человек. */
const HUMAN_CMD = 'npm publish --access public';
/** Чуть другой вызов: разрешение на первый его не покрывает. */
const OTHER_CMD = 'npm publish --access public --tag next';

const PARENT = 'p-deferred-live';
const GROUP_CHAT = 'g-deferred-live-0';
const SINGLE_CHAT = 'new-deferred-live-c';
const WITH_UI = process.env.DEFERRED_UI === '1' || Boolean(process.env.SHOTS);
/** Зрители интерфейса (`DEFERRED_UI`): заводятся, когда стенд поднят. */
let ui;

/** Строки, которые фальшивый CLI записал о себе. */
function results(state) {
  const file = join(state, 'results.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function until(fn, seconds, stepMs = 500) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await wait(stepMs);
  }
  return undefined;
}

/** Ход в чат: ответ маршрута — поток хода до конца, ждём только статус. */
async function send(stand, body) {
  const res = await fetch(`${stand.apiUrl}/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status >= 300) return { status: res.status, text: await res.text() };
  void res
    .text()
    .then(() => undefined)
    .catch(() => undefined);
  return { status: res.status, text: '' };
}

/** План разделения с одной группой и связь её чата — так группу видит мост прав. */
function seedGroup(cfg, work) {
  const file = join(cfg, 'agentdeck', 'state.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const now = new Date().toISOString();
  state.chatLinks = {
    [GROUP_CHAT]: { parentChatId: PARENT, groupIndex: 0, title: 'Релиз', branch: 'agent/release' },
  };
  state.splitPlans = {
    [PARENT]: {
      parentChatId: PARENT,
      projectPath: work,
      createdAt: now,
      order: [0],
      request: {},
      proposal: { groups: [{ title: 'Релиз', branch: 'agent/release', tasks: ['опубликовать'] }] },
      groups: [
        {
          index: 0,
          title: 'Релиз',
          branch: 'agent/release',
          after: [],
          status: 'running',
          chatId: GROUP_CHAT,
          startedAt: now,
        },
      ],
    },
  };
  writeFileSync(file, `${JSON.stringify(state)}\n`, 'utf8');
  // Транскрипт родителя: без него чата разделения нет, и хаб с разделом D-n не открыть.
  const dir = join(cfg, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const line = (type, uuid, parentUuid, message) =>
    JSON.stringify({
      parentUuid,
      uuid,
      type,
      message,
      sessionId: PARENT,
      cwd: work,
      timestamp: now,
      isSidechain: false,
      userType: 'external',
      version: '2.1.999',
    });
  writeFileSync(
    join(dir, `${PARENT}.jsonl`),
    `${[
      line('user', 'u-1', null, { role: 'user', content: 'Разложи релиз на группы' }),
      line('assistant', 'a-1', 'u-1', {
        id: 'msg_parent',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'Разложил: одна группа «Релиз».' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ].join('\n')}\n`,
    'utf8',
  );
}

async function deferredList(stand) {
  const res = await stand.api('/chat/deferred');
  return Array.isArray(res.body?.items) ? res.body.items : [];
}

async function scenarioGroup(stand, state, work, check) {
  console.log('\nG. группа: D-n сразу, перезапуск, решение, разовое разрешение');
  const startedAt = Date.now();
  const sent = await send(stand, {
    chatId: GROUP_CHAT,
    prompt: 'SCENARIO:ASK опубликуй пакет',
    projectPath: work,
  });
  if (!check(sent.status < 300, `ход группы принят: ${sent.status}`, sent.text)) {
    throw new NotChecked('ход группы не принят');
  }
  const asked = await until(() => results(state).find((entry) => entry.step === 'ask'), 40);
  const elapsed = Date.now() - startedAt;
  check(
    Boolean(asked?.id) && asked?.behavior === 'deny',
    `вызов человеку получил отказ с номером D-n: ${asked?.id ?? 'нет'}`,
    asked?.message ?? 'ответа моста нет',
  );
  check(elapsed < 30_000, `без ожидания карточки: ${Math.round(elapsed / 1000)} с до ответа`);
  const id = asked?.id;
  const selfFetch = await until(
    () => results(state).find((entry) => entry.step === 'self-fetch'),
    20,
  );
  check(
    selfFetch?.status === 403,
    `ответ за человека запросом из прогона — 403: ${selfFetch?.status}`,
  );
  const selfBridge = await until(
    () => results(state).find((entry) => entry.step === 'self-bridge'),
    20,
  );
  check(
    // Именно отказ «за человека не отвечают», а не очередная D-n: та тоже «deny».
    selfBridge?.behavior === 'deny' && String(selfBridge?.message).startsWith('agentdeck(refused)'),
    `ответ за человека вызовом инструмента — отказ моста: ${selfBridge?.behavior}`,
    selfBridge?.message,
  );
  const ended = await until(() => results(state).find((entry) => entry.step === 'end'), 20);
  check(Boolean(ended), 'агент довёл ход до конца после D-n');
  const before = (await deferredList(stand)).find((item) => item.id === id);
  check(before?.state === 'waiting', `запись ${id} ждёт человека: ${before?.state}`);
  check(
    before?.scope?.kind === 'group' && before?.scope?.parentChatId === PARENT,
    `запись принадлежит группе: ${JSON.stringify(before?.scope)}`,
  );
  if (ui && id) await checkGroupUi(ui, stand.webUrl, { parentChatId: PARENT, id }, check);

  const { killedPid, pid } = await stand.restartHard();
  console.log(`  панель перезапущена жёстко: ${killedPid} → ${pid}`);
  const after = (await deferredList(stand)).find((item) => item.id === id);
  check(after?.state === 'waiting', `после перезапуска ${id} на месте: ${after?.state}`);

  const decided = await stand.api(`/chat/deferred/${id}/decision`, {
    method: 'POST',
    body: { behavior: 'allow', via: 'web' },
  });
  check(
    decided.status === 200 && decided.body?.item?.state === 'allowed',
    `человек разрешил: ${decided.status} ${decided.body?.item?.state} (продолжение: ${decided.body?.resume})`,
    decided.text.slice(0, 300),
  );
  const resumedBy = decided.body?.resume;
  // Продолжения нет (разговор после перезапуска реестру неизвестен) — человек
  // пишет сам; разрешение ждёт своего срока и действует на следующем ходу.
  if (resumedBy !== 'sent' && resumedBy !== 'queued') {
    const next = await send(stand, {
      chatId: GROUP_CHAT,
      prompt: 'SCENARIO:AGAIN',
      projectPath: work,
    });
    check(next.status < 300, `следующий ход группы принят: ${next.status}`, next.text);
  }
  const done = await until(() => results(state).find((entry) => entry.step === 'other'), 60);
  const lines = results(state);
  const exact1 = lines.find((entry) => entry.step === 'exact1');
  const exact2 = lines.find((entry) => entry.step === 'exact2');
  check(Boolean(done), 'ход после решения дошёл до трёх вызовов');
  check(exact1?.behavior === 'allow', `тот же вызов прошёл: ${exact1?.behavior}`);
  check(
    exact2?.behavior !== 'allow',
    `второй такой же — не разрешён: ${exact2?.behavior}`,
    exact2?.message,
  );
  check(done?.behavior !== 'allow', `чуть другой — не разрешён: ${done?.behavior}`, done?.message);
  const final = (await deferredList(stand)).find((item) => item.id === id);
  check(final?.state === 'consumed', `разрешение ${id} погашено: ${final?.state}`);
}

async function scenarioChat(stand, state, work, check) {
  console.log('\nC. одиночный чат: карточка, срок вышел — D-n, ход дошёл');
  const startedAt = Date.now();
  const sent = await send(stand, {
    chatId: SINGLE_CHAT,
    prompt: 'SCENARIO:ASK опубликуй пакет',
    projectPath: work,
  });
  if (!check(sent.status < 300, `ход чата принят: ${sent.status}`, sent.text)) return;
  if (ui) {
    // Зрители открывают чат до карточки — так человек «смотрит», и карточка первой.
    const run = await until(async () => {
      const active = (await stand.api('/chat/active')).body;
      // Ключ чата сервер может уже называть сессией — ищем прогон не группы, самый новый.
      const mine = Array.isArray(active)
        ? active
            .filter((item) => item.chatId !== GROUP_CHAT && item.status !== 'done')
            .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        : [];
      return mine[0];
    }, 20);
    await openChatUi(ui, stand.webUrl, run?.sessionId ?? run?.chatId ?? SINGLE_CHAT);
    await wait(8000);
    await shotLiveCard(ui);
  }
  const asked = await until(
    () => results(state).find((entry) => entry.step === 'ask' && entry.at >= startedAt),
    150,
  );
  const elapsed = Date.now() - startedAt;
  check(
    Boolean(asked?.id) && asked?.behavior === 'deny',
    `карточка без ответа стала D-n: ${asked?.id ?? 'нет'}`,
    asked?.message ?? 'ответа моста нет',
  );
  check(elapsed >= 55_000, `сначала карточка ждала человека: ${Math.round(elapsed / 1000)} с`);
  const ended = await until(
    () => results(state).find((entry) => entry.step === 'end' && entry.at >= startedAt),
    30,
  );
  check(Boolean(ended), 'агент довёл ход до конца после D-n');
  const item = (await deferredList(stand)).find((entry) => entry.id === asked?.id);
  check(
    item?.state === 'waiting' && item?.scope?.kind === 'chat',
    `запись чата ждёт человека: ${item?.state} ${item?.scope?.kind}`,
  );
  if (ui && asked?.id) await checkChatUi(ui, asked.id, check);
}

async function main() {
  const report = reporter();
  const { finish } = report;
  // Порядок как в остальных живых проверках: условие, строка, подробность.
  const check = (condition, text, detail = '') =>
    report.check(text, Boolean(condition), detail ?? '');
  let stand;
  let state = '';
  let work = '';
  try {
    stand = await startStand({
      web: WITH_UI,
      label: 'deferred',
      settings: { deferAfterMinutes: 1 },
      fakeCli: { claude: FAKE_CLI },
      // Копия сервера с мутантом (проверка «краснеет ли»): правка рабочего дерева
      // перезапустила бы панель человека под её сторожем.
      ...(process.env.DEFERRED_SERVER_DIR ? { serverDir: process.env.DEFERRED_SERVER_DIR } : {}),
      seed: ({ root, cfg }) => {
        state = join(root, 'fake-state');
        work = join(root, 'work');
        mkdirSync(state, { recursive: true });
        mkdirSync(work, { recursive: true });
        seedGroup(cfg, work);
      },
      env: {
        FAKE_HUMAN_CMD: HUMAN_CMD,
        FAKE_OTHER_CMD: OTHER_CMD,
      },
    });
    console.log(`Одноразовая панель ${stand.apiUrl}${WITH_UI ? `, фронт ${stand.webUrl}` : ''}`);
    if (WITH_UI) ui = await openViewers(stand.webUrl, process.env.SHOTS);
    if (ONLY !== 'C') await scenarioGroup(stand, state, work, check);
    if (ONLY !== 'G') await scenarioChat(stand, state, work, check);
    console.log(
      `\nЗаписи фальшивого CLI:\n${results(state)
        .map((entry) => JSON.stringify(entry))
        .join('\n')}`,
    );
  } catch (error) {
    if (error instanceof NotChecked) {
      console.log(`Не проверено: ${error.message}`);
      if (stand) console.log(`\nЖурнал панели (хвост):\n${stand.log().slice(-3000)}`);
      if (stand) await stand.stop();
      process.exit(2);
    }
    check('сценарий дошёл до конца', false, error?.stack ?? String(error));
    if (stand) console.log(`\nЖурнал панели (хвост):\n${stand.log().slice(-4000)}`);
  } finally {
    if (ui) await ui.close();
    if (stand) await stand.stop();
  }
  finish();
}

await main();
