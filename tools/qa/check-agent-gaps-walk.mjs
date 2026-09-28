/**
 * Сквозной ход агента панели по действиям, закрывшим пробелы реестра
 * возможностей (дорожка A, 28.09). Кейс panel-agent-walks-003.
 *
 * Подменена только модель — фальшивый `claude` (`fake-cli-panel-agent-gaps.mjs`)
 * на PATH одноразовой панели. Путь целиком настоящий: `POST /api/agent/run` →
 * процесс CLI с `--mcp-config` панели → переходник `tools/mcp/panel.mjs` →
 * действия → карточки → решение человека (`/api/agent/pending/:id` с Origin
 * окна) → настройка проекта в `state.json`.
 *
 * Свидетельства: ответ маршрута подбора модели, строки `agent-cli.jsonl` (что
 * модель ПОЛУЧИЛА от панели) и ответ в файле разговора. Ветки: правки агента в
 * чате (чтение, без карточки), собственный `.claude` проекта (ключ из команды
 * хука до модели не дошёл), папка вне реестра (отказ до карточки), подбор
 * модели: отклонено (не изменился) и одобрено (изменился).
 *
 * Проект в просьбах назван ИМЕНЕМ, не путём: имя временного каталога стенда
 * (`cc-agent-gaps-walk-32tvF6`) детектор секретов панели примерно в 5% запусков
 * принимает за ключ и маскирует в просьбе человека — ход тогда проверял бы маску,
 * а не действие. Чужая папка — путём: отказ приходит и по маске.
 *
 * Стенд одноразовый: свой дом, свой PATH; стенд человека не трогается.
 * Запуск: `node tools/qa/check-agent-gaps-walk.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_PANEL_AGENT_GAPS_CLI_SOURCE } from './fake-cli-panel-agent-gaps.mjs';

const NAME = 'Проект пробелов';
// Ключ формы GitHub PAT, собранный на месте: детектор секретов обязан его узнать.
const TOKEN = `ghp_${'Gw4pS8kL2m'.repeat(4).slice(0, 36)}`;
const CHAT = randomUUID();

let project = '';
let outside = '';

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
};

await runOnStand(
  {
    label: 'agent-gaps-walk',
    web: false,
    fakeCli: { claude: FAKE_PANEL_AGENT_GAPS_CLI_SOURCE },
    seed: ({ root, cfg }) => {
      project = join(root, 'gaps-project');
      outside = join(root, 'outside');
      write(join(project, 'a.ts'), 'const a = 1;\n');
      write(
        join(project, '.claude', 'skills', 'deploy', 'SKILL.md'),
        '---\nname: deploy\ndescription: Выкладка\n---\n',
      );
      write(
        join(project, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: `curl -H "token ${TOKEN}" x` }] }],
          },
        }),
      );
      write(join(project, '.claude', 'rules', 'style.md'), '# Стиль\n');
      write(join(outside, '.claude', 'rules', 'foreign.md'), '# Чужое\n');
      const gitConfig = join(root, 'gitconfig');
      writeFileSync(gitConfig, '');
      const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
      const git = (...args) =>
        execFileSync('git', args, {
          cwd: project,
          stdio: 'ignore',
          windowsHide: true,
          env: gitEnv,
        });
      git('init', '--initial-branch=main');
      git('-c', 'user.email=qa@example.com', '-c', 'user.name=QA', 'add', '.');
      git('-c', 'user.email=qa@example.com', '-c', 'user.name=QA', 'commit', '-m', 'init');
      // Разговор, где агент чата заменил строку в a.ts, — транскрипт там, где его ищет панель.
      // +2/-1, а не +1/-1: перепутанные счётчики иначе не отличить от верных.
      writeFileSync(join(project, 'a.ts'), 'const a = 10;\nconst b = 2;\n');
      const records = [
        {
          type: 'user',
          uuid: randomUUID(),
          sessionId: CHAT,
          cwd: project,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'Поправь a.ts' },
        },
        {
          type: 'assistant',
          uuid: randomUUID(),
          sessionId: CHAT,
          cwd: project,
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-1',
                name: 'Edit',
                input: {
                  file_path: join(project, 'a.ts'),
                  old_string: 'const a = 1;',
                  new_string: 'const a = 10;\nconst b = 2;',
                },
              },
            ],
          },
        },
      ];
      write(
        join(cfg, 'projects', 'gaps-project', `${CHAT}.jsonl`),
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
    },
  },
  async (stand, check) => {
    // Без фронта окном панели считается адрес WEB_PORT = порт API + 1 (throwaway-stand).
    const origin = `http://127.0.0.1:${Number(new URL(stand.apiUrl).port) + 1}`;
    const cliCalls = () => {
      const file = join(stand.bin, 'agent-cli.jsonl');
      return existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    };
    const registered = await stand.api('/projects', {
      method: 'POST',
      headers: { origin },
      body: { path: project, name: NAME },
    });
    check('проект зарегистрирован', registered.status === 200, registered.text.slice(0, 300));
    const cascade = async () =>
      (await stand.api(`/chat/cascade?path=${encodeURIComponent(project)}`)).body?.enabled;

    async function turn(content, decide) {
      const conversationId = `walk-${randomUUID()}`;
      const cards = [];
      let settled = false;
      const running = fetch(`${stand.apiUrl}/api/agent/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          messages: [{ role: 'user', content }],
          conversationId,
          context: { route: '/projects' },
        }),
      })
        .then(async (res) => ({ status: res.status, text: await res.text() }))
        .finally(() => (settled = true));
      const seen = new Set();
      for (let t = 0; t < 120_000 && !settled; t += 200) {
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

    // ── Правки агента в чате: чтение без карточки ────────────────────────────
    const changes = await turn(`Что поменял агент в чате «${CHAT}»?`, () => 'reject');
    check('правки: запуск принят (200)', changes.response.status === 200, changes.response.text);
    check('правки: ни одной карточки', changes.cards.length === 0);
    check(
      'правки: ответ называет a.ts +2/-1',
      changes.reply === 'Файлы: a.ts +2/-1',
      changes.reply,
    );

    // ── Собственный .claude проекта: ключ из команды хука до модели не дошёл ──
    const before = cliCalls().length;
    const local = await turn(`Что в .claude проекта «${NAME}»?`, () => 'reject');
    const localCall = cliCalls()
      .slice(before)
      .find((item) => item.name === 'read_project_local_config');
    check('.claude: ни одной карточки', local.cards.length === 0);
    check(
      '.claude: ответ называет скилл, правило и хук Stop',
      local.reply.startsWith('Скиллы: deploy; правила: style.md; хуки: Stop curl'),
      local.reply,
    );
    check(
      '.claude: ключ из команды хука не дошёл до модели и не попал в ответ',
      localCall?.isError === false &&
        !JSON.stringify(localCall).includes(TOKEN) &&
        !local.reply.includes(TOKEN),
      JSON.stringify(localCall)?.slice(0, 400),
    );

    // ── Папка вне реестра: отказ до карточки ─────────────────────────────────
    const foreign = await turn(`Что в .claude папки «${outside}»?`, () => 'approve');
    check('чужая папка: ни одной карточки', foreign.cards.length === 0);
    check(
      'чужая папка: ответ передаёт отказ панели «not registered»',
      foreign.reply.startsWith('Папка не прочитана') && foreign.reply.includes('not registered'),
      foreign.reply,
    );
    check('чужая папка: правило чужой папки не прочитано', !foreign.reply.includes('foreign.md'));

    // ── Подбор модели: отклонено, затем одобрено ─────────────────────────────
    const initial = await cascade();
    check('подбор модели: состояние читается', typeof initial === 'boolean', String(initial));
    const verb = initial ? 'Выключи' : 'Включи';
    const rejected = await turn(`${verb} подбор модели в проекте «${NAME}»`, () => 'reject');
    check(
      'отклонено: одна карточка set_model_cascade:change с русской сводкой',
      rejected.cards.length === 1 &&
        rejected.cards[0].name === 'set_model_cascade' &&
        rejected.cards[0].risk === 'change' &&
        /[а-я]/i.test(rejected.cards[0].preview?.summary ?? ''),
      JSON.stringify(rejected.cards.map((card) => [card.name, card.risk, card.preview?.summary])),
    );
    check('отклонено: переключатель не изменился', (await cascade()) === initial);
    check(
      'отклонено: ответ говорит, что не изменён',
      rejected.reply.startsWith('Подбор модели не изменён'),
      rejected.reply,
    );
    const approved = await turn(`${verb} подбор модели в проекте «${NAME}»`, () => 'approve');
    check('одобрено: одна карточка', approved.cards.length === 1);
    check('одобрено: переключатель изменился', (await cascade()) === !initial);
    check(
      'одобрено: ответ называет сделанное',
      approved.reply === `Подбор модели ${initial ? 'выключен' : 'включён'}.`,
      approved.reply,
    );
  },
);
