#!/usr/bin/env node
/**
 * Фальшивый `claude` для кадров раздела «Агент панели» — подменена ТОЛЬКО модель.
 *
 * Всё остальное на пути настоящее, и ради этого файл и существует. Панель
 * запускает его тем же маршрутом `POST /api/agent/run`, теми же флагами и с тем
 * же `mcp.json`, что и живой CLI; он поднимает из этого `mcp.json` настоящий
 * переходник `tools/mcp/panel.mjs` и зовёт его инструменты по MCP. Значит,
 * карточка подтверждения в кадре пришла от реестра действий панели, дифф
 * посчитан её предпросмотром, строка «выполнено» — её исходом, а след действий
 * и файл разговора записала она сама. Сыграна по сценарию только реплика модели.
 *
 * Сценарий выбирается по последней реплике человека (русской или английской) и
 * отвечает на её языке. Ход печатается строками stream-json — тем форматом,
 * который разбирает `domains/panel-agent/runner.ts`.
 *
 * Заодно файл ведёт честный журнал того, что модель ПОЛУЧИЛА (`CC_FAKE_SEEN`):
 * кадр «ключ в чат не уходит» опирается на него, а не на слова.
 */
import { createRequire } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'apps', 'server', 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require('@modelcontextprotocol/sdk/client/stdio.js');

const PREFIX = 'mcp__agentdeck-panel__';

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const say = (text) => emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

function argValue(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const prompt = await readStdin();
const marker = 'Human (current request): ';
const request = prompt.includes(marker)
  ? prompt.slice(prompt.lastIndexOf(marker) + marker.length)
  : prompt;
// Метка маски ([КЛЮЧ_1]) русская при любом языке человека — язык решает остальной текст.
const ru = /[а-яё]/i.test(request.replace(/\[[^\]]*\]/g, ''));
const t = (ruText, enText) => (ru ? ruText : enText);

if (process.env.CC_FAKE_SEEN) {
  appendFileSync(process.env.CC_FAKE_SEEN, `${JSON.stringify({ request })}\n`, 'utf8');
}

// Переходник — ровно из того конфига, который панель положила во временную папку.
const config = JSON.parse(readFileSync(argValue('--mcp-config'), 'utf8'));
const bridge = Object.values(config.mcpServers)[0];
const client = new Client({ name: 'help-shots-fake-model', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: bridge.command,
    args: bridge.args,
    env: { ...getDefaultEnvironment(), ...bridge.env },
  }),
);

let seq = 0;
/** Вызов инструмента: шаг в ленте, настоящий вызов переходника, итог шага. */
async function tool(name, input) {
  seq += 1;
  const id = `toolu_${seq}`;
  emit({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: `${PREFIX}${name}`, input }] },
  });
  const answer = await client.callTool({ name, arguments: input }, undefined, {
    timeout: 11 * 60_000,
  });
  const text = (answer.content ?? []).map((part) => part.text ?? '').join('\n');
  emit({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, is_error: answer.isError === true }],
    },
  });
  return { text, isError: answer.isError === true };
}

/** JSON, который переходник кладёт после «Done.» — из него модель берёт id. */
function doneJson(text) {
  const start = text.indexOf('\n');
  try {
    return JSON.parse(text.slice(start + 1));
  } catch {
    return undefined;
  }
}

const outcomeReply = (result, done) => {
  if (/REJECTED/.test(result.text)) {
    return t(
      'Вы отклонили — ничего не выполнено. Что сделать вместо этого?',
      'You rejected it — nothing was done. What should I do instead?',
    );
  }
  if (/secret is needed/i.test(result.text)) {
    return t(
      'Сохранено без ключа. Панель открыла своё поле — введите ключ там, мне его не присылайте.',
      'Saved without the key. The panel opened its own field — type the key there, never send it to me.',
    );
  }
  if (/target changed/i.test(result.text)) {
    return t(
      'Карточка устарела: файл изменился после показа. Перечитаю и покажу новую, если скажете.',
      'The card went stale: the file changed after it was shown. Say so and I will show a fresh one.',
    );
  }
  if (result.isError) {
    return t(
      `Панель не выполнила действие: ${result.text.replace(/^.*?: /, '')}`,
      `The panel did not do it: ${result.text.replace(/^.*?: /, '')}`,
    );
  }
  return done;
};

