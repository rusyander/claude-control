import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../../lib/app-store.ts';
import { readZip } from '../../lib/zip.ts';
import type { ServerContext } from '../../context.ts';
import { forgetShownPlans } from '../../domains/portability/plan.ts';
import { registerPortabilityRoutes } from '../portability-routes.ts';
import { registerEnvTransferRoutes } from '../env-transfer-routes.ts';
import { HARNESS_ORIGIN, manageHarness, type ManageHarness } from './manage-test-harness.ts';

/**
 * Перенос среды Claude Code в другой CLI и архив среды — на настоящих
 * маршрутах раздела «Перенос» и НАСТОЯЩЕМ доме: временный каталог с живыми
 * файлами источника (`~/.claude`) и цели (`~/.gemini`), подставленный через
 * HOME/USERPROFILE, как в `portability-routes.transfer.integration.test.ts`.
 * Доказательства — байты файла цели до и после, а не ответы действий.
 */
const HUMAN_TEXT = 'Мой собственный текст, который панель не писала.';
const SECRET = 'sk-ant-api03-PORTABLESECRETPORTABLESECRET00000000';

describe('panel-agent actions: portability', () => {
  const savedEnv = { ...process.env };
  let home: string;
  let appData: string;
  let backupDir: string;
  let gemini: string;
  let h: ManageHarness;
  const results: string[] = [];

  const put = (path: string, text: string): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, 'utf8');
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-agent-port-home-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-port-data-'));
    backupDir = join(appData, 'backups');
    for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.APPDATA = join(home, 'AppData', 'Roaming');
    delete process.env.CLAUDE_CONFIG_DIR;
    // Предохранитель: дом ДОЛЖЕН быть временным, иначе перенос писал бы в
    // настоящий `~/.gemini` человека.
    expect(homedir()).toBe(home);
    forgetShownPlans();

    put(join(home, '.claude', 'CLAUDE.md'), 'Преамбула источника.\n');
    put(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        env: { EDITOR: 'code', ANTHROPIC_API_KEY: SECRET },
        permissions: { allow: ['Bash(git status)'] },
      }),
    );
    gemini = join(home, '.gemini', 'GEMINI.md');
    put(gemini, `${HUMAN_TEXT}\n`);
    results.length = 0;

    const ctx = {
      store: new AppStore(appData),
      backupDir,
      location: { paths: { root: join(home, '.claude'), appData } },
    } as unknown as ServerContext;
    h = await manageHarness(ctx, (app) => {
      registerPortabilityRoutes(app, ctx);
      registerEnvTransferRoutes(app, ctx);
    });
  });

  afterEach(async () => {
    await h.close();
    for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(appData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const call = async (name: string, input: unknown) => {
    const result = await h.call(name, input);
    results.push(JSON.stringify(result));
    return result;
  };
  const decided = async (name: string, input: unknown, decision?: 'approve' | 'reject') => {
    const out = await h.decided(name, input, decision);
    results.push(JSON.stringify(out));
    return out;
  };
  const target = { target: 'gemini' };

  it('план: файлы цели и итоги, ни одной записи; незнакомая цель — отказ маршрута', async () => {
    const out = await call('portability_plan', target);
    expect(out.outcome).toBe('done');
    const plan = out.result as {
      source: string;
      target: string;
      files: { file: string; unchanged: boolean }[];
      outcomes: Record<string, number>;
    };
    expect(plan).toMatchObject({ source: 'claude', target: 'gemini' });
    expect(plan.files.some((file) => file.file.endsWith('GEMINI.md') && !file.unchanged)).toBe(
      true,
    );
    expect(Object.values(plan.outcomes).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(readFileSync(gemini, 'utf8')).toBe(`${HUMAN_TEXT}\n`);
    expect(existsSync(backupDir)).toBe(false);

    const unknown = await call('portability_plan', { target: 'одиннадцатый' });
    expect(unknown.outcome).toBe('failed');
    expect(await h.pendingCards()).toEqual([]);
  });

  it('применение: карточка с диффом файла, запись с копией; след виден; повтор — «ничего не изменится»', async () => {
    const rejected = await decided('apply_portability', target, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(readFileSync(gemini, 'utf8')).toBe(`${HUMAN_TEXT}\n`);

    const { card, result } = await decided('apply_portability', target);
    expect(card.risk).toBe('danger');
    expect(card.preview.summaryCode).toBe('summary-apply-portability');
    expect(card.preview.diff).toContain('GEMINI.md');
    expect(card.preview.diff).toContain('Преамбула источника.');
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ applied: true, target: 'gemini' });
    const written = readFileSync(gemini, 'utf8');
    expect(written).not.toBe(`${HUMAN_TEXT}\n`);
    expect(written).toContain('Преамбула источника.');
    expect(existsSync(backupDir)).toBe(true);

    const trace = await call('portability_transfer', target);
    expect(trace.outcome).toBe('done');
    expect(
      (trace.result as { files: string[] }).files.some((file) => file.endsWith('GEMINI.md')),
    ).toBe(true);

    const again = await call('apply_portability', target);
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('Nothing would change');
    expect(await h.pendingCards()).toEqual([]);
  });

  it('правка цели между карточкой и кликом — устаревшая карточка, правка человека цела', async () => {
    const running = h.call('apply_portability', target);
    let [card] = await h.pendingCards();
    for (let attempt = 0; !card && attempt < 500; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
      [card] = await h.pendingCards();
    }
    put(gemini, `${HUMAN_TEXT}\nчеловек дописал строку\n`);
    await h.app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card!.id}`,
      headers: { origin: HARNESS_ORIGIN },
      payload: { decision: 'approve' },
    });
    const stale = await running;
    expect(stale.outcome).toBe('failed');
    expect(stale.messageCode).toBe('stale_preview');
    expect(readFileSync(gemini, 'utf8')).toBe(`${HUMAN_TEXT}\nчеловек дописал строку\n`);
  });

  it('отмена: без следа — отказ до карточки; файл, правленный человеком, остаётся и назван', async () => {
    const nothing = await call('revert_portability', target);
    expect(nothing.outcome).toBe('failed');
    expect(nothing.message).toContain('Nothing to undo');
    expect(await h.pendingCards()).toEqual([]);

    await decided('apply_portability', target);
    const edited = `${readFileSync(gemini, 'utf8')}правка человека после переноса\n`;
    put(gemini, edited);

    const { card, result } = await decided('revert_portability', target);
    expect(card.risk).toBe('danger');
    expect(
      card.preview.fields.find((field) => field.labelCode === 'label-changed-since')?.value,
    ).toContain('GEMINI.md');
    expect(result.outcome).toBe('done');
    const answer = result.result as { keptEditedByHuman: string[] };
    expect(answer.keptEditedByHuman.some((file) => file.endsWith('GEMINI.md'))).toBe(true);
    // `confirm` агент не шлёт: правка человека не перезаписана копией.
    expect(readFileSync(gemini, 'utf8')).toBe(edited);
  });

  it('отмена без правок человека возвращает файл цели к состоянию до переноса', async () => {
    await decided('apply_portability', target);
    const { result } = await decided('revert_portability', target);
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ keptEditedByHuman: [], stillRecorded: false });
    expect(readFileSync(gemini, 'utf8')).toBe(`${HUMAN_TEXT}\n`);
    expect((await call('portability_transfer', target)).result).toEqual({ record: null });
  });

  it('подписки: список читается; архив среды: объём и чек-лист, секрет не виден', async () => {
    const subs = await call('list_portability_subscriptions', {});
    expect(subs.outcome).toBe('done');
    expect(subs.result).toEqual({ items: [] });

    const preview = await call('env_transfer_preview', {});
    expect(preview.outcome).toBe('done');
    expect((preview.result as { files: number }).files).toBeGreaterThan(0);
    expect(results.join('\n')).not.toContain(SECRET);
  });

  it('архив: несуществующая папка — отказ до карточки; одобрение кладёт zip в папку', async () => {
    const missing = await call('env_transfer_export', { targetDir: join(home, 'нет-такой') });
    expect(missing.outcome).toBe('failed');
    expect(missing.message).toContain('not an existing absolute folder');
    const relative = await call('env_transfer_export', { targetDir: 'out' });
    expect(relative.outcome).toBe('failed');
    expect(await h.pendingCards()).toEqual([]);

    // Ревью 28.09, m10: обещание «без секретов» проверяется по содержимому архива.
    const TOKEN = 'sk-ant-oat01-CREDENTIALSTOKENCREDENTIALSTOKEN0000';
    put(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }),
    );
    put(join(home, '.claude', '.mcp-secrets.env'), `GITLAB_TOKEN=${TOKEN}\n`);
    const out = join(home, 'архив');
    mkdirSync(out);
    const rejected = await decided('env_transfer_export', { targetDir: out }, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(readdirSync(out)).toEqual([]);

    const { card, result } = await decided('env_transfer_export', { targetDir: out });
    expect(card.preview.summaryCode).toBe('summary-env-transfer-export');
    expect(result.outcome).toBe('done');
    const path = (result.result as { path: string }).path;
    expect(path.startsWith(out)).toBe(true);
    expect(path.endsWith('.zip')).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(results.join('\n')).not.toContain(SECRET);
    const entries = readZip(readFileSync(path));
    const names = entries.map((entry) => entry.path);
    // Не пустышка: настройки и инструкции в архиве есть…
    expect(names.some((name) => name.endsWith('settings.json'))).toBe(true);
    expect(names.some((name) => name.endsWith('CLAUDE.md'))).toBe(true);
    // …а доступа к аккаунту, файла секретов MCP и значений ключей — нет.
    expect(names.filter((name) => /\.credentials\.json$|\.mcp-secrets\.env$/.test(name))).toEqual(
      [],
    );
    const bytes = entries.map((entry) => entry.data.toString('utf8')).join('\n');
    expect(bytes).not.toContain(SECRET);
    expect(bytes).not.toContain(TOKEN);
  });
});
