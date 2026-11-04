/**
 * Вопрос права ядра в чате `/chat` (этап 10, F2b) — настоящая дорога человека: одноразовая панель с
 * фронтом, своё ядро, НАСТОЯЩИЙ `claude` из PATH, Chromium (Playwright) кликает в окне чата; модель —
 * сценарий `packages/stub-model` в этом процессе (единственное, что подменено). В конфиге ядра
 * `grantRequired` на `guarded/**` проекта, модель правит `guarded/aN.txt` инструментом Write.
 *
 * Ответ `answer` и грант у ядра — класс human-strict (06 §Authority): ядро примет их только с числом
 * страницы браузера при чистом пире. Поэтому:
 *   1. тумблер автоподтверждения выключен (клик в меню чата): ядро отказало правке пунктом 5,
 *      вопрос права — карточкой «Агент просит разрешение» в окне чата, файл не записан, ответа
 *      ядру без человека нет;
 *   2. клик «Разрешить» на карточке: окно шлёт ядру грант (путь отказа) и ответ `grant` — в журнале
 *      задачи `grant.given` и `human.answered grant`, ни одного `command.rejected`; карточка снята;
 *      тот же ход дописывает файл (модель повторяет Write, пока файла нет);
 *   3. маршрут карточки сервера (`/api/chat/:id/permission-decision`) на вопрос ядра отвечает
 *      названным отказом `core_permit_browser_only`, а не тихим «принято»;
 *   4. клик тумблера «включить»: окно само выдаёт задаче грант правки `**` — следующий ход правит
 *      `guarded/a2.txt` без вопроса права (в журнале нет `human.asked` источника `permit` этого хода),
 *      файл записан.
 *
 * Вход модели — `env` личного settings.json стенда (адрес заглушки и ключ), как у человека со
 * своим адресом модели (см. check-core-chat.mjs). Нет `claude` в PATH — «не проверено» (код 2).
 *
 * Запуск: `node tools/qa/check-core-permit-auto.mjs` (стенд свой, `pnpm dev` не нужен).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';
import { cliDir } from './panel-agent-core-stand.mjs';
import { openProjectChat } from './chat-walk.mjs';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const MARK = /правка-(\d+)/;
/** Сколько раз модель повторяет Write за ход, пока файла нет (с паузой) — окно для клика. */
const RETRIES = 90;
const RETRY_HOLD_MS = 1000;

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b?.type === 'text')
          .map((b) => b.text ?? '')
          .join('\n')
      : '';

/**
 * Сценарий модели: ход «правка-N» → Write в `guarded/aN.txt`; после результата инструмента —
 * снова Write с паузой, пока файла нет (ядро отказало и ждёт ответа человека), файл есть — текст
 * «записано-N». Первый Write хода держится паузой: модель «думает» — как живая модель, это время,
 * за которое команда окна доходит до ядра.
 */
function editScript(repo) {
  return (ctx) => {
    const messages = Array.isArray(ctx.request.body?.messages) ? ctx.request.body.messages : [];
    let at = -1;
    messages.forEach((m, i) => {
      if (m?.role === 'user' && MARK.test(textOf(m.content))) at = i;
    });
    if (at < 0) return { text: 'stub side reply' };
    const turn = MARK.exec(textOf(messages[at].content))[1];
    const file = join(repo.dir, 'guarded', `a${turn}.txt`);
    const results = messages
      .slice(at + 1)
      .filter(
        (m) =>
          m?.role === 'user' &&
          Array.isArray(m.content) &&
          m.content.some((b) => b?.type === 'tool_result'),
      ).length;
    if (existsSync(file)) return { text: `записано-${turn}` };
    if (results >= RETRIES) return { text: `не записано-${turn}` };
    const writer = ctx.info.tools.find((t) => t.name === 'Write');
    if (!writer) return { text: `нет Write: ${ctx.info.tools.map((t) => t.name)}` };
    return {
      holdMs: results === 0 ? 4000 : RETRY_HOLD_MS,
      tool: { name: 'Write', args: { file_path: file, content: `правка ${turn}\n` } },
    };
  };
}

