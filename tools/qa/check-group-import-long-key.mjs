/**
 * Импорт найденного набора, чей ключ длиннее 100 знаков. Кейс panel-agent-walks-002.
 *
 * Ключ находки — `<путь источника>#<слаг>`, а маршрут импорта берёт его параметром
 * адреса (`POST /api/groups/discovery/:key/import`) — тем же, которым импортируют и
 * страница «Группы» (`GroupSourcesApi.ts`), и действие агента
 * `import_discovered_group`. У Fastify по умолчанию параметр не длиннее 100 знаков:
 * проект в глубокой папке Windows получал 414, и импорт не работал нигде.
 *
 * Проверка идёт в НАСТОЯЩИЙ экземпляр панели — `apps/server/src/index.ts` на
 * одноразовом доме (`throwaway-stand.mjs`), без фронта. Поиск наборов зовёт модель
 * служебным `claude -p` — его отвечает фальшивый CLI (`fake-cli-panel-agent.mjs`).
 * Свидетельства: статус ответа импорта и группа в `state.json` одноразового дома.
 *
 * Запуск: `node tools/qa/check-group-import-long-key.mjs [--server-dir <копия apps/server>]`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_PANEL_AGENT_CLI_SOURCE } from './fake-cli-panel-agent.mjs';

// Глубокая папка проекта: путь источника вместе со слагом — заведомо за 100 знаков.
const DEEP = ['clients', 'north-region', 'platform-services', 'billing-and-invoices', 'long-proj'];
const SET_NAME = `Walk set ${DEEP.at(-1)}`;

const serverAt = process.argv.indexOf('--server-dir');
const SERVER_DIR = serverAt > 0 ? process.argv[serverAt + 1] : undefined;

function seed({ root }) {
  for (const id of ['long-alpha', 'long-beta']) {
    const dir = join(root, ...DEEP, '.claude', 'skills', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id}\n---\n\n## 1. Do\n`);
  }
}

await runOnStand(
  {
    label: 'group-import-long-key',
    web: false,
    fakeCli: { claude: FAKE_PANEL_AGENT_CLI_SOURCE },
    seed,
    ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
  },
  async (stand, check) => {
    // Без фронта стенд назначает окну порт API + 1 — его Origin панель и пропускает.
    const origin = `http://127.0.0.1:${Number(new URL(stand.apiUrl).port) + 1}`;
    const project = join(stand.root, ...DEEP);
    const added = await stand.api('/projects', {
      method: 'POST',
      headers: { origin },
      body: { path: project },
    });
    check('проект в глубокой папке добавлен', added.status === 200, added.text.slice(0, 300));

    let view;
    for (let t = 0; t < 60_000; t += 300) {
      view = (await stand.api('/groups/discovery')).body;
      if (view && !view.running && view.lastRunAt) break;
      await wait(300);
    }
    const found = (view?.groups ?? []).find((item) => item.name === SET_NAME);
    check('поиск наборов нашёл набор проекта', Boolean(found), JSON.stringify(view).slice(0, 600));
    if (!found) return;
    check(
      `ключ находки длиннее 100 знаков (${found.key.length})`,
      found.key.length > 100,
      found.key,
    );

    // Тот же адрес, что шлёт страница «Группы»: `/api` + `/groups/discovery/${encodeURIComponent(key)}/import`.
    const imported = await stand.api(`/groups/discovery/${encodeURIComponent(found.key)}/import`, {
      method: 'POST',
      headers: { origin },
      body: {},
    });
    check(
      'импорт по длинному ключу принят (200, не 414)',
      imported.status === 200,
      `HTTP ${imported.status}: ${imported.text.slice(0, 300)}`,
    );
    const state = JSON.parse(stand.read(join(stand.cfg, 'agentdeck', 'state.json')) ?? '{}');
    const group = (state.groups ?? []).find((item) => item.name === SET_NAME);
    check(
      'группа легла в state.json: проектная, выключенная',
      group?.isEnabled === false && group?.scope?.kind === 'project',
      JSON.stringify(group),
    );
  },
);
