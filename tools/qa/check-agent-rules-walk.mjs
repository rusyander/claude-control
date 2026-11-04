/**
 * Сквозной ход агента панели: «создай правила для X» → правила созданы и видны;
 * «для чего эти правила?» → объяснение из их текста. Кейс panel-agent-walks-001.
 *
 * Ход идёт через ядро (этап 10): `POST /api/agent/run` → вопрос ядра «ask» → НАСТОЯЩИЙ
 * `claude` сессией ядра, у которой из инструментов только мост панели (`tools/mcp/panel.mjs`)
 * → действия панели → карточки → решение человека (`/api/agent/pending/:id` с Origin окна) →
 * файл инструкций одноразового дома → страница «Правила» фронта. Подменена только модель:
 * заглушка по программе ниже (`panel-agent-core-stand.mjs`).
 *
 * Свидетельства: файл инструкций на диске, страница «Правила» в браузере, файл разговора,
 * вызовы моста, дошедшие до модели. Отрицательная ветка: отклонённая карточка — правила нет ни
 * на диске, ни в ответе. Объяснение сверяется со строкой, которую человек дописал в правило
 * МЕЖДУ ходами: модели её неоткуда знать, кроме как из результата действия панели.
 *
 * Второй блок — действия строк настроек (U5a), каждое отклонено и одобрено, исход сверяется с
 * диском: перенос переменной settings.json → settings.local.json, правка права allow → ask на
 * месте. Действий групп у агента больше нет (группы ведёт ядро) — их блок снят.
 *
 * Стенд одноразовый: свой дом, свой PATH, своё ядро; стенд человека не трогается. Нет `claude`
 * в PATH — «не проверено» (код 2).
 * Запуск: `node tools/qa/check-agent-rules-walk.mjs [--server-dir <копия apps/server>]`
 * (`--server-dir` — поднять копию сервера, например с внесённым мутантом).
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { wait } from './throwaway-stand.mjs';
import { runPanelAgentOnCore } from './panel-agent-core-stand.mjs';

const TOPIC = 'сообщений коммитов';
const REJECTED_TOPIC = 'имён веток';
const HUMAN_LINE = 'Ссылка на задачу — в последней строке.';
const ENV_KEY = 'WALK_MODE';
const PERMISSION = 'Bash(npm test:*)';

const serverAt = process.argv.indexOf('--server-dir');
const SERVER_DIR = serverAt > 0 ? process.argv[serverAt + 1] : undefined;

const parse = (text) => {
  const at = text.indexOf('{');
  try {
    return at >= 0 ? JSON.parse(text.slice(at)) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Модель хода — выбор по ТЕКУЩЕЙ просьбе:
 * - «создай правила для X» → два `save_rule` про X; ответ называет созданные;
 * - «перенеси переменную KEY …» → `move_env` из settings.json;
 * - «поменяй право «P» …» → `edit_permission_rule` allow → ask;
 * - иначе («для чего эти правила?») → `list_rules`, потом каждое правило целиком, и ответ
 *   пересказывает ИХ ТЕКСТ из панели — тел правил программа на этом ходу не знает.
 */
