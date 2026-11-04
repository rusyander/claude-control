/**
 * Локальный слой в недоверенной папке (s10 G14 p7) — настоящая дорога на одноразовой панели со
 * своим ядром. Слой — содержимое репозитория, и ядро везёт его только в папку, которой Claude Code
 * доверяет (F-86); иначе ход отказан `session-carry-local-layer-needs-layer-on`. Человек видит это:
 *
 *   - на карточке «Локальный слой» («Проекты» → проект → «Из проекта») ДО хода: значок «папке нет
 *     доверия» и выход (доверить папку или «Выключен») вместо «Включён всегда — чаты идут на слое»;
 *   - в чате после отправки: отказ словами панели на языке интерфейса с тем же выходом, без строки
 *     ядра `session-carry-…` — и по-русски, и по-английски (язык переключён настройкой панели);
 *   - доверие записано (`<каталог конфигурации>/.claude.json`, `hasTrustDialogAccepted`, как пишет
 *     сам Claude Code): карточка без предупреждения, и ход идёт — фальшивый CLI получил его.
 *
 * Подменены только CLI (`fake-cli-chat-basics.mjs`) и дом; панель, ядро, отказ ядра, разбор отказа
 * сервером, словарь клиента — настоящие. Реальную конфигурацию человека не трогает (свой дом).
 *
 * Запуск: `node tools/qa/check-local-layer-trust.mjs` (стенд свой). `SHOTS=<dir>` — кадры ru/en.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_BASICS_CLI } from './fake-cli-chat-basics.mjs';
import { readTurns } from './fake-cli-append.mjs';
import { openProjectChat } from './chat-walk.mjs';

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

const TEXT = {
  ru: {
    tab: 'Из проекта',
    badge: 'папке нет доверия',
    card: 'Claude Code не доверяет этой папке',
    chat: 'а Claude Code папке не доверяет',
    way: 'режим «Выключен»',
    cardWay: 'на «Выключен»',
  },
  en: {
    tab: 'From the project',
    badge: 'folder not trusted',
    card: 'Claude Code does not trust this folder',
    chat: 'Claude Code does not trust the folder',
    way: 'mode «Off»',
    cardWay: 'to «Off»',
  },
};

let project = '';

/** Хвост журналов задач ядра стенда — почему ход отказан, если текст на экране не тот. */
function journalTail(stand) {
  const tasks = join(stand.coreHome, 'tasks');
  if (!existsSync(tasks)) return 'задач нет';
  return readdirSync(tasks)
    .flatMap((id) =>
      readdirSync(join(tasks, id))
        .filter((f) => f.endsWith('.jsonl'))
        .flatMap((f) =>
          readFileSync(join(tasks, id, f), 'utf8')
            .split('\n')
            .filter(Boolean),
        ),
    )
    .slice(-6)
    .map((line) => line.slice(0, 400))
    .join('\n      ');
}

