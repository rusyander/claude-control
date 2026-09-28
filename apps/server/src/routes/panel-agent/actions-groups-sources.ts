import { z } from 'zod';
import type { Group, GroupView } from '@agentdeck/contracts';
import type { ResourceCatalogView } from '@agentdeck/contracts/group-describe';
import { pathAnchorSchema, type GroupPathView } from '@agentdeck/contracts/group-path';
import {
  GROUP_OVERRIDE_FILE,
  IMPORTABLE_MEMBER_KINDS,
  scopeOf,
  type CopyWarning,
  type DiscoveredGroup,
  type DiscoveryView,
  type GroupOverrideView,
  type MemberAdvice,
} from '@agentdeck/contracts/group-sources';
import { groupsForCwd } from '../../domains/group-activation.ts';
import { unifiedDiff } from '../../domains/config-preview/unified-diff.ts';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import { definePanelAction, fingerprintOf, type AnyPanelAction } from './registry.ts';
import {
  card,
  encode,
  listPage,
  literalSecrets,
  maskDeep,
  OFFSET_DESCRIPTION,
  readRoute,
  SECRET_REFUSAL,
} from './action-kit.ts';
import { findGroup } from './actions-app.ts';
import { bilingualField, bothSides, dataField, textField } from './texts.ts';
import { assertRegistered, registeredOnly } from './registered-folder.ts';

/**
 * Группы по областям — то, что в окне «Группы» делают кнопки над карточкой:
 * найти наборы ресурсов в проектах и каталогах CLI и сделать находку группой,
 * скопировать проектную группу в общие (с советами модели) и применить советы,
 * слить копию с ушедшим вперёд оригиналом, переопределить общую группу в
 * проекте, включить группы, привязанные к каталогу, «Путь»: черновик шага от
 * ассистента и шаг → отдельный ресурс, каталог готовых ресурсов.
 *
 * Каждая запись — маршрутом окна и через карточку; своей логики групп здесь
 * нет. Всё, что зовёт модель (обнаружение, советы, слияние, переопределение),
 * — изменение с карточкой: оно тратит лимит человека, и карточка это говорит.
 * Копия в чужой CLI не предлагается: агент работает только с Claude (D6).
 */

const groupId = z.string().min(1).describe('Group id from list_groups');

/** Текст совета для модели: замена целиком может быть файлом — голова, дальше пометка. */
const ADVICE_TEXT_MAX = 2_000;

function adviceForModel(items: readonly MemberAdvice[]) {
  return items.map((item) => ({
    member: `${item.kind}:${item.id}`,
    verdict: item.verdict,
    reason: item.reason,
    ...(item.replacement
      ? {
          replacement:
            item.replacement.length > ADVICE_TEXT_MAX
              ? `${item.replacement.slice(0, ADVICE_TEXT_MAX)}… (${item.replacement.length} chars)`
              : item.replacement,
        }
      : {}),
  }));
}

const memberList = (group: Pick<Group, 'members'>): string =>
  group.members.map((member) => `${member.kind}:${member.id}`).join(', ') || '—';

const readDiscovery = (inject: Parameters<typeof readRoute>[0]) =>
  readRoute<DiscoveryView>(inject, '/api/groups/discovery');

/**
 * Ключ находки для модели — `<слаг набора>@<номер источника>`, без пути. Настоящий
 * ключ `<путь источника>#<слаг>` несёт путь, а последняя сетка (`result-net.ts`)
 * принимает непрозрачный сегмент пути (временный каталог `cc-…-n71z0A`) за секрет и
 * прячет его — импорт по такому ключу находку не находил (обход агента 28.09, ≈6%
 * случайных имён каталога). Слаг уникален внутри источника, номер — среди источников.
 */
function modelKey(view: DiscoveryView, item: DiscoveredGroup): string {
  const at = item.key.lastIndexOf('#');
  const slug = at >= 0 ? item.key.slice(at + 1) : `set-${view.groups.indexOf(item) + 1}`;
  return `${slug}@${view.sources.findIndex((entry) => entry.source === item.foundIn) + 1}`;
}

async function findDiscovered(
  inject: Parameters<typeof readRoute>[0],
  key: string,
): Promise<DiscoveredGroup> {
  const view = await readDiscovery(inject);
  const found = view.groups.filter((item) => item.key === key || modelKey(view, item) === key);
  if (found.length !== 1) {
    throw new Error(`No discovered set with key «${key}». Call list_discovered_groups.`);
  }
  return found[0]!;
}

