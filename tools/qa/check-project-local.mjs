/**
 * «Из проекта» — собственный `.claude` проекта, который панель только показывает.
 *
 * Почему прогон нужен: Claude Code загружает скиллы, хуки и правила из каталога
 * репозитория поверх пользовательских, а панель до этого показывала только
 * `~/.claude`. Группа, привязанная к проекту, выглядела пустой, хотя агент в ней
 * работал с правилами и скиллами проекта. Теперь набор виден в двух местах:
 * вкладка «Из проекта» на странице проектов и компактный блок на карточке
 * привязанной группы, который раскрывается в тот же полный вид.
 *
 * Данные подменяются целиком: реестр проектов, группы и оба адреса набора
 * (`/projects/:id/local` и `/projects/local?path=`). Прогон не зависит ни от
 * реальных проектов, ни от установленного CLI, ни от того, приземлился ли уже
 * серверный маршрут.
 *
 * Снимки: `.agent/screenshots/before-after/project-local/after-{projects,groups}.png`.
 *
 * Запуск: `node tools/qa/check-project-local.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = '.agent/screenshots/before-after/project-local';

const PROJECT = { id: 'qa-local-project', name: 'QA локальный набор', path: 'C:/qa-local-project' };

const LOCAL = {
  root: `${PROJECT.path}/.claude`,
  exists: true,
  skills: [
    {
      id: 'qa-skill-notes',
      name: 'qa-skill-notes',
      description: 'Собирает заметки к релизу из закрытых задач.',
      body: '',
      files: ['references/template.md', 'config/sections.json'],
      sizeBytes: 2048,
      modifiedAt: '2026-09-01T10:00:00.000Z',
      groupIds: [],
      isEnabled: true,
    },
    {
      id: 'qa-skill-legacy',
      name: 'qa-skill-legacy',
      description: 'Выключен до конца миграции.',
      body: '',
      files: [],
      sizeBytes: 512,
      modifiedAt: '2026-08-20T10:00:00.000Z',
      groupIds: [],
      isEnabled: false,
    },
  ],
  hooks: [
    {
      id: 'PreToolUse:qa1',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'node .claude/hooks/qa-guard.mjs',
      isEnabled: true,
      scriptPath: '.claude/hooks/qa-guard.mjs',
      scriptExists: true,
      description: 'Страж деструктивных команд.',
      groupIds: [],
      source: 'settings',
    },
    {
      id: 'local:Stop:qa2',
      event: 'Stop',
      command: 'node .claude/hooks/qa-missing.mjs',
      isEnabled: true,
      scriptPath: '.claude/hooks/qa-missing.mjs',
      scriptExists: false,
      groupIds: [],
      source: 'settings-local',
    },
  ],
  rules: [
    {
      path: 'frontend.md',
      title: 'QA правило фронтенда',
      body: '# Фронтенд\n\nТекст правила фронтенда для прогона.',
      paths: ['src/**/*.tsx'],
      sizeBytes: 256,
      modifiedAt: '2026-09-01T10:00:00.000Z',
    },
    {
      path: 'commits.md',
      title: 'QA правило коммитов',
      body: '# Коммиты\n\nТекст правила коммитов для прогона.',
      paths: [],
      sizeBytes: 128,
      modifiedAt: '2026-08-15T10:00:00.000Z',
    },
  ],
};

const GROUP = {
  id: 'qa-local-group',
  name: 'QA привязанная группа',
  description: 'Группа, привязанная к проекту с собственным .claude.',
  color: 'accent',
  icon: 'folder',
  members: [],
  env: {},
  projectPaths: [PROJECT.path],
  isEnabled: true,
  order: 0,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
await bypassOnboarding(page);

// Страница проектов гейтится по провайдеру: у чужого CLI вкладки другие, поэтому
// провайдер закрепляется явно — прогон не зависит от настроек этой машины.
await page.route('**/api/settings', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const response = await route.fetch();
  const body = await response.json();
  return route.fulfill({ response, json: { ...body, onboardingDone: true, provider: 'claude' } });
});

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});
// Голое «Failed to load resource» в консоли не называет адрес — записываем его сами.
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});

