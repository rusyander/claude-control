/**
 * Заметки к правкам в окне «Код проекта» (этап 12 ядра, N1, P172) — настоящая дорога: одноразовая
 * панель, своё ядро, настоящий claude из PATH человека против `packages/stub-model` (подменена
 * только модель). Правки делает сам агент заглушки (Read → Edit `a.txt`, Write `b.txt`), окно кода
 * показывает их дифф; ответы панели и ядра не перехватываются, кроме ОДНОГО ответа в шаге отказа:
 * на сетевой границе вкладки он подменён тем, что сервер шлёт при отказе (422 workspace_missing).
 *
 * Что видно:
 *   - у строк диффа есть «+ заметка» (поле строки и кнопка «Заметка» для строки курсора);
 *   - три заметки на двух файлах, добавленные вразнобой, — «В очередь» во время хода: пока ход
 *     идёт, ничего не уходит; после хода — ОДНО сообщение (один `/chat/send`, одна команда
 *     `message-to-step` в журнале ядра), блоки по файлу и строке, у модели — то же одно сообщение;
 *   - «Сейчас» во время хода — одно слово «на ходу» (`steer`), одна команда в журнале;
 *   - агент свободен — «В очередь» отправляет сразу, одним сообщением;
 *   - отправка не принята (422 workspace_missing) — заметки остаются в лотке; повтор — уходят. Обрыв сети отказом не считается: хранилище само повторяет отправку и
 *     доставляет её, как из поля чата.
 *
 * Запуск: `node tools/qa/check-diff-notes.mjs` (стенд свой, `pnpm dev` не нужен). `SHOTS=<dir>` —
 * кадры в обеих темах, `SHOT_TAG=BEFORE|AFTER` — суффикс кадра.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHOTS = process.env.SHOTS || '';
const SHOT_TAG = process.env.SHOT_TAG || 'AFTER';
/** Пауза ответа хода «занят»: окно, в котором человек жмёт кнопку лотка посреди хода. */
const BUSY_MS = 25_000;
const HEADER = 'Заметки к правкам';

const { chromium } = await import('playwright');
const { runOnStand, NotChecked, wait } = await import('./throwaway-stand.mjs');
const { openProjectChat } = await import('./chat-walk.mjs');
const { startStubModel } = await import('../../packages/stub-model/src/index.mjs');

const cliAt = (name) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
};
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

/** Текст содержимого сообщения любой формы (строка, блоки, результат инструмента). */
function flat(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : (b?.text ?? flat(b?.content))))
    .filter(Boolean)
    .join('\n');
}
const messagesOf = (body) => (Array.isArray(body?.messages) ? body.messages : []);
/** Слова человека в сообщении — без результатов инструментов. */
const wordsOf = (m) =>
  m?.role !== 'user'
    ? ''
    : Array.isArray(m.content)
      ? flat(m.content.filter((b) => b?.type !== 'tool_result'))
      : flat(m.content);
const isToolResult = (m) =>
  m?.role === 'user' &&
  Array.isArray(m.content) &&
  m.content.some((b) => b?.type === 'tool_result');
const MARK = /ход-\d+|метка-n\d/;

const claude = cliAt('claude');
let repo = '';
const fileA = () => join(repo, 'a.txt');
const fileB = () => join(repo, 'b.txt');

/**
 * Модель чата. Ход — последнее сообщение человека с «ход-N» или меткой заметки. «правь» — агент
 * правит сам: Read a.txt → Edit a.txt → Write b.txt → «правки готовы» (по числу результатов
 * инструментов после хода). «занят» — ответ придержан на BUSY_MS. Иначе короткий ответ.
 */
