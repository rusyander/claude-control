/**
 * Помощник формы заполняет КАЖДОЕ поле каждой формы — и отбрасывает с объяснением
 * то, чего в панели нет. Владелец 28.09: в «Новом наборе» помощник ответил, что
 * умеет только имя, описание, «Когда» и переменные, — состав и проекты ему не
 * давались вовсе.
 *
 * Что гоняется: одноразовая панель (throwaway-stand) и фальшивый `claude`
 * (`fake-cli-assistant.mjs`), который пишет пришедшее задание в файл и отвечает
 * полями из `assistant-answers.json`. Путь целиком настоящий: окно формы →
 * POST /api/assist → сервер собирает задание → процесс CLI → ответ → поля формы.
 * Подменена только модель.
 *
 * Проверяется по каждой из восьми форм:
 *   - задание модели несёт каждое поле формы, а у перечислимых — допустимые
 *     значения с настоящими id стенда (модель выбирает из того, что есть);
 *   - поля на экране действительно изменились: отмечены участники и проект,
 *     выбран транспорт/событие/файл, стоят тексты и числа;
 *   - несуществующее отброшено и НАЗВАНО в ответе помощника, значение не того
 *     вида не применено и тоже названо.
 *
 * Лёгкое окно (U6, решение владельца D4 28.09) — по каждому запуску CLI:
 *   - argv: без инструментов (`--tools ""`), без сохранения сессии, без наших
 *     слоёв (`--setting-sources local`, `--disable-slash-commands`,
 *     `--strict-mcp-config`), без `--resume`; рабочий каталог — пустая временная
 *     папка, а не каталог сервера;
 *   - история — в самом задании: второй и третий ход группы несут прежние
 *     реплики; «только предложи» не меняет форму ни на байт;
 *   - секреты: MCP-сервер со значением переменной и заголовка открыт на правку,
 *     переменная с паролем в имени — ни одно значение не доходит до задания,
 *     маска в ответе возвращается секретом формы, испорченная — поле не
 *     тронуто и названо.
 *
 * Ничего не сохраняет. `--shots <dir> [--tag before|after]` — снимки формы группы.
 * `--server-dir <каталог>` — поднять копию сервера (прогон «до правки»).
 * `--prompts-out <файл>` — задания, собранные сервером для модели, одной строкой
 * JSON на форму: их можно отдать настоящему `claude` и проверить, что настоящая
 * модель отвечает в виде, который форма примет (здесь модель подменена).
 * `--race-discovery` — перед первым ходом запустить поиск групп и дождаться его
 * задания: так гонка, покрасившая прогон 05.10, воспроизводится каждый раз.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_ASSISTANT_CLI_SOURCE } from './fake-cli-assistant.mjs';

const argOf = (flag) => {
  const at = process.argv.indexOf(flag);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const SHOTS = argOf('--shots');
const TAG = argOf('--tag') ?? 'run';
const PROMPTS_OUT = argOf('--prompts-out');
const SERVER_DIR = argOf('--server-dir');
const RACE_DISCOVERY = process.argv.includes('--race-discovery');
let raced = false;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const MISSING_RULE = 'rule:qa-missing-rule';
const MISSING_PROJECT = 'C:/qa/missing-project';
const MASK = '••••••';
// Значения секретов: ни одно не должно дойти до задания модели.
const SECRET_ENV = 'qa-secret-env-7f3k2q';
// Флаг с секретом в аргументах stdio-сервера (заголовки у stdio не хранятся).
const SECRET_ARG = 'qa-secret-arg-9x8y7w';
// Ревью F3: формы значений, которые детектор резал или пропускал — пробел,
// `#`, аргумент с пробелом (`formatArgs` берёт его в кавычки).
const SECRET_SPACED = 'hunter two 7q';
const SECRET_HASHED = 'abc#def7XYZ';
const SECRET_ARG_SPACED = 'arg secret 5v';
const SECRET_TYPED = 'qa-typed-secret-5k2m';
// Секрет в файле скилла: помощник структуры видит маску, файл на диске — секрет.
const SECRET_STRUCT = 'qa-struct-secret-3h6j';
const STRUCT_LINE = `API_TOKEN=${SECRET_STRUCT}`;
const SECRET_STRUCT_QUOTED = 'struct pass 8w';
const structSkill = (line, quoted) =>
  `---\nname: qa-skill-secret\ndescription: QA skill with a secret.\n---\n\nUse the key:\n${line}\n\npassword: "${quoted}"\n`;
const STRUCT_SKILL = structSkill(STRUCT_LINE, SECRET_STRUCT_QUOTED);

await runOnStand(
  {
    label: 'assistant-fields',
    ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
    fakeCli: { claude: FAKE_ASSISTANT_CLI_SOURCE },
    seed: ({ home, cfg }) => {
      mkdirSync(join(home, 'qa-proj'), { recursive: true });
      mkdirSync(join(cfg, 'skills', 'qa-skill-secret'), { recursive: true });
      writeFileSync(join(cfg, 'skills', 'qa-skill-secret', 'SKILL.md'), STRUCT_SKILL, 'utf8');
    },
  },
  async (stand, check) => {
    // ── Сущности стенда, из которых помощник выбирает ─────────────────────
    const post = async (path, body) => {
      const res = await stand.api(path, { method: 'POST', body });
      check(`заведено ${path}`, res.status === 200, `${res.status} ${res.text.slice(0, 200)}`);
      return res.body;
    };
    await post('/rules', { title: 'QA rule alpha', body: 'Alpha.', isEnabled: true, groupIds: [] });
    await post('/skills', {
      name: 'qa-skill-alpha',
      description: 'QA skill.',
      body: 'Body.',
      groupIds: [],
    });
    await post('/hooks', {
      event: 'PreToolUse',
      matchers: ['Bash'],
      command: 'echo qa-hook-alpha',
      isEnabled: true,
      groupIds: [],
    });
    await post('/permissions', { pattern: 'Bash(qa-alpha:*)', decision: 'allow', groupIds: [] });
    await post('/mcp', {
      name: 'qa-mcp-alpha',
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      headers: {},
      groupIds: [],
    });
    await post('/mcp', {
      name: 'qa-mcp-secret',
      transport: 'stdio',
      command: 'node',
      args: ['--token', SECRET_ARG, '--api-key', SECRET_ARG_SPACED],
      env: { QA_API_TOKEN: SECRET_ENV, QA_DB_PASSWORD: SECRET_SPACED, QA_HASH_KEY: SECRET_HASHED },
      headers: {},
      groupIds: [],
    });
    await post('/groups', { name: 'QA nested group' });
    await post('/projects', { path: join(stand.home, 'qa-proj') });

    const list = async (path) => (await stand.api(path)).body ?? [];
    const rule = (await list('/rules')).find((item) => item.title === 'QA rule alpha');
    const skill = (await list('/skills')).find((item) => item.name === 'qa-skill-alpha');
    const hook = (await list('/hooks')).find((item) => item.command === 'echo qa-hook-alpha');
    const permission = (await list('/permissions')).find(
      (item) => item.pattern === 'Bash(qa-alpha:*)',
    );
    const mcp = (await list('/mcp')).find((item) => item.name === 'qa-mcp-alpha');
    const nested = (await list('/groups')).find((item) => item.name === 'QA nested group');
    const project = (await list('/projects'))[0];
    const templates = await list('/resources/skill/templates');
    const template = templates[0];
    check(
      'все сущности стенда найдены',
      Boolean(rule && skill && hook && permission && mcp && nested && project && template),
      JSON.stringify({ rule, skill, hook, permission, mcp, nested, project, template }).slice(
        0,
        400,
      ),
    );

    const members = [
      `rule:${rule.id}`,
      `skill:${skill.id}`,
      `hook:${hook.id}`,
      `mcp:${mcp.id}`,
      `permission:${permission.id}`,
      `group:${nested.id}`,
    ];

    // ── Ответы «модели» по формам ─────────────────────────────────────────
    // Список `[{ when, reply, fields }]` — ходы по подстроке текущей просьбы
    // (`fake-cli-assistant.mjs`); последний без `when` — «заполни всё».
    const answers = {
      group: [
        { when: 'только предложи', reply: 'QA-PROPOSE group: add a lint rule', fields: {} },
        {
          when: 'поменяй только описание',
          reply: 'QA-EDIT group',
          fields: { description: 'QA edited description' },
        },
        {
          fields: {
            name: 'QA bundle',
            when: 'QA work',
            envText: 'QA_BUNDLE=1',
            // Не того вида: описание — строка, не список.
            description: ['not', 'a', 'string'],
            members: [...members, MISSING_RULE],
            projectPaths: [project.path, MISSING_PROJECT],
          },
        },
      ],
      rule: { title: 'QA rule title', body: 'QA rule body' },
      skill: {
        name: 'qa-skill-new',
        description: 'QA skill description',
        body: 'QA skill body',
        structureTemplate: template.id,
      },
      hook: {
        event: 'PostToolUse',
        matchers: ['Bash', 'Write'],
        scriptName: 'qa-hook',
        template: 'shell',
        description: 'QA hook description',
        command: 'echo qa-shell',
        timeout: 45,
        // Поля, которого у формы нет.
        bogusField: 'x',
      },
      'MCP server': [
        {
          // Правка сервера с секретами: модель видела маски и вернула переменные
          // с маской на месте (вернуть можно) и аргументы с лишней маской (нельзя).
          when: 'добавь QA_MODE',
          reply: 'QA-SECRET MCP',
          fields: {
            envText: `QA_API_TOKEN=${MASK}\nQA_DB_PASSWORD=${MASK}\nQA_HASH_KEY=${MASK}\nQA_MODE=1`,
            args: `--token ${MASK} --api-key ${MASK} --extra ${MASK}`,
          },
        },
        {
          fields: {
            name: 'qa-mcp-new',
            transport: 'http',
            url: 'http://127.0.0.1:9/qa',
            headersText: 'Authorization=Bearer qa',
            envText: 'QA_MCP=1',
          },
        },
      ],
      'permission rule': { pattern: 'Bash(qa-new:*)', decision: 'deny' },
      'environment variable': [
        {
          when: 'поменяй комментарий',
          reply: 'QA-SECRET env',
          fields: { value: MASK, comment: 'QA secret comment' },
        },
        {
          // Имя с «PASSWORD»: значение — секрет, и следующий ход обязан его маскировать.
          fields: {
            key: 'QA_DB_PASSWORD',
            value: SECRET_TYPED,
            source: 'settings',
            comment: 'QA comment',
          },
        },
      ],
      script: { name: 'qa-script.mjs', content: 'console.log("qa");\n' },
      // Помощник структуры: SKILL.md — та же строка с маской (секрет вернётся),
      // notes.md — маска в новом файле (не пишется, названа), README.md — просто файл.
      structure: [
        {
          reply: 'QA-STRUCTURE secrets',
          files: [
            {
              path: 'SKILL.md',
              content: `${structSkill(`API_TOKEN=${MASK}`, MASK)}\n## Rollback\nRevert.\n`,
            },
            { path: 'notes.md', content: `token: ${MASK}\n` },
            { path: 'README.md', content: 'QA readme.\n' },
          ],
        },
      ],
    };
    writeFileSync(join(stand.bin, 'assistant-answers.json'), JSON.stringify(answers), 'utf8');

    const prompts = () => {
      const file = join(stand.bin, 'prompts.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { width: 1500, height: 1000 });

      /** Открыть форму создания; вернуть её окно. */
      const openForm = async (path, button, pick) => {
        await page.goto(`${stand.webUrl}${path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('nav');
        await page.locator('main').getByRole('button', { name: button }).first().click();
        if (pick) {
          const chooser = page.getByRole('dialog', { name: 'Какую группу создать' });
          await chooser.waitFor({ timeout: 5000 });
          await chooser.getByRole('button', { name: pick }).click();
          await page
            .locator('[role="dialog"][data-state="closed"]')
            .waitFor({ state: 'detached', timeout: 5000 })
            .catch(() => undefined);
        }
        const dialog = page.locator('[role="dialog"]').last();
        await dialog.locator('textarea[data-assistant-input]').waitFor({ timeout: 10000 });
        return dialog;
      };

      /**
       * Попросить помощника и дождаться его ответа в ленте. Не дождались —
       * проверка называет это провалом и идёт дальше: прогон «до правки» должен
       * показать все расхождения, а не первое.
       */
      const ask = async (
        dialog,
        kind,
        text = `QA: fill everything (${kind})`,
        replyText = `QA-REPLY ${kind}`,
      ) => {
        const before = prompts().length;
        if (RACE_DISCOVERY && !raced) {
          raced = true;
          await stand.api('/groups/discovery/run', { method: 'POST', body: {} });
          for (let i = 0; i < 50 && prompts().length === before; i += 1) await wait(100);
        }
        await dialog.locator('textarea[data-assistant-input]').fill(text);
        await dialog.getByRole('button', { name: 'Отправить' }).click();
        const answered = await dialog
          .locator('[data-assistant-message="assistant"]')
          .getByText(replyText)
          .waitFor({ timeout: 30000 })
          .then(() => true)
          .catch(() => false);
        check(`ответ помощника пришёл: «${text}»`, answered);
        await wait(300);
        // Задание этого хода — по виду формы и тексту просьбы, не по порядку: первый
        // заход на «Группы» сам запускает поиск групп (group-discover), и его задание
        // ложится в тот же prompts.jsonl в любой момент хода (красный прогон 05.10).
        return (
          prompts()
            .slice(before)
            .find((item) => item.kind === kind && item.request.includes(text))?.prompt ?? ''
        );
      };
      /** Поля, отмеченные под последним ответом помощника. */
      const lastChips = (dialog) =>
        dialog
          .locator('[data-assistant-message="assistant"]')
          .last()
          .locator('[data-assistant-changed] > *')
          .allInnerTexts();
      /** Всё, что стоит в окне: значения полей и отметки. */
      const formState = (dialog) =>
        dialog.evaluate((node) =>
          JSON.stringify(
            [...node.querySelectorAll('input, textarea, select')]
              .filter((element) => !element.hasAttribute('data-assistant-input'))
              .map((element) => (element.type === 'checkbox' ? element.checked : element.value)),
          ),
        );

      /** Все значения полей ввода окна: так видно, что стоит на экране. */
      const valuesOf = (dialog) =>
        dialog.evaluate((node) =>
          [...node.querySelectorAll('input:not([type=checkbox]), textarea, select')]
            .filter((element) => !element.hasAttribute('data-assistant-input'))
            .map((element) => element.value),
        );
      const shows = async (dialog, expected) => (await valuesOf(dialog)).includes(expected);
      const missedText = async (dialog) =>
        (await dialog.locator('[data-assistant-missed]').allInnerTexts()).join(' | ');
      const closeForm = async () => {
        await page.keyboard.press('Escape');
        await page
          .locator('[role="dialog"]')
          .first()
          .waitFor({ state: 'detached', timeout: 5000 })
          .catch(() => undefined);
      };

      // ── 1. Группа: состав и проекты ──────────────────────────────────────
      console.log('\n── Группа («Набор»)');
      {
        // Тайминг: реестр проектов придержан. Пока он не пришёл, задание собралось
        // бы по пустому списку («none exist yet») — под нагрузкой так и красилось
        // «настоящие id» (form-assistant-001, 06.10). Помощник обязан ждать.
        let releaseProjects = () => undefined;
        const projectsHeld = new Promise((resolve) => (releaseProjects = resolve));
        const projectsRoute = /\/api\/projects(\?|$)/;
        await page.route(projectsRoute, async (route) => {
          if (route.request().method() === 'GET') await projectsHeld;
          await route.continue();
        });
        const dialog = await openForm('/groups', 'Создать группу', /^Набор/);
        await dialog.locator('textarea[data-assistant-input]').fill('QA: рано');
        const hint = dialog.locator('[data-assistant-loading]');
        check('списки грузятся — помощник говорит, что ждёт', await hint.isVisible());
        check(
          'списки грузятся — отправка закрыта',
          await dialog.getByRole('button', { name: 'Отправить' }).isDisabled(),
        );
        const sentEarly = prompts().some((item) => item.request.includes('QA: рано'));
        await page.keyboard.press('Enter');
        await wait(500);
        check(
          'Enter до списков ничего не отправил',
          !sentEarly && !prompts().some((item) => item.request.includes('QA: рано')),
        );
        // Перехват остаётся до конца прогона: отпущенный, он пропускает запросы
        // сразу, а unroute при ждущих обработчиках рвёт их («already handled»).
        releaseProjects();
        check(
          'списки пришли — подсказка ушла',
          await hint
            .waitFor({ state: 'detached', timeout: 10000 })
            .then(() => true)
            .catch(() => false),
        );
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${TAG}-group-empty.png`) });
        const prompt = await ask(dialog, 'group');
        check(
          'задание модели называет состав и проекты',
          /- members:/.test(prompt) && /- projectPaths:/.test(prompt),
          prompt.slice(0, 600),
        );
        check(
          'в задании — настоящие id участников и путь проекта',
          // Значения в задании — строками JSON: обратные косые пути Windows удвоены.
          members.every((ref) => prompt.includes(JSON.stringify(ref))) &&
            prompt.includes(JSON.stringify(project.path)),
          [...members, project.path]
            .filter((ref) => !prompt.includes(JSON.stringify(ref)))
            .map((ref) => `нет ${JSON.stringify(ref)}`)
            .concat(prompt.split('\n').filter((line) => /- (members|projectPaths):/.test(line)))
            .join(' | ')
            .slice(0, 900),
        );
        check('имя стоит', await shows(dialog, 'QA bundle'));
        check('«Когда» стоит', await shows(dialog, 'QA work'));
        check('переменные стоят', await shows(dialog, 'QA_BUNDLE=1'));
        const rows = await dialog.evaluate((node) =>
          [...node.querySelectorAll('label')]
            .filter((label) => label.querySelector('input[type=checkbox]'))
            .map((label) => ({
              text: label.innerText,
              checked: label.querySelector('input[type=checkbox]').checked,
            })),
        );
        const checkedRow = (needle) => rows.some((row) => row.checked && row.text.includes(needle));
        for (const [label, needle] of [
          ['правило', 'QA rule alpha'],
          ['скилл', 'qa-skill-alpha'],
          ['хук', 'PreToolUse · Bash'],
          ['сервер', 'qa-mcp-alpha'],
          ['право', 'Bash(qa-alpha:*)'],
          ['вложенная группа', 'QA nested group'],
          ['проект', project.path],
        ]) {
          check(`отмечен ${label}`, checkedRow(needle), JSON.stringify(rows).slice(0, 500));
        }
        const missed = await missedText(dialog);
        check('несуществующий участник назван', missed.includes(MISSING_RULE), missed);
        check('несуществующий проект назван', missed.includes(MISSING_PROJECT), missed);
        check(
          'описание не того вида не применено и названо',
          missed.includes('description') && !(await shows(dialog, 'not,a,string')),
          missed,
        );
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${TAG}-group-filled.png`) });
        check(
          'задание учит виду значений (массив, число — по строке Value:)',
          /follows its field's "Value:" line/.test(prompt) &&
            /never a comma-separated string/.test(prompt),
          prompt.slice(-1500),
        );
        check(
          'задание учит «только предложить» — пустые fields',
          /only for suggestions[^]*"fields": \{\}/.test(prompt),
          prompt.slice(-1500),
        );

        // Ход 2 — только предложить: форма не меняется ни на байт.
        const stateBefore = await formState(dialog);
        const propose = await ask(
          dialog,
          'group',
          'QA: только предложи, что добавить, ничего не меняй (group)',
          'QA-PROPOSE group',
        );
        check(
          '«только предложи»: под ответом ни одного поля',
          (await lastChips(dialog)).length === 0,
        );
        check('«только предложи»: форма та же до байта', (await formState(dialog)) === stateBefore);
        check(
          'история — в задании второго хода (сессии нет)',
          propose.includes('Human: QA: fill everything (group)') &&
            propose.includes('Assistant: QA-REPLY group'),
          propose.slice(-1200),
        );

        // Ход 3 — поменяй одно: меняется ровно оно, история несёт оба прежних хода.
        const edit = await ask(
          dialog,
          'group',
          'QA: поменяй только описание (group)',
          'QA-EDIT group',
        );
        const chips = await lastChips(dialog);
        check(
          '«поменяй одно»: отмечено ровно описание',
          JSON.stringify(chips) === '["description"]',
          JSON.stringify(chips),
        );
        check('описание стоит', await shows(dialog, 'QA edited description'));
        check('имя не тронуто', await shows(dialog, 'QA bundle'));
        check(
          'история третьего хода — оба прежних, по порядку',
          edit.indexOf('Human: QA: fill everything (group)') > -1 &&
            edit.indexOf('Human: QA: fill everything (group)') <
              edit.indexOf('Human: QA: только предложи') &&
            edit.includes('Assistant: QA-PROPOSE group'),
          edit.slice(-1200),
        );
        await closeForm();
      }

      // ── 2. Правило ───────────────────────────────────────────────────────
      console.log('\n── Правило');
      {
        const dialog = await openForm('/rules', 'Добавить правило');
        await ask(dialog, 'rule');
        check('заголовок стоит', await shows(dialog, 'QA rule title'));
        check('текст стоит', await shows(dialog, 'QA rule body'));
        await closeForm();
      }

      // ── 3. Скилл: поля и заготовка структуры ─────────────────────────────
      console.log('\n── Скилл');
      {
        const dialog = await openForm('/skills', 'Создать скилл');
        const prompt = await ask(dialog, 'skill');
        check(
          'в задании — заготовки структуры с id',
          prompt.includes('- structureTemplate:') && prompt.includes(template.id),
        );
        check('имя стоит', await shows(dialog, 'qa-skill-new'));
        check('описание стоит', await shows(dialog, 'QA skill description'));
        check('инструкции стоят', await shows(dialog, 'QA skill body'));
        const pressed = await dialog.locator('[data-skill-template][aria-pressed="true"]').count();
        check('заготовка структуры выбрана (конструктор включён)', pressed === 1, String(pressed));
        await closeForm();
      }

      // ── 4. Хук: событие, фильтры, шаблон, таймаут ────────────────────────
      console.log('\n── Хук');
      {
        const dialog = await openForm('/hooks', 'Добавить хук');
        const prompt = await ask(dialog, 'hook');
        check('в задании есть таймаут', prompt.includes('- timeout:'));
        check('событие выбрано', await shows(dialog, 'PostToolUse'));
        check('фильтры отмечены', (await dialog.innerText()).includes('Bash|Write'));
        check('имя файла стоит', await shows(dialog, 'qa-hook'));
        check('описание стоит', await shows(dialog, 'QA hook description'));
        check('команда стоит', await shows(dialog, 'echo qa-shell'));
        check('таймаут стоит', await shows(dialog, '45'));
        const missed = await missedText(dialog);
        check('незнакомое поле названо', missed.includes('bogusField'), missed);
        await closeForm();
      }

      // ── 5. MCP-сервер ────────────────────────────────────────────────────
      console.log('\n── MCP-сервер');
      {
        const dialog = await openForm('/mcp', 'Добавить сервер');
        await ask(dialog, 'MCP server');
        check('имя стоит', await shows(dialog, 'qa-mcp-new'));
        check('транспорт выбран', await shows(dialog, 'http'));
        check('адрес стоит', await shows(dialog, 'http://127.0.0.1:9/qa'));
        check('заголовки стоят', await shows(dialog, 'Authorization=Bearer qa'));
        check('переменные стоят', await shows(dialog, 'QA_MCP=1'));
        await closeForm();
      }

      // ── 5b. MCP-сервер с секретами: правка ───────────────────────────────
      console.log('\n── MCP-сервер с секретами (правка)');
      {
        await page.goto(`${stand.webUrl}/mcp`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('nav');
        await page.getByRole('button', { name: 'Редактировать: qa-mcp-secret' }).click();
        const dialog = page.locator('[role="dialog"]').last();
        await dialog.locator('textarea[data-assistant-input]').waitFor({ timeout: 10000 });
        const envBefore = `QA_API_TOKEN=${SECRET_ENV}\nQA_DB_PASSWORD=${SECRET_SPACED}\nQA_HASH_KEY=${SECRET_HASHED}`;
        const argsBefore = `--token ${SECRET_ARG} --api-key "${SECRET_ARG_SPACED}"`;
        check(
          'форма правки держит настоящие значения секретов (их и надо прятать)',
          (await shows(dialog, envBefore)) && (await shows(dialog, argsBefore)),
          JSON.stringify(await valuesOf(dialog)),
        );
        const prompt = await ask(
          dialog,
          'MCP server',
          'QA: добавь QA_MODE=1 в переменные (MCP server)',
          'QA-SECRET MCP',
        );
        check(
          'секреты сервера до задания модели не дошли — только маска',
          [SECRET_ENV, SECRET_ARG, SECRET_SPACED, 'def7XYZ', SECRET_ARG_SPACED].every(
            (secret) => !prompt.includes(secret),
          ) && prompt.includes(MASK),
          prompt.slice(0, 1500),
        );
        check(
          'маска в ответе вернулась секретом формы',
          await shows(dialog, `${envBefore}\nQA_MODE=1`),
          JSON.stringify(await valuesOf(dialog)),
        );
        check(
          'испорченная маска: аргументы не тронуты',
          (await shows(dialog, argsBefore)) &&
            !(await valuesOf(dialog)).some((value) => value.includes(MASK)),
          JSON.stringify(await valuesOf(dialog)),
        );
        const missed = await missedText(dialog);
        check(
          'испорченная маска названа под ответом',
          missed.includes('args') && missed.includes('Секрет'),
          missed,
        );
        await closeForm();
      }

      // ── 6. Право ─────────────────────────────────────────────────────────
      console.log('\n── Право');
      {
        const dialog = await openForm('/permissions', 'Добавить правило');
        await ask(dialog, 'permission rule');
        check('шаблон стоит', await shows(dialog, 'Bash(qa-new:*)'));
        check(
          'решение «запретить» выбрано',
          (await dialog.innerText()).includes(
            'Claude не сможет это выполнить даже с подтверждением.',
          ),
        );
        await closeForm();
      }

      // ── 7. Переменная ────────────────────────────────────────────────────
      console.log('\n── Переменная');
      {
        const dialog = await openForm('/env', 'Добавить переменную');
        await ask(dialog, 'environment variable');
        check('имя стоит', await shows(dialog, 'QA_DB_PASSWORD'));
        check('значение стоит', await shows(dialog, SECRET_TYPED));
        check('файл выбран', await shows(dialog, 'settings'));
        check('комментарий стоит', await shows(dialog, 'QA comment'));
        // Второй ход: значение переменной с «PASSWORD» в имени уже в форме.
        const prompt = await ask(
          dialog,
          'environment variable',
          'QA: поменяй комментарий (environment variable)',
          'QA-SECRET env',
        );
        check(
          'значение секретной переменной до задания не дошло',
          !prompt.includes(SECRET_TYPED) && prompt.includes('QA_DB_PASSWORD'),
          prompt.slice(0, 1500),
        );
        check('маска вернулась значением формы', await shows(dialog, SECRET_TYPED));
        check('комментарий поменян', await shows(dialog, 'QA secret comment'));
        await closeForm();
      }

      // ── 8. Скрипт ────────────────────────────────────────────────────────
      console.log('\n── Скрипт');
      {
        const dialog = await openForm('/scripts', 'Добавить скрипт');
        await ask(dialog, 'script');
        check('имя стоит', await shows(dialog, 'qa-script.mjs'));
        check('код стоит', await shows(dialog, 'console.log("qa");\n'));
        await closeForm();
      }

      // ── 9. Помощник структуры: секрет в файле скилла ─────────────────────
      console.log('\n── Помощник структуры (секрет в файле)');
      {
        const skillDir = join(stand.cfg, 'skills', 'qa-skill-secret');
        await page.goto(`${stand.webUrl}/skills`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('nav');
        await page
          .getByRole('button', { name: 'Редактировать: qa-skill-secret' })
          .first()
          .click({ timeout: 30_000 });
        const scope = page.locator('[data-structure-assistant]');
        await scope.waitFor({ timeout: 20_000 });
        await scope.locator('textarea').fill('добавь раздел про откат');
        await scope.getByRole('button', { name: 'Собрать' }).click();
        await scope
          .getByText('QA-STRUCTURE secrets')
          .waitFor({ timeout: 60_000 })
          .catch(() => undefined);
        const kept = scope.locator('[data-structure-kept]');
        const keptText = (await kept.count()) > 0 ? await kept.innerText() : '';
        check(
          'файл с маской в новом месте назван под ответом',
          keptText.includes('notes.md'),
          keptText || 'строки нет',
        );
        if (SHOTS) {
          await scope.scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(SHOTS, `${TAG}-structure-kept.png`) });
        }
        const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
        check(
          'SKILL.md: маска вернулась секретом, правка записана',
          skill === `${STRUCT_SKILL}\n## Rollback\nRevert.\n`,
          skill.slice(-160),
        );
        check('notes.md не записан', !existsSync(join(skillDir, 'notes.md')));
        check('README.md записан', existsSync(join(skillDir, 'README.md')));
        const run = prompts().find((item) => item.kind === 'structure');
        check(
          'задание помощника структуры: секрета нет, маска есть',
          Boolean(run) &&
            !run.prompt.includes(SECRET_STRUCT) &&
            !run.prompt.includes(SECRET_STRUCT_QUOTED) &&
            run.prompt.includes(`API_TOKEN=${MASK}`),
        );
        await page.keyboard.press('Escape');
      }

      // ── Лёгкое окно: каждый запуск CLI за прогон ─────────────────────────
      console.log('\n── Лёгкое окно (argv и рабочий каталог каждого запуска)');
      {
        // Помощники (у них `kind`) — счётом; лёгкое окно и маска — у КАЖДОГО
        // запуска, включая служебные подписи групп (`-p --model haiku` через раннер).
        const all = prompts();
        const runs = all.filter((run) => run.kind);
        const own = all.filter((run) => !run.kind);
        const serverDir = join(REPO, 'apps', 'server').toLowerCase();
        const valueOf = (argv, flag) => {
          const at = argv.indexOf(flag);
          return at < 0 ? undefined : argv[at + 1];
        };
        const light = (run) =>
          run.argv.includes('--no-session-persistence') &&
          run.argv.includes('--tools') &&
          valueOf(run.argv, '--tools') === '' &&
          valueOf(run.argv, '--setting-sources') === 'local' &&
          run.argv.includes('--disable-slash-commands') &&
          run.argv.includes('--strict-mcp-config') &&
          !run.argv.includes('--resume');
        const tempCwd = (run) =>
          /cc-assistant-/.test(run.cwd) && !run.cwd.toLowerCase().startsWith(serverDir);
        check(`запусков помощников за прогон: ${runs.length} (ждём 13)`, runs.length === 13);
        const label = (run) => run.kind || `служебный ${JSON.stringify(run.argv.slice(0, 3))}`;
        const heavy = runs.filter((run) => !light(run));
        check(
          'каждый запуск помощника — без инструментов, сессии и наших слоёв, без --resume',
          runs.length > 0 && heavy.length === 0,
          heavy
            .slice(0, 2)
            .map((run) => `${label(run)}: ${JSON.stringify(run.argv)}`)
            .join(' | '),
        );
        const inServer = all.filter((run) => !tempCwd(run));
        check(
          'каждый запуск — в пустой временной папке, не в каталоге сервера',
          all.length > 0 && inServer.length === 0,
          inServer
            .slice(0, 2)
            .map((run) => `${label(run)}: ${run.cwd}`)
            .join(' | '),
        );
        // Служебные вызовы раннера (подписи групп) — тем же лёгким окном. Их число
        // зависит от очереди описаний; ноль — тоже честный ответ, строка это скажет.
        const heavyOwn = own.filter((run) => !light(run));
        check(
          `служебные вызовы модели (${own.length}) — лёгким окном`,
          heavyOwn.length === 0,
          heavyOwn
            .slice(0, 2)
            .map((run) => JSON.stringify(run.argv))
            .join(' | '),
        );
        const leaked = all.filter((run) =>
          [
            SECRET_ENV,
            SECRET_ARG,
            SECRET_TYPED,
            SECRET_STRUCT,
            SECRET_SPACED,
            'def7XYZ',
            SECRET_ARG_SPACED,
            SECRET_STRUCT_QUOTED,
          ].some((secret) => run.prompt.includes(secret)),
        );
        // Первый ход формы переменной пароль ещё не видел (форма пуста); дальше — только маска.
        check(
          'ни одно задание не несёт значения секретов',
          leaked.length === 0,
          leaked.map((run) => `${label(run)}: «${run.request}»`).join(' | '),
        );
      }

      check('ошибок страницы нет', page.errors.length === 0, page.errors.join(' | '));
    } finally {
      await browser.close();
      // Стенд сносится сразу после прогона — задания забираем до этого.
      if (PROMPTS_OUT) {
        const lines = prompts().map((p) => JSON.stringify(p));
        writeFileSync(PROMPTS_OUT, `${lines.join('\n')}\n`, 'utf8');
      }
    }
  },
);