async function program({ current, tool }) {
  const done = (result) => !result.isError && result.text.startsWith('Done.');
  if (/перенеси/i.test(current)) {
    const key = /\b([A-Z][A-Z0-9_]+)\b/.exec(current)?.[1] ?? 'X';
    const result = await tool('move_env', { key, source: 'settings' });
    return done(result)
      ? `Переменная ${key} теперь в settings.local.json.`
      : `Переменная ${key} осталась на месте: ${result.text.slice(0, 200)}`;
  }
  if (/право/i.test(current)) {
    const pattern = /«(.+?)»/.exec(current)?.[1] ?? 'X';
    const result = await tool('edit_permission_rule', {
      id: `allow:${pattern}`,
      decision: 'ask',
      pattern,
    });
    return done(result)
      ? `Право ${pattern} теперь спрашивает.`
      : `Право ${pattern} не изменено: ${result.text.slice(0, 200)}`;
  }
  if (/созда/i.test(current)) {
    const topic = (/для\s+(.+?)[.?!]*$/i.exec(current)?.[1] ?? 'X').trim();
    const drafts = [
      {
        title: `${topic}: язык`,
        body: `Сообщения про ${topic} пишутся по-русски, в повелительном наклонении.`,
      },
      { title: `${topic}: длина`, body: `Первая строка про ${topic} — не длиннее 72 символов.` },
    ];
    const made = [];
    const refused = [];
    for (const draft of drafts) {
      const result = await tool('save_rule', draft);
      (done(result) ? made : refused).push(draft.title);
    }
    return made.length > 0
      ? `Создал правила: ${made.map((title) => `«${title}»`).join(', ')}.`
      : `Правила не созданы: ${refused.map((title) => `«${title}»`).join(', ')} — вы отклонили.`;
  }
  const listed = parse((await tool('list_rules', {})).text);
  const parts = [];
  for (const rule of listed?.rules ?? []) {
    const full = parse((await tool('list_rules', { id: rule.id })).text);
    const body = typeof full?.body === 'string' ? full.body : (full?.body?.text ?? '');
    parts.push(`«${rule.title}» — ${body.trim()}`);
  }
  return parts.length > 0 ? `Эти правила задают вот что:\n${parts.join('\n')}` : 'Правил нет.';
}

/** Настройки с переменной и правом — для второго блока. */
function seed({ cfg }) {
  writeFileSync(
    join(cfg, 'settings.json'),
    `${JSON.stringify({ env: { [ENV_KEY]: 'walk' }, permissions: { allow: [PERMISSION] } }, null, 2)}\n`,
  );
}

