/**
 * Свои шаги «Пути» группы после стадии у ребёнка разделения в git-копии с
 * несвежим закреплением (`runPathSteps`) — то, что WA 28.09 оставил
 * непройденным вживую («нужен целый прогон разделения»).
 *
 * После хода стадии ребёнка панель заводит ОТДЕЛЬНЫЙ ход с шагом группы,
 * поставленным после этой стадии (`pathTurn` в `handoff-routes.ts`). Группа
 * берётся по `runGroupChoice`: закрепление, сверенное с парой ОСНОВНОГО проекта
 * (F-107). Несвежая половина пары и удалённая группа шагов не дают.
 *
 * Что настоящее: одноразовая панель над временным домом, настоящий git
 * (репозиторий и `git worktree`), выбор группы в меню «Настройки чата» каждого
 * ребёнка, сообщение из поля. Подменено только то, что стоит до вопроса:
 * связь «ребёнок разделения на стадии fix» пишет в хранилище сама панель, когда
 * разделение запускает детей, — здесь её пишет тот же `AppStore` до старта
 * панели, вместе с транскриптом ребёнка (весь веер через разбор модели ради
 * этой связи прогнать нечем). CLI — фальшивый (`fake-cli-append.mjs`).
 *
 *   1. основной проект на глобальной половине, ребёнок 1 закрепил её — после
 *      хода стадии отдельный ход с MARK_GLOB_FIX (контроль);
 *   2. основной проект переключили на проектную; ребёнок 2 закрепил глобальную
 *      ДО переключения (несвежее) — ход шага несёт MARK_PROJ_FIX, MARK_GLOB_FIX нет;
 *   3. ребёнок 3 закрепил Solo, Solo удалили — хода с MARK_SOLO_FIX нет.
 *
 * Запуск: `node tools/qa/check-group-pin-stage-steps.mjs` (стенд поднимается сам).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { chatGroupMenu, dismissAccess, openProjectChat } from './chat-walk.mjs';
import { FAKE_APPEND_CLI, readTurns } from './fake-cli-append.mjs';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';

const NOW = '2026-09-28T00:00:00.000Z';
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** Дети разделения: сессия, заголовок в списке (первая реплика). */
const KIDS = [
  { sid: 'walk-kid-one', title: 'Kid one fixes' },
  { sid: 'walk-kid-two', title: 'Kid two fixes' },
  { sid: 'walk-kid-three', title: 'Kid three fixes' },
];

/** Шаг «после стадии fix» с меткой. */
const stepAfterFix = (mark) => ({
  id: `${mark.toLowerCase()}-after-fix`,
  anchor: 'fix',
  order: 0,
  kind: 'prompt',
  title: { ru: `Шаг ${mark}`, en: `Step ${mark}` },
  prompt: { ru: 'Прогони весь набор', en: `${mark} run the whole suite.` },
  source: 'ru',
  createdAt: NOW,
});

/** Транскрипт ребёнка в копии — как у настоящего CLI (путь по рабочей папке). */
function writeKidTranscript(cfg, cwd, kid) {
  const dir = join(cfg, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const line = (type, content, n) =>
    JSON.stringify({
      type,
      sessionId: kid.sid,
      cwd,
      timestamp: NOW,
      uuid: `${kid.sid}-${n}`,
      message:
        type === 'user'
          ? { role: 'user', content }
          : { id: `${kid.sid}-m`, role: 'assistant', content: [{ type: 'text', text: content }] },
    });
  writeFileSync(
    join(dir, `${kid.sid}.jsonl`),
    `${[line('user', kid.title, 1), line('assistant', 'Started.', 2)].join('\n')}\n`,
  );
}

/** Связь «ребёнок разделения на стадии fix» — тем же хранилищем, что пишет панель. */
function seedLinks(root, appData) {
  const script = join(root, 'seed-links.ts');
  const storeUrl = pathToFileURL(join(REPO, 'apps/server/src/lib/app-store.ts')).href;
  const links = KIDS.map(
    (kid, index) =>
      `store.setChatLink(${JSON.stringify(kid.sid)}, { parentChatId: 'walk-parent', createdAt: '${NOW}', title: ${JSON.stringify(kid.title)}, branch: 'split/kid-${index}', groupIndex: ${index}, model: 'sonnet', effort: 'medium', kind: 'mechanical', stage: 'fix', ceilingModel: 'claude-opus-5', workModel: 'sonnet', workEffort: 'medium' });`,
  ).join('\n');
  writeFileSync(
    script,
    `import { AppStore } from ${JSON.stringify(storeUrl)};\nconst store = new AppStore(${JSON.stringify(appData)});\n${links}\n`,
  );
  const done = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', script],
    {
      encoding: 'utf8',
    },
  );
  if (done.status !== 0) throw new Error(`связи не записаны: ${done.stderr}`);
}

