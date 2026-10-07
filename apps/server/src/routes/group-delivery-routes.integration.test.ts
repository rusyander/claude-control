import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import type { GroupDelivery } from '@agentdeck/contracts/group-delivery';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerGroupRoutes } from './group-routes.ts';
import { registerGroupDeliveryRoutes } from './group-delivery-routes.ts';

/**
 * Тумблер группы и «что дойдёт до CLI» со стороны маршрутов (F1 владельца
 * 06.10, X2): для чужого CLI тумблер — отметка `enabledFor` без единой записи
 * в файлы Claude, у CLI без слоя — отказ с причиной. Доказательство «файлы не
 * тронуты» — отпечаток всего временного каталога Claude до и после.
 */
describe('группа для чужого CLI: тумблер и доставка', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  /** Отпечаток каталога Claude: всё, кроме хранилища панели. */
  const claudeTree = (): string => {
    const hash = createHash('sha256');
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const full = join(dir, entry.name);
        if (entry.name === 'agentdeck') continue;
        hash.update(relative(root, full));
        if (entry.isDirectory()) walk(full);
        else hash.update(readFileSync(full));
      }
    };
    walk(root);
    return hash.digest('hex');
  };

  const group = (patch: Partial<Group> = {}): Group =>
    store.saveGroup({
      id: 'g',
      name: 'Ревью',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [
        { kind: 'skill', id: 'ladder' },
        { kind: 'permission', id: 'Bash(rm:*)' },
      ],
      env: { REVIEW_ROUNDS: '2' },
      isEnabled: false,
      order: 0,
      projectPaths: [],
      ...patch,
    });

  const reread = (): Group | undefined =>
    new AppStore(join(root, 'agentdeck')).getGroups().find((item) => item.id === 'g');

  const toggle = (payload: object) =>
    app.inject({ method: 'POST', url: '/api/groups/g/enabled', payload });

  const delivery = async (provider?: string) => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/groups/g/delivery${provider ? `?provider=${provider}` : ''}`,
    });
    return { status: response.statusCode, body: response.json() as GroupDelivery };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-delivery-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'skills', 'ladder'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'ladder', 'SKILL.md'),
      '---\nname: ladder\ndescription: Review rounds\n---\n\nTwo rounds.\n',
      'utf8',
    );
    writeFileSync(join(root, 'settings.json'), '{"permissions":{"allow":["Bash(rm:*)"]}}', 'utf8');
    writeFileSync(join(root, 'CLAUDE.md'), '# Правила\n', 'utf8');
    store = new AppStore(join(root, 'agentdeck'));
    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          appData: join(root, 'agentdeck'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
    } as unknown as ServerContext;
    app = Fastify();
    registerGroupRoutes(app, ctx);
    registerGroupDeliveryRoutes(app, ctx);
    await app.ready();
    group();
  });

  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('CLI без слоя: 409 «не доходит», ни группы, ни файлов Claude не трогает', async () => {
    const before = claudeTree();
    const response = await toggle({ isEnabled: true, provider: 'goose' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      messageCode: 'groups-foreign-not-delivered',
      params: { provider: 'Goose' },
    });
    expect(reread()?.isEnabled).toBe(false);
    expect(reread()?.enabledFor).toBeUndefined();
    expect(claudeTree()).toBe(before);
  });

  it('без `provider` тумблер — активного CLI', async () => {
    store.updateSettings({ provider: 'goose' });
    const before = claudeTree();
    const response = await toggle({ isEnabled: true });
    expect(response.statusCode).toBe(409);
    expect(claudeTree()).toBe(before);
  });

  it('незнакомый CLI — 400 с кодом, а не откат на Claude', async () => {
    const response = await toggle({ isEnabled: true, provider: 'nope' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      messageCode: 'provider-unknown',
      params: { id: 'nope' },
    });
    expect((await delivery('nope')).status).toBe(400);
  });

  it('Qwen: отметка `enabledFor`, файлы Claude те же; выключение её снимает', async () => {
    const before = claudeTree();
    const on = await toggle({ isEnabled: true, provider: 'qwen' });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ messageCode: 'group-layer-enabled-for', affected: 0 });
    expect(reread()?.enabledFor).toEqual({ qwen: true });
    expect(reread()?.isEnabled).toBe(false);
    expect(claudeTree()).toBe(before);

    const off = await toggle({ isEnabled: false, provider: 'qwen' });
    expect(off.json()).toMatchObject({ messageCode: 'group-layer-disabled-for' });
    expect(reread()?.enabledFor).toBeUndefined();
    expect(claudeTree()).toBe(before);
  });

  it('правка формы `enabledFor` не стирает', async () => {
    group({ enabledFor: { qwen: true } });
    const saved = reread()!;
    const response = await app.inject({
      method: 'PUT',
      url: '/api/groups/g',
      payload: { ...saved, enabledFor: undefined, name: 'Ревью 2' },
    });
    expect(response.statusCode).toBe(200);
    expect(reread()?.name).toBe('Ревью 2');
    expect(reread()?.enabledFor).toEqual({ qwen: true });
  });

  it('доставка: Claude — свои файлы, goose — не действует, Qwen — слой с отказом по правам', async () => {
    group({ enabledFor: { qwen: true } });
    const claude = await delivery('claude');
    expect(claude.body).toMatchObject({ model: 'claude-files', enabled: false, refused: [] });
    expect(claude.body.envNames).toEqual(['REVIEW_ROUNDS']);

    const goose = await delivery('goose');
    expect(goose.body).toMatchObject({ model: 'none', delivered: [], refused: [] });

    const qwen = await delivery('qwen');
    expect(qwen.body.model).toBe('run-layer');
    expect(qwen.body.enabled).toBe(true);
    expect(qwen.body.delivered).toContainEqual({ group: 'g', member: 'skill:ladder' });
    expect(qwen.body.refused.map((item) => item.code)).toEqual(['group-layer-permission']);
    expect(qwen.body.envNames).toEqual(['REVIEW_ROUNDS']);
    expect(qwen.body.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('доставка без `provider` — для активного CLI', async () => {
    store.updateSettings({ provider: 'goose' });
    expect((await delivery()).body).toMatchObject({ provider: 'goose', model: 'none' });
  });
});