await runPanelAgentOnCore(
  {
    label: 'agent-rules-walk',
    program,
    seed,
    ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
  },
  async (stand, check, model) => {
    const origin = stand.webUrl;
    // Файл инструкций — тот, что разрешила сама панель (имя зависит от того, что лежит в доме).
    const location = (await stand.api('/location')).body;
    const instructions = location?.paths?.claudeMd ?? join(stand.cfg, 'CLAUDE.md');
    console.log(`Файл инструкций стенда: ${instructions}\n`);
    const claudeMd = () => stand.read(instructions) ?? '';
    /** Вызовы моста хода: последний запрос хода к модели несёт их все с результатами. */
    const callsSince = (n) => model.turns.slice(n).at(-1)?.calls ?? [];

    /**
     * Один ход: запрос держится открытым (поток кадров), а карточки тем временем
     * решаются так, как их решил бы человек в окне, — POST с Origin фронта.
     */
    async function turn(conversationId, messages, decide) {
      const cards = [];
      let settled = false;
      const running = fetch(`${stand.apiUrl}/api/agent/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ messages, conversationId, context: { route: '/rules' } }),
      })
        .then(async (res) => ({ status: res.status, text: await res.text() }))
        .finally(() => (settled = true));
      const seen = new Set();
      for (let t = 0; t < 180_000 && !settled; t += 200) {
        const pending = (await stand.api('/agent/pending')).body ?? [];
        for (const card of pending) {
          if (seen.has(card.id)) continue;
          seen.add(card.id);
          cards.push(card);
          const answer = await stand.api(`/agent/pending/${card.id}`, {
            method: 'POST',
            headers: { origin },
            body: { decision: decide(card) },
          });
          if (answer.status !== 200) throw new Error(`решение карточки: HTTP ${answer.status}`);
        }
        await wait(200);
      }
      const response = await running;
      const conversation = (await stand.api(`/agent/conversations/${conversationId}`)).body;
      return { response, cards, conversation };
    }

    // ── Ход 1: «создай правила для X» ──────────────────────────────────────
    const conversationId = `walk-${randomUUID()}`;
    const ask1 = `Создай мне правила для ${TOPIC}`;
    const first = await turn(conversationId, [{ role: 'user', content: ask1 }], () => 'approve');
    check(
      'ход 1: запуск принят (200)',
      first.response.status === 200,
      first.response.text.slice(0, 400),
    );
    check(
      'ход 1: ход шёл через ядро — кадр start, ответ без кадра ошибки',
      first.response.text.includes('"kind":"start"') &&
        !first.response.text.includes('"kind":"error"'),
      first.response.text.slice(0, 1200),
    );
    check(
      'ход 1: две карточки save_rule, каждая — изменение',
      first.cards.length === 2 &&
        first.cards.every((card) => card.name === 'save_rule' && card.risk === 'change'),
      JSON.stringify(first.cards.map((card) => [card.name, card.risk])),
    );
    const disk = claudeMd();
    check(
      'ход 1: оба правила легли в файл инструкций одноразового дома',
      disk.includes(`${TOPIC}: язык`) && disk.includes(`${TOPIC}: длина`),
      disk.slice(0, 600),
    );
    const rules = (await stand.api('/rules')).body ?? [];
    check(
      'ход 1: панель отдаёт правила списком',
      rules.some((rule) => rule.title === `${TOPIC}: язык`) &&
        rules.some((rule) => rule.title === `${TOPIC}: длина`),
      JSON.stringify(rules.map((rule) => rule.title)),
    );
    const reply1 = first.conversation?.messages?.at(-1)?.content ?? '';
    check(
      'ход 1: ответ агента называет созданные правила',
      reply1.includes(`«${TOPIC}: язык»`) && reply1.includes(`«${TOPIC}: длина»`),
      reply1,
    );
    const offered = model.turns.flatMap((item) => item.offered);
    check(
      'ход 1: модели предложены только мост панели и загрузчик инструментов',
      offered.length > 0 &&
        offered.every(
          (name) =>
            name.startsWith('mcp__panel-bridge__') ||
            name === 'ToolSearch' ||
            name === 'DeferredToolPlaceholder',
        ),
      JSON.stringify([...new Set(offered)]),
    );

    // Правила видны человеку — на странице «Правила» одноразового фронта.
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await page.goto(`${stand.webUrl}/rules`);
      const visible = await page
        .getByText(`${TOPIC}: длина`, { exact: false })
        .first()
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      check('ход 1: правило видно на странице «Правила»', visible);
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }

    // ── Отрицательная ветка: человек отклоняет карточки ─────────────────────
    const rejectedId = `walk-${randomUUID()}`;
    const rejected = await turn(
      rejectedId,
      [{ role: 'user', content: `Создай мне правила для ${REJECTED_TOPIC}` }],
      () => 'reject',
    );
    check('отказ: карточки были показаны', rejected.cards.length === 2);
    check(
      'отказ: отклонённых правил нет в файле инструкций',
      !claudeMd().includes(REJECTED_TOPIC),
      claudeMd().slice(0, 600),
    );
    const rejectedReply = rejected.conversation?.messages?.at(-1)?.content ?? '';
    check(
      'отказ: агент говорит, что правила не созданы',
      rejectedReply.startsWith('Правила не созданы'),
      rejectedReply,
    );

    // Человек дописал строку в правило между ходами — мимо агента.
    const target = (await stand.api('/rules')).body.find(
      (rule) => rule.title === `${TOPIC}: длина`,
    );
    const edited = await stand.api(`/rules/${encodeURIComponent(target.id)}`, {
      method: 'PUT',
      headers: { origin },
      body: {
        title: target.title,
        body: `${target.body.trim()}\n${HUMAN_LINE}`,
        isEnabled: target.isEnabled,
        groupIds: target.groupIds ?? [],
      },
    });
    check('правка человека сохранена', edited.status === 200, edited.text.slice(0, 300));

    // ── Ход 2: «для чего эти правила?» ─────────────────────────────────────
    const history = first.conversation.messages.map(({ role, content }) => ({ role, content }));
    const before = model.turns.length;
    const second = await turn(
      conversationId,
      [...history, { role: 'user', content: 'Для чего эти правила?' }],
      () => 'approve',
    );
    check(
      'ход 2: запуск принят (200)',
      second.response.status === 200,
      second.response.text.slice(0, 400),
    );
    check('ход 2: ни одной карточки — только чтение', second.cards.length === 0);
    const reads = callsSince(before);
    check(
      'ход 2: агент читал правила действиями панели',
      reads.length >= 3 && reads.every((call) => call.name === 'list_rules' && !call.isError),
      JSON.stringify(reads.map((call) => [call.name, call.isError])),
    );
    const reply2 = second.conversation?.messages?.at(-1)?.content ?? '';
    check(
      'ход 2: объяснение пересказывает текст правил',
      reply2.includes(`Сообщения про ${TOPIC} пишутся по-русски`) &&
        reply2.includes('не длиннее 72 символов'),
      reply2,
    );
    check(
      'ход 2: в объяснении есть строка, дописанная человеком после хода 1',
      reply2.includes(HUMAN_LINE),
      reply2,
    );

    // ── Действия строк настроек: каждое — отказ, потом одобрение ───────────
    const json = (path) => {
      const text = stand.read(path);
      return text ? JSON.parse(text) : {};
    };
    const settingsPath = join(stand.cfg, 'settings.json');
    const localPath = join(stand.cfg, 'settings.local.json');

    /** Один ход с одним действием: одна карточка ожидаемого имени, решение, ответ агента. */
    async function actionTurn(label, ask, name, decision) {
      const result = await turn(
        `walk-${randomUUID()}`,
        [{ role: 'user', content: ask }],
        () => decision,
      );
      const reply = result.conversation?.messages?.at(-1)?.content ?? '';
      check(`${label}: запуск принят (200)`, result.response.status === 200);
      check(
        `${label}: одна карточка ${name}, изменение`,
        result.cards.length === 1 &&
          result.cards[0].name === name &&
          result.cards[0].risk === 'change',
        `${JSON.stringify(result.cards.map((card) => [card.name, card.risk]))} · ответ: ${reply}`,
      );
      return reply;
    }

    const moveAsk = `Перенеси переменную ${ENV_KEY} в личный файл`;
    const moveRejected = await actionTurn(
      'перенос переменной, отказ',
      moveAsk,
      'move_env',
      'reject',
    );
    check(
      'перенос переменной, отказ: переменная в settings.json, в settings.local.json её нет',
      json(settingsPath).env?.[ENV_KEY] === 'walk' && json(localPath).env?.[ENV_KEY] === undefined,
      `${stand.read(settingsPath)}\n${stand.read(localPath)}`,
    );
    check('перенос переменной, отказ: ответ честный', moveRejected.includes('осталась на месте'));
    await actionTurn('перенос переменной, одобрение', moveAsk, 'move_env', 'approve');
    check(
      'перенос переменной, одобрение: переменная в settings.local.json с тем же значением',
      json(settingsPath).env?.[ENV_KEY] === undefined && json(localPath).env?.[ENV_KEY] === 'walk',
      `${stand.read(settingsPath)}\n${stand.read(localPath)}`,
    );

    const permissionAsk = `Поменяй право «${PERMISSION}», пусть спрашивает`;
    const permissions = () => json(settingsPath).permissions ?? {};
    const editRejected = await actionTurn(
      'правка права, отказ',
      permissionAsk,
      'edit_permission_rule',
      'reject',
    );
    check(
      'правка права, отказ: право осталось в allow',
      (permissions().allow ?? []).includes(PERMISSION) &&
        !(permissions().ask ?? []).includes(PERMISSION),
      JSON.stringify(permissions()),
    );
    check('правка права, отказ: ответ честный', editRejected.includes('не изменено'));
    await actionTurn('правка права, одобрение', permissionAsk, 'edit_permission_rule', 'approve');
    check(
      'правка права, одобрение: право перешло из allow в ask того же файла',
      (permissions().ask ?? []).includes(PERMISSION) &&
        !(permissions().allow ?? []).includes(PERMISSION),
      JSON.stringify(permissions()),
    );
  },
);