/** Имя находки на обеих сторонах: русская сторона могла не прийти от модели. */
const discoveredName = (item: DiscoveredGroup) =>
  bothSides(item.localized?.name ?? { ru: item.name, en: item.name });

// --- Обнаружение ---

const listDiscoveredGroups = definePanelAction({
  name: 'list_discovered_groups',
  section: 'groups',
  risk: 'read',
  description:
    'Resource sets the panel found in projects and CLI folders (skills, rules, hooks, MCP used ' +
    'together), each with a key, where it was found, members and status (new / imported / ' +
    'copied). The very first call starts discovery by itself, as the Groups page does. ' +
    '`running: true` = still searching: read again later.',
  input: z.object({
    offset: z.number().int().min(0).optional().describe(OFFSET_DESCRIPTION),
  }),
  route: () => ({ method: 'GET', url: '/api/groups/discovery' }),
  shape: (input, body) => {
    const view = body as DiscoveryView;
    const page = listPage(view.groups, input.offset ?? 0, 40);
    return {
      ...(maskDeep({
        running: view.running,
        ...(view.lastRunAt ? { lastRunAt: view.lastRunAt } : {}),
        sources: view.sources.map((source) => ({
          source: source.source,
          state: source.state,
          found: source.found,
          ...(source.errorCode ? { errorCode: source.errorCode } : {}),
        })),
      }) as Record<string, unknown>),
      ...page.meta,
      // Ключ — вне маски и без пути (`modelKey`): спрятанный ключ импорт не нашёл бы.
      groups: page.slice.map((item) => ({
        key: modelKey(view, item),
        ...(maskDeep({
          name: discoveredName(item).en,
          when: item.when,
          why: item.why,
          foundIn: item.foundIn,
          usedIn: item.usedIn,
          status: item.status,
          members: item.members.map((member) => `${member.kind}:${member.id}`),
          // Агенты, команды и инструкции группа не держит — импорт их не перенесёт.
          notImported: item.members
            .filter((member) => !IMPORTABLE_MEMBER_KINDS.includes(member.kind))
            .map((member) => `${member.kind}:${member.id}`),
          steps: item.steps.length,
        }) as Record<string, unknown>),
      })),
    };
  },
  summary: 'journal-list-discovered-groups',
});

const runGroupDiscovery = definePanelAction({
  name: 'run_group_discovery',
  section: 'groups',
  risk: 'change',
  title: 'journal-run-group-discovery',
  description:
    'Search projects and CLI folders for resource sets again (the «Find» button on Groups). The ' +
    'model reads every changed source, which spends the human’s quota; files are not changed. ' +
    'Runs in the background: read the result with list_discovered_groups. Needs confirmation.',
  input: z.object({}),
  route: () => ({ method: 'POST', url: '/api/groups/discovery/run' }),
  fingerprint: async (_input, inject) => {
    const view = await readDiscovery(inject);
    return fingerprintOf({ running: view.running, lastRunAt: view.lastRunAt ?? null });
  },
  preview: async (_input, inject) => {
    const view = await readDiscovery(inject);
    if (view.running) {
      throw new Error('Discovery is already running. Read list_discovered_groups a bit later.');
    }
    return {
      ...card('summary-run-group-discovery', { sources: view.sources.length || '—' }),
      fields: [textField('label-what-happens', 'value-happens-discovery')],
    };
  },
  page: () => ({ route: '/groups' }),
});

