/**
 * Сквозной обход волны 3 этапа 12 через все её зоны — настоящая дорога на ОДНОМ одноразовом стенде:
 * своя панель, своё ядро на временном доме, настоящие `claude` и `codex` из PATH против
 * `packages/stub-model` (подменена только модель: сценарий `core-w3-walk-model.mjs` — и у маршрута-
 * заглушки ядра, и у входа CLI). Сеть — только эта машина: стенды проекта, «чужой сайт» на адресе сети
 * машины, поддельный Expo, `packages/stub-tracker`. Ответы панели и ядра не перехватываются.
 *
 * Что видно, по порядку (ноги — `core-w3-walk-legs.mjs`, `core-w3-walk-legs-board.mjs`):
 *   1. «Тесты» → «Сценарии» → «Записать сценарий»: проход ядра по стенду с доступом по имени, окно
 *      пережило закрытие и перечитку, запись в кейс и спек; «Прогнать все» — без единого вызова
 *      модели; поле пароля стало числовым — прогон встал на расхождении, ошибка без значения
 *      доступа, одна задача прохода, «Дефект продукта»;
 *   2. значение доступа — ни в одном файле стенда, следе модели, журнале;
 *   3. переходы за пределы стендов (302, ссылка) остановлены до запроса — «чужой сайт» получил 0;
 *      адреса самой панели (веб 8888, API 5178, даже записанные окружением) — отказ; доступ в
 *      числовое поле — ошибка без значения;
 *   4. проект в подкаталоге репозитория: проход копией берёт СВОИ окружения и доступ, CLI идёт в
 *      подкаталоге копии; чат на месте — в подкаталоге проекта;
 *   5. push: по одному на каждый ждущий вопрос всех задач обхода, ни одного на неждущий;
 *   6. окно сайта в чате: выбор элемента → чип → сообщение модели несёт разметку;
 *   7. связанные карточки из трекера → «Объединить» (не больше 15 отметок) → одна задача со всеми
 *      тикетами; отказ ядра — одной строкой по-русски; отказ хода в окне карточки — по-русски;
 *   8. «Максимум качества» → второе ревью на другом CLI (codex), заглушка модели у обоих.
 *
 * Запуск: `node tools/qa/check-core-w3-cross-zone-live.mjs` (стенд свой, `pnpm dev` не нужен; нужны
 * `claude`, `codex` и Chromium Playwright). `ONLY=walk,relay,…` — только эти ноги (отладка).
 * `SHOTS=<dir>` — кадры. Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { NotChecked, REAL_HOME, REPO, runOnStand } from './throwaway-stand.mjs';
import { w3WalkScript } from './core-w3-walk-model.mjs';
import { startFakeExpo, startForeignCounter, startW3Site } from './core-w3-walk-site.mjs';
import {
  walkAway,
  walkRecord,
  walkReplay,
  walkSecretSweep,
  walkSubfolder,
} from './core-w3-walk-legs.mjs';
import { walkPick, walkRelay } from './core-w3-walk-legs-chat.mjs';
import { walkRelated, walkStrict } from './core-w3-walk-legs-board.mjs';

const { startStubModel } = await import('../../packages/stub-model/src/index.mjs');
const { startStubTracker } = await import('../../packages/stub-tracker/src/index.mjs');
const { writeToken } = await import('../../apps/server/src/domains/integrations/store/store.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = join(HERE, 'core-w3-walk-model.mjs');
const PUSH_SEED = join(HERE, 'check-core-push.mjs');
const PICK_FIXTURE = 'apps/server/src/domains/site-preview/__fixtures__/dev-site.mjs';
const SHOTS = process.env.SHOTS ?? '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const wants = (leg) => ONLY.length === 0 || ONLY.includes(leg);

/** Значения доступов стендов: ни одно не должно лечь в файл, след или журнал. */
const SECRETS = { STAND_PASSWORD: 'W3pw-7c1e4b0d', SUB_TOKEN: 'W3sub-91ad0f2e' };

const cliAt = (name) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
};
const claude = cliAt('claude');
const codex = cliAt('codex');
const git = (cwd, ...args) => {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
};

