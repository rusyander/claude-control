import { describe, it, expect } from 'vitest';
import {
  GROUP_SKILLS,
  groupRunProfile,
  readOnlyMcpDeny,
  STAGE_SKILLS,
  stageSkills,
  type ProfileMcpEntry,
} from './group-profile.ts';

/**
 * Профиль звена группы (L1.2, L1.3). Что CLI делает с шаблонами `deny` и
 * `name-only`, доказывает настоящий CLI (`tools/qa/check-run-layers.mjs`,
 * случай 0); здесь — какие имена шаблоны звена накрывают. Сверка — по правилу
 * CLI, замеренному там же: `*` — любая строка, шаблон сравнивается с именем целиком.
 */

const ENTRIES: ProfileMcpEntry[] = [
  { id: 'gitlab-work', config: { command: 'npx', args: ['@zereight/mcp-gitlab'] } },
  { id: 'atlassian.work', config: { url: 'https://mcp.example.com/jira' } },
  { id: 'figma', config: { url: 'https://mcp.figma.com/mcp' } },
  { id: 'notes', config: { command: 'notes-mcp' } },
];

/** Правило CLI для `deny` по имени инструмента: `*` — любая строка, сравнение целиком. */
function denied(rules: readonly string[], tool: string): boolean {
  return rules.some((rule) =>
    new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(tool),
  );
}

const WRITES = [
  'mcp__gitlab-work__create_merge_request',
  'mcp__gitlab-work__create_merge_request_note',
  'mcp__gitlab-work__update_merge_request',
  'mcp__gitlab-work__merge_merge_request',
  'mcp__gitlab-work__push_files',
  'mcp__gitlab-work__bulk_publish_draft_notes',
  'mcp__gitlab-work__execute_graphql',
  'mcp__atlassian_work__jira_create_issue',
  'mcp__atlassian_work__jira_add_comment',
  'mcp__atlassian_work__jira_transition_issue',
  'mcp__atlassian_work__jira_batch_create_issues',
  'mcp__atlassian_work__confluence_update_page',
  'mcp__figma__add_code_connect_map',
];

const READS = [
  'mcp__gitlab-work__get_merge_request',
  'mcp__gitlab-work__list_merge_requests',
  'mcp__gitlab-work__get_merge_request_diffs',
  'mcp__gitlab-work__list_pipelines',
  'mcp__atlassian_work__jira_get_issue',
  'mcp__atlassian_work__jira_search',
  'mcp__atlassian_work__jira_get_link_types',
  'mcp__atlassian_work__jira_batch_get_changelogs',
  'mcp__figma__get_design_context',
  'mcp__notes__create_note',
];

describe('MCP наружу только на чтение — звеньям плана и ревью (L1.2)', () => {
  it('план и ревью: запись трекера, хранилища кода и макетов снята, чтение — нет', () => {
    for (const stage of ['plan', 'review'] as const) {
      const rules = readOnlyMcpDeny(ENTRIES, stage);
      for (const tool of WRITES) expect(denied(rules, tool), `${stage}: ${tool}`).toBe(true);
      // Чтение — и сервер неизвестной роли целиком: его поставил человек, и что в
      // нём запись, панель не знает.
      for (const tool of READS) expect(denied(rules, tool), `${stage}: ${tool}`).toBe(false);
    }
  });

  it('работа, правки, доставка и связь без звена — запрета нет', () => {
    for (const stage of ['work', 'fix', 'deliver', 'triage', undefined] as const) {
      expect(readOnlyMcpDeny(ENTRIES, stage)).toEqual([]);
    }
  });

  it('профиль ревью: запрет рядом с правилами `ask` и строкой о чтении; работа — без них', () => {
    const input = { entries: ENTRIES, tasksText: 'PROJ-1 макет', extra: [] };
    const review = groupRunProfile({ ...input, stage: 'review' });
    const permissions = review.settings.permissions as { ask: string[]; deny?: string[] };
    expect(permissions.ask).toContain('mcp__gitlab-work');
    expect(permissions.deny).toEqual(readOnlyMcpDeny(review.mcp.ids.map(byId), 'review'));
    expect(review.note).toContain('write tools are not in this run');
    const work = groupRunProfile({ ...input, stage: 'work' });
    expect(work.settings.permissions).not.toHaveProperty('deny');
    expect(work.note).not.toContain('write tools are not in this run');
  });
});

function byId(id: string): ProfileMcpEntry {
  return ENTRIES.find((entry) => entry.id === id)!;
}

describe('описания навыков — только своих звену (L1.3)', () => {
  it('ревью, правки и доставка — свой набор; работа, план и без звена — весь набор группы', () => {
    expect(stageSkills('review')).toContain('deep-review');
    expect(stageSkills('review')).not.toContain('prepare-mr');
    expect(stageSkills('deliver')).toContain('prepare-mr');
    expect(stageSkills('deliver')).not.toContain('deep-review');
    expect(stageSkills('fix')).toContain('unit-integration-tests');
    expect(stageSkills('fix')).not.toContain('prepare-mr');
    for (const stage of ['work', 'plan', undefined] as const) {
      expect(stageSkills(stage)).toEqual(GROUP_SKILLS);
    }
    for (const list of Object.values(STAGE_SKILLS)) expect(list).toContain('skill-map');
  });

  it('профиль звена: навыку чужого звена — имя, навыку групп панели — описание всегда', () => {
    const profile = groupRunProfile({
      entries: [],
      tasksText: 'PROJ-1',
      extra: [],
      skills: {
        user: ['deep-review', 'prepare-mr', 'team-skill'],
        group: ['team-skill'],
        plugins: [],
      },
      stage: 'review',
    });
    const overrides = profile.settings.skillOverrides as Record<string, string>;
    expect(overrides['prepare-mr']).toBe('name-only');
    expect(overrides).not.toHaveProperty('deep-review');
    expect(overrides).not.toHaveProperty('team-skill');
  });
});