const importDiscoveredGroup = definePanelAction({
  name: 'import_discovered_group',
  section: 'groups',
  risk: 'change',
  title: 'journal-import-discovered-group',
  description:
    'Make a discovered set (key from list_discovered_groups) a project group. The group is ' +
    'created switched OFF; agents, commands and instruction files stay out (the CLI reads them ' +
    'anyway). Needs confirmation.',
  input: z.object({
    key: z.string().min(1).describe('Discovered set key from list_discovered_groups'),
    lang: z
      .enum(['ru', 'en'])
      .optional()
      .describe('Language of the new group’s name and «When»; default = the human’s language'),
  }),
  // Маршрут ждёт настоящий ключ находки, модель знает ключ без пути (`modelKey`).
  route: async (input, inject) => ({
    method: 'POST',
    url: `/api/groups/discovery/${encode((await findDiscovered(inject, input.key)).key)}/import`,
    body: input.lang ? { lang: input.lang } : {},
  }),
  fingerprint: async (input, inject) => fingerprintOf(await findDiscovered(inject, input.key)),
  preview: async (input, inject) => {
    const item = await findDiscovered(inject, input.key);
    if (item.status === 'imported') {
      throw new Error(
        `The set «${item.name}» is already a project group. Find it with list_groups.`,
      );
    }
    const importable = item.members.filter((member) =>
      IMPORTABLE_MEMBER_KINDS.includes(member.kind),
    );
    if (importable.length === 0) {
      throw new Error(
        'Nothing to import: the set has no skill, rule, hook or MCP member a group can hold.',
      );
    }
    const left = item.members.filter((member) => !IMPORTABLE_MEMBER_KINDS.includes(member.kind));
    const name = discoveredName(item);
    return {
      ...card('summary-import-discovered-group', { name: name.ru }, { name: name.en }),
      fields: [
        dataField('label-found-in', item.foundIn),
        dataField(
          'label-members',
          importable.map((member) => `${member.kind}:${member.id}`).join(', '),
        ),
        ...(left.length > 0
          ? [
              textField('label-warning', 'value-import-left-out', {
                members: left.map((member) => `${member.kind}:${member.id}`).join(', '),
              }),
            ]
          : []),
      ],
    };
  },
  page: (_input, result) => {
    const id = (result as { id?: unknown } | undefined)?.id;
    return typeof id === 'string' ? { route: '/groups', focus: id } : { route: '/groups' };
  },
  shape: (_input, body) => {
    const group = body as Group;
    return { id: group.id, name: group.name, isEnabled: group.isEnabled, scope: group.scope };
  },
});

// --- Копия в общие, советы, слияние ---

const copyGroupToGlobal = definePanelAction({
  name: 'copy_group_to_global',
  section: 'groups',
  risk: 'change',
  title: 'journal-copy-group-to-global',
  description:
    'Copy a PROJECT group into the global Claude Code folders: its members are copied (a taken ' +
    'name gets a suffix, see `warnings`) and the model then advises per member — `ours` (use an ' +
    'existing global resource), `improve` (new text) or `keep`. Advice is NOT applied: tell the ' +
    'human what it says, then apply the chosen items with apply_group_advice on the NEW group id. ' +
    'Spends quota. Needs confirmation.',
  input: z.object({ id: groupId }),
  route: (input) => ({
    method: 'POST',
    url: `/api/groups/${encode(input.id)}/copy-to-global`,
    body: {},
  }),
  fingerprint: async (input, inject) => fingerprintOf(await findGroup(inject, input.id)),
  preview: async (input, inject) => {
    const group = await findGroup(inject, input.id);
    if (scopeOf(group).kind !== 'project') {
      throw new Error(`«${group.name}» is already global: only a project group is copied.`);
    }
    return {
      ...card('summary-copy-group-to-global', { name: group.name }),
      fields: [
        dataField('label-members', memberList(group)),
        textField('label-what-happens', 'value-happens-copy-global'),
      ],
    };
  },
  shape: (_input, body) => {
    const result = body as {
      group: Group;
      advice: MemberAdvice[];
      adviceFailed?: true;
      warnings: CopyWarning[];
    };
    return maskDeep({
      copy: { id: result.group.id, name: result.group.name },
      advice: adviceForModel(result.advice),
      ...(result.adviceFailed ? { adviceFailed: true } : {}),
      warnings: result.warnings,
    });
  },
  page: (_input, result) => {
    const id = (result as { copy?: { id?: unknown } } | undefined)?.copy?.id;
    return typeof id === 'string' ? { route: '/groups', focus: id } : { route: '/groups' };
  },
});

const adviceItem = z.object({
  kind: z.enum(['skill', 'hook', 'rule', 'agent', 'command', 'mcp', 'instructions']),
  id: z.string().min(1),
});

const applyGroupAdvice = definePanelAction({
  name: 'apply_group_advice',
  section: 'groups',
  risk: 'change',
  title: 'journal-apply-group-advice',
  description:
    'Apply the chosen advice items (member kind + id exactly as the advice named them) to a ' +
    'GLOBAL copy after copy_group_to_global or merge_group_origin. Only the global copy changes; ' +
    'the project stays as it is. Needs confirmation.',
  input: z.object({
    id: groupId.describe('Id of the GLOBAL copy the advice belongs to'),
    items: z.array(adviceItem).min(1).max(100),
  }),
  route: (input) => ({
    method: 'POST',
    url: `/api/groups/${encode(input.id)}/advice/apply`,
    body: { items: input.items },
  }),
  fingerprint: async (input, inject) => fingerprintOf(await findGroup(inject, input.id)),
  preview: async (input, inject) => {
    const group = await findGroup(inject, input.id);
    return {
      ...card('summary-apply-group-advice', { name: group.name }),
      fields: [
        dataField(
          'label-advice-items',
          input.items.map((item) => `${item.kind}:${item.id}`).join(', '),
        ),
        dataField('label-members', memberList(group)),
      ],
    };
  },
  shape: (_input, body) => {
    const group = body as Group;
    return { id: group.id, name: group.name, members: memberList(group) };
  },
  page: (input) => ({ route: '/groups', focus: input.id }),
});

