import { z } from 'zod';
import type { AppSettings, Group } from '@agentdeck/contracts';
import { groupCopyName, type GroupDuplicateResult } from '@agentdeck/contracts/groups';
import { definePanelAction, type InjectRoute } from './registry.ts';
import { card, encode, readRoute, routeFingerprint, stateCard } from './action-kit/action-kit.ts';
import { findGroup } from './actions-app/actions-app.ts';
import { dataField, textField } from './texts/texts.ts';

/**
 * «Копировать группу» для агента панели — тем же маршрутом, что кнопка окна
 * группы (`POST /api/groups/:id/duplicate`). Имя копии считается ЗДЕСЬ и
 * уходит в тело: карточка подтверждения показывает ровно то имя, под которым
 * копия ляжет, а не догадку о том, что выберет сервер.
 */

const copyInput = z.object({
  id: z.string().min(1).describe('Group id from list_groups'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Name of the copy; omit → «<name> (copy)» in the panel language, numbered «(copy 2)» when taken',
    ),
});
type CopyInput = z.infer<typeof copyInput>;

async function copyPlan(input: CopyInput, inject: InjectRoute) {
  const groups = await readRoute<Group[]>(inject, '/api/groups');
  const group = await findGroup(inject, input.id);
  const { language } = await readRoute<AppSettings>(inject, '/api/settings');
  const name =
    input.name ??
    groupCopyName(
      group.name,
      groups.map((item) => item.name),
      language,
    );
  const taken = groups.find(
    (item) => item.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
  );
  if (taken) {
    throw new Error(`A group «${taken.name}» already exists (id ${taken.id}). Pick another name.`);
  }
  return { group, name };
}

const copyGroup = definePanelAction({
  name: 'copy_group',
  section: 'groups',
  risk: 'change',
  title: 'journal-copy-group',
  description:
    'Copy a group into a NEW independent one next to it: same members, own «Path» steps (new ids), ' +
    'knobs, «When», flow and scope; the project binding is not copied. The copy is created switched ' +
    'OFF and switches nothing off; editing it never touches the original. Needs confirmation.',
  input: copyInput,
  route: async (input, inject) => {
    const { name } = await copyPlan(input, inject);
    return { method: 'POST', url: `/api/groups/${encode(input.id)}/duplicate`, body: { name } };
  },
  // Источник — целиком: карточка показывает его участников, ручки и «Когда»,
  // и правка любого из них между карточкой и кликом — уже другая копия. Прочие
  // группы — только id и имя: по ним решается, свободно ли имя копии.
  fingerprint: (input, inject) =>
    routeFingerprint(inject, '/api/groups', (body) =>
      (body as Group[]).map((group) => (group.id === input.id ? group : [group.id, group.name])),
    ),
  preview: async (input, inject) => {
    const { group, name } = await copyPlan(input, inject);
    const steps = group.path?.steps.length ?? 0;
    return stateCard(
      `state.json: groups/${name}`,
      undefined,
      {
        name,
        copyOf: group.name,
        isEnabled: false,
        members: group.members.map((member) => `${member.kind}:${member.id}`),
        steps,
        ...(group.knobs && Object.keys(group.knobs).length > 0 ? { knobs: group.knobs } : {}),
        ...(group.when ? { when: group.when } : {}),
        // Копия уносит и их: переменные — только именами (значения бывают
        // секретами), устаревший сценарий — признаком.
        ...(Object.keys(group.env ?? {}).length > 0 ? { env: Object.keys(group.env) } : {}),
        ...(group.scenario ? { scenario: true } : {}),
      },
      card('summary-group-copy', { name: group.name, copy: name }),
      [
        textField('label-group-copy-effect', 'value-group-copy-effect'),
        dataField('label-members', String(group.members.length)),
        dataField('label-group-steps', String(steps)),
      ],
    );
  },
  shape: (_input, body) => {
    const { group, sourceId } = body as GroupDuplicateResult;
    return { id: group.id, name: group.name, isEnabled: group.isEnabled, sourceId };
  },
  page: (_input, result) => {
    const id = (result as { id?: unknown } | undefined)?.id;
    return { route: '/groups', ...(typeof id === 'string' ? { focus: id } : {}) };
  },
});

export const GROUP_COPY_ACTIONS = [copyGroup] as const;
