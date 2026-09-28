/**
 * «Числа» группы (половина `chatKnobsLine`, выписанная моделью) у чата в git-копии
 * проекта с несвежим закреплением — то, что WA 28.09 оставил непройденным вживую.
 *
 * Строка чисел едет в добавку к системному промпту каждого хода чата группы.
 * Выбор группы у копии обязан идти по стороне пары, действующей в ОСНОВНОМ
 * проекте (`runGroupChoice` → `pinnedChoiceAt`), и строка чисел — вместе с ним:
 * у половин пары числа разные, и чужая половина в ход попасть не должна.
 *
 * Путь настоящий: одноразовая панель над временным домом, настоящий git
 * (репозиторий и `git worktree` во временном каталоге), группа выбирается в
 * меню «Настройки чата», сообщение уходит из поля. Фальшивый `claude` на PATH
 * пишет, что дошло до процесса (`fake-cli-append.mjs`), и он же отвечает на
 * служебный вызов выписки чисел вместо модели — единственная подмена.
 *
 *   1. в основном проекте действует глобальная половина (5 кругов) — ход в копии
 *      несёт «Review rounds: 5», без «: 4» проектной (контроль);
 *   2. основной проект переключили на проектную половину — следующий ход того
 *      же чата несёт «: 4», без «: 5»;
 *   3. закреплённую Solo (6 кругов) удалили — в следующем ходе её чисел нет.
 *
 * Запуск: `node tools/qa/check-group-pin-knobs.mjs` (стенд поднимается сам).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chatGroupMenu, dismissAccess, openProjectChat, sendAndWait } from './chat-walk.mjs';
import { FAKE_APPEND_CLI } from './fake-cli-append.mjs';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SKILL = [
  '---',
  'name: fleet-review',
  'description: Review with a fleet.',
  '---',
  '',
  'Run 2 review rounds before the verdict.',
  '',
].join('\n');

/** Ответ «модели» на выписку: одно число с дословной цитатой. */
const EXTRACTION = {
  knobs: [
    {
      key: 'review-rounds',
      label: { ru: 'Кругов ревью', en: 'Review rounds' },
      default: 2,
      min: 1,
      max: 8,
      quote: 'Run 2 review rounds before the verdict.',
    },
  ],
};

/** Служебный вызов (`-p` без stream-json): выписка чисел — ответом выше, прочее — «Done.». */
const EXTRACT_PRELUDE = [
  "if (process.argv.includes('-p') && !process.argv.includes('stream-json')) {",
  '  const chunks = [];',
  '  for await (const chunk of process.stdin) chunks.push(chunk);',
  "  const input = Buffer.concat(chunks).toString('utf8');",
  "  const lang = /language (\\S+) containing/.exec(input)?.[1] ?? 'json';",
  "  const fence = '`'.repeat(3);",
  "  const isKnobs = input.split('\\n').some((line) => line.startsWith('skill '));",
  `  process.stdout.write(isKnobs ? fence + lang + '\\n' + ${JSON.stringify(JSON.stringify(EXTRACTION))} + '\\n' + fence + '\\n' : 'Done.');`,
  '  process.exit(0);',
  '}',
  '',
].join('\n');
const FAKE = FAKE_APPEND_CLI.replace(
  "if (args.includes('--version')",
  `${EXTRACT_PRELUDE}if (args.includes('--version')`,
);

const ID = 'fleet-review:review-rounds';
const rounds = (append, n) => append.includes(`Review rounds: ${n} (skill default 2)`);