const trace = [];
const stub = await startStubModel({
  script: (ctx) => {
    const messages = messagesOf(ctx.request.body);
    trace.push(messages.map(wordsOf).filter(Boolean));
    let at = -1;
    messages.forEach((m, i) => {
      if (MARK.test(wordsOf(m))) at = i;
    });
    const said = at >= 0 ? wordsOf(messages[at]) : '';
    const done = messages.slice(at + 1).filter(isToolResult).length;
    const tools = ctx.info.tools.map((t) => t.name);
    if (/метка-n\d/.test(said)) return { text: 'заметки приняты' };
    if (/правь/.test(said) && tools.includes('Edit') && tools.includes('Write')) {
      if (done === 0) return { tool: { name: 'Read', args: { file_path: fileA() } } };
      if (done === 1) {
        return {
          tool: {
            name: 'Edit',
            args: {
              file_path: fileA(),
              old_string: 'строка a3',
              new_string: 'строка a3 — правка агента',
            },
          },
        };
      }
      if (done === 2) {
        return {
          tool: {
            name: 'Write',
            args: { file_path: fileB(), content: 'строка b1\nстрока b2\nстрока b3\n' },
          },
        };
      }
      return { text: 'правки готовы' };
    }
    const turn = /ход-(\d+)/.exec(said)?.[1];
    if (/занят/.test(said)) return { text: `ответ на ход-${turn}`, holdMs: BUSY_MS };
    return { text: turn ? `ответ на ход-${turn}` : 'stub side reply' };
  },
});
const stubEnv = { ANTHROPIC_BASE_URL: stub.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };

await runOnStand(
  {
    label: 'diff-notes',
    extraPath: claude ? [dirname(claude)] : [],
    env: stubEnv,
    core: true,
    seed: ({ root }) => {
      repo = join(root, 'repo');
      mkdirSync(repo, { recursive: true });
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.name', 'stand']);
      git(repo, ['config', 'user.email', 'stand@example.invalid']);
      const lines = Array.from({ length: 8 }, (_, i) => `строка a${i + 1}`);
      writeFileSync(fileA(), `${lines.join('\n')}\n`);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'init']);
    },
  },
  async (stand, check) => {
    if (!claude) throw new NotChecked('claude нет в PATH — чат через ядро не проверен');
    seedClaudeEnv(stand);
    const browser = await chromium.launch();
    try {
      await scenario(stand, check, browser);
    } finally {
      await browser.close();
      await stub.close();
    }
  },
);

/** Вход claude стенда — адрес заглушки в `env` личного settings.json (как в `check-core-chat`). */
function seedClaudeEnv(stand) {
  const path = join(stand.cfg, 'settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  writeFileSync(
    path,
    `${JSON.stringify({ ...settings, env: { ...settings.env, ...stubEnv } }, null, 2)}\n`,
  );
}

/** Строки журналов всех задач ядра стенда. */
function journalLines(stand) {
  const tasks = join(stand.coreHome, 'tasks');
  if (!existsSync(tasks)) return [];
  return readdirSync(tasks).flatMap((taskId) => {
    const dir = join(tasks, taskId);
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
      .map((l) => JSON.parse(l));
  });
}

/** Команды `message-to-step` в журналах ядра, чей текст содержит `mark`. */
function stepMessages(stand, mark) {
  return journalLines(stand).filter((l) => {
    if (l.kind !== 'command.received') return false;
    const data = l.data ?? l.body ?? {};
    return data.kind === 'message-to-step' && JSON.stringify(data.fields ?? {}).includes(mark);
  });
}

/** Сообщения человека у модели, где есть хоть одна из меток (объявление функцией: сценарий выше). */
function modelSaw(marks) {
  return [...new Set(trace.flat())].filter((text) => marks.some((m) => text.includes(m)));
}