const dir = cliDir('claude');
const repo = { dir: '' };
const model = await startStubModel({ script: editScript(repo) });
const stubEnv = { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };

try {
  await runOnStand(
    {
      label: 'core-permit-auto',
      core: true,
      // Черновик разговора тумблера не держит (чата ещё нет): ход 1 идёт за общей настройкой.
      settings: { chatAutoMode: false },
      env: stubEnv,
      ...(dir ? { extraPath: [dir] } : {}),
      seed: ({ root, cfg, coreHome }) => {
        repo.dir = join(root, 'repo');
        mkdirSync(join(repo.dir, 'guarded'), { recursive: true });
        const git = (...a) => execFileSync('git', a, { cwd: repo.dir, encoding: 'utf8' });
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'stand');
        git('config', 'user.email', 'stand@example.invalid');
        writeFileSync(join(repo.dir, 'README.md'), 'repo\n');
        writeFileSync(join(repo.dir, 'guarded', 'keep.txt'), 'keep\n');
        git('add', '.');
        git('commit', '-qm', 'init');
        // Правка под маской — только с грантом задачи: ядро отказывает пунктом 5 и спрашивает.
        const cfgPath = join(coreHome, 'config.json');
        const coreCfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        coreCfg.grantRequired = [{ project: repo.dir, globs: ['guarded/**'], ops: ['edit'] }];
        writeFileSync(cfgPath, `${JSON.stringify(coreCfg, null, 2)}\n`);
        // Вход claude — адрес и ключ заглушки в личном слое (его ядро передаёт CLI как есть).
        const settingsPath = join(cfg, 'settings.json');
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        writeFileSync(settingsPath, `${JSON.stringify({ ...settings, env: stubEnv }, null, 2)}\n`);
      },
    },
    async (stand, check) => {
      if (!dir) throw new NotChecked('claude нет в PATH');
      const { chromium } = await import('playwright');
      const tasksDir = join(stand.coreHome, 'tasks');
      const tasks = () => (existsSync(tasksDir) ? readdirSync(tasksDir) : []);
      const journal = (taskId) => {
        const name = readdirSync(join(tasksDir, taskId)).find((f) => f.endsWith('.jsonl'));
        if (!name) return [];
        return readFileSync(join(tasksDir, taskId, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      };
      /** Команды ядру, ушедшие из окна, с исходом — в подробности провала рядом с журналом. */
      const sent = [];
      const t0 = Date.now();
      const tail = (taskId, n = 8) =>
        [
          ...journal(taskId)
            .filter((l) => l.kind !== 'tool.event' && l.kind !== 'turn.usage')
            .slice(-n)
            .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 220)}`),
          `окно → ядро: ${sent.join(' | ') || 'команд не было'}`,
        ].join('\n      ');
      const until = async (probe, seconds) => {
        for (let i = 0; i < seconds * 2; i++) {
          const got = probe();
          if (got) return got;
          await wait(500);
        }
        return undefined;
      };
      const file = (n) => join(repo.dir, 'guarded', `a${n}.txt`);

      const browser = await chromium.launch();
      try {
        const page = await openProjectChat(stand, browser, repo.dir, 'repo');
        // Команды ядру, ушедшие из окна, и их исход — разбор провала без догадок.
        page.on('request', (req) => {
          if (!/\/core\/commands\b|\/auto-approve\b/.test(req.url()) || req.method() !== 'POST') {
            return;
          }
          let draft = {};
          try {
            draft = JSON.parse(req.postData() ?? '{}');
          } catch {
            // тело не JSON — запишем как есть
          }
          const what = /\/auto-approve\b/.test(req.url())
            ? `auto-approve ${JSON.stringify(draft)}`
            : `${draft.kind ?? '?'} ${JSON.stringify(draft.fields ?? {})}`;
          const at = sent.push(`+${Math.round((Date.now() - t0) / 1000)}s ${what}`) - 1;
          void req
            .response()
            .then(async (res) => {
              const body = await res?.json().catch(() => null);
              sent[at] += ` → ${res?.status() ?? '?'} ${body?.status ?? ''} ${body?.code ?? ''}`;
            })
            .catch(() => undefined);
        });
        // Положение тумблера, каким его видит окно (ответы сервера), — для разбора провала.
        page.on('response', (res) => {
          if (!/\/auto-mode\b/.test(res.url())) return;
          void res
            .json()
            .then((body) =>
              sent.push(
                `+${Math.round((Date.now() - t0) / 1000)}s auto-mode ${new URL(res.url()).pathname.split('/')[3]} → ${body?.enabled}`,
              ),
            )
            .catch(() => undefined);
        });
        const toggle = async (on) => {
          await page.getByRole('button', { name: 'Настройки чата' }).first().click();
          const box = page.getByRole('switch', { name: 'Автоподтверждение прав' }).first();
          await box.waitFor({ timeout: 10_000 });
          const checked = (await box.getAttribute('aria-checked')) === 'true';
          if (checked !== on) await box.click();
          sent.push(
            `+${Math.round((Date.now() - t0) / 1000)}s тумблер → ${await box.getAttribute('aria-checked')}`,
          );
          await box.press('Escape');
          return checked !== on;
        };
        const say = async (text) => {
          const input = page.locator('textarea[data-chat-input]');
          await input.fill(text);
          await input.press('Enter');
        };

        // 1. Авторежим выключен общей настройкой — вопрос права карточкой в окне, файла нет.
        const before = tasks();
        await say('правка-1: запиши файл');
        const taskId = await until(() => tasks().find((t) => !before.includes(t)), 90);
        check(`ход 1: задача ядра заведена (${taskId ?? 'нет'})`, Boolean(taskId));
        if (!taskId) return;
        const asked = await until(
          () =>
            journal(taskId).find((l) => l.kind === 'human.asked' && l.data?.source === 'permit'),
          120,
        );
        check(
          `ход 1: ядро спросило право пунктом 5 (${asked?.data?.askId ?? 'нет'})`,
          asked?.data?.point === 5,
          tail(taskId),
        );
        if (!asked) return;
        const allowButton = page.getByRole('button', { name: 'Разрешить', exact: true });
        const card = page
          .locator('div')
          .filter({ hasText: 'Агент просит разрешение', has: allowButton })
          .last();
        const allow = card.getByRole('button', { name: 'Разрешить', exact: true }).first();
        const shown = await allow
          .waitFor({ timeout: 60_000 })
          .then(() => true)
          .catch(() => false);
        if (!shown && process.env.PERMIT_SHOT) {
          await page.screenshot({ path: process.env.PERMIT_SHOT, fullPage: true });
        }
        check(
          'тумблер выключен: вопрос ядра — карточкой «Агент просит разрешение» в окне',
          shown,
          `адрес окна: ${page.url()}`,
        );
        check('тумблер выключен: файл под маской не записан', !existsSync(file(1)));
        check(
          'тумблер выключен: ответа ядру без человека нет',
          !journal(taskId).some((l) => l.kind === 'human.answered'),
        );

        // 3. Маршрут карточки сервера на вопросе ядра — названный отказ (до клика: вопрос висит).
        // Отказ узнаёт вопрос ядра по номеру вызова; ключ разговора — из адреса страницы.
        const runKey = new URL(page.url()).searchParams.get('c') ?? 'chat';
        const viaServer = await page.evaluate(
          async ({ key, askId }) => {
            const res = await fetch(`/api/chat/${encodeURIComponent(key)}/permission-decision`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ toolUseId: askId, behavior: 'allow' }),
            });
            return { status: res.status, body: await res.json().catch(() => null) };
          },
          { key: runKey ?? '', askId: asked.data.askId },
        );
        check(
          `маршрут сервера: названный отказ (${viaServer.status} ${viaServer.body?.code ?? ''})`,
          viaServer.status === 409 && viaServer.body?.code === 'core_permit_browser_only',
          JSON.stringify(viaServer.body),
        );

        // 2. Клик «Разрешить» — грант и ответ ядру от окна; ход дописывает файл.
        if (shown) {
          await allow.click();
          const answered = await until(
            () =>
              journal(taskId).find(
                // Повтор вызова моделью поднимает новый вопрос с тем же ключом — карточек может
                // быть несколько; клик отвечает на свой.
                (l) => l.kind === 'human.answered' || l.kind === 'command.rejected',
              ),
            60,
          );
          check(
            `карточка: ядро приняло ответ окна (${answered?.kind ?? 'нет'} ${answered?.data?.answer ?? answered?.data?.code ?? ''})`,
            answered?.kind === 'human.answered' && answered.data.answer === 'grant',
            tail(taskId),
          );
          // Грант `**` ядра при постановке на месте (`actor: core`) — не ответ окна.
          const grant = journal(taskId).find(
            (l) => l.kind === 'grant.given' && l.actor !== 'core' && !l.data?.globs?.includes('**'),
          );
          check(
            `карточка: грант окна на путь отказа (${JSON.stringify(grant?.data?.globs ?? null)})`,
            Boolean(grant?.data?.globs?.includes('guarded/a1.txt')),
            tail(taskId),
          );
          const gone = await allowButton
            .first()
            .waitFor({ state: 'detached', timeout: 30_000 })
            .then(() => true)
            .catch(() => false);
          check('карточка снята ответом ядра', gone);
          const written = await until(() => existsSync(file(1)), 120);
          check(
            'ход продолжился: файл под маской записан тем же ходом',
            Boolean(written),
            tail(taskId),
          );
          check(
            'ни одной команды ядру не отвергнуто',
            !journal(taskId).some((l) => l.kind === 'command.rejected'),
            tail(taskId),
          );
        }
        await until(() => journal(taskId).some((l) => l.kind === 'turn.usage'), 30);
        await page
          .getByText('записано-1')
          .first()
          .waitFor({ timeout: 60_000 })
          .catch(() => undefined);

        // 4. Клик тумблера «включить» — грант `**` от окна; следующий ход без вопроса права.
        const flipped = await toggle(true);
        check('тумблер автоподтверждения включён кликом', flipped);
        const autoGrant = await until(
          () =>
            journal(taskId).find(
              (l) =>
                l.kind === 'grant.given' && l.data?.globs?.includes('**') && l.actor !== 'core',
            ),
          30,
        );
        check(
          `тумблер включён: окно выдало задаче грант правки ** (${autoGrant ? 'есть' : 'нет'})`,
          Boolean(autoGrant),
          tail(taskId),
        );
        const askedBefore = journal(taskId).filter(
          (l) => l.kind === 'human.asked' && l.data?.source === 'permit',
        ).length;
        const tasksBefore2 = tasks();
        await say('правка-2: запиши ещё файл');
        const written2 = await until(() => existsSync(file(2)), 180);
        const owner = tasks().find((t) => !tasksBefore2.includes(t)) ?? taskId;
        const askedAfter = journal(owner).filter(
          (l) => l.kind === 'human.asked' && l.data?.source === 'permit',
        ).length;
        check('тумблер включён: ход 2 записал файл под маской', Boolean(written2), tail(owner));
        check(
          `тумблер включён: вопросов права в ходе 2 нет (${askedAfter - (owner === taskId ? askedBefore : 0)})`,
          askedAfter - (owner === taskId ? askedBefore : 0) === 0,
          tail(owner),
        );
      } finally {
        await browser.close();
      }
    },
  );
} finally {
  await model.close();
}
