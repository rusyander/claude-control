/**
 * Модель кадров раздела «Агент панели» — подменена ТОЛЬКО она (этап 10: ход идёт через ядро).
 *
 * Программа для заглушки `packages/stub-model/src/scenarios/panel-agent.mjs`: НАСТОЯЩИЙ `claude`
 * сессии ядра «ask» говорит с заглушкой, заглушка переигрывает программу над историей запроса
 * и зовёт инструменты моста `panel-bridge` (`tools/mcp/panel.mjs`). Карточки, диффы, исходы, след
 * действий и файлы разговоров в кадрах сделала сама панель; по сценарию сыграна лишь реплика
 * модели. Сценарий выбирается по текущей просьбе человека и отвечает на её языке.
 *
 * Что модель ПОЛУЧИЛА, видно по `current`: кадр «ключ в чат не уходит» опирается на метку маски
 * в самой просьбе, а не на слова.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON, который мост кладёт после «Done.» — из него модель берёт id. */
function doneJson(text) {
  const start = text.indexOf('\n');
  try {
    return JSON.parse(text.slice(start + 1));
  } catch {
    return undefined;
  }
}

/** Ответ по исходу действия: отказ человека, нужный секрет, устаревшая карточка, ошибка. */
function outcomeReply(t, result, done) {
  if (/REJECTED/.test(result.text))
    return t(
      'Вы отклонили — ничего не выполнено. Что сделать вместо этого?',
      'You rejected it — nothing was done. What should I do instead?',
    );
  if (/secret is needed/i.test(result.text))
    return t(
      'Сохранено без ключа. Панель открыла своё поле — введите ключ там, мне его не присылайте.',
      'Saved without the key. The panel opened its own field — type the key there, never send it to me.',
    );
  if (/target changed/i.test(result.text))
    return t(
      'Карточка устарела: файл изменился после показа. Перечитаю и покажу новую, если скажете.',
      'The card went stale: the file changed after it was shown. Say so and I will show a fresh one.',
    );
  if (result.isError)
    return t(
      `Панель не выполнила действие: ${result.text.replace(/^.*?: /, '')}`,
      `The panel did not do it: ${result.text.replace(/^.*?: /, '')}`,
    );
  return done;
}

const SCRIPTS = [
  {
    when: /проект|project/i,
    async run({ request, t, tool }) {
      const path = request.match(/[A-Za-z]:[\\/][^\s«»"]+/)?.[0] ?? '';
      const result = await tool(
        'create_project',
        { path, name: t('Магазин', 'Shop') },
        {
          say: t(
            'Добавлю проект — подтвердите карточку.',
            'Adding the project — please confirm the card.',
          ),
        },
      );
      if (result.isError || !/^Done/.test(result.text)) return outcomeReply(t, result, '');
      // Как велит системная дописка: open_page — только если действие само страницу не открыло.
      if (!/panel opened/i.test(result.text)) await tool('open_page', { route: '/projects' });
      return t(
        'Проект «Магазин» добавлен, открыл страницу «Проекты».',
        'Project “Shop” added; I opened the Projects page.',
      );
    },
  },
  {
    when: /удали|delete/i,
    async run({ t, tool }) {
      const listed = await tool('list_rules', {});
      const rules = doneJson(listed.text)?.rules ?? doneJson(listed.text) ?? [];
      const rule = (Array.isArray(rules) ? rules : []).find((item) =>
        /русск|Russian/i.test(`${item.title} ${item.body ?? ''}`),
      );
      if (!rule) return t('Такого правила не нашёл.', 'I could not find that rule.');
      // Пауза «модель думает» длиннее двух секунд после Enter человека: карточка, пришедшая
      // раньше, фокус не берёт — человек ещё считается печатающим.
      await sleep(3000);
      const result = await tool(
        'delete_rule',
        { id: rule.id },
        {
          say: t(
            'Удаление необратимо — проверьте карточку.',
            'Deleting cannot be undone — check the card.',
          ),
        },
      );
      return outcomeReply(t, result, t('Правило удалено.', 'Rule deleted.'));
    },
  },
  {
    when: /правил|rule/i,
    async run({ request, t, tool }) {
      // Текст правила — всё после двоеточия: «Добавь правило: сначала тесты».
      const text = (request.split(/[:：]/).slice(1).join(':').trim() || request).replace(/\.$/, '');
      const title = text.charAt(0).toUpperCase() + text.slice(1);
      const result = await tool(
        'save_rule',
        { title, body: `${title}.` },
        {
          say: t(
            'Готовлю правило — посмотрите, что изменится в файле.',
            'Preparing the rule — see what changes in the file.',
          ),
        },
      );
      return outcomeReply(
        t,
        result,
        t('Правило записано в CLAUDE.md.', 'The rule is written to CLAUDE.md.'),
      );
    },
  },
  {
    when: /контур|contour/i,
    async run({ t, tool }) {
      const result = await tool(
        'save_contour_draft',
        {
          id: 'corp',
          title: t('Контур отдела', 'Team contour'),
          baseUrl: 'http://gateway.corp.internal:8080',
        },
        {
          say: t(
            'Сохраню черновик контура. Ключ я не принимаю — его вводите вы.',
            'I will save a contour draft. I never take the key — you type it.',
          ),
        },
      );
      return outcomeReply(t, result, t('Черновик сохранён.', 'Draft saved.'));
    },
  },
  {
    when: /\[[A-ZА-ЯЁ_]+_\d+\]|ключ|key/i,
    async run({ request, t }) {
      const seen = request.match(/\[[A-ZА-ЯЁ_]+_\d+\]/)?.[0];
      return seen
        ? t(
            `Ключ до меня не дошёл: вместо него панель прислала метку ${seen}. Введите ключ в поле на странице контура.`,
            `The key never reached me: the panel sent the label ${seen} instead. Type the key into the field on the contour page.`,
          )
        : t('Ключ в чат не присылайте.', 'Do not send keys in chat.');
    },
  },
  {
    when: /mcp|сервер|server/i,
    async run({ t, tool }) {
      const result = await tool(
        'save_mcp_server',
        {
          name: 'gitlab',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@example/gitlab-mcp'],
          env: { GITLAB_TOKEN: '' },
        },
        {
          say: t(
            'Добавлю сервер. Значение токена оставляю пустым — его введёте вы.',
            'Adding the server. I leave the token empty — you will type it.',
          ),
        },
      );
      if (/secret is needed/i.test(result.text))
        return t(
          'Сервер записан с пустым токеном. Откройте его правку в разделе «MCP-серверы» и введите значение там — мне его не присылайте.',
          'Server saved with an empty token. Open its edit form in MCP servers and type the value there — never send it to me.',
        );
      return outcomeReply(t, result, t('Сервер записан.', 'Server saved.'));
    },
  },
];

/** Программа заглушки (`PanelAgentProgram`). */
export async function panelAgentShotsProgram({ current, tool }) {
  // Метка маски ([КЛЮЧ_1]) русская при любом языке человека — язык решает остальной текст.
  const ru = /[а-яё]/i.test(current.replace(/\[[^\]]*\]/g, ''));
  const t = (ruText, enText) => (ru ? ruText : enText);
  const script = SCRIPTS.find((item) => item.when.test(current));
  return script
    ? script.run({ request: current, t, tool })
    : t(
        'Я умею только то, что есть в списке действий панели.',
        'I can only do what the panel action list offers.',
      );
}