await runOnStand(
  {
    label: 'pin-stage-steps',
    fakeCli: { claude: FAKE_APPEND_CLI },
    seed: ({ root, home, cfg }) => {
      const repo = join(home, 'repo');
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, 'a.txt'), 'x\n', 'utf8');
      const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'qa@example.com');
      git('config', 'user.name', 'qa');
      git('add', '.');
      git('commit', '-q', '-m', 'one');
      const copy = join(home, 'repo-wt');
      git('worktree', 'add', '-q', '-b', 'feat', copy);
      for (const kid of KIDS) writeKidTranscript(cfg, copy, kid);
      seedLinks(root, join(cfg, 'agentdeck'));
    },
  },
  async (stand, check) => {
    const repo = join(stand.home, 'repo');
    const copy = join(stand.home, 'repo-wt');
    await stand.api('/projects', { method: 'POST', body: { path: repo } });
    const project = await stand.api('/groups', {
      method: 'POST',
      body: { name: 'Pair', scope: { kind: 'project', path: repo, provider: 'claude' } },
    });
    check(
      'проектная группа создана',
      project.status === 200,
      `${project.status} ${project.text.slice(0, 200)}`,
    );
    const copied = await stand.api(`/groups/${project.body?.id}/copy-to-global`, {
      method: 'POST',
      body: {},
    });
    check(
      'глобальная копия создана',
      copied.status === 200,
      `${copied.status} ${copied.text.slice(0, 200)}`,
    );
    const solo = await stand.api('/groups', { method: 'POST', body: { name: 'Solo' } });
    const ids = { proj: project.body?.id, glob: copied.body?.group?.id, solo: solo.body?.id };
    for (const [id, mark] of [
      [ids.proj, 'MARK_PROJ_FIX'],
      [ids.glob, 'MARK_GLOB_FIX'],
      [ids.solo, 'MARK_SOLO_FIX'],
    ]) {
      const saved = await stand.api(`/groups/${id}/path/steps`, {
        method: 'PUT',
        body: { steps: [stepAfterFix(mark)] },
      });
      check(
        `шаг ${mark} после fix сохранён`,
        saved.status === 200,
        `${saved.status} ${saved.text.slice(0, 200)}`,
      );
    }
    const choose = (key) =>
      stand.api('/projects/group-choice', { method: 'PUT', body: { path: repo, groupKey: key } });
    const toGlobal = await choose(`global:${ids.glob}`);
    check(
      'в основном проекте действует глобальная половина',
      toGlobal.status === 200,
      toGlobal.text.slice(0, 200),
    );

    const turnsIn = () => readTurns(stand.read, stand.bin);
    /** Ходы, пришедшие после `since`, с этим текстом в промпте. */
    const stepTurns = (since, mark) =>
      turnsIn()
        .slice(since)
        .filter((turn) => turn.prompt?.includes(mark));
    const waitStep = async (since, mark, seconds = 30) => {
      for (let i = 0; i < seconds * 4; i += 1) {
        if (stepTurns(since, mark).length > 0) return stepTurns(since, mark);
        await wait(250);
      }
      return [];
    };

    const browser = await chromium.launch();
    try {
      const page = await openProjectChat(stand, browser, copy, 'repo-wt');
      /** Открыть ребёнка в списке чатов копии. */
      const openKid = async (kid) => {
        // Дети без родителя (его транскрипта нет) — под карточкой «Родительский
        // чат удалён», свёрнутые в «Ещё N»: раскрыть, если ребёнка не видно.
        const row = page.getByText(kid.title, { exact: true }).first();
        if (!(await row.isVisible()))
          await page
            .getByText(/^Ещё \d+$/)
            .first()
            .click();
        await row.click();
        await page.locator('textarea[data-chat-input]').waitFor({ timeout: 30_000 });
        await wait(800);
      };
      /** Отправить из поля и дождаться хода с этим текстом у CLI. */
      const send = async (text) => {
        const since = turnsIn().length;
        const input = page.locator('textarea[data-chat-input]');
        await input.fill(text);
        await input.press('Enter');
        for (let i = 0; i < 120; i += 1) {
          if (
            turnsIn()
              .slice(since)
              .some((turn) => turn.prompt.includes(text))
          )
            return since;
          await wait(250);
        }
        return -1;
      };

      // Закрепления — пока в основном проекте действует глобальная половина.
      for (const kid of KIDS.slice(0, 2)) {
        await openKid(kid);
        const menu = await chatGroupMenu(page, /^Pair/);
        console.log(`  ${kid.sid}: меню ${menu.labels.join(' | ')}`);
      }
      await openKid(KIDS[2]);
      await chatGroupMenu(page, /^Solo/);
      const soloPinned = await chatGroupMenu(page);
      check('ребёнок 3 закрепил Solo', /^Solo/.test(soloPinned.current), soloPinned.current);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, 'kids-pinned.png') });

      // 1. Контроль: ребёнок 1, действующая глобальная половина.
      await openKid(KIDS[0]);
      const since1 = await send('kid one stage work');
      check('1. ход стадии ребёнка 1 дошёл до CLI', since1 >= 0);
      const glob1 = await waitStep(since1, 'MARK_GLOB_FIX');
      check(
        '1. после стадии fix — отдельный ход с шагом глобальной половины',
        glob1.length === 1,
        `${glob1.length}`,
      );
      check(
        '1. ход шага идёт в копии и называет стадию',
        glob1[0]?.cwd?.toLowerCase() === copy.toLowerCase() &&
          /after the fix stage/.test(glob1[0]?.prompt ?? ''),
        (glob1[0]?.prompt ?? '').slice(0, 300),
      );
      check('1. строк проектной половины нет', stepTurns(since1, 'MARK_PROJ_FIX').length === 0);

      // 2. Основной проект — на проектную половину; ребёнок 2 закреплён несвежо.
      const toProject = await choose(`project:${ids.proj}`);
      check(
        'в основном проекте действует проектная половина',
        toProject.status === 200,
        toProject.text.slice(0, 200),
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('textarea[data-chat-input]').waitFor({ timeout: 60_000 });
      await dismissAccess(page);
      await openKid(KIDS[1]);
      const stale = await chatGroupMenu(page);
      console.log(`  ${KIDS[1].sid}: меню после переключения «${stale.current}»`);
      const since2 = await send('kid two stage work');
      check('2. ход стадии ребёнка 2 дошёл до CLI', since2 >= 0);
      const proj2 = await waitStep(since2, 'MARK_PROJ_FIX');
      check(
        '2. ход шага — по действующей проектной половине',
        proj2.length === 1,
        `${proj2.length}`,
      );
      await wait(2000);
      check(
        '2. шага несвежей глобальной половины нет',
        stepTurns(since2, 'MARK_GLOB_FIX').length === 0,
        stepTurns(since2, 'MARK_GLOB_FIX')
          .map((turn) => turn.prompt.slice(0, 120))
          .join(' | '),
      );

      // 3. Solo удалили — её шага нет, ход стадии проходит.
      const removed = await stand.api(`/groups/${ids.solo}`, { method: 'DELETE' });
      check('Solo удалена', removed.status < 300, `${removed.status}`);
      await openKid(KIDS[2]);
      const since3 = await send('kid three stage work');
      check('3. ход стадии ребёнка 3 дошёл до CLI', since3 >= 0);
      await wait(6000);
      check('3. шага удалённой группы нет', stepTurns(since3, 'MARK_SOLO_FIX').length === 0);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, 'kid-three.png') });
      check('страница без ошибок', page.errors.length === 0, page.errors.join(' | '));
    } finally {
      await browser.close();
    }
  },
);
