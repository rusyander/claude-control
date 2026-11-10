/**
 * Клиент трекера панели вживую (этап 12, I1): одноразовая панель ходит в Jira через общий
 * пакет `@agentdeck/trackers`, а Jira — заглушка `packages/stub-tracker` в двух диалектах
 * (облако: Basic + `/rest/api/3`, своя установка: Bearer + `/rest/api/2`). Проверяется весь
 * путь человека: карточка «Проверить связь» в браузере, поиск, задача, комментарий, переход,
 * новая задача, снимок приёма ядра, отказы — токен отклонён и «ответила не JSON».
 *
 * Пишет только во временный дом стенда; настоящий `~/.claude*`, сеть и настоящий трекер не
 * трогаются. Токены — выдуманные значения заглушки; в след заглушки и в журнал панели они
 * попадать не должны (проверяется).
 *
 *   node tools/qa/check-tracker-client.mjs
 */
import { chromium } from 'playwright';
import { startStubTracker } from '../../packages/stub-tracker/src/index.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { runOnStand } from './throwaway-stand.mjs';

const cloud = await startStubTracker({ deployment: 'cloud' });
const own = await startStubTracker({ deployment: 'server' });
const agent = cloud.users.find((user) => user.name === 'agent');
const cloudToken = cloud.tokens.agent;
const ownToken = own.tokens.agent;

/** Запросы заглушки после отметки `from`, без управляющих. */
const since = (stub, from) => stub.requests.slice(from).filter((request) => !request.control);

/** Путь запроса без строки запроса (след заглушки пишет путь целиком). */
const pathOf = (request) => request?.path.split('?')[0];

