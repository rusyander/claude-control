import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { bootCore } from './boot.ts';
import { PANEL_DATA_ENV } from './panel-profiles.ts';

/**
 * Каталог панели, переданный загрузке (`bootCore({ panelAppData })`), — единственный источник
 * форжа для проводок дирижёра (ревью по ссылке, публикатор, страж) и для сверки/опроса: ядро в
 * процессе теста не читает каталог, который нашло бы само (здесь — приманка в `AGENTDECK_PANEL_DATA`,
 * первая ступень `panelAppDataDir()`, на месте настоящего `~/.claude/agentdeck`).
 *
 * Наблюдаемое — ответ `POST /v1/review-link` на загруженном ядре. Сайт GitLab на закрытом порту
 * loopback у remote репозитория: каталог с этим сайтом даёт форж (ключа нет — `review_link_unread`),
 * каталог без сайта — «форжа нет» (`review_link_forge_unsupported`).
 */

const saved: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
});

/** Порт loopback, на котором никто не слушает: запрос к нему — быстрый отказ соединения. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** Каталог панели; `site` — сайт GitLab в `settings.integrations`, без него — пустой каталог. */
function panelDir(path: string, site?: string): string {
  mkdirSync(path, { recursive: true });
  if (site)
    writeFileSync(
      join(path, 'state.json'),
      JSON.stringify({
        settings: { integrations: { gitlab: { enabled: true, baseUrl: site, repo: '' } } },
      }),
    );
  return path;
}

/**
 * Загрузка в процессе без `AGENTDECK_CORE_HOME`, приманка — в переменной панели; ответ ручки
 * ревью по ссылке на репозиторий с remote на `site`.
 */
async function reviewCodeOnBoot(opts: {
  /** `null` — загрузка без панели (`panelAppData: null`). */
  siteInGiven: boolean | null;
  siteInDecoy: boolean;
}) {
  const root = tempDir('boot-panel-forge-');
  const site = `http://127.0.0.1:${await closedPort()}`;
  const decoy = panelDir(join(root, 'decoy-panel'), opts.siteInDecoy ? site : undefined);
  const given =
    opts.siteInGiven === null
      ? null
      : panelDir(join(root, 'given-panel'), opts.siteInGiven ? site : undefined);
  setEnv('AGENTDECK_CORE_HOME', undefined);
  setEnv(PANEL_DATA_ENV, decoy);

  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', `${site}/group/app.git`);

  const core = await bootCore({
    home: join(root, 'core'),
    build: 'panel-forge-test',
    loop: false,
    panelAppData: given,
  });
  try {
    const token = readFileSync(core.layout.token, 'utf8').trim();
    const page = newId();
    const headers = { authorization: `Bearer ${token}` };
    const nonceRes = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers });
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const res = await fetch(`${core.url}/v1/review-link`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        cmdId: newId(),
        fields: { url: `${site}/group/app/-/merge_requests/12`, repo },
        proof: { nonce, page },
      }),
    });
    const body = (await res.json()) as { code?: string; problems?: string[] };
    return { status: res.status, code: body.code, body: JSON.stringify(body) };
  } finally {
    await core.stop();
  }
}

describe('boot: forge settings come only from the panel dir given to bootCore', () => {
  it('the panel dir the core would find itself (a forge site there) is never read: no forge', async () => {
    const got = await reviewCodeOnBoot({ siteInGiven: false, siteInDecoy: true });
    expect([got.status, got.code], got.body).toEqual([422, 'review_link_forge_unsupported']);
  });

  it('panelAppData: null boots without a panel: the found panel dir is not a fallback', async () => {
    const got = await reviewCodeOnBoot({ siteInGiven: null, siteInDecoy: true });
    expect([got.status, got.code], got.body).toEqual([422, 'review_link_forge_unsupported']);
  });

  it('the given panel dir is the one read: its forge site is reached (no key stored → unread)', async () => {
    const got = await reviewCodeOnBoot({ siteInGiven: true, siteInDecoy: false });
    expect([got.status, got.code], got.body).toEqual([422, 'review_link_unread']);
    expect(got.body).toContain('no gitlab credential');
  });
});
