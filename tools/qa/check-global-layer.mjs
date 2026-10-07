/**
 * Раздел «Глобальный слой» (В5) — на одноразовом стенде, через настоящий
 * интерфейс: сверка, отметка правки без перезагрузки, перенос в чат и запись
 * предложения в слой с резервной копией.
 *
 * Глобальная сторона — КОПИИ настоящих файлов пары из `~/.claude` человека
 * (только чтение), разложенные во временный каталог конфигурации стенда. Всё,
 * что проверка правит и записывает, — в этом каталоге; в конце сверяется, что
 * настоящие файлы остались байт в байт прежними.
 *
 * Ничего не подменено между интерфейсом и стороной: сверку ведёт настоящий
 * сервер, стороны работают в дочерних процессах на настоящих git-репозиториях
 * корпуса. Ослабленная глобальная сторона — файл в каталоге стенда, а не
 * перехват ответа.
 *
 * Запуск: node tools/qa/check-global-layer.mjs   (стенд не нужен, CLI не нужен)
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const PAIR_FILES = [
  'hooks/lib/push-sieves.mjs',
  'hooks/lib/push-sieves-scan.mjs',
  'skills/prepare-mr/SKILL.md',
];
const MODULE = 'hooks/lib/push-sieves-scan.mjs';
const REAL = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

/** Слабая глобальная сторона: ловит только закоммиченный `.env`. */
const WEAK = `export function scanBranch(git, { cwd, base, ref }) {
  const names = git(cwd, ['diff', '--name-only', base, ref]).stdout.split('\\n').filter(Boolean);
  const env = names.filter((name) => name.endsWith('.env'));
  return { blocks: env.length ? [{ id: 'committed-artifacts', items: env }] : [], advisories: [] };
}
`;

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const realShas = () => PAIR_FILES.map((file) => sha(join(REAL, file)));

function findFiles(dir, prefix, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) findFiles(path, prefix, out);
    else if (entry.name.startsWith(prefix)) out.push(path);
  }
  return out;
}

const missing = PAIR_FILES.filter((file) => !existsSync(join(REAL, file)));
if (missing.length > 0) {
  console.log(`Не проверено: в ${REAL} нет файлов пары: ${missing.join(', ')}`);
  process.exit(2);
}
const before = realShas();