const site1 = await startW3Site('p1');
const site2 = await startW3Site('sub');
const foreign = await startForeignCounter();
const expo = await startFakeExpo();
const tracker = await startStubTracker({
  deployment: 'cloud',
  issues: [
    { key: 'PROJ-100', summary: 'Checkout epic', type: 'Epic' },
    ...Array.from({ length: 17 }, (_, i) => ({
      key: `PROJ-${101 + i}`,
      summary: `Checkout part ${i + 1}`,
      type: 'Story',
      labels: ['agentdeck'],
      parent: 'PROJ-100',
    })),
  ],
});
// Вход CLI (`cli-login:*`): тот же сценарий в процессе проверки, все тела — в память.
const cliTrace = [];
const script = w3WalkScript({ awayUrl: foreign.url });
const cliStub = await startStubModel({
  script: (ctx) => {
    cliTrace.push(ctx.request.body ?? {});
    return script(ctx);
  },
});
const stubEnv = {
  ANTHROPIC_BASE_URL: cliStub.baseUrl,
  ANTHROPIC_API_KEY: 'stand-stub-key',
  ANTHROPIC_MODEL: 'stub-model',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost',
};

let paths = {};
/** Ссылки node_modules, заведённые `seedRepos`; снимает `unlinkModules`. */
const linked = [];
let exit = 0;
try {
  await runOnStand(
    {
      label: 'w3-walk',
      core: true,
      web: true,
      extraPath: [...new Set([claude, codex].filter(Boolean).map((p) => dirname(p)))],
      env: {
        ...stubEnv,
        AGENTDECK_CORE_SUPERVISE: '0',
        AGENTDECK_EXPO_PUSH_URL: expo.url,
        // Chromium Playwright лежит в настоящем LOCALAPPDATA, а дом стенда временный: только путь
        // к браузеру — граница, не настройка человека.
        PLAYWRIGHT_BROWSERS_PATH: join(
          process.env.LOCALAPPDATA ?? join(REAL_HOME, 'AppData', 'Local'),
          'ms-playwright',
        ),
      },
      settings: {
        integrations: {
          jira: {
            enabled: true,
            baseUrl: tracker.url,
            email: 'agent@tracker.example.com',
            deployment: 'cloud',
          },
        },
      },
      seed: ({ root, cfg, coreHome }) => {
        writeFileSync(join(cfg, 'settings.json'), `${JSON.stringify({ env: stubEnv }, null, 2)}\n`);
        writeToken(join(cfg, 'agentdeck'), 'jira', tracker.tokens.agent);
        paths = seedRepos(root);
        // Сайт окна чата — поддельный dev-сервер, его запускает реестр запусков панели.
        paths.pickSite = join(root, 'pick-site');
        mkdirSync(paths.pickSite, { recursive: true });
        copyFileSync(join(REPO, PICK_FIXTURE), join(paths.pickSite, 'dev-site.mjs'));
        writeFileSync(
          join(paths.pickSite, 'package.json'),
          `${JSON.stringify({ name: 'pick-site', private: true, scripts: { dev: 'node dev-site.mjs' } }, null, 2)}\n`,
        );
        // Вопросы с действием по умолчанию и без — кодом ядра до старта (режим посева check-core-push).
        const seeded = spawnSync(
          process.execPath,
          ['--experimental-strip-types', '--no-warnings', PUSH_SEED, '--seed', coreHome],
          { encoding: 'utf8' },
        );
        if (seeded.status !== 0) throw new Error(`посев вопросов: ${seeded.stderr}`);
        const trace = join(root, 'core-stub-trace.jsonl');
        const configFile = join(coreHome, 'config.json');
        const config = JSON.parse(readFileSync(configFile, 'utf8'));
        config.routes = {
          stub: [
            {
              name: 'stand',
              models: ['stub-model'],
              script: { module: MODEL, export: 'w3WalkScript', args: [{ awayUrl: foreign.url }] },
              trace,
            },
          ],
        };
        // Входящие из трекера: истории с меткой agentdeck, репозиторий проекта PROJ — p1.
        config.inbox = {
          pollMs: 60_000,
          sources: [
            {
              id: 'jira-w3',
              enabled: true,
              system: 'jira',
              jira: { labels: ['agentdeck'], assignedToMe: false },
              repos: { PROJ: paths.p1 },
            },
          ],
        };
        config.board = {
          inWork: 4,
          perDay: null,
          paused: false,
          stopOnQuestion: false,
          defaultStop: 'mr',
        };
        writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
        paths.coreTrace = trace;
      },
    },
    async (stand, check) => {
      if (!claude) throw new NotChecked('claude нет в PATH — сессиям задач нужен CLI');
      if (!foreign.url)
        throw new NotChecked('нет адреса сети этой машины — «чужой сайт» не поднять');
      const ctx = {
        stand,
        check,
        paths,
        site1,
        site2,
        foreign,
        expo,
        tracker,
        cliTrace,
        codex,
        SECRETS,
        SHOTS,
        tasks: new Set(),
      };
      const leg = async (name, run) => {
        if (!wants(name)) return;
        const t0 = Date.now();
        console.log(`— нога «${name}»`);
        try {
          await run();
        } catch (error) {
          check(
            `нога «${name}» дошла до конца`,
            false,
            String(error?.stack ?? error).slice(0, 900),
          );
        }
        console.log(`  · нога «${name}»: ${Math.round((Date.now() - t0) / 1000)} с`);
      };
      const device = await stand.api('/remote/devices', {
        method: 'POST',
        body: { token: 'ExponentPushToken[qa-w3-walk]', platform: 'android', label: 'QA' },
      });
      check('телефон заведён для push', device.status < 300, device.text.slice(0, 300));
      const browser = await chromium.launch();
      try {
        const page = await stand.newPage(browser, { width: 1600, height: 1100 });
        page.setDefaultTimeout(15_000);
        ctx.page = page;
        await leg('walk', () => walkRecord(ctx, page));
        await leg('walk', () => walkReplay(ctx, page));
        await leg('away', () => walkAway(ctx));
        await leg('sub', () => walkSubfolder(ctx, browser));
        await leg('pick', () => walkPick(ctx, browser));
        await leg('related', () => walkRelated(ctx, browser));
        await leg('strict', () => walkStrict(ctx, browser));
        await leg('relay', () => walkRelay(ctx));
        await leg('walk', () => walkSecretSweep(ctx));
        check('страница обхода без ошибок', page.errors.length === 0, page.errors.join(' | '));
      } finally {
        await browser.close();
        unlinkModules();
      }
    },
  );
} catch (error) {
  console.error(error);
  exit = 1;
} finally {
  await Promise.allSettled([
    cliStub.close?.(),
    site1.close(),
    site2.close(),
    foreign.close(),
    expo.close(),
    tracker.close?.(),
  ]);
}
if (exit) process.exit(exit);

/** Два репозитория: проект в вершине (p1) и проект в подкаталоге `mono/app` (p2). */
function seedRepos(root) {
  const make = (dir, files) => {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'qa');
    git(dir, 'config', 'user.email', 'qa@example.invalid');
    git(dir, 'config', 'core.autocrlf', 'false');
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\nnode_modules\ntest-results/\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    // Записанный спек ищет пакет playwright вверх от себя — как в проекте, где он стоит
    // (recorded.live.integration.test.ts). Ссылка снимается до удаления каталога стенда.
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'junction');
    linked.push(join(dir, 'node_modules'));
  };
  const p1 = join(root, 'p1');
  make(p1, { 'README.md': '# p1\n' });
  const mono = join(root, 'mono');
  make(mono, { 'README.md': '# mono\n', 'app/README.md': '# app\n', 'lib/README.md': '# lib\n' });
  return { p1, mono, p2: join(mono, 'app') };
}

/** Ссылки node_modules проектов стенда: только сама ссылка, никогда не то, на что она ведёт. */
function unlinkModules() {
  for (const link of linked.splice(0)) rmSync(link, { force: true, recursive: false });
}
