import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatInbox } from '@agentdeck/contracts/chat-inbox';
import { launchOf, sourceOf, withSources } from './ask-source.ts';
import { readAgentDefinition } from './agent-definition.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ask-source', () => {
  it('группа — номер с единицы, название, стадия и родитель; фон — по реестру', () => {
    const source = sourceOf(
      { id: 'child', runKey: 'run-child' },
      {
        link: (key) =>
          key === 'child'
            ? { parentChatId: 'parent', groupIndex: 1, title: 'Тесты', stage: 'review' }
            : undefined,
        parentTitle: (id) => (id === 'parent' ? 'Задача' : undefined),
        cliName: 'Claude Code',
        background: (runKey) => runKey === 'run-child',
      },
    );
    expect(source).toEqual({
      app: 'agentdeck',
      cli: 'Claude Code',
      background: true,
      group: { index: 2, title: 'Тесты', stage: 'review', parentTitle: 'Задача' },
    });
    expect(
      sourceOf({ id: 'x', outside: true }, { link: () => undefined, cliName: 'Claude Code' }),
    ).toEqual({ app: 'outside', cli: 'Claude Code' });
  });

  it('запуск агента: модель и усилие из вызова, иначе из описания агента', () => {
    expect(launchOf('Bash', { command: 'ls' })).toBeUndefined();
    expect(
      launchOf(
        'Agent',
        { description: 'ревью', subagent_type: 'reviewer', run_in_background: true },
        () => ({ model: 'opus', effort: 'high' }),
      ),
    ).toEqual({
      description: 'ревью',
      subagentType: 'reviewer',
      model: 'opus',
      effort: 'high',
      background: true,
    });
    expect(
      launchOf('Task', { subagent_type: 'reviewer', model: 'sonnet' }, () => ({ model: 'opus' })),
    ).toEqual({ subagentType: 'reviewer', model: 'sonnet' });
  });

  it('описание агента — из проекта раньше общего; чужой путь в типе не читается', () => {
    const root = mkdtempSync(join(tmpdir(), 'ask-source-'));
    dirs.push(root);
    const config = join(root, 'config');
    const project = join(root, 'project');
    mkdirSync(join(config, 'agents'), { recursive: true });
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
    const agent = (model: string, effort: string) =>
      `---\nname: reviewer\ndescription: r\nmodel: ${model}\neffort: ${effort}\n---\nbody\n`;
    writeFileSync(join(config, 'agents', 'reviewer.md'), agent('opus', 'high'));
    expect(readAgentDefinition(config, 'reviewer', project)).toEqual({
      model: 'opus',
      effort: 'high',
    });
    writeFileSync(join(project, '.claude', 'agents', 'reviewer.md'), agent('sonnet', 'medium'));
    expect(readAgentDefinition(config, 'reviewer', project)).toEqual({
      model: 'sonnet',
      effort: 'medium',
    });
    expect(readAgentDefinition(config, '../reviewer', project)).toBeUndefined();
  });

  it('withSources подписывает только чаты с вопросами', () => {
    const inbox: ChatInbox = {
      generatedAt: '',
      chats: [
        {
          id: 'a',
          title: 'a',
          project: 'p',
          projectPath: '',
          isSandbox: false,
          status: 'waiting',
          running: true,
          updatedAt: '',
          asks: [
            {
              kind: 'permission',
              key: 'k',
              toolUseId: 't',
              toolName: 'Agent',
              input: { description: 'd' },
              askedAt: '',
            },
          ],
        },
        {
          id: 'b',
          title: 'b',
          project: 'p',
          projectPath: '',
          isSandbox: false,
          status: 'running',
          running: true,
          updatedAt: '',
          asks: [],
        },
      ],
    };
    withSources(inbox, { link: () => undefined, cliName: 'Claude Code' });
    expect(inbox.chats[0]!.source).toEqual({ app: 'agentdeck', cli: 'Claude Code' });
    expect(inbox.chats[0]!.asks[0]).toMatchObject({ launch: { description: 'd' } });
    expect(inbox.chats[1]!.source).toBeUndefined();
  });
});
