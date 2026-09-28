import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelAgentPageContext } from '@agentdeck/contracts/panel-agent';
import {
  readPanelAgentConversation,
  recordPanelAgentTurnProgress,
  writePanelAgentConversation,
} from './conversations.ts';

/**
 * F-268. Ход пишет разговор на каждом блоке, а на Windows переименование поверх
 * файла, который в ту же долю секунды читает вторая вкладка или сканер, отдаёт
 * EPERM. Однократная попытка роняла запись, вызывающий её глотал — и сказанное
 * молча пропадало. Граница подменена одна: файловая система отвечает EPERM ровно
 * на первое переименование.
 */
const busy = vi.hoisted(() => ({ left: 0 }));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (busy.left > 0) {
        busy.left -= 1;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), {
          code: 'EPERM',
        });
      }
      real.renameSync(from, to);
    },
  };
});

const ID = '22222222-2222-4222-8222-222222222222';
const CONTEXT = { route: '/' } as PanelAgentPageContext;

describe('запись разговора при занятом файле', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'cc-conv-rename-'));
  });
  afterEach(() => {
    busy.left = 0;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('разовый EPERM на переименовании не теряет сказанное', () => {
    writePanelAgentConversation(dir, ID, CONTEXT, [{ role: 'user', content: 'привет' }]);
    busy.left = 1;
    recordPanelAgentTurnProgress(dir, ID, { texts: ['сказано'], actions: [] });
    expect(busy.left).toBe(0);
    const files = fs.readdirSync(join(dir, 'panel-agent'));
    expect(files.filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(readPanelAgentConversation(dir, ID)?.openTurn?.texts).toEqual(['сказано']);
  });
});