await page.route('**/api/projects', (route) => route.fulfill({ json: [PROJECT] }));
// Панель открывается на вкладке «Правила» и сразу читает CLAUDE.md проекта, которого
// на живом сервере нет: без заглушки прогон видел бы чужой 404.
await page.route(`**/api/projects/${PROJECT.id}/rules`, (route) =>
  route.fulfill({ json: { content: '' } }),
);
await page.route(`**/api/projects/${PROJECT.id}/local`, (route) => route.fulfill({ json: LOCAL }));
await page.route('**/api/projects/local?*', (route) => route.fulfill({ json: LOCAL }));
await page.route('**/api/groups', (route) => route.fulfill({ json: [GROUP] }));
await page.route('**/api/automations', (route) => route.fulfill({ json: [] }));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};
const visible = (locator) => locator.isVisible().catch(() => false);

// --- Страница проектов: вкладка «Из проекта» ---
await page.goto(`${BASE}/projects?id=${PROJECT.id}`);
await page.waitForSelector('nav');
await page.waitForTimeout(1200);

const tab = page.getByRole('button', { name: 'Из проекта', exact: true });
check(await visible(tab), 'у проекта есть вкладка «Из проекта»');
await tab.click();
await page.waitForTimeout(1000);

check(
  await visible(page.getByText('только чтение', { exact: true })),
  'вкладка помечена «только чтение»',
);

for (const [title, count] of [
  ['Скиллы', 2],
  ['Хуки', 2],
  ['Правила', 2],
]) {
  const section = page.getByRole('region', { name: title });
  const badge = section.getByText(String(count), { exact: true }).first();
  check(await visible(badge), `раздел «${title}» показывает счётчик ${count}`);
}

check(await visible(page.getByText('qa-skill-notes', { exact: true })), 'скилл показан по имени');
check(await visible(page.getByText('файлов: 2', { exact: true })), 'у скилла виден счётчик файлов');
check(await visible(page.getByText('выключен', { exact: true })), 'выключенный скилл помечен');

check(await visible(page.getByText('PreToolUse', { exact: true })), 'хук показан по событию');
check(await visible(page.getByText('Bash', { exact: true })), 'у хука виден matcher');
check(
  await visible(page.getByText('settings.local.json', { exact: true })),
  'хук из settings.local.json помечен именем файла',
);
check(
  await visible(page.getByText('скрипт не найден', { exact: true })),
  'битый путь к скрипту помечен предупреждением',
);
check(
  await visible(page.getByText('node .claude/hooks/qa-guard.mjs', { exact: true })),
  'команда хука показана моноширинным',
);

check(
  await visible(page.getByText('QA правило фронтенда', { exact: true })),
  'правило показано по заголовку',
);
check(await visible(page.getByText('frontend.md', { exact: true })), 'у правила виден путь');
check(
  await visible(page.getByText('src/**/*.tsx', { exact: true })),
  'маски paths показаны чипами',
);

const ruleBody = page.getByText('Текст правила фронтенда для прогона.');
check(!(await visible(ruleBody)), 'тело правила по умолчанию свёрнуто');
await page.getByRole('button', { name: 'Показать текст: QA правило фронтенда' }).click();
await page.waitForTimeout(400);
check(await visible(ruleBody), 'тело правила раскрывается по кнопке');

await page.screenshot({ path: `${SHOTS}/after-projects.png`, fullPage: true });

// --- Страница групп: компактный блок на карточке привязанной группы ---
await page.goto(`${BASE}/groups`);
await page.waitForSelector('nav');
await page.waitForTimeout(1200);

check(await visible(page.getByText(GROUP.name, { exact: true })), 'карточка группы на экране');
check(
  await visible(page.getByText('Из проекта', { exact: true })),
  'на карточке есть блок «Из проекта»',
);
check(await visible(page.getByText(PROJECT.path, { exact: true })), 'блок подписан путём проекта');
for (const text of ['скиллов: 2', 'хуков: 2', 'правил: 2']) {
  check(
    await visible(page.getByText(text, { exact: true })),
    `компактный блок показывает «${text}»`,
  );
}

const skillInGroup = page.getByText('qa-skill-notes', { exact: true });
check(!(await visible(skillInGroup)), 'до раскрытия полный набор скрыт');
await page.getByRole('button', { name: 'Показать набор', exact: true }).click();
await page.waitForTimeout(600);
check(await visible(skillInGroup), 'после «Показать набор» виден полный набор');
check(
  await visible(page.getByText('settings.local.json', { exact: true })),
  'в раскрытом наборе те же пометки хуков',
);
check(
  await visible(page.getByRole('button', { name: 'Свернуть набор', exact: true })),
  'кнопка переключилась на «Свернуть набор»',
);

await page.screenshot({ path: `${SHOTS}/after-groups.png`, fullPage: true });

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Набор «Из проекта» виден на обеих страницах' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
