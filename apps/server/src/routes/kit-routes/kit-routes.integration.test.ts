import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { KitItemContent, KitResponse } from '@agentdeck/contracts/kit';
import type { ServerContext } from '../../context.ts';
import { KitService, builtinKitDir } from '../../domains/kit/service.ts';
import { kitFiles } from '../../domains/kit/items.ts';
import { registerKitRoutes } from './kit-routes.ts';

/**
 * Страница «Набор панели» поверх настоящего сокета: настоящие маршруты,
 * настоящий `KitService` над временными данными панели и временным каталогом
 * Claude, настоящий встроенный набор приложения. Подменять нечего — ни сети,
 * ни CLI маршруты не трогают; свидетель — ответ и файлы на диске.
 */

const SKILL = 'skills/read-before-edit/SKILL.md';
const RULE = 'rules/standard.md';
const HOOK = 'hooks/guard-destructive.mjs';

let root: string;
let appData: string;
let claudeDir: string;
let app: FastifyInstance;
let base: string;
let changes = 0;

interface Refusal {
  error?: string;
  messageCode?: string;
  code?: string;
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}
const q = (id: string) => `/api/kit/item?id=${encodeURIComponent(id)}`;

beforeAll(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-kit-routes-')));
  appData = join(root, 'app-data');
  claudeDir = join(root, 'claude');
  mkdirSync(join(claudeDir, 'skills', 'read-before-edit'), { recursive: true });
  writeFileSync(join(claudeDir, 'skills', 'read-before-edit', 'SKILL.md'), 'навык человека');
  const kit = new KitService({
    appDataDir: appData,
    claudeDir: () => claudeDir,
    providers: () => [
      { id: 'claude', name: 'Claude Code' },
      { id: 'codex', name: 'Codex' },
    ],
  });
  app = Fastify();
  registerKitRoutes(app, {} as ServerContext, kit, () => {
    changes += 1;
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await app?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  changes = 0;
});

describe('набор панели по настоящему сокету', () => {
  it('GET /api/kit — элементы, режимы и конфликт с навыком человека', async () => {
    const { status, body } = await api<KitResponse>('GET', '/api/kit');
    expect(status).toBe(200);
    expect(body.version).toBe('1.2.0');
    expect(body.items.map((item) => item.id)).toEqual(
      kitFiles(builtinKitDir()).map((file) => file.id),
    );
    expect(body.items.map((item) => item.id)).toEqual(expect.arrayContaining([SKILL, RULE, HOOK]));
    expect(body.providers.map(({ id, mode, modes }) => ({ id, mode, modes }))).toEqual([
      { id: 'claude', mode: 'global', modes: ['global', 'hybrid', 'ours'] },
      { id: 'codex', mode: 'global', modes: ['global', 'hybrid'] },
    ]);
    expect(body.items.find((item) => item.id === SKILL)?.conflict).toEqual({
      userPath: join(claudeDir, 'skills', 'read-before-edit', 'SKILL.md'),
      winner: 'user',
      same: false,
    });
    expect(changes).toBe(0);
  });

  it('GET /api/kit/item — встроенный текст и пустая копия', async () => {
    const { status, body } = await api<KitItemContent>('GET', q(RULE));
    expect(status).toBe(200);
    expect(body).toEqual({
      id: RULE,
      builtin: readFileSync(join(builtinKitDir(), RULE), 'utf8'),
      mine: null,
      global: null,
      diff: null,
    });
    expect(changes).toBe(0);
  });

  it('PUT /api/kit/item — копия «моё» на диске, ответ — новый снимок', async () => {
    const { status, body } = await api<KitResponse>('PUT', '/api/kit/item', {
      id: RULE,
      content: '# МОИ ПРАВИЛА\n',
    });
    expect(status).toBe(200);
    expect(body.items.find((item) => item.id === RULE)?.origin).toBe('modified');
    expect(readFileSync(join(appData, 'kit', 'mine', RULE), 'utf8')).toBe('# МОИ ПРАВИЛА\n');
    expect((await api<KitItemContent>('GET', q(RULE))).body.mine).toBe('# МОИ ПРАВИЛА\n');
    expect(changes).toBe(1);
  });

  it('DELETE /api/kit/item — копия уходит в архив набора', async () => {
    const { status, body } = await api<KitResponse>('DELETE', q(RULE));
    expect(status).toBe(200);
    expect(body.items.find((item) => item.id === RULE)?.origin).toBe('builtin');
    expect(existsSync(join(appData, 'kit', 'mine', RULE))).toBe(false);
    const [stamp] = readdirSync(join(appData, 'kit', 'archive'));
    expect(readFileSync(join(appData, 'kit', 'archive', stamp ?? '', RULE), 'utf8')).toBe(
      '# МОИ ПРАВИЛА\n',
    );
    expect(changes).toBe(1);
  });

  it('PUT /api/kit/item/enabled — выключение и включение', async () => {
    const off = await api<KitResponse>('PUT', '/api/kit/item/enabled', {
      id: HOOK,
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(off.body.items.find((item) => item.id === HOOK)?.enabled).toBe(false);
    const on = await api<KitResponse>('PUT', '/api/kit/item/enabled', { id: HOOK, enabled: true });
    expect(on.body.items.find((item) => item.id === HOOK)?.enabled).toBe(true);
    expect(changes).toBe(2);
  });

  it('PUT /api/kit/conflict — побеждает набор', async () => {
    const { status, body } = await api<KitResponse>('PUT', '/api/kit/conflict', {
      id: SKILL,
      winner: 'kit',
    });
    expect(status).toBe(200);
    expect(body.items.find((item) => item.id === SKILL)?.conflict?.winner).toBe('kit');
    expect(changes).toBe(1);
  });

  it('PUT /api/kit/mode — режим записан; неподдержанный — 400 с кодом', async () => {
    const ok = await api<KitResponse>('PUT', '/api/kit/mode', { provider: 'claude', mode: 'ours' });
    expect(ok.status).toBe(200);
    expect(ok.body.providers.find((p) => p.id === 'claude')?.mode).toBe('ours');
    const refused = await api<Refusal>('PUT', '/api/kit/mode', { provider: 'codex', mode: 'ours' });
    expect(refused.status).toBe(400);
    expect(refused.body.messageCode).toBe('kit-mode-unsupported');
    expect(refused.body.error).toBe('Этот CLI такой режим набора не поддерживает');
    expect(changes).toBe(1);
  });

  it.each([
    ['GET', 'nope'],
    ['GET', '../x'],
    ['GET', 'skills/../../etc'],
    ['DELETE', '../../outside.md'],
    ['DELETE', ''],
  ])('%s неизвестный id %j — 404 kit-item-unknown', async (method, id) => {
    const { status, body } = await api<Refusal>(method, q(id));
    expect(status).toBe(404);
    expect(body.messageCode).toBe('kit-item-unknown');
    expect(changes).toBe(0);
  });

  it.each([
    ['/api/kit/item', { id: '../x', content: 'ВЗЛОМ' }],
    ['/api/kit/item/enabled', { id: 'skills/../../etc', enabled: false }],
    ['/api/kit/conflict', { id: 'nope', winner: 'kit' }],
  ])('PUT %s с неизвестным id — 404, ничего не записано', async (path, body) => {
    const response = await api<Refusal>('PUT', path, body);
    expect(response.status).toBe(404);
    expect(response.body.messageCode).toBe('kit-item-unknown');
    expect(existsSync(join(root, 'x'))).toBe(false);
    expect(existsSync(join(appData, 'kit', 'x'))).toBe(false);
    expect(changes).toBe(0);
  });

  it.each([
    ['/api/kit/item', { id: RULE }],
    ['/api/kit/item', { id: '', content: 'x' }],
    ['/api/kit/item', { id: RULE, content: 'x'.repeat(200_001) }],
    ['/api/kit/item/enabled', { id: HOOK, enabled: 'нет' }],
    ['/api/kit/conflict', { id: SKILL, winner: 'both' }],
    ['/api/kit/mode', { provider: 'claude', mode: 'all' }],
    ['/api/kit/mode', { mode: 'ours' }],
  ])('PUT %s с неверным телом %j — 400 invalid_body', async (path, body) => {
    const response = await api<Refusal>('PUT', path, body);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_body');
    expect(changes).toBe(0);
  });

  it('PUT /api/kit/item с кривым hooks.json — 400 kit-hooks-invalid, на диске ничего', async () => {
    const response = await api<Refusal>('PUT', '/api/kit/item', {
      id: 'hooks/hooks.json',
      content: '{"hooks": [',
    });
    expect(response.status).toBe(400);
    expect(response.body.messageCode).toBe('kit-hooks-invalid');
    expect(existsSync(join(appData, 'kit', 'mine', 'hooks', 'hooks.json'))).toBe(false);
    expect(changes).toBe(0);
  });

  it('POST /api/kit/global/export — файл в глобальном слое, прежний — в резервной копии', async () => {
    const before = readFileSync(join(claudeDir, 'skills', 'read-before-edit', 'SKILL.md'), 'utf8');
    const { status, body } = await api<{ kit: KitResponse; backup?: string }>(
      'POST',
      '/api/kit/global/export',
      { id: SKILL },
    );
    expect(status).toBe(200);
    expect(readFileSync(join(claudeDir, 'skills', 'read-before-edit', 'SKILL.md'), 'utf8')).toBe(
      readFileSync(join(builtinKitDir(), SKILL), 'utf8'),
    );
    // Навык уходит в копию папкой — вместе с соседними файлами.
    expect(body.backup && readFileSync(join(body.backup, 'SKILL.md'), 'utf8')).toBe(before);
    expect(body.kit.items.find((item) => item.id === SKILL)?.conflict?.same).toBe(true);
    expect(changes).toBe(1);
  });

  it('POST /api/kit/global/import — элемент только из глобального становится элементом набора', async () => {
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', 'only-global.md'), '# only global\n');
    const listed = await api<KitResponse>('GET', '/api/kit');
    expect(listed.body.globalOnly).toContainEqual(
      expect.objectContaining({ kind: 'command', name: 'only-global' }),
    );
    const { status, body } = await api<KitResponse>('POST', '/api/kit/global/import', {
      kind: 'command',
      name: 'only-global',
    });
    expect(status).toBe(200);
    expect(body.items.find((item) => item.id === 'commands/only-global.md')?.origin).toBe('added');
    expect(body.globalOnly.some((item) => item.name === 'only-global')).toBe(false);
    expect(readFileSync(join(appData, 'kit', 'mine', 'commands', 'only-global.md'), 'utf8')).toBe(
      '# only global\n',
    );
    expect(changes).toBe(1);
  });

  it.each([
    ['/api/kit/global/export', { id: RULE }, 400, 'kit-global-unsupported'],
    ['/api/kit/global/export', { id: 'nope' }, 404, 'kit-item-unknown'],
    ['/api/kit/global/import', { kind: 'skill', name: 'absent' }, 404, 'kit-global-missing'],
    ['/api/kit/global/import', { kind: 'command', name: '..' }, 404, 'kit-global-missing'],
  ])('POST %s %j — %i %s, ничего не записано', async (path, body, code, messageCode) => {
    const response = await api<Refusal>('POST', path, body);
    expect(response.status).toBe(code);
    expect(response.body.messageCode).toBe(messageCode);
    expect(existsSync(join(claudeDir, 'rules'))).toBe(false);
    expect(changes).toBe(0);
  });

  it.each([
    ['/api/kit/global/export', {}],
    ['/api/kit/global/import', { kind: 'rule', name: 'standard' }],
    ['/api/kit/global/import', { kind: 'skill' }],
  ])('POST %s с неверным телом %j — 400 invalid_body', async (path, body) => {
    const response = await api<Refusal>('POST', path, body);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_body');
    expect(changes).toBe(0);
  });
});