await runOnStand(
  {
    label: 'local-layer-trust',
    fakeCli: { claude: FAKE_BASICS_CLI },
    core: true,
    seed: ({ root }) => {
      project = join(root, 'app');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'CLAUDE.md'), '# App\n\nКомандные правила проекта.\n', 'utf8');
      // Задача ядра берёт базу из ветки: репозиторий без коммита ядро не примет.
      const git = (args) => execFileSync('git', args, { cwd: project });
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.name', 'stand']);
      git(['config', 'user.email', 'stand@example.invalid']);
      git(['add', '.']);
      git(['commit', '-qm', 'init']);
    },
  },
  async (stand, check) => {
    const added = await stand.api('/projects', { method: 'POST', body: { path: project } });
    const id = added.body?.id;
    check('проект заведён в реестре стенда', added.status === 200 && Boolean(id), added.text);
    const on = await stand.api(`/projects/${id}/local-layer`, {
      method: 'PUT',
      body: { mode: 'on' },
    });
    check(
      'слой включён «Всегда», ручка называет папку недоверенной',
      on.body?.used === true && on.body?.folderTrust === 'untrusted',
      on.text.slice(0, 300),
    );

    const browser = await chromium.launch();
    try {
      for (const lang of ['ru', 'en']) {
        const t = TEXT[lang];
        if (lang === 'en') {
          const en = await stand.api('/settings', { method: 'PATCH', body: { language: 'en' } });
          check('язык панели переключён на английский', en.status === 200, en.text.slice(0, 200));
        }

        // ── Карточка: до хода ───────────────────────────────────────────────────────────
        const card = await stand.newPage(browser, { height: 1000 });
        await card.goto(`${stand.webUrl}/projects?id=${id}`, { waitUntil: 'domcontentloaded' });
        await card.getByRole('tab', { name: t.tab }).first().click({ timeout: 60_000 });
        const warn = card.getByTestId('local-layer-untrusted');
        await warn.waitFor({ timeout: 30_000 }).catch(() => undefined);
        const cardText = await card
          .getByTestId('local-layer-card')
          .innerText()
          .catch(() => '');
        check(`${lang}: карточка — значок «${t.badge}»`, cardText.includes(t.badge), cardText);
        check(
          `${lang}: карточка — причина и выход до хода`,
          cardText.includes(t.card) && cardText.includes(t.cardWay),
        );
        check(
          `${lang}: карточка не обещает «чаты идут на слое»`,
          !(await card.getByTestId('local-layer-reason').count()),
        );
        await card.getByTestId('local-layer-card').scrollIntoViewIfNeeded();
        await shot(card, `local-layer-card-untrusted-${lang}`);
        await card.close();

        // ── Чат: после отправки ─────────────────────────────────────────────────────────
        const page = await openProjectChat(stand, browser, project, 'app');
        const input = page.locator('textarea[data-chat-input]');
        await input.fill(lang === 'ru' ? 'привет' : 'hello');
        await input.press('Enter');
        const main = page.locator('main');
        let body = '';
        for (let i = 0; i < 240 && !body.includes(t.chat); i += 1) {
          body = await main.innerText().catch(() => '');
          await wait(250);
        }
        check(
          `${lang}: чат — отказ словами панели («${t.chat}»)`,
          body.includes(t.chat),
          `${body.slice(-600)}\n    журнал ядра: ${journalTail(stand)}`,
        );
        check(`${lang}: чат — выход назван («${t.way}»)`, body.includes(t.way));
        check(
          `${lang}: чат — строки ядра session-carry-… на экране нет`,
          !body.includes('session-carry-'),
        );
        await shot(page, `local-layer-chat-refused-${lang}`);
        await page.close();
      }

      // ── Доверие записано: предупреждения нет, ход идёт ───────────────────────────────────
      const config = join(stand.cfg ?? join(stand.home, '.claude'), '.claude.json');
      let current = {};
      try {
        current = JSON.parse(readFileSync(config, 'utf8'));
      } catch {
        current = {};
      }
      const key = project.replace(/\\/g, '/');
      current.projects = { ...(current.projects ?? {}), [key]: { hasTrustDialogAccepted: true } };
      writeFileSync(config, JSON.stringify(current, null, 2), 'utf8');
      const trusted = await stand.api(`/projects/${id}/local-layer`);
      check(
        'доверие записано — ручка называет папку доверенной',
        trusted.body?.folderTrust === 'trusted',
        trusted.text.slice(0, 200),
      );
      const page = await openProjectChat(stand, browser, project, 'app');
      const input = page.locator('textarea[data-chat-input]');
      await input.fill('ПИНГ: Ответь одним словом: пинг');
      await input.press('Enter');
      let reached;
      for (let i = 0; i < 240 && !reached; i += 1) {
        reached = readTurns(stand.read, stand.bin).find((turn) => turn.scenario === 'ping');
        await wait(250);
      }
      const after = await page
        .locator('main')
        .innerText()
        .catch(() => '');
      check('доверенная папка — ход дошёл до CLI', Boolean(reached), after.slice(-800));
      check(
        'доверенная папка — отказа о доверии нет',
        !after.includes(TEXT.en.chat) && !after.includes(TEXT.ru.chat),
      );
      check('ошибок страницы нет', page.errors.length === 0, page.errors.join('\n'));
      await page.close();
    } finally {
      await browser.close();
    }
  },
);
