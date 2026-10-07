/**
 * «Влит ли MR» пока хаб открыт (владелец 06.10.2026) — на настоящем проводе.
 *
 * Своя одноразовая панель и свой «GitLab» на свободном порту (заглушка
 * `/api/v4/projects/:p/merge_requests`). В записи панели — план разделения с
 * тремя группами: MR 949 (влит), 950 (открыт) и 951, уже отмеченный влитым.
 * Проверка читает дерево родителя тем же маршрутом, что пульт каждые 5 с, и
 * смотрит, что ушло в фордж и что после этого отдал хаб.
 *
 * 1. Фордж выключен — чтение хаба в фордж не ходит.
 * 2. Фордж включён — первое же чтение будит ОДИН запрос списка по iids только
 *    тех MR, что ещё могут поменяться (без 951), без веток обсуждения; хаб
 *    отдаёт 949 «влит», 950 без отметки.
 * 3. Частые чтения хаба (как опрос пульта) второго запроса не шлют.
 *
 * Ни настоящий `~/.claude`, ни рабочий стенд, ни сеть не трогаются.
 * Запуск: `node tools/qa/check-hub-mr-state.mjs`.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, runOnStand, wait } from './throwaway-stand.mjs';

const PARENT = 'qa-mr-state-parent';
const forgePort = await freePort();
const SITE = `http://127.0.0.1:${forgePort}`;
const mr = (iid) => `${SITE}/team/app/-/merge_requests/${iid}`;
const STATES = { 949: 'merged', 950: 'opened', 951: 'merged' };

const forgeCalls = [];
const forge = createServer((req, res) => {
  forgeCalls.push(decodeURIComponent(req.url ?? ''));
  const url = new URL(req.url ?? '/', SITE);
  if (
    url.pathname === '/api/v4/projects/team%2Fapp/merge_requests' ||
    url.pathname === '/api/v4/projects/team/app/merge_requests'
  ) {
    const iids = url.searchParams.getAll('iids[]').map(Number);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(iids.map((iid) => ({ iid, state: STATES[iid] ?? 'opened' }))));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise((done) => forge.listen(forgePort, '127.0.0.1', done));

const group = (index, iid, extra = {}) => ({
  index,
  title: `Группа ${index}`,
  branch: `feature/g${index}`,
  after: [],
  status: 'done',
  deliver: true,
  chatId: `qa-mr-state-kid-${index}`,
  startedAt: '2026-10-05T09:05:00.000Z',
  mr: mr(iid),
  ...extra,
});

const PLAN = {
  parentChatId: PARENT,
  projectPath: 'C:/qa-mr-state-project',
  createdAt: '2026-10-05T09:00:00.000Z',
  order: [0, 1, 2],
  request: {},
  proposal: {
    groups: [0, 1, 2].map((index) => ({
      title: `Группа ${index}`,
      branch: `feature/g${index}`,
      tasks: [`PROJ-${100 + index}`],
    })),
  },
  groups: [group(0, 949), group(1, 950), group(2, 951, { mrClosed: 'merged' })],
};

const groupsOf = async (stand) => {
  const tree = await stand.api(`/chat/${PARENT}/tree`);
  return tree.body?.split?.groups ?? [];
};

try {
  await runOnStand(
    {
      web: false,
      label: 'mr-state',
      seed: ({ cfg }) => {
        const file = join(cfg, 'agentdeck', 'state.json');
        const state = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, `${JSON.stringify({ ...state, splitPlans: { [PARENT]: PLAN } })}\n`);
      },
    },
    async (stand, check) => {
      // 1. Фордж выключен.
      const before = await groupsOf(stand);
      check(
        'хаб отдаёт план из трёх групп',
        before.length === 3,
        JSON.stringify(before).slice(0, 200),
      );
      await wait(800);
      check(
        'фордж выключен — чтение хаба в фордж не ходит',
        forgeCalls.length === 0,
        JSON.stringify(forgeCalls),
      );

      const saved = await stand.api('/integrations/forge', {
        method: 'PUT',
        body: {
          settings: { enabled: true, kind: 'gitlab', baseUrl: SITE, repo: 'team/app' },
          token: 'qa-token',
        },
      });
      check('фордж включён через API панели', saved.status === 200, saved.text.slice(0, 300));
      forgeCalls.length = 0;

      // 2. Первое чтение будит проверку; 3. частые чтения второго запроса не шлют.
      await groupsOf(stand);
      for (let i = 0; i < 4; i += 1) {
        await wait(300);
        await groupsOf(stand);
      }
      await wait(500);
      const after = await groupsOf(stand);
      const lists = forgeCalls.filter((call) => call.includes('/merge_requests?'));
      check(
        'один запрос состояния на проект за пять чтений хаба',
        lists.length === 1,
        JSON.stringify(forgeCalls),
      );
      check(
        'спрошены только MR, что ещё могут поменяться: 949 и 950, без 951',
        /iids\[\]=949&iids\[\]=950&/.test(lists[0] ?? '') && !/951/.test(lists[0] ?? ''),
        lists[0] ?? '',
      );
      check(
        'ни веток обсуждения, ни конвейера',
        !forgeCalls.some((call) => /discussions|pipelines/.test(call)),
        JSON.stringify(forgeCalls),
      );
      check('MR 949 — «влит»', after[0]?.mrClosed === 'merged', JSON.stringify(after[0]));
      check('MR 950 — без отметки', after[1]?.mrClosed === undefined, JSON.stringify(after[1]));
      check('MR 951 — отметка осталась', after[2]?.mrClosed === 'merged', JSON.stringify(after[2]));
    },
  );
} finally {
  forge.close();
}