await runOnStand(
  {
    label: 'global-layer',
    seed: ({ cfg }) => {
      for (const file of PAIR_FILES) {
        mkdirSync(dirname(join(cfg, file)), { recursive: true });
        cpSync(join(REAL, file), join(cfg, file));
      }
    },
  },
  async (stand, check) => {
    const pairs = async () => (await stand.api('/global-layer')).body.pairs;
    const settled = async (seconds = 180) => {
      for (let i = 0; i < seconds * 2; i += 1) {
        const pair = (await pairs())[0];
        if (pair && !pair.comparing && pair.comparedAt) return pair;
        await wait(500);
      }
      throw new Error('сверка не закончилась');
    };
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      const card = page.locator('[data-global-pair="sieves"]');
      const uiMatchesApi = async (pair, label) => {
        await page
          .waitForFunction(
            (at) =>
              document.querySelector('[data-global-pair]')?.textContent?.includes(at) ?? false,
            new Date(pair.comparedAt).toLocaleString('ru-RU'),
            { timeout: 20_000 },
          )
          .catch(() => undefined);
        const rows = await page.$$eval('[data-global-sieve]', (nodes) =>
          nodes.map((node) => ({
            sieve: node.getAttribute('data-global-sieve'),
            verdict: node.getAttribute('data-verdict'),
            counts: [...node.querySelectorAll('td')]
              .slice(0, 4)
              .map((td) => Number(td.textContent)),
          })),
        );
        const want = pair.rows.map((row) => ({
          sieve: row.sieve,
          verdict: row.verdict,
          counts: [row.both, row.panelOnly, row.globalOnly, row.neither],
        }));
        check(
          `${label}: таблица на странице = ответ API (${want.length} сит)`,
          JSON.stringify(rows) === JSON.stringify(want),
          `страница ${JSON.stringify(rows)}\n    API ${JSON.stringify(want)}`,
        );
        return rows;
      };

      // ── 1. Первая выдача сама сверяет настоящие копии ──────────────────────
      await page.goto(`${stand.webUrl}/settings?tab=globalLayer`);
      await card.waitFor({ timeout: 30_000 });
      const first = await settled();
      check(
        'сверка настоящих копий прошла у обеих сторон',
        first.panel?.ok && first.global?.ok,
        JSON.stringify({ panel: first.panel, global: first.global, error: first.error }),
      );
      check('корпус — 20 случаев', first.cases === 20, `cases=${first.cases}`);
      await uiMatchesApi(first, 'настоящие копии');
      const globalBetter = first.rows.filter((row) => row.verdict === 'global');
      if (globalBetter.length > 0) {
        const summary = await page.locator('[data-global-summary]').innerText();
        check(
          'итог словами называет, где глобальный слой лучше',
          summary.includes('Глобальный слой лучше'),
          summary.slice(0, 200),
        );
      }

      // ── 2. Правка глобального файла видна без перезагрузки ─────────────────
      writeFileSync(join(stand.cfg, MODULE), WEAK, 'utf8');
      const mark = page.locator('[data-global-changed]');
      const marked = await mark.waitFor({ timeout: 20_000 }).then(
        () => true,
        () => false,
      );
      check('отметка правки появилась на открытой странице без перезагрузки', marked);
      if (marked) {
        check('отметка называет сторону', (await mark.innerText()).includes('Глобальный слой'));
      }
      await wait(1500);
      const weak = await settled();
      check(
        'после правки сверка перезапустилась сама и отметка осталась',
        weak.changed?.sides?.includes('global') === true,
        JSON.stringify(weak.changed),
      );
      const migration = weak.rows.find((row) => row.sieve === 'migration-safety');
      check(
        'ослабленная копия проигрывает: migration-safety — «панель лучше»',
        migration?.verdict === 'panel',
        JSON.stringify(migration),
      );
      await uiMatchesApi(weak, 'ослабленная копия');
      const summary = await page.locator('[data-global-summary]').innerText();
      const name = await page
        .locator('[data-global-sieve="migration-safety"] th > span')
        .innerText();
      check(
        'карточка говорит «Панель лучше» и называет сито',
        summary.includes('Панель лучше') && summary.includes(name),
        summary.slice(0, 300),
      );

      // ── 3. Ручная сверка снимает отметку ───────────────────────────────────
      await mark.locator('button').click();
      await wait(1000);
      await settled();
      const gone = await mark.waitFor({ state: 'detached', timeout: 20_000 }).then(
        () => true,
        () => false,
      );
      check('«Сверить» в отметке снимает её после сверки', gone);

      // ── 4. Перенос — задание в поле ввода чата репозитория ─────────────────
      await page
        .locator('[data-global-sieve="migration-safety"]')
        .getByRole('button', { name: 'Перенести в глобальный' })
        .click();
      await page.waitForURL(/\/chat/, { timeout: 20_000 });
      const input = page.locator('textarea[data-chat-input]');
      await input.waitFor({ timeout: 20_000 });
      await page
        .waitForFunction(
          () => (document.querySelector('textarea[data-chat-input]')?.value ?? '').length > 0,
          null,
          { timeout: 10_000 },
        )
        .catch(() => undefined);
      const draft = await input.inputValue();
      check(
        'задание переноса лежит в поле ввода нового чата',
        draft.includes('sieve `migration-safety`') && draft.includes('--proposal'),
        draft.slice(0, 300),
      );
      check('задание запрещает писать в слой', draft.includes('Do NOT edit anything under'));

      // ── 5. Предложение: дифф, отказ по чужому отпечатку, запись с копией ───
      const proposalFile = join(
        stand.cfg,
        'agentdeck',
        'global-layer',
        'sieves',
        'proposal',
        MODULE,
      );
      mkdirSync(dirname(proposalFile), { recursive: true });
      cpSync(join(REAL, MODULE), proposalFile);
      await page.goto(`${stand.webUrl}/settings?tab=globalLayer`);
      const proposal = page.locator('[data-global-proposal]');
      check(
        'блок предложения показан',
        await proposal.waitFor({ timeout: 20_000 }).then(
          () => true,
          () => false,
        ),
      );
      await proposal.getByRole('button', { name: 'Показать дифф' }).click();
      await proposal.locator(`[data-proposal-file="${MODULE}"]`).waitFor({ timeout: 20_000 });

      const shown = (await stand.api('/global-layer/sieves/proposal')).body.files[0];
      const refused = await stand.api('/global-layer/sieves/apply', {
        method: 'POST',
        body: { files: [{ path: MODULE, beforeSha: shown.beforeSha, afterSha: 'not-shown' }] },
      });
      check(
        'запись не того, что показано, отклонена',
        refused.status >= 400 && refused.status < 500,
        `status ${refused.status}`,
      );
      check('после отказа файл слоя прежний', stand.read(join(stand.cfg, MODULE)) === WEAK);

      await proposal.getByRole('button', { name: 'Записать в глобальный слой' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Записать в глобальный слой' }).click();
      let written = false;
      for (let i = 0; i < 40 && !written; i += 1) {
        written = stand.read(join(stand.cfg, MODULE)) === readFileSync(join(REAL, MODULE), 'utf8');
        if (!written) await wait(250);
      }
      check('подтверждённое предложение записано в слой стенда', written);
      const backups = findFiles(stand.root, 'global-layer__hooks__lib__push-sieves-scan.mjs');
      check(
        'резервная копия прежнего файла сохранена',
        backups.length === 1 && readFileSync(backups[0], 'utf8') === WEAK,
        backups.join(', '),
      );
      check('каталог предложения очищен', !existsSync(proposalFile));
      await settled();
      check('ошибок страницы нет', page.errors.length === 0, page.errors.join('\n    '));
    } finally {
      await browser.close();
    }
    const after = realShas();
    check(
      'настоящие файлы пары в ~/.claude байт в байт прежние',
      after.every((value, index) => value === before[index]),
    );
  },
);