await runOnStand(
  {
    label: 'pin-knobs',
    fakeCli: { claude: FAKE },
    seed: ({ home, cfg }) => {
      mkdirSync(join(cfg, 'skills', 'fleet-review'), { recursive: true });
      writeFileSync(join(cfg, 'skills', 'fleet-review', 'SKILL.md'), SKILL, 'utf8');
      const repo = join(home, 'repo');
      mkdirSync(join(repo, '.claude', 'skills', 'fleet-review'), { recursive: true });
      writeFileSync(join(repo, '.claude', 'skills', 'fleet-review', 'SKILL.md'), SKILL, 'utf8');
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
    if (FAKE === FAKE_APPEND_CLI)
      throw new Error('фальшивый CLI: точка вставки выписки не найдена');
    const repo = join(stand.home, 'repo');
    const copy = join(stand.home, 'repo-wt');
    await stand.api('/projects', { method: 'POST', body: { path: repo } });

    const project = await stand.api('/groups', {
      method: 'POST',
      body: {
        name: 'Pair',
        scope: { kind: 'project', path: repo, provider: 'claude' },
        members: [{ kind: 'skill', id: 'fleet-review' }],
      },
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
    const solo = await stand.api('/groups', {
      method: 'POST',
      body: { name: 'Solo', members: [{ kind: 'skill', id: 'fleet-review' }] },
    });
    const ids = { proj: project.body?.id, glob: copied.body?.group?.id, solo: solo.body?.id };

    // Выписка чисел: первый показ зовёт «модель», дальше — из кэша по хэшу скилла.
    const knobsOf = async (id) => {
      let view;
      for (let i = 0; i < 80; i += 1) {
        view = (await stand.api(`/groups/${id}/knobs`)).body;
        if (!view?.pending) break;
        await wait(250);
      }
      return view;
    };
    for (const [side, value] of [
      ['proj', 4],
      ['glob', 5],
      ['solo', 6],
    ]) {
      const view = await knobsOf(ids[side]);
      check(
        `${side}: число выписано из скилла`,
        (view?.knobs ?? []).some((knob) => knob.key === 'review-rounds'),
        JSON.stringify(view).slice(0, 300),
      );
      const put = await stand.api(`/groups/${ids[side]}/knobs`, {
        method: 'PUT',
        body: { values: { [ID]: value } },
      });
      check(
        `${side}: закреплено ${value}`,
        put.status === 200,
        `${put.status} ${put.text.slice(0, 200)}`,
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

    const browser = await chromium.launch();
    try {
      // 1. Контроль: закрепили в меню копии, ход несёт числа глобальной половины.
      const chat = await openProjectChat(stand, browser, copy, 'repo-wt');
      check(
        'первый ход в копии дошёл до CLI',
        Boolean(await sendAndWait(chat, stand, 'knobs warm up')),
      );
      const menu = await chatGroupMenu(chat, /^Pair/);
      console.log(`  меню копии: ${menu.labels.join(' | ')}`);
      const control = (await sendAndWait(chat, stand, 'knobs turn global'))?.append ?? '';
      check(
        '1. ход в копии: числа действующей глобальной половины (5), без проектной (4)',
        rounds(control, 5) && !rounds(control, 4),
        control.slice(0, 600),
      );

      // 2. Основной проект переключили — закрепление в чате стало несвежим.
      const toProject = await choose(`project:${ids.proj}`);
      check(
        'в основном проекте действует проектная половина',
        toProject.status === 200,
        toProject.text.slice(0, 200),
      );
      await chat.reload({ waitUntil: 'domcontentloaded' });
      await chat.locator('textarea[data-chat-input]').waitFor({ timeout: 60_000 });
      await dismissAccess(chat);
      const switched = (await sendAndWait(chat, stand, 'knobs turn after switch'))?.append ?? '';
      check(
        '2. после переключения: числа проектной половины (4), без глобальной (5)',
        rounds(switched, 4) && !rounds(switched, 5),
        switched.slice(0, 600),
      );
      await chat.close();

      // 3. Закреплённую Solo удалили — её числа в ход не попадают.
      const second = await openProjectChat(stand, browser, copy, 'repo-wt');
      await second.getByRole('button', { name: 'Новый чат' }).first().click();
      check(
        'новый чат: первый ход дошёл',
        Boolean(await sendAndWait(second, stand, 'solo knobs warm up')),
      );
      await chatGroupMenu(second, /^Solo/);
      const pinned = (await sendAndWait(second, stand, 'solo knobs pinned'))?.append ?? '';
      check(
        'контроль: числа закреплённой Solo (6) доезжают',
        rounds(pinned, 6) && pinned.includes('"Solo"'),
        pinned.slice(0, 400),
      );
      const removed = await stand.api(`/groups/${ids.solo}`, { method: 'DELETE' });
      check('Solo удалена', removed.status < 300, `${removed.status}`);
      const gone = await sendAndWait(second, stand, 'solo knobs after delete');
      check('ход после удаления дошёл до CLI', Boolean(gone));
      check(
        '3. чисел удалённой группы в ходе нет',
        !rounds(gone?.append ?? '', 6) && !(gone?.append ?? '').includes('"Solo"'),
        (gone?.append ?? '').slice(0, 400),
      );
      check(
        'страницы без ошибок',
        chat.errors.length === 0 && second.errors.length === 0,
        [...chat.errors, ...second.errors].join(' | '),
      );
    } finally {
      await browser.close();
    }
  },
);
