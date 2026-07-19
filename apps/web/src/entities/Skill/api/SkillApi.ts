import type { Skill, SkillDraft } from '@claude-control/contracts';
import { createEntityApi } from '@shared/api/create-entity-api';
import { queryKeys } from '@shared/api/query-keys';

export const skillApi = createEntityApi<Skill, SkillDraft>({
  resource: 'skills',
  listKey: queryKeys.skills,
  kind: 'skill',
});