async function until(probe, seconds) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await probe()) return true;
    await wait(250);
  }
  return false;
}

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${SHOT_TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

async function scenario(stand, check, browser) {
  const page = await openProjectChat(stand, browser, repo, 'repo');
  const sends = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().includes('/api/chat/send')) return;
    const body = req.postDataJSON?.() ?? {};
    sends.push({ steer: body.steer === true, prompt: String(body.prompt ?? ''), at: Date.now() });
  });
  const input = page.locator('textarea[data-chat-input]');
  const stopButton = page.getByRole('button', { name: 'Остановить' });
  const say = async (text) => {
    await input.fill(text);
    await input.press('Enter');
  };
  const idle = () => until(async () => (await stopButton.count()) === 0, 120);

  // Ход-1: агент правит два файла сам.
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
  await wait(1000);
  await say('ход-1: правь файлы');
  const edited = await until(
    () => existsSync(fileB()) && readFileSync(fileA(), 'utf8').includes('правка агента'),
    180,
  );
  check('агент заглушки поправил a.txt и записал b.txt', edited);
  check(
    'ход-1 закончился ответом',
    await until(() => page.getByText('правки готовы').count(), 120),
  );
  await idle();

  // Окно кода: дифф правок агента.
  const dialog = page.getByRole('dialog');
  const openCode = async () => {
    await page.getByRole('button', { name: 'Код проекта' }).first().click();
    await dialog.locator('[data-testid="project-code-editor"] .cm-content').waitFor({
      timeout: 30_000,
    });
  };
  const closeCode = async () => {
    await dialog.getByRole('button', { name: 'Закрыть' }).first().click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  };
  const openFile = async (name) => {
    await dialog
      .getByRole('button', { name: new RegExp(`${name.replace('.', '\\.')}`) })
      .first()
      .click();
    await until(
      async () =>
        (
          await dialog.locator('[data-testid="project-code-editor"] .cm-content').innerText()
        ).includes(name === 'a.txt' ? 'строка a1' : 'строка b1'),
      20,
    );
  };
  await openCode();
  await check(
    'окно кода: два изменённых файла агента',
    await until(() => dialog.getByRole('button', { name: /Изменённые \(2\)/ }).count(), 30),
  );
  await openFile('a.txt');
  check(
    'дифф правки агента виден (строка a3 помечена изменённой)',
    await until(() => dialog.locator('.cm-changedLine').count(), 20),
  );
  const hasNotes = (await dialog.locator('.cm-diff-notes-gutter').count()) > 0;
  if (SHOT_TAG === 'BEFORE') await shoot(page, 'diff-view');
  check('у строк диффа есть «+ заметка» (поле заметок у редактора)', hasNotes);
  if (!hasNotes) return;

  const tray = dialog.locator('[data-testid="diff-notes-tray"]');
  const notesShown = () => tray.locator('[data-testid="diff-note"]').count();
  /** Заметка полем строки: «+» у строки `line` открытого файла. */
  const noteByGutter = async (line, text) => {
    await dialog.locator(`[data-note-line="${line}"]`).first().click();
    await dialog.locator('[data-testid="diff-note-draft"]').fill(text);
    await dialog.getByRole('button', { name: 'Добавить', exact: true }).click();
  };
  /** Заметка кнопкой «Заметка» — для строки курсора (дорога с клавиатуры). */
  const noteByCursor = async (line, text) => {
    await dialog
      .locator('.cm-content .cm-line')
      .nth(line - 1)
      .click();
    await dialog.getByRole('button', { name: 'Заметка', exact: true }).click();
    const draft = dialog.locator('[data-testid="diff-note-draft"]');
    await draft.fill(text);
    await draft.press('Control+Enter');
  };

  // Три заметки на двух файлах, вразнобой: b:2, a:6, a:3 — сообщение обязано идти a:3, a:6, b:2.
  await openFile('b.txt');
  await noteByGutter(2, 'метка-n1 вторая строка лишняя');
  await openFile('a.txt');
  await noteByGutter(6, 'метка-n2 шестая лишняя');
  await noteByCursor(3, 'метка-n3 правка агента не нужна');
  check(`в лотке три заметки (${await notesShown()})`, (await notesShown()) === 3);
  const marked = await dialog
    .locator('[data-note-line][data-has-note="true"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-note-line')).join(','));
  check(`строки a.txt с заметками помечены у поля: 3 и 6 (${marked})`, marked === '3,6');
  await shoot(page, 'notes-on-lines');

  // «В очередь» во время хода.
  await closeCode();
  await say('ход-2: занят');
  check('ход-2 идёт у модели', await until(() => modelSaw(['ход-2']).length > 0, 90));
  await openCode();
  check('лоток пережил закрытие окна: три заметки', (await notesShown()) === 3);
  await shoot(page, 'batch-bar-live');
  await dialog.getByRole('button', { name: 'В очередь', exact: true }).click();
  check(
    '«В очередь» принята — лоток пуст',
    await until(async () => (await notesShown()) === 0, 10),
  );
  const marks3 = ['метка-n1', 'метка-n2', 'метка-n3'];
  const sentDuring = () => sends.filter((s) => marks3.some((m) => s.prompt.includes(m)));
  await wait(1500);
  check(
    'пока ход-2 идёт, заметки не ушли (очередь, не «на ходу»)',
    sentDuring().length === 0,
    JSON.stringify(sends),
  );
  await closeCode();
  await until(() => page.getByText('ответ на ход-2').count(), 90);
  check('после хода-2 заметки ушли', await until(() => sentDuring().length > 0, 60));
  await until(() => modelSaw(marks3).length > 0, 90);
  await idle();
  const batch = sentDuring();
  check(
    `ОДИН запрос /chat/send с тремя заметками, не «на ходу» (${batch.length})`,
    batch.length === 1 && !batch[0].steer && marks3.every((m) => batch[0].prompt.includes(m)),
    JSON.stringify(batch),
  );
  const order = marks3.map((m) => batch[0]?.prompt.indexOf(m) ?? -1);
  check(
    'блоки по файлу и строке: a.txt:3, a.txt:6, b.txt:2',
    order[2] < order[1] &&
      order[1] < order[0] &&
      /a\.txt:3[\s\S]*a\.txt:6[\s\S]*b\.txt:2/.test(batch[0]?.prompt ?? '') &&
      (batch[0]?.prompt ?? '').startsWith(HEADER),
    batch[0]?.prompt,
  );
  check(
    'в каждом блоке строка файла: «строка a3 — правка агента», «строка a6», «строка b2»',
    ['строка a3 — правка агента', 'строка a6', 'строка b2'].every((s) =>
      (batch[0]?.prompt ?? '').includes(s),
    ),
  );
  check(
    `одна команда message-to-step с заметками в журнале ядра`,
    stepMessages(stand, 'метка-n1').length === 1,
  );
  const sawBatch = modelSaw(marks3);
  check(
    `у модели — одно сообщение со всеми тремя заметками (разных сообщений с метками: ${sawBatch.length})`,
    sawBatch.length >= 1 && sawBatch.every((t) => marks3.every((m) => t.includes(m))),
    JSON.stringify(sawBatch).slice(0, 600),
  );
  check('ход заметок отвечен', await until(() => page.getByText('заметки приняты').count(), 60));

  // «Сейчас» во время хода — одно слово «на ходу».
  await openCode();
  await openFile('a.txt');
  await noteByGutter(7, 'метка-n4 седьмая');
  await openFile('b.txt');
  await noteByGutter(3, 'метка-n5 третья');
  await closeCode();
  await say('ход-4: занят');
  check('ход-4 идёт у модели', await until(() => modelSaw(['ход-4']).length > 0, 90));
  await openCode();
  await dialog.getByRole('button', { name: 'Сейчас', exact: true }).click();
  check('«Сейчас» принята — лоток пуст', await until(async () => (await notesShown()) === 0, 10));
  await closeCode();
  const marks2 = ['метка-n4', 'метка-n5'];
  const nowSends = () => sends.filter((s) => marks2.some((m) => s.prompt.includes(m)));
  await until(() => modelSaw(marks2).length > 0, 120);
  await idle();
  check(
    `«Сейчас»: один запрос «на ходу» (steer) с двумя заметками (${nowSends().length})`,
    nowSends().length === 1 &&
      nowSends()[0].steer &&
      marks2.every((m) => nowSends()[0].prompt.includes(m)),
    JSON.stringify(nowSends()),
  );
  check(
    '«Сейчас»: одна команда message-to-step в журнале ядра',
    stepMessages(stand, 'метка-n4').length === 1,
  );
  check(
    '«Сейчас»: модель получила заметки одним сообщением',
    modelSaw(marks2).every((t) => marks2.every((m) => t.includes(m))),
    JSON.stringify(modelSaw(marks2)).slice(0, 400),
  );

  // Агент свободен — «В очередь» уходит сразу.
  await openCode();
  await openFile('a.txt');
  await noteByGutter(1, 'метка-n6 первая');
  await dialog.getByRole('button', { name: 'В очередь', exact: true }).click();
  check(
    'свободный агент: лоток пуст после «В очередь»',
    await until(async () => (await notesShown()) === 0, 15),
  );
  const idleSends = () => sends.filter((s) => s.prompt.includes('метка-n6'));
  check(
    'свободный агент: заметка ушла сразу, один запрос, не «на ходу»',
    (await until(() => idleSends().length > 0, 15)) &&
      idleSends().length === 1 &&
      !idleSends()[0].steer,
    JSON.stringify(idleSends()),
  );
  check(
    'свободный агент: модель получила заметку',
    await until(() => modelSaw(['метка-n6']).length > 0, 90),
  );
  await closeCode();
  await idle();

  // Отказ отправки — заметки остаются. Ответ сервера на ОДИН запрос подменён на
  // сетевой границе вкладки ровно тем, что сервер шлёт при отказе
  // (`refuse()` в run-routes: 422 workspace_missing). Вызвать этот отказ на
  // самом сервере здесь нельзя: на Windows папку проекта держит открытой живой
  // процесс агента, и убрать её с диска не выходит. Обрыв сети отказом не
  // считается: хранилище повторяет отправку само и доставляет её, как из поля чата.
  await openCode();
  await openFile('a.txt');
  await noteByGutter(8, 'метка-n7 восьмая');
  let refused = 0;
  const refuseOnce = async (route) => {
    if (route.request().method() !== 'POST' || refused > 0) return route.fallback();
    refused++;
    return route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'workspace_missing',
        message: `Рабочая папка этого чата не найдена: ${repo}.`,
        cwd: repo,
        messageCode: 'run-workspace-missing',
        params: { cwd: repo },
      }),
    });
  };
  await page.route('**/api/chat/send', refuseOnce);
  await dialog.getByRole('button', { name: 'Сейчас', exact: true }).click();
  await until(() => refused > 0, 10);
  // Причина отказа видна человеку — уведомлением с текстом сервера.
  const why = page.getByText('Сообщение не отправлено', { exact: false }).first();
  const explained = await why
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  await wait(1000);
  const kept = await notesShown();
  await shoot(page, 'refused');
  await page.unroute('**/api/chat/send', refuseOnce);
  check(`отказ отправки (422): заметка осталась в лотке (${kept})`, refused === 1 && kept === 1);
  check('отказ отправки: причина показана («Сообщение не отправлено…»)', explained);
  check('отказ отправки: до модели ничего не дошло', modelSaw(['метка-n7']).length === 0);
  // Уведомление ложится поверх правого нижнего угла и на наведении не гаснет:
  // увести мышь и дождаться, пока оно уйдёт само (3 с), — как сделал бы человек.
  await page.mouse.move(10, 10);
  await why.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
  await dialog.getByRole('button', { name: 'Сейчас', exact: true }).click();
  check('повтор: лоток пуст', await until(async () => (await notesShown()) === 0, 15));
  check(
    'повтор: модель получила заметку',
    await until(() => modelSaw(['метка-n7']).length > 0, 90),
  );
  await closeCode();
  await page.close();
}