const SCRIPTS = [
  {
    when: /проект|project/i,
    async run() {
      const path = request.match(/[A-Za-z]:[\\/][^\s«»"]+/)?.[0] ?? '';
      say(
        t(
          'Добавлю проект — подтвердите карточку.',
          'Adding the project — please confirm the card.',
        ),
      );
      const result = await tool('create_project', { path, name: t('Магазин', 'Shop') });
      if (result.isError || !/^Done/.test(result.text)) return outcomeReply(result, '');
      // Как велит системная дописка: open_page — только если действие само
      // страницу не открыло.
      if (!/panel opened/i.test(result.text)) await tool('open_page', { route: '/projects' });
      return t(
        'Проект «Магазин» добавлен, открыл страницу «Проекты».',
        'Project “Shop” added; I opened the Projects page.',
      );
    },
  },
  {
    when: /удали|delete/i,
    async run() {
      const listed = await tool('list_rules', {});
      const rules = doneJson(listed.text)?.rules ?? doneJson(listed.text) ?? [];
      const rule = (Array.isArray(rules) ? rules : []).find((item) =>
        /русск|Russian/i.test(`${item.title} ${item.body ?? ''}`),
      );
      if (!rule) return t('Такого правила не нашёл.', 'I could not find that rule.');
      say(
        t(
          'Удаление необратимо — проверьте карточку.',
          'Deleting cannot be undone — check the card.',
        ),
      );
      // Пауза «модель думает» длиннее двух секунд после Enter человека: карточка,
      // пришедшая раньше, фокус не берёт — человек ещё считается печатающим.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const result = await tool('delete_rule', { id: rule.id });
      return outcomeReply(result, t('Правило удалено.', 'Rule deleted.'));
    },
  },
  {
    when: /правил|rule/i,
    async run() {
      // Текст правила — всё после двоеточия: «Добавь правило: сначала тесты».
      const text = (request.split(/[:：]/).slice(1).join(':').trim() || request).replace(/\.$/, '');
      const title = text.charAt(0).toUpperCase() + text.slice(1);
      say(
        t(
          'Готовлю правило — посмотрите, что изменится в файле.',
          'Preparing the rule — see what changes in the file.',
        ),
      );
      const result = await tool('save_rule', { title, body: `${title}.` });
      return outcomeReply(
        result,
        t('Правило записано в CLAUDE.md.', 'The rule is written to CLAUDE.md.'),
      );
    },
  },
  {
    when: /контур|contour/i,
    async run() {
      say(
        t(
          'Сохраню черновик контура. Ключ я не принимаю — его вводите вы.',
          'I will save a contour draft. I never take the key — you type it.',
        ),
      );
      const result = await tool('save_contour_draft', {
        id: 'corp',
        title: t('Контур отдела', 'Team contour'),
        baseUrl: 'http://gateway.corp.internal:8080',
      });
      return outcomeReply(result, t('Черновик сохранён.', 'Draft saved.'));
    },
  },
  {
    when: /\[[A-ZА-ЯЁ_]+_\d+\]|ключ|key/i,
    async run() {
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
    async run() {
      say(
        t(
          'Добавлю сервер. Значение токена оставляю пустым — его введёте вы.',
          'Adding the server. I leave the token empty — you will type it.',
        ),
      );
      const result = await tool('save_mcp_server', {
        name: 'gitlab',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/gitlab-mcp'],
        env: { GITLAB_TOKEN: '' },
      });
      if (/secret is needed/i.test(result.text)) {
        return t(
          'Сервер записан с пустым токеном. Откройте его правку в разделе «MCP-серверы» и введите значение там — мне его не присылайте.',
          'Server saved with an empty token. Open its edit form in MCP servers and type the value there — never send it to me.',
        );
      }
      return outcomeReply(result, t('Сервер записан.', 'Server saved.'));
    },
  },
];

let reply;
try {
  const script = SCRIPTS.find((item) => item.when.test(request));
  reply = script
    ? await script.run()
    : t(
        'Я умею только то, что есть в списке действий панели.',
        'I can only do what the panel action list offers.',
      );
} finally {
  await client.close().catch(() => undefined);
}
if (reply) say(reply);
emit({ type: 'result', result: reply ?? '', is_error: false });
process.exit(0);
