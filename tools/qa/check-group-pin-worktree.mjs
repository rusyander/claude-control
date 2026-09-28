/**
 * Кейс groups-015: группа, закреплённая в меню чата, у разговора в git-копии
 * проекта и закрепление, ставшее несвежим (F-107 и его соседи 28.09).
 *
 * Прогон идёт в КОПИИ репозитория (`git worktree`), а выбор стороны пары
 * «проектная группа — её глобальная копия» записан на ОСНОВНОЙ проект. Строки
 * группы в добавке к системному промпту — подсказка «Пути» (`chatPathHint`) и
 * шаг внутри скилла (строка скиллов, `chatKnobsLine`) — обязаны идти по стороне,
 * действующей в основном проекте, а не по сырому закреплению.
 *
 * Путь настоящий: одноразовая панель над временным домом, настоящий git
 * (репозиторий и копия во временном каталоге), группа выбирается в меню
 * «Настройки чата», сообщение уходит из поля, а фальшивый `claude` на PATH
 * записывает, что дошло до процесса (`fake-cli-append.mjs`).
 *
 * Что доказывается:
 *   1. в копии меню предлагает действующую в основном проекте сторону пары;
 *      выбранная, она доезжает до процесса своими строками (контроль);
 *   2. сторону пары в основном проекте переключили — следующий ход того же
 *      чата в копии идёт по новой действующей стороне; строк прежней нет, а
 *      меню называет закрепление «другой стороной пары»;
 *   3. закреплённую группу удалили — её строк в ходе нет, ход проходит.
 *
 * Запуск: `node tools/qa/check-group-pin-worktree.mjs` (стенд поднимается сам).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chatGroupMenu, dismissAccess, openProjectChat, sendAndWait } from './chat-walk.mjs';
import { FAKE_APPEND_CLI } from './fake-cli-append.mjs';
import { runOnStand } from './throwaway-stand.mjs';

const NOW = '2026-09-28T00:00:00.000Z';
const SKILL = [
  '---',
  'name: flow-skill',
  'description: A numbered flow.',
  '---',
  '',
  '## 1. Read',
  'read',
  '## 2. Fix',
  'fix',
  '',
].join('\n');

/** Два своих шага группы с меткой: после плана (подсказка) и внутри скилла. */
const stepsOf = (mark) => [
  {
    id: `${mark}-hint`,
    anchor: 'plan',
    order: 0,
    kind: 'prompt',
    title: { ru: 'Шаг', en: 'Step' },
    prompt: { ru: 'Сделай', en: `${mark}_HINT run lint.` },
    source: 'ru',
    createdAt: NOW,
  },
  {
    id: `${mark}-inside`,
    anchor: 'work',
    order: 0,
    kind: 'prompt',
    title: { ru: 'Внутри', en: 'Inside' },
    prompt: { ru: 'Сверь', en: `${mark}_INSIDE take a shot.` },
    source: 'ru',
    createdAt: NOW,
    within: { skillId: 'flow-skill', index: 0, after: 'Read' },
  },
];
const carries = (append, mark) =>
  append.includes(`${mark}_HINT`) && append.includes(`${mark}_INSIDE`);
const mentions = (append, mark) => append.includes(mark);