const mergeGroupOrigin = definePanelAction({
  name: 'merge_group_origin',
  section: 'groups',
  risk: 'change',
  title: 'journal-merge-group-origin',
  description:
    'For a global copy whose project original changed since copying (`originChanged` in ' +
    'list_groups): the model compares base, copy and original and proposes merged texts. Nothing ' +
    'is written to files: relay the advice, then apply chosen items with apply_group_advice. ' +
    'Spends quota. Needs confirmation.',
  input: z.object({ id: groupId.describe('Id of the GLOBAL copy') }),
  route: (input) => ({ method: 'POST', url: `/api/groups/${encode(input.id)}/merge-origin` }),
  fingerprint: async (input, inject) => fingerprintOf(await findGroup(inject, input.id)),
  preview: async (input, inject) => {
    const group = (await findGroup(inject, input.id)) as GroupView;
    if (!group.origin) {
      throw new Error(`«${group.name}» has no original: it was not copied from a project group.`);
    }
    const changed = group.originChanged ?? [];
    if (changed.length === 0) {
      throw new Error('Nothing to merge: the original has not changed since the copy.');
    }
    return {
      ...card('summary-merge-group-origin', { name: group.name }),
      fields: [
        dataField('label-members', changed.join(', ')),
        textField('label-what-happens', 'value-happens-merge'),
      ],
    };
  },
  shape: (_input, body) => {
    const result = body as { group: Group; advice: MemberAdvice[] };
    return maskDeep({ id: result.group.id, advice: adviceForModel(result.advice) });
  },
  page: (input) => ({ route: '/groups', focus: input.id }),
});

// --- Переопределение и включение по каталогу ---

const projectPath = z.string().trim().min(1).describe('Absolute project directory');

const overrideUrl = (id: string, path: string) =>
  `/api/groups/${encode(id)}/override?path=${encode(path)}`;

const readGroupOverride = definePanelAction({
  name: 'read_group_override',
  section: 'groups',
  risk: 'read',
  description:
    'Whether a project has the override of a global group on: the panel’s rule file in the ' +
    'project and the skill denies it added.',
  input: z.object({ id: groupId.describe('Id of the GLOBAL group'), path: projectPath }),
  // Карточки у чтения нет — папка проверяется здесь (см. `registeredOnly`).
  route: async (input, inject) => {
    await assertRegistered(inject, input.path, { copies: true });
    return { method: 'GET', url: overrideUrl(input.id, input.path) };
  },
  summary: 'journal-read-group-override',
});

