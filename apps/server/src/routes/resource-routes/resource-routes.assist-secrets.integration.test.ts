import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../../context.ts';
import { registerResourceRoutes } from './resource-routes.ts';

/** Маршрут окна для проверок, которым он не важен: контура нет, шлюз не поднят. */
const NO_ROUTE = { runRoute: () => ({ env: {} }), gatewayPort: () => 0 };

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
 * Настоящий маршрут, настоящее чтение и запись файлов ресурса, настоящий запуск
 * процесса; вместо `claude` — фальшивый CLI (PATH — только его каталог и
 * системный), он пишет stdin и отвечает заданными файлами.
 */
const isWindows = process.platform === 'win32';
const SECRET_LINE = 'API_TOKEN=qa-struct-secret-5d1e';
// Ревью F3: значения в кавычках и с пробелом (YAML, export) — тоже секреты файла.
const BODY = (token: string, quoted: string, exported: string): string =>
  `---\nname: demo\ndescription: Deploy helper\n---\n\nUse the key:\n${token}\n\n` +
  `password: "${quoted}"\n\nexport DEPLOY_TOKEN="${exported}"\n`;
const ORIGINAL = BODY(SECRET_LINE, 'hunter two 2', 'tok en 123');
/** То, что модель видит (и возвращает, не трогая строк с секретами). */
const MASKED = BODY('API_TOKEN=••••••', '••••••', '••••••');

const FAKE = `
import { readFileSync, writeFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const near = (name) => new URL('./' + name, import.meta.url);
writeFileSync(near('stdin.txt'), Buffer.concat(chunks).toString('utf8'));
process.stdout.write(JSON.stringify({ result: readFileSync(near('answer.json'), 'utf8') }));
`;

let app: FastifyInstance | undefined;
let dir: string;
let root: string;
let savedPath: string | undefined;

const skillFile = (name: string): string => join(root, 'skills', 'demo', name);
const answer = (files: Array<{ path: string; content: string }>): void =>
  writeFileSync(join(dir, 'answer.json'), JSON.stringify({ reply: 'Сделал.', files }), 'utf8');
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
  const script = join(dir, 'fake-claude.mjs');
  writeFileSync(script, FAKE, 'utf8');
  if (isWindows) {
    writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
      mode: 0o755,
    });
  }
  savedPath = process.env.PATH;
  const system = isWindows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/bin';
  process.env.PATH = [dir, system].join(isWindows ? ';' : ':');

  const ctx = {
    location: {
      paths: {
        root,
        settings: join(root, 'settings.json'),
        claudeMd: join(root, 'CLAUDE.md'),
        skills: join(root, 'skills'),
        hooks: join(root, 'hooks'),
        appData: join(root, 'agentdeck'),
      },
    },
    backupDir: join(root, 'agentdeck', 'backups'),
    store: { getSettings: () => ({ provider: 'claude' }) },
  } as unknown as ServerContext;
  app = Fastify();
  registerResourceRoutes(app, ctx, NO_ROUTE);
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env.PATH = savedPath;
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

    const stdin = readFileSync(join(dir, 'stdin.txt'), 'utf8');
    for (const leak of ['qa-struct-secret-5d1e', 'hunter two 2', 'hunter', 'tok en 123']) {
      expect(stdin, leak).not.toContain(leak);
    }
    expect(stdin).toContain('API_TOKEN=••••••');

    expect(body.applied.sort()).toEqual(['README.md', 'SKILL.md']);
    expect(body.kept).toEqual(['notes.md']);
    const written = readFileSync(skillFile('SKILL.md'), 'utf8');
    expect(written).toBe(`${ORIGINAL}\n## Rollback\nRevert.\n`);
    expect(existsSync(skillFile('notes.md'))).toBe(false);
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
