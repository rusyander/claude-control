/**
 * Сквозной ход агента панели над проектом (U4a). Кейс panel-agent-projects-004.
 *
 * Подменена только модель — фальшивый `claude` (`fake-cli-panel-agent-projects.mjs`)
 * на PATH одноразовой панели. Путь целиком настоящий: `POST /api/agent/run` →
 * процесс CLI с `--mcp-config` панели → переходник `tools/mcp/panel.mjs` →
 * действия проекта → карточки → решение человека (`/api/agent/pending/:id` с
 * Origin окна) → git временного репозитория.
 *
 * Свидетельства: состояние git на диске, строки `agent-cli.jsonl` (что модель
 * ПОЛУЧИЛА от панели) и ответ в файле разговора. Ветки: одобрено (ветка и
 * коммит в git), отклонено (ветки нет), чтение кода (токен не дошёл до модели;
 * блоки PEM проверяет интеграционный тест), push (действия нет).
 *
 * Стенд одноразовый: свой дом, свой PATH, свой репозиторий; стенд человека не
 * трогается. Запуск: `node tools/qa/check-agent-projects-walk.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_PANEL_AGENT_PROJECTS_CLI_SOURCE } from './fake-cli-panel-agent-projects.mjs';

const NAME = 'Проект прогулки';
// Ключ формы GitHub PAT, собранный на месте: детектор секретов обязан его узнать.
const TOKEN = `ghp_${'Z9y8X7w6V5'.repeat(4).slice(0, 36)}`;

let project = '';
let gitEnv = process.env;

await runOnStand(
  {
    label: 'agent-projects-walk',
    web: false,
    fakeCli: { claude: FAKE_PANEL_AGENT_PROJECTS_CLI_SOURCE },
    seed: ({ root }) => {
      project = join(root, 'walk-project');
      mkdirSync(project, { recursive: true });
      const gitConfig = join(root, 'gitconfig');
      writeFileSync(gitConfig, '');
      // Глобальный конфиг git человека не участвует: его шаблоны и excludes меняли бы итог.
      gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
      const git = (...args) =>
        execFileSync('git', args, {
          cwd: project,
          stdio: 'ignore',
          windowsHide: true,
          env: gitEnv,
        });
      git('init', '--initial-branch=main');
      git('config', 'user.email', 'qa@example.com');
      git('config', 'user.name', 'QA');
      git('config', 'core.autocrlf', 'false');
      writeFileSync(join(project, 'a.txt'), 'one\n');
      writeFileSync(join(project, 'secret.ts'), `export const token = '${TOKEN}';\n`);
      git('add', '.');
      git('commit', '-m', 'init');
    },
  },
  async (stand, check) => {
    // Без фронта окном панели считается адрес WEB_PORT = порт API + 1 (throwaway-stand).
    const origin = `http://127.0.0.1:${Number(new URL(stand.apiUrl).port) + 1}`;
    const gitOut = (...args) =>
      execFileSync('git', args, {
        cwd: project,
        encoding: 'utf8',
        windowsHide: true,
        env: gitEnv,
      }).trim();
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

    // ── Одобрено: ветка и коммит ─────────────────────────────────────────────
    writeFileSync(join(project, 'a.txt'), 'two\n');
    const approved = await turn(
      `Создай ветку feature/walk в проекте «${NAME}» и закоммить правки`,
      () => 'approve',
    );
    check(
      'одобрено: запуск принят (200)',
      approved.response.status === 200,
      approved.response.text.slice(0, 300),
    );
    check(
      'одобрено: две карточки danger — ветка и коммит',
      approved.cards.map((card) => `${card.name}:${card.risk}`).join(',') ===
        'git_create_branch:danger,git_commit:danger',
      JSON.stringify(approved.cards.map((card) => [card.name, card.risk])),
    );
    check(
      'одобрено: карточка несёт русскую сводку, не код',
      approved.cards.length > 0 &&
        approved.cards.every((card) => /[а-я]/i.test(card.preview?.summary ?? '')),
      JSON.stringify(approved.cards.map((card) => card.preview?.summary)),
    );
    check(
      'одобрено: git на ветке feature/walk',
      gitOut('branch', '--show-current') === 'feature/walk',
      gitOut('branch', '--show-current'),
    );
    check(
      'одобрено: коммит сделан, дерево чистое',
      gitOut('log', '-1', '--format=%s') === 'walk: feature/walk' &&
        gitOut('status', '--porcelain') === '',
      gitOut('log', '-1', '--format=%s'),
    );
    check(
      'одобрено: ответ агента называет сделанное',
      approved.reply.includes('Создал ветку feature/walk'),
      approved.reply,
    );

    // ── Отклонено: ветки нет ─────────────────────────────────────────────────
    const rejected = await turn(
      `Создай ветку feature/rejected в проекте «${NAME}» и закоммить правки`,
      () => 'reject',
    );
    check('отклонено: карточка показана', rejected.cards.length === 1);
    check(
      'отклонено: ветки feature/rejected в git нет',
      gitOut('branch', '--list', 'feature/rejected') === '',
    );
    check(
      'отклонено: ответ говорит, что ветка не создана',
      rejected.reply.startsWith('Ветка feature/rejected не создана'),
      rejected.reply,
    );

    // ── Чтение кода: токен до модели не доходит ──────────────────────────────
    const before = cliCalls().length;
    const read = await turn(`Покажи файл secret.ts проекта «${NAME}»`, () => 'reject');
    const readCalls = cliCalls().slice(before);
    const seenByModel = readCalls.map((call) => call.text).join('\n');
    check('чтение: ни одной карточки', read.cards.length === 0);
    check(
      'чтение: модель получила файл через read_project_file',
      readCalls.some((call) => call.name === 'read_project_file' && !call.isError) &&
        seenByModel.includes('export const token'),
      JSON.stringify(readCalls.map((call) => [call.name, call.isError])),
    );
    check(
      'чтение: токен до модели не дошёл',
      !seenByModel.includes(TOKEN),
      seenByModel.slice(0, 600),
    );
    check(
      'чтение: в ответе агента токена нет, файл назван',
      !read.reply.includes(TOKEN) && read.reply.includes('secret.ts'),
      read.reply.slice(0, 400),
    );

    // ── push: действия нет ────────────────────────────────────────────────────
    const pushBefore = cliCalls().length;
    const push = await turn(`Отправь проект «${NAME}» на сервер`, () => 'approve');
    const pushCall = cliCalls()
      .slice(pushBefore)
      .find((call) => call.name === 'git_push');
    check('push: ни одной карточки', push.cards.length === 0);
    check(
      'push: вызов git_push вернулся ошибкой',
      pushCall?.isError === true,
      JSON.stringify(pushCall),
    );
    check(
      'push: ответ агента — «Отправить не могу»',
      push.reply.startsWith('Отправить не могу'),
      push.reply,
    );
  },
);
