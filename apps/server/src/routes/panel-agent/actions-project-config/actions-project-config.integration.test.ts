import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import { openProjectStand, type ProjectStand } from '../project-actions.harness.ts';

/**
 * Настройки проекта руками агента (U4a): CLAUDE.md, `.mcp.json`, права
 * `.claude/settings.json` и выбор стороны пары групп — настоящими маршрутами
 * вкладки проекта во ВРЕМЕННОМ каталоге. Доказательство — файл на диске после
 * клика, и отказ ДО карточки там, где клик человека был бы впустую.
 */

// Живой ключ формы GitHub PAT: детектор секретов обязан его узнать.
const LIVE_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`;

describe('panel-agent actions: project config', () => {
  let stand: ProjectStand;

  beforeEach(async () => {
    stand = await openProjectStand();
  });
  afterEach(async () => {
    await stand.close();
  });

  it('read_project_claude_md маскирует секрет; save_project_claude_md — danger, дифф и файл на диске', async () => {
    const file = join(stand.projectDir, 'CLAUDE.md');
    writeFileSync(file, `# Проект\n\nTOKEN=${LIVE_TOKEN}\n`);
    const read = await stand.call('read_project_claude_md', { project: stand.projectId });
    expect(read.outcome).toBe('done');
    expect(JSON.stringify(read.result)).not.toContain(LIVE_TOKEN);
    expect(JSON.stringify(read.result)).toContain('# Проект');

    // Маска из чтения возвращается секретом с диска — агент его не видел и не прислал.
    const masked = (read.result as { text: string }).text;
    expect(masked).toContain('TOKEN=');
    const saved = await stand.decided('save_project_claude_md', {
      project: stand.projectDir,
      content: `${masked}\nНовая строка\n`,
    });
    expect(saved.card.risk).toBe('danger');
    expect(saved.card.preview.diff).toContain('+Новая строка');
    expect(saved.result.outcome).toBe('done');
    const disk = readFileSync(file, 'utf8');
    expect(disk).toContain(`TOKEN=${LIVE_TOKEN}`);
    expect(disk).toContain('Новая строка');

    const refused = await stand.call('save_project_claude_md', {
      project: stand.projectId,
      content: `leak ${LIVE_TOKEN}`,
    });
    expect(refused.outcome).toBe('failed');
    expect(readFileSync(file, 'utf8')).toBe(disk);
  });

  it('MCP проекта: добавить, выключить, удалить — в .mcp.json; литерал секрета отклонён', async () => {
    const mcpFile = join(stand.projectDir, '.mcp.json');
    const added = await stand.decided('save_project_mcp_server', {
      project: stand.projectId,
      name: 'docs',
      transport: 'stdio',
      command: 'node',
      args: ['docs.js'],
      env: { API_TOKEN: '' },
    });
    // Ревью m5: команда stdio исполнится потом, без карточки, — это danger, и карточка её называет.
    expect(added.card.risk).toBe('danger');
    expect(JSON.stringify(added.card.preview.fields)).toContain('node docs.js');
    // Пустое значение секретного ключа — запись прошла, ввод ключа за человеком.
    expect(added.result.outcome).toBe('needs-secret');
    const onDisk = JSON.parse(readFileSync(mcpFile, 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(onDisk.mcpServers.docs?.command).toBe('node');

    const list = await stand.call('list_project_mcp', { project: stand.projectId });
    expect(list.outcome).toBe('done');
    expect(JSON.stringify(list.result)).toContain('docs');

    const toggled = await stand.decided('toggle_project_mcp_server', {
      project: stand.projectId,
      id: 'docs',
      enabled: false,
    });
    expect(toggled.result.outcome).toBe('done');

    const secret = await stand.call('save_project_mcp_server', {
      project: stand.projectId,
      name: 'leak',
      transport: 'stdio',
      command: 'node',
      env: { API_TOKEN: LIVE_TOKEN },
    });
    expect(secret.outcome).toBe('invalid');
    expect(secret.message).toContain('Secret values are never accepted');
    expect(readFileSync(mcpFile, 'utf8')).not.toContain(LIVE_TOKEN);

    const removed = await stand.decided('delete_project_mcp_server', {
      project: stand.projectId,
      id: 'docs',
    });
    expect(removed.card.risk).toBe('danger');
    expect(removed.result.outcome).toBe('done');
    expect(readFileSync(mcpFile, 'utf8')).not.toContain('docs.js');
  });

  it('права проекта: добавить, изменить, удалить — в .claude/settings.json проекта', async () => {
    const settings = join(stand.projectDir, '.claude', 'settings.json');
    const added = await stand.decided('add_project_permission', {
      project: stand.projectId,
      decision: 'allow',
      pattern: 'Bash(npm test:*)',
    });
    expect(added.result.outcome).toBe('done');
    expect(readFileSync(settings, 'utf8')).toContain('Bash(npm test:*)');

    const listed = await stand.call('list_project_permissions', { project: stand.projectId });
    const rules = (listed.result as { permissions: Array<{ id: string; pattern: string }> })
      .permissions;
    const rule = rules.find((item) => item.pattern === 'Bash(npm test:*)');
    expect(rule).toBeDefined();

    const edited = await stand.decided('edit_project_permission', {
      project: stand.projectId,
      id: rule!.id,
      decision: 'ask',
      pattern: 'Bash(npm run test:*)',
    });
    expect(edited.result.outcome).toBe('done');
    const after = JSON.parse(readFileSync(settings, 'utf8')) as {
      permissions: { ask?: string[]; allow?: string[] };
    };
    expect(after.permissions.ask).toContain('Bash(npm run test:*)');
    expect(after.permissions.allow ?? []).not.toContain('Bash(npm test:*)');

    const secret = await stand.call('add_project_permission', {
      project: stand.projectId,
      decision: 'allow',
      pattern: `Bash(curl -H ${LIVE_TOKEN}:*)`,
    });
    expect(secret.outcome).toBe('failed');

    const relisted = await stand.call('list_project_permissions', { project: stand.projectId });
    const current = (
      relisted.result as { permissions: Array<{ id: string; pattern: string }> }
    ).permissions.find((item) => item.pattern === 'Bash(npm run test:*)');
    const removed = await stand.decided('remove_project_permission', {
      project: stand.projectId,
      id: current!.id,
    });
    expect(removed.card.risk).toBe('danger');
    expect(removed.result.outcome).toBe('done');
    expect(readFileSync(settings, 'utf8')).not.toContain('npm run test');
  });

  it('выбор стороны пары групп: чтение, установка глобальной копии, возврат; чужой ключ — отказ без карточки', async () => {
    const group = (id: string, name: string, patch: Partial<Group>): Group => ({
      id,
      name,
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      projectPaths: [],
      isEnabled: true,
      order: 0,
      ...patch,
    });
    const scope = { kind: 'project' as const, path: stand.projectDir, provider: 'claude' };
    stand.store.saveGroup(group('pa', 'Проектная', { scope }));
    stand.store.saveGroup(
      group('ga', 'Глобальная копия', {
        origin: { scope, groupId: 'pa', hash: 'h', copiedAt: '2026-09-28T00:00:00.000Z' },
      }),
    );

    const before = await stand.call('read_project_group_choice', { project: stand.projectId });
    expect(before.outcome).toBe('done');
    expect(before.result).toMatchObject({ choices: {} });

    const set = await stand.decided('set_project_group_choice', {
      project: stand.projectId,
      groupKey: 'global:ga',
    });
    expect(set.card.risk).toBe('change');
    expect(set.result.outcome).toBe('done');
    const after = await stand.call('read_project_group_choice', { project: stand.projectId });
    expect(after.result).toMatchObject({ choices: { pa: 'global:ga' } });

    const foreign = await stand.call('set_project_group_choice', {
      project: stand.projectId,
      groupKey: 'global:nobody',
    });
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('not a side of any group pair');

    const reset = await stand.decided('set_project_group_choice', {
      project: stand.projectId,
      groupKey: null,
    });
    expect(reset.result.outcome).toBe('done');
    const cleared = await stand.call('read_project_group_choice', { project: stand.projectId });
    expect(cleared.result).toMatchObject({ choices: {} });
  });

  it('неизвестный проект — отказ без карточки; отказ человека оставляет файл нетронутым', async () => {
    const unknown = await stand.call('read_project_claude_md', { project: 'nope' });
    expect(unknown.outcome).toBe('failed');
    expect(unknown.message).toContain('nope');

    const file = join(stand.projectDir, 'CLAUDE.md');
    writeFileSync(file, 'old\n');
    const rejected = await stand.decided(
      'save_project_claude_md',
      { project: stand.projectId, content: 'new\n' },
      'reject',
    );
    expect(rejected.result.outcome).toBe('rejected');
    expect(readFileSync(file, 'utf8')).toBe('old\n');
    expect(existsSync(join(stand.projectDir, '.mcp.json'))).toBe(false);
  });
});
