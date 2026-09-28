import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { blockLang } from '@agentdeck/contracts/brand';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import type { GroupAsk, GroupModelMessage } from '../domains/groups/model.ts';
import { registerGroupPathRoutes } from './group-path-routes.ts';

/**
 * Картинка ассистенту шага группы (12b): маршрут `…/path/draft` принимает её
 * рядом со схемой, общая проверка отказывает с именем файла, а вызов модели
 * получает картинку на последней реплике. В файл черновиков ложится только
 * строка с именем — base64 там осел бы и ехал заново каждым кругом.
 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('ассистент шага: картинка', () => {
  let root: string;
  let app: FastifyInstance;
  let calls: GroupModelMessage[][];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-draft-images-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    const store = new AppStore(join(root, 'agentdeck'));
    store.saveGroup({
      id: 'g1',
      name: 'Delivery',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      projectPaths: [],
      isEnabled: true,
      order: 0,
    });
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
    calls = [];
    const ask: GroupAsk = async (messages) => {
      calls.push(messages);
      return `\n\`\`\`${blockLang('path-step')}\n${JSON.stringify({
        title: { ru: 'Сверка', en: 'Check' },
        prompt: { ru: 'сверить экран', en: 'check the screen' },
      })}\n\`\`\`\n`;
    };
    app = Fastify();
    registerGroupPathRoutes(app, ctx, () => ask);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('картинка доходит до вызова модели, в черновик ложится только имя', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/groups/g1/path/draft',
      payload: {
        text: 'шаг как на снимке',
        anchor: 'work',
        images: [{ name: 'screen.png', mediaType: 'image/png', base64: PNG }],
      },
    });
    expect(response.statusCode).toBe(200);
    const last = calls[0]!.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.images).toEqual([{ name: 'screen.png', mediaType: 'image/png', base64: PNG }]);

    const dir = join(root, 'agentdeck');
    const drafts = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n');
    expect(drafts).toContain('Attached images: screen.png');
    expect(drafts).not.toContain(PNG.slice(0, 40));
  });

  it('не картинка — 400 с именем файла, модель не вызывается', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/groups/g1/path/draft',
      payload: {
        text: 'шаг',
        anchor: 'work',
        images: [
          { name: 'a.png', mediaType: 'image/png', base64: Buffer.from('text').toString('base64') },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ messageCode: 'media-agent-image-not-image' });
    expect(calls).toHaveLength(0);
  });
});