const setGroupOverride = definePanelAction({
  name: 'set_group_override',
  section: 'groups',
  risk: 'change',
  title: 'journal-set-group-override',
  description:
    'Turn on or off the override of a GLOBAL Claude group inside one project that has a project ' +
    'group: on = the model writes a local rule file (hidden from git) telling the CLI to follow ' +
    'the global group instead of the project one, and the project’s copies of its skills are ' +
    'denied; off = both removed, the project byte for byte as before. Turning on spends quota. ' +
    'Needs confirmation.',
  input: z.object({
    id: groupId.describe('Id of the GLOBAL group'),
    path: projectPath,
    enabled: z.boolean(),
  }),
  route: (input) => ({
    method: 'PUT',
    url: `/api/groups/${encode(input.id)}/override`,
    body: { path: input.path, enabled: input.enabled },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf({
      group: await findGroup(inject, input.id),
      override: await readRoute<GroupOverrideView>(inject, overrideUrl(input.id, input.path)),
    }),
  preview: async (input, inject) => {
    const group = await findGroup(inject, input.id);
    if (scopeOf(group).kind !== 'global') {
      throw new Error(`«${group.name}» is a project group: only a global group is overridden.`);
    }
    const now = await readRoute<GroupOverrideView>(inject, overrideUrl(input.id, input.path));
    if (!input.enabled && !now.enabled) {
      throw new Error('Nothing would change: the override is already off in this project.');
    }
    return {
      ...card(input.enabled ? 'summary-group-override-on' : 'summary-group-override-off', {
        name: group.name,
      }),
      fields: [
        dataField('label-project', input.path),
        textField(
          'label-what-happens',
          input.enabled ? 'value-happens-override-on' : 'value-happens-override-off',
          { file: GROUP_OVERRIDE_FILE },
        ),
      ],
    };
  },
  page: (input) => ({ route: '/groups', focus: input.id }),
});

const activateGroupsForPath = definePanelAction({
  name: 'activate_groups_for_path',
  section: 'groups',
  risk: 'change',
  title: 'journal-activate-groups',
  description:
    'Switch on every disabled group bound to a folder (its project paths; a git worktree of the ' +
    'repo counts) — what the panel does itself before a chat starts there. Bound groups are only ' +
    'switched on, never off. Needs confirmation.',
  input: z.object({ path: projectPath }),
  route: (input) => ({ method: 'POST', url: '/api/groups/activate', body: { path: input.path } }),
  fingerprint: async (input, inject) => {
    const groups = await readRoute<Group[]>(inject, '/api/groups');
    return fingerprintOf(
      groupsForCwd(groups, input.path).map((group) => [group.id, group.isEnabled]),
    );
  },
  preview: async (input, inject) => {
    const groups = await readRoute<Group[]>(inject, '/api/groups');
    const off = groupsForCwd(groups, input.path).filter((group) => !group.isEnabled);
    if (off.length === 0) {
      throw new Error(
        'Nothing to switch on: no disabled group is bound to this folder (see projectPaths in list_groups).',
      );
    }
    return {
      ...card('summary-activate-groups', { path: input.path }),
      fields: [
        dataField('label-group', off.map((group) => group.name).join(', ')),
        textField('label-what-happens', 'value-happens-activate'),
      ],
    };
  },
  page: () => ({ route: '/groups' }),
});

// --- «Путь» и каталог ---

const listResourceCatalog = definePanelAction({
  name: 'list_resource_catalog',
  section: 'groups',
  risk: 'read',
  description:
    'Ready resources a group can take (the «Pick ready» list): global skills, rules, hooks and ' +
    'scripts, plus the project’s own with `path`; each with a one-line summary when described.',
  input: z.object({
    path: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Project directory to include its resources'),
    offset: z.number().int().min(0).optional().describe(OFFSET_DESCRIPTION),
  }),
  route: async (input, inject) => {
    if (input.path) await assertRegistered(inject, input.path, { copies: true });
    return {
      method: 'GET',
      url: `/api/groups/resource-catalog${input.path ? `?path=${encode(input.path)}` : ''}`,
    };
  },
  shape: (input, body) => {
    const view = body as ResourceCatalogView;
    const page = listPage(view.items, input.offset ?? 0, 80);
    return maskDeep({
      ...page.meta,
      items: page.slice.map((item) => ({
        type: item.type,
        id: item.id,
        scope: item.scope,
        ...(item.title ? { title: item.title.en || item.title.ru } : {}),
        ...(item.summary ? { summary: item.summary.en || item.summary.ru } : {}),
        ...(item.description ? { description: item.description } : {}),
      })),
      ...(view.pending?.length ? { stillDescribing: view.pending.length } : {}),
    });
  },
  summary: 'journal-list-resource-catalog',
});

const draftGroupStep = definePanelAction({
  name: 'draft_group_step',
  section: 'groups',
  // Зовёт модель (лимит человека) и пишет разговор ассистента в данные панели —
  // значит, как и поиск наборов, идёт через карточку, а не молча.
  risk: 'change',
  title: 'journal-draft-group-step',
  description:
    'Ask the panel’s path-step assistant (the «Assistant» button of a path step) to turn the ' +
    'human’s words into a step: title, prompt and «done when» in both languages, or questions. ' +
    'The group is not changed — save the result with add_group_step; the assistant’s ' +
    'conversation is kept in the panel’s data. Pass conversationId back to answer its ' +
    'questions. Spends the human’s quota, so every call needs confirmation.',
  input: z.object({
    id: groupId,
    text: z
      .string()
      .trim()
      .min(1)
      .max(8_000)
      .describe('What the step should do, in the human’s words'),
    anchor: pathAnchorSchema.describe('Stage the step runs after'),
    lang: z.enum(['ru', 'en']).optional().describe('Language of `text`; default ru'),
    conversationId: z.string().optional().describe('From the previous answer, to continue'),
  }),
  route: (input) => ({
    method: 'POST',
    url: `/api/groups/${encode(input.id)}/path/draft`,
    body: {
      mode: 'author',
      text: input.text,
      anchor: input.anchor,
      ...(input.lang ? { lang: input.lang } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
  }),
  fingerprint: async (input, inject) => fingerprintOf(await findGroup(inject, input.id)),
  preview: async (input, inject) => {
    const group = await findGroup(inject, input.id);
    return {
      ...card('summary-draft-group-step', { group: group.name }),
      fields: [
        dataField('label-message', maskSecretsInText(input.text)),
        textField('label-what-happens', 'value-happens-draft-step'),
      ],
    };
  },
  shape: (_input, body) => maskDeep(body),
});

const promoteGroupStep = definePanelAction({
  name: 'promote_group_step',
  section: 'groups',
  risk: 'change',
  title: 'journal-promote-group-step',
  description:
    'Turn one of the group’s own path steps (step id from read_group) into a real resource the ' +
    'group then uses: skill (draft = full SKILL.md with frontmatter), rule (draft = rule text), ' +
    'hook (draft = JSON {"event","matcher"?,"command"}) or script (draft = file text, `name` = ' +
    'file name). A project group writes into its project’s .claude. Never put secrets into the ' +
    'draft. Needs confirmation.',
  input: z.object({
    id: groupId,
    stepId: z.string().min(1).describe('Step id from read_group'),
    type: z.enum(['skill', 'rule', 'hook', 'script']),
    draft: z.string().min(1).max(64_000),
    name: z.string().trim().min(1).max(120).optional().describe('Resource name (scripts)'),
  }),
  route: (input) => ({
    method: 'POST',
    url: `/api/groups/${encode(input.id)}/path/promote`,
    body: {
      stepId: input.stepId,
      type: input.type,
      draft: input.draft,
      ...(input.name ? { name: input.name } : {}),
    },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf(
      (
        await readRoute<GroupPathView>(inject, `/api/groups/${encode(input.id)}/path`)
      ).entries.filter((entry) => entry.kind === 'custom'),
    ),
  preview: async (input, inject) => {
    if (literalSecrets({ draft: input.draft }).length > 0) throw new Error(SECRET_REFUSAL);
    const group = await findGroup(inject, input.id);
    const view = await readRoute<GroupPathView>(inject, `/api/groups/${encode(group.id)}/path`);
    const step = view.entries.flatMap((entry) =>
      entry.kind === 'custom' && entry.step.id === input.stepId ? [entry.step] : [],
    )[0];
    if (!step) {
      throw new Error(`Step «${input.stepId}» is not a step of «${group.name}». Call read_group.`);
    }
    if (step.kind === 'resource') {
      throw new Error(
        `The step already points to a resource (${step.resource?.type}:${step.resource?.id}).`,
      );
    }
    const title = bothSides(step.title);
    const label = `${input.type}${input.name ? `:${input.name}` : ''}`;
    const diff = unifiedDiff(label, '', `${maskSecretsInText(input.draft)}\n`);
    return {
      ...card('summary-promote-group-step', { step: title.ru }, { step: title.en }),
      fields: [
        bilingualField('label-group-steps', title),
        dataField('label-resource-type', input.type),
        dataField(
          'label-scope',
          scopeOf(group).kind === 'project'
            ? `project ${(group.scope as { path: string }).path}`
            : 'global',
        ),
      ],
      ...(diff.truncated
        ? {
            truncated: true,
            diff: `--- /dev/null\n+++ b/${label}\n(правка слишком велика для построчного диффа)`,
          }
        : { diff: diff.diff }),
    };
  },
  page: (input) => ({ route: '/groups', focus: input.id }),
});

export const GROUP_SOURCES_ACTIONS: readonly AnyPanelAction[] = [
  listDiscoveredGroups,
  runGroupDiscovery,
  importDiscoveredGroup,
  copyGroupToGlobal,
  applyGroupAdvice,
  mergeGroupOrigin,
  readGroupOverride,
  // Файл переопределения ложится в папку, включение идёт по папке: только проект
  // панели или его рабочая копия (чат в копии включает группы так же).
  registeredOnly(setGroupOverride, { field: 'path', copies: true }),
  registeredOnly(activateGroupsForPath, { field: 'path', copies: true }),
  listResourceCatalog,
  draftGroupStep,
  promoteGroupStep,
];