try {
  await runOnStand({ label: 'tracker-client' }, async (stand, check) => {
    const jira = (path, init) => stand.api(`/integrations/jira${path}`, init);
    const save = (settings, token) =>
      stand.api('/integrations/jira', { method: 'PUT', body: { settings, token } });

    // ── Облако: сохранить, определить диалект ──────────────────────────────
    const saved = await save(
      { enabled: true, baseUrl: `${cloud.url}/`, email: agent.email, deployment: '' },
      cloudToken,
    );
    check('сохранение карточки Jira принято', saved.status === 200, saved.text.slice(0, 300));
    check(
      'ключ в ответе только маской',
      saved.body?.hasToken === true && !saved.text.includes(cloudToken),
      saved.text.slice(0, 300),
    );

    let mark = cloud.requests.length;
    const probe = await jira('/check', { method: 'POST' });
    check(
      'проверка связи: облако, учётка заглушки',
      probe.body?.deployment === 'cloud' && probe.body?.account === 'Stub Agent',
      probe.text.slice(0, 400),
    );
    const myself = since(cloud, mark).find((request) => request.path === '/rest/api/3/myself');
    check(
      'облако спрошено Basic на /rest/api/3/myself, учётка узнана по ключу',
      myself?.auth === 'basic' && myself?.tokenId === 'agent' && myself?.status === 200,
      JSON.stringify(myself),
    );

    // ── Поиск: свободный текст и JQL с &, = и кавычками ─────────────────────
    mark = cloud.requests.length;
    const found = await jira('/search?q=button');
    check(
      'поиск словами находит задачу заглушки',
      found.status === 200 && found.body?.some?.((issue) => issue.key === 'PROJ-2'),
      found.text.slice(0, 300),
    );
    const searched = since(cloud, mark)[0];
    check(
      'поиск ушёл на /search/jql облака с text ~ "button"',
      pathOf(searched) === '/rest/api/3/search/jql' && searched?.jql === 'text ~ "button"',
      JSON.stringify(searched),
    );

    const jql = 'project = PROJ AND assignee = "owner"';
    mark = cloud.requests.length;
    const byJql = await jira(`/search?jql=${encodeURIComponent(jql)}`);
    check(
      'JQL с = и кавычками доходит целым и находит задачу владельца',
      since(cloud, mark)[0]?.jql === jql &&
        byJql.body?.length === 1 &&
        byJql.body[0]?.key === 'PROJ-3',
      `${JSON.stringify(since(cloud, mark)[0]?.jql)} → ${byJql.text.slice(0, 200)}`,
    );

    // ── Задача: поля контракта, без полей входящих ядра ─────────────────────
    const issue = await jira('/issue/PROJ-2');
    check(
      'задача читается с описанием из ADF и адресом browse',
      issue.status === 200 &&
        issue.body?.description?.includes('press the button') &&
        issue.body?.url === `${cloud.url}/browse/PROJ-2` &&
        issue.body?.statusCategory === 'new',
      issue.text.slice(0, 400),
    );
    check(
      'карточка панели — только поля контракта (меток и связей ядра нет)',
      issue.body && !('labels' in issue.body) && !('links' in issue.body),
      Object.keys(issue.body ?? {}).join(','),
    );

    // ── Записи: комментарий, переход, новая задача ───────────────────────────
    const commented = await jira('/issue/PROJ-2/comment', {
      method: 'POST',
      body: { body: 'MR: https://forge.example.com/mr/7\nвторая строка' },
    });
    const comment = cloud
      .state()
      .issues.find((item) => item.key === 'PROJ-2')
      ?.comments.at(-1);
    check(
      'комментарий облаку ушёл документом ADF',
      commented.status < 300 &&
        comment?.body?.type === 'doc' &&
        comment?.text.includes('https://forge.example.com/mr/7'),
      `${commented.status} ${JSON.stringify(comment)?.slice(0, 300)}`,
    );

    const transitions = await jira('/issue/PROJ-2/transitions');
    const target =
      transitions.body?.find?.((item) => item.to === 'In Progress') ?? transitions.body?.[1];
    const moved = await jira('/issue/PROJ-2/transition', {
      method: 'POST',
      body: { id: target?.id },
    });
    const status = cloud.state().issues.find((item) => item.key === 'PROJ-2')?.status;
    check(
      'переход по рабочему процессу меняет статус в трекере',
      moved.status < 300 &&
        Boolean(target) &&
        status === (target?.to ?? status) &&
        status !== 'To Do',
      `${transitions.text.slice(0, 200)} → ${moved.status} ${status}`,
    );

    const created = await jira('/issue', {
      method: 'POST',
      body: { projectKey: 'PROJ', summary: 'Stand defect', description: 'first\nsecond' },
    });
    const stored = cloud.state().issues.find((item) => item.key === created.body?.key);
    check(
      'новая задача заведена дефектом и прочитана обратно',
      created.status < 300 &&
        created.body?.summary === 'Stand defect' &&
        stored?.type === 'Bug' &&
        stored?.description.includes('second'),
      `${created.text.slice(0, 300)}`,
    );

    // ── Снимок приёма ядра ───────────────────────────────────────────────────
    const snapshot = await stand.api('/core-intake/tracker-snapshot?key=PROJ-2');
    check(
      'снимок приёма: критерии из поля, связь с именем, отпечаток',
      snapshot.status === 200 &&
        snapshot.body?.acceptance?.length === 2 &&
        snapshot.body?.links?.some?.((link) => link.title === 'blocks PROJ-3') &&
        /^[0-9a-f]{64}$/.test(snapshot.body?.digest ?? ''),
      snapshot.text.slice(0, 500),
    );

    // ── Отказы словами панели ────────────────────────────────────────────────
    cloud.fault({ kind: 'garbage', path: '/rest/api/3/issue/PROJ-3', times: 1 });
    const garbage = await jira('/issue/PROJ-3');
    check(
      'не JSON при удачном коде — «ответила не JSON», не 500',
      garbage.status >= 400 && garbage.body?.messageCode === 'integration-not-json',
      garbage.text.slice(0, 300),
    );

    await save(
      { enabled: true, baseUrl: cloud.url, email: agent.email, deployment: 'cloud' },
      'not-a-real-token',
    );
    const rejected = await jira('/search?q=button');
    check(
      'чужой ключ — «токен отклонён» с кодом ответа',
      rejected.status >= 400 &&
        rejected.body?.messageCode === 'integration-token-rejected' &&
        rejected.body?.params?.status === 401,
      rejected.text.slice(0, 300),
    );

    // ── Своя установка: Bearer, /rest/api/2, текст вместо ADF ────────────────
    await save({ enabled: true, baseUrl: own.url, email: '', deployment: '' }, ownToken);
    const ownProbe = await jira('/check', { method: 'POST' });
    check(
      'своя установка определена живой проверкой',
      ownProbe.body?.deployment === 'server',
      ownProbe.text.slice(0, 300),
    );
    mark = own.requests.length;
    const ownFound = await jira('/search?q=button');
    const ownSearch = since(own, mark)[0];
    check(
      'своя установка: поиск Bearer на /rest/api/2/search',
      ownFound.body?.some?.((item) => item.key === 'PROJ-2') &&
        pathOf(ownSearch) === '/rest/api/2/search' &&
        ownSearch?.auth === 'bearer' &&
        ownSearch?.tokenId === 'agent',
      `${JSON.stringify(ownSearch)} ${ownFound.text.slice(0, 200)}`,
    );
    await jira('/issue/PROJ-2/comment', { method: 'POST', body: { body: 'plain text' } });
    const ownComment = own
      .state()
      .issues.find((item) => item.key === 'PROJ-2')
      ?.comments.at(-1);
    check(
      'своей установке комментарий ушёл строкой',
      ownComment?.body === 'plain text',
      JSON.stringify(ownComment),
    );

    // ── Браузер: карточка Jira показывает, кем панель представилась ──────────
    await save(
      { enabled: true, baseUrl: cloud.url, email: agent.email, deployment: '' },
      cloudToken,
    );
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await bypassOnboarding(page);
      await page.goto(`${stand.webUrl}/settings?tab=integrations`, {
        waitUntil: 'domcontentloaded',
      });
      const card = page
        .locator('div[class*="padding-md"]')
        .filter({
          has: page.locator('[data-agent-anchor] > span:first-child', { hasText: /^Jira$/ }),
        })
        .last();
      await card.getByRole('button', { name: /Проверить связь/ }).click({ timeout: 60_000 });
      await card
        .getByText(/Stub Agent/)
        .first()
        .waitFor({ timeout: 30_000 });
      check('карточка Jira в браузере: «Проверить связь» → учётка заглушки', true);
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } catch (error) {
      check('карточка Jira в браузере: «Проверить связь» → учётка заглушки', false, String(error));
    } finally {
      await browser.close();
    }

    // ── Ключ не утёк ─────────────────────────────────────────────────────────
    const traces = JSON.stringify(
      [...cloud.requests, ...own.requests].map(({ body: _body, ...rest }) => rest),
    );
    check(
      'ключей нет ни в следе заглушек, ни в журнале панели',
      ![cloudToken, ownToken].some(
        (token) => traces.includes(token) || stand.log().includes(token),
      ),
    );
  });
} finally {
  await cloud.stop();
  await own.stop();
}
