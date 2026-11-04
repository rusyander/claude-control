import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../../context.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { createCoreAskPort } from '../../domains/core-ask/core-ask.ts';
import { startFakeCore, type FakeCore } from '../../domains/core-ask/__fixtures__/fake-core.ts';
import { registerResourceRoutes } from './resource-routes.ts';

/**
 * Помощник структуры и секреты в файлах ресурса (U6, 28.09).
 *
 * До правки содержимое файлов скилла уходило модели как есть — вместе с
 * токеном, вписанным в SKILL.md. А ответ пишется на диск СРАЗУ: маску, если бы
 * её вернула модель, панель записала бы на место секрета. Теперь модель видит
 * маску; маска в ответе, стоящая в той же строке, возвращается секретом файла;
 * не сошлось (строка переписана, маска в новом файле) — файл не пишется и
 * назван в `kept`.
 *
 * Настоящий маршрут, настоящее чтение и запись файлов ресурса, настоящий клиент ядра
 * (`createCoreAskPort`) настоящим HTTP. Ядро — заглушка (этап 10, F2b: своего процесса CLI у
 * помощника больше нет): запоминает текст вопроса и отвечает заданными файлами.
 */
const SECRET_LINE = 'API_TOKEN=qa-struct-secret-5d1e';
// Ревью F3: значения в кавычках и с пробелом (YAML, export) — тоже секреты файла.
const BODY = (token: string, quoted: string, exported: string): string =>
  `---\nname: demo\ndescription: Deploy helper\n---\n\nUse the key:\n${token}\n\n` +
  `password: "${quoted}"\n\nexport DEPLOY_TOKEN="${exported}"\n`;
const ORIGINAL = BODY(SECRET_LINE, 'hunter two 2', 'tok en 123');
/** То, что модель видит (и возвращает, не трогая строк с секретами). */
const MASKED = BODY('API_TOKEN=••••••', '••••••', '••••••');

let app: FastifyInstance | undefined;
let core: FakeCore | undefined;
let dir: string;
let root: string;
/** Текст вопроса, дошедший до ядра, — то, что увидела бы модель. */
let sent = '';
let reply = '';
let store: AppStore;
/** CLI, для которых маршрут просил набор панели (G13). */
let carried: string[] = [];

const skillFile = (name: string): string => join(root, 'skills', 'demo', name);
const answer = (files: Array<{ path: string; content: string }>): void => {
  reply = JSON.stringify({ reply: 'Сделал.', files });
};
const assist = async (): Promise<{ reply: string; applied: string[]; kept?: string[] }> => {
  const response = await app!.inject({
    method: 'POST',
    url: '/api/resources/skill/demo/assist',
    payload: { prompt: 'добавь раздел про откат' },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cc-structure-secrets-'));
  root = join(dir, 'config');
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  writeFileSync(skillFile('SKILL.md'), ORIGINAL, 'utf8');
  sent = '';
  core = await startFakeCore({
    turn: async ({ fields, emit }) => {
      sent = fields.prompt;
      emit({ kind: 'assistant-text', data: { text: reply } });
      emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
    },
  });

  const appData = join(root, 'agentdeck');
  const ctx = {
    location: {
      paths: {
        root,
        settings: join(root, 'settings.json'),
        claudeMd: join(root, 'CLAUDE.md'),
        skills: join(root, 'skills'),
        hooks: join(root, 'hooks'),
        appData,
      },
    },
    backupDir: join(appData, 'backups'),
    store: (store = new AppStore(appData)),
  } as unknown as ServerContext;
  app = Fastify();
  carried = [];
  registerResourceRoutes(
    app,
    ctx,
    createCoreAskPort(() => core!.home, core.identity),
    ({ cli }) => {
      carried.push(cli);
      return { ok: true, session: { env: ['QWEN_HOME'] }, env: { QWEN_HOME: join(dir, 'qwen') } };
    },
  );
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await core?.close();
  core = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('POST /api/resources/:kind/:id/assist — секреты файлов', () => {
  it('модель видит маску; маска в той же строке вернулась секретом; маска в новом файле — файл не записан', async () => {
    answer([
      {
        path: 'SKILL.md',
        content: `${MASKED}\n## Rollback\nRevert.\n`,
      },
      { path: 'notes.md', content: 'token: ••••••\n' },
      { path: 'README.md', content: 'Plain readme.\n' },
    ]);
    const body = await assist();

    expect(core!.asks).toHaveLength(1);
    for (const leak of ['qa-struct-secret-5d1e', 'hunter two 2', 'hunter', 'tok en 123']) {
      expect(sent, leak).not.toContain(leak);
    }
    expect(sent).toContain('API_TOKEN=••••••');

    expect(body.applied.sort()).toEqual(['README.md', 'SKILL.md']);
    expect(body.kept).toEqual(['notes.md']);
    const written = readFileSync(skillFile('SKILL.md'), 'utf8');
    expect(written).toBe(`${ORIGINAL}\n## Rollback\nRevert.\n`);
    expect(existsSync(skillFile('notes.md'))).toBe(false);
  });

  it('набор чужого CLI (G13): помощник структуры везёт его ядру, как прежнее окно', async () => {
    store.updateSettings({ provider: 'qwen' });
    answer([]);
    await assist();
    expect(carried).toEqual(['qwen']);
    expect(core!.asks[0]!.session).toEqual({ env: ['QWEN_HOME'] });
    expect(core!.askEnvs[0]).toEqual({ QWEN_HOME: join(dir, 'qwen') });
  });

  it('строка с маской переписана — файл не тронут, назван в kept', async () => {
    answer([
      {
        path: 'SKILL.md',
        content: MASKED.replace('API_TOKEN=••••••', 'API_TOKEN=•••••• # rotated'),
      },
    ]);
    const body = await assist();
    expect(body.applied).toEqual([]);
    expect(body.kept).toEqual(['SKILL.md']);
    expect(readFileSync(skillFile('SKILL.md'), 'utf8')).toBe(ORIGINAL);
  });
});