await runOnStand(
  {
    label: 'pin-worktree',
    fakeCli: { claude: FAKE_APPEND_CLI },
    seed: ({ home, cfg }) => {
      mkdirSync(join(cfg, 'skills', 'flow-skill'), { recursive: true });
      writeFileSync(join(cfg, 'skills', 'flow-skill', 'SKILL.md'), SKILL, 'utf8');
      const repo = join(home, 'repo');
      mkdirSync(join(repo, '.claude', 'skills', 'flow-skill'), { recursive: true });
      writeFileSync(join(repo, '.claude', 'skills', 'flow-skill', 'SKILL.md'), SKILL, 'utf8');
      writeFileSync(join(repo, 'a.txt'), 'x\n', 'utf8');
      const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'qa@example.com');
      git('config', 'user.name', 'qa');
      git('add', '.');
      git('commit', '-q', '-m', 'one');
      git('worktree', 'add', '-q', '-b', 'feat', join(home, 'repo-wt'));
    },
  },
  async (stand, check) => {
    const repo = join(stand.home, 'repo');
    const copy = join(stand.home, 'repo-wt');
    await stand.api('/projects', { method: 'POST', body: { path: repo } });

    // Пара: проектная группа и её глобальная копия, у каждой свои метки.
    const project = await stand.api('/groups', {
      method: 'POST',
      body: {
        name: 'Pair',
        scope: { kind: 'project', path: repo, provider: 'claude' },
        members: [{ kind: 'skill', id: 'flow-skill' }],
      },
    });
    check(
      'проектная группа создана',
      project.status === 200,
      `${project.status} ${project.text.slice(0, 300)}`,
    );
    const copied = await stand.api(`/groups/${project.body?.id}/copy-to-global`, {
      method: 'POST',
      body: {},
    });
    check(
      'глобальная копия создана',
      copied.status === 200,
      `${copied.status} ${copied.text.slice(0, 300)}`,
    );
    const projectId = project.body?.id;
    const globalId = copied.body?.group?.id;
    for (const [id, mark] of [
      [projectId, 'MARK_PROJ'],
      [globalId, 'MARK_GLOB'],
    ]) {
      const saved = await stand.api(`/groups/${id}/path/steps`, {
        method: 'PUT',
        body: { steps: stepsOf(mark) },
      });
      check(
        `шаги ${mark} сохранены`,
        saved.status === 200,
        `${saved.status} ${saved.text.slice(0, 200)}`,
      );
    }
    const choose = async (key) =>
      stand.api('/projects/group-choice', { method: 'PUT', body: { path: repo, groupKey: key } });
    const toGlobal = await choose(`global:${globalId}`);
    check(
      'в основном проекте действует глобальная сторона',
      toGlobal.status === 200,
      `${toGlobal.status} ${toGlobal.text.slice(0, 200)}`,
    );

    const browser = await chromium.launch();
    try {
      // 1. Копия: меню видит пару основного проекта; выбор доезжает (контроль).
      const chat = await openProjectChat(stand, browser, copy, 'repo-wt');
      check(
        'первый ход в копии дошёл до CLI',
        Boolean(await sendAndWait(chat, stand, 'wt warm up')),
      );
      const menu = await chatGroupMenu(chat, /^Pair/);
      console.log(`  варианты меню в копии: ${menu.labels.join(' | ')}`);
      check(
        'меню копии предлагает одну сторону пары — действующую',
        menu.labels.filter((label) => label.startsWith('Pair')).length === 1,
        menu.labels.join(' | '),
      );
      const control = await sendAndWait(chat, stand, 'wt turn global');
      check(
        'контроль: ход в копии несёт строки действующей глобальной стороны',
        carries(control?.append ?? '', 'MARK_GLOB') &&
          !mentions(control?.append ?? '', 'MARK_PROJ'),
        (control?.append ?? 'хода нет').slice(0, 500),
      );

      // 2. Сторону переключили на проектную — закрепление в чате стало несвежим.
      const toProject = await choose(`project:${projectId}`);
      check(
        'в основном проекте действует проектная сторона',
        toProject.status === 200,
        `${toProject.status} ${toProject.text.slice(0, 200)}`,
      );
      const cached = await chatGroupMenu(chat);
      console.log(`  меню без перезагрузки: «${cached.current}» из ${cached.labels.join(' | ')}`);
      await chat.reload({ waitUntil: 'domcontentloaded' });
      await chat.locator('textarea[data-chat-input]').waitFor({ timeout: 60_000 });
      await dismissAccess(chat);
      const stale = await chatGroupMenu(chat);
      console.log(`  меню после переключения: «${stale.current}» из ${stale.labels.join(' | ')}`);
      check(
        'меню называет закрепление другой стороной пары',
        /другая сторона пары/.test(stale.current),
        stale.current,
      );
      const after = await sendAndWait(chat, stand, 'wt turn after switch');
      const text = after?.append ?? '';
      check('ход после переключения дошёл до CLI', Boolean(after));
      check(
        'ход в копии идёт по действующей проектной стороне',
        carries(text, 'MARK_PROJ'),
        text.slice(0, 500),
      );
      check(
        'строк несвежей глобальной стороны нет — ни подсказки, ни шага внутри скилла',
        !mentions(text, 'MARK_GLOB'),
        text.slice(0, 500),
      );
      await chat.close();

      // 3. Закреплённую группу удалили.
      const solo = await stand.api('/groups', {
        method: 'POST',
        body: { name: 'Solo', members: [{ kind: 'skill', id: 'flow-skill' }] },
      });
      await stand.api(`/groups/${solo.body?.id}/path/steps`, {
        method: 'PUT',
        body: { steps: stepsOf('MARK_SOLO') },
      });
      const second = await openProjectChat(stand, browser, copy, 'repo-wt');
      await second.getByRole('button', { name: 'Новый чат' }).first().click();
      check(
        'новый чат: первый ход дошёл',
        Boolean(await sendAndWait(second, stand, 'solo warm up')),
      );
      await chatGroupMenu(second, /^Solo/);
      const soloTurn = await sendAndWait(second, stand, 'solo turn pinned');
      check(
        'контроль: закреплённая Solo доезжает своими строками',
        carries(soloTurn?.append ?? '', 'MARK_SOLO'),
        (soloTurn?.append ?? 'хода нет').slice(0, 300),
      );
      const removed = await stand.api(`/groups/${solo.body?.id}`, { method: 'DELETE' });
      check(
        'Solo удалена',
        removed.status < 300,
        `${removed.status} ${removed.text.slice(0, 200)}`,
      );
      const gone = await sendAndWait(second, stand, 'solo turn after delete');
      check('ход после удаления группы дошёл до CLI', Boolean(gone));
      check(
        'строк удалённой группы в ходе нет',
        !mentions(gone?.append ?? '', 'MARK_SOLO'),
        (gone?.append ?? '').slice(0, 300),
      );
      const cached3 = await chatGroupMenu(second);
      console.log(`  меню после удаления без перезагрузки: «${cached3.current}»`);
      await second.reload({ waitUntil: 'domcontentloaded' });
      await second.locator('textarea[data-chat-input]').waitFor({ timeout: 60_000 });
      await dismissAccess(second);
      const after3 = await chatGroupMenu(second);
      console.log(`  меню после удаления: «${after3.current}»`);
      check(
        'меню называет удалённую группу, а не молчит',
        after3.current.length > 0,
        after3.current,
      );
      check(
        'страницы чата без ошибок',
        chat.errors.length === 0 && second.errors.length === 0,
        [...chat.errors, ...second.errors].join(' | '),
      );
    } finally {
      await browser.close();
    }
  },
);
