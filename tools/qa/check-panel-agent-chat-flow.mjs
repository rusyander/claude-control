/**
 * Сквозной ход агента панели над чатом проекта: «раздели задачи чата про X» →
 * агент находит чат, пишет в него, просит агента чата предложить разделение и
 * говорит человеку, какую кнопку нажать. Кейс panel-agent-013.
 *
 * Подменена только модель — фальшивый `claude` (`fake-cli-chat-flow.mjs`) на
 * PATH одноразовой панели; он же играет процесс чата. Путь целиком настоящий:
 * `POST /api/agent/run` → CLI с `--mcp-config` панели → переходник
 * `tools/mcp/panel.mjs` → действия → карточки → решение человека (POST с Origin
 * окна) → `/api/chat/send` → процесс чата → транскрипт → лента чата во фронте.
 *
 * Свидетельства: что дошло до процесса чата (`turns.jsonl`: сессия, текст хода),
 * дерево чата (плана разделения нет — применяет только человек), список
 * инструментов переходника (применить разделение нечем) и кнопка «Разделить на
 * 3 чата» на странице чата. Отрицательная ветка: отклонённые карточки — до
 * процесса чата не дошло ничего.
 *
 * Стенд одноразовый: свой дом, свой PATH; стенд человека не трогается.
 * Запуск: `node tools/qa/check-panel-agent-chat-flow.mjs`.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_CHAT_FLOW_CLI_SOURCE } from './fake-cli-chat-flow.mjs';

const TOPIC = 'страницу входа';
const SID = randomUUID();
const SENT = 'Сначала допиши README.';
const SPLIT_ASK = 'Split the tasks of this conversation';
const CHAT_ACTIONS = [
  'read_chat',
  'search_chats',
  'list_waiting',
  'send_chat_message',
  'request_split',
  'split_decline',
  'set_chat_group',
  'stop_chat_run',
  'split_control',
];

let project = '';

await runOnStand(
  {
    label: 'agent-chat-flow',
    fakeCli: { claude: FAKE_CHAT_FLOW_CLI_SOURCE },
    // Чат проекта с одним ходом — как его оставил бы настоящий CLI.
    seed: ({ root, cfg }) => {
      project = join(root, 'project');
      mkdirSync(project, { recursive: true });
      const dir = join(cfg, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'));
      mkdirSync(dir, { recursive: true });
      const at = new Date().toISOString();
      const line = (type, content) =>
        JSON.stringify({
          type,
          uuid: randomUUID(),
          sessionId: SID,
          cwd: project,
          timestamp: at,
          message: { role: type, ...(type === 'assistant' ? { model: 'claude-x' } : {}), content },
        });
      writeFileSync(
        join(dir, `${SID}.jsonl`),
        `${[
          line('user', `Сделай ${TOPIC}, тесты к ней и README`),
          line('assistant', [{ type: 'text', text: 'Начинаю со страницы.' }]),
        ].join('\n')}\n`,
        'utf8',
      );
    },
  },
  async (stand, check) => {
    const origin = stand.webUrl;
    const lines = (name) => {
      const file = join(stand.bin, name);
      return existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    };
    const tree = async () => (await stand.api(`/chat/${encodeURIComponent(SID)}/tree`)).body;

    /** Один ход агента; карточки решаются так, как их решил бы человек в окне. */
    async function turn(conversationId, content, decide) {
      const cards = [];
      let settled = false;
      const running = fetch(`${stand.apiUrl}/api/agent/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          messages: [{ role: 'user', content }],
          conversationId,
          context: { route: '/chat' },
        }),
      })
        .then(async (res) => ({ status: res.status, text: await res.text() }))
        .finally(() => (settled = true));
      const seen = new Set();
      for (let t = 0; t < 180_000 && !settled; t += 200) {
        for (const card of (await stand.api('/agent/pending')).body ?? []) {
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
      return { response, cards, reply: conversation?.messages?.at(-1)?.content ?? '' };
    }

    const listed = (await stand.api('/chats')).body ?? [];
    check(
      'засеянный чат виден панели',
      listed.some((chat) => chat.id === SID),
      JSON.stringify(listed.map((chat) => [chat.id, chat.title])),
    );

    // ── Отрицательная ветка: человек отклоняет обе карточки ────────────────
    const rejected = await turn(
      `walk-${randomUUID()}`,
      `Раздели задачи чата про ${TOPIC}`,
      () => 'reject',
    );
    check('отказ: запуск принят (200)', rejected.response.status === 200);
    check(
      'отказ: показаны две карточки — сообщение и просьба о разделении',
      rejected.cards.map((card) => card.name).join(',') === 'send_chat_message,request_split',
      JSON.stringify(rejected.cards.map((card) => card.name)),
    );
    check(
      'отказ: до процесса чата не дошло ничего',
      lines('turns.jsonl').length === 0,
      JSON.stringify(lines('turns.jsonl')),
    );
    check(
      'отказ: агент говорит, что разделение не запрошено',
      rejected.reply.startsWith('Разделение не запрошено'),
      rejected.reply,
    );

    // ── Ход: «раздели задачи чата про X», человек одобряет ─────────────────
    const approved = await turn(
      `walk-${randomUUID()}`,
      `Раздели задачи чата про ${TOPIC}`,
      () => 'approve',
    );
    check(
      'ход: запуск принят (200)',
      approved.response.status === 200,
      approved.response.text.slice(0, 400),
    );
    check(
      'ход: две карточки, обе — опасные (человек подтверждает запись в чат)',
      approved.cards.length === 2 &&
        approved.cards.every((card) => card.risk === 'danger') &&
        approved.cards.map((card) => card.name).join(',') === 'send_chat_message,request_split',
      JSON.stringify(approved.cards.map((card) => [card.name, card.risk])),
    );
    const turns = lines('turns.jsonl');
    check(
      'чат: сообщение агента дошло до процесса ЭТОГО чата (та же сессия, та же папка)',
      turns.some((entry) => entry.prompt === SENT && entry.sid === SID && entry.cwd === project),
      JSON.stringify(turns.map((entry) => [entry.sid, entry.cwd, entry.prompt.slice(0, 60)])),
    );
    // Текст кнопки «Разделить задачи по чатам» — его отдаёт сервер, второй копии нет.
    const buttonAsk = (await stand.api(`/chat/split/request?path=${encodeURIComponent(project)}`))
      .body?.prompt;
    check(
      'чат: просьба о разделении — ровно текст кнопки сервера, в той же сессии',
      typeof buttonAsk === 'string' &&
        buttonAsk.startsWith(SPLIT_ASK) &&
        turns.some((entry) => entry.prompt === buttonAsk && entry.sid === SID),
      JSON.stringify(turns.map((entry) => entry.prompt.slice(0, 60))),
    );
    const calls = lines('agent-cli.jsonl');
    const splitRead = calls.filter((call) => call.name === 'read_chat').at(-1);
    check(
      'агент прочёл предложение из чата действием read_chat',
      Boolean(splitRead && !splitRead.isError && splitRead.text.includes('"splitProposal"')),
      splitRead?.text.slice(0, 400),
    );
    check(
      'ответ агента называет кнопку человека «Разделить на 3 чата»',
      approved.reply.includes('«Разделить на 3 чата»'),
      approved.reply,
    );

    // Применяет только человек: у агента нечем, и плана разделения нет.
    const tools = JSON.parse(stand.read(join(stand.bin, 'agent-tools.json')) ?? '[]');
    const names = tools.map((item) => item.name);
    check(
      'переходник отдаёт все девять действий над чатами',
      CHAT_ACTIONS.every((name) => names.includes(name)),
      CHAT_ACTIONS.filter((name) => !names.includes(name)).join(', '),
    );
    const modes = tools.find((item) => item.name === 'split_control')?.inputSchema?.properties?.mode
      ?.enum;
    check(
      'применить или отменить разделение агенту нечем',
      !names.some((name) => /apply|cancel|cleanup/.test(name) && /split/.test(name)) &&
        Array.isArray(modes) &&
        !modes.some((mode) => /apply|cancel|cleanup|force/.test(mode)),
      JSON.stringify({ modes, split: names.filter((name) => /split/.test(name)) }),
    );
    const afterTurn = await tree();
    check(
      'плана разделения нет — человек ещё не нажал',
      !afterTurn?.split,
      JSON.stringify(afterTurn),
    );
    const chatsNow = (await stand.api('/chats')).body ?? [];
    check('новых чатов не заведено', chatsNow.length === 1, String(chatsNow.length));

    // Кнопка — у человека, в ленте чата.
    const browser = await chromium.launch();
    const splitPosts = [];
    try {
      const page = await stand.newPage(browser);
      page.on('request', (request) => {
        if (request.method() === 'POST' && /\/api\/chat\/split(\/|$|\?)/.test(request.url())) {
          splitPosts.push(request.url());
        }
      });
      const url = `${stand.webUrl}/chat?id=${encodeURIComponent(SID)}`;
      await page.goto(url);
      const button = page.getByRole('button', { name: 'Разделить на 3 чата' });
      const visible = await button
        .first()
        .waitFor({ timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      check('страница открыта по адресу чата', page.url() === url, page.url());
      check('в чате видна кнопка «Разделить на 3 чата»', visible);
      check('кнопка доступна человеку', visible && (await button.first().isEnabled()));
      await wait(1500);
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
    check(
      'никто не нажал разделение: POST /api/chat/split не уходил',
      splitPosts.length === 0,
      splitPosts.join('\n'),
    );
    const finalTree = await tree();
    check('и после показа кнопки плана нет', !finalTree?.split, JSON.stringify(finalTree));
  },
);
