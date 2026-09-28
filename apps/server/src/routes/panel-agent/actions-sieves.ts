import { z } from 'zod';
import { BUILTIN_SIEVES, type LearnedSieve, type SievesView } from '@agentdeck/contracts/sieves';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { card, maskDeep, readRoute, stateCard } from './action-kit.ts';
import { dataField } from './texts.ts';

/**
 * Сита перед MR (решение владельца 28.09) — те же маршруты, что у вкладки
 * «Группы» в настройках. Встроенные сита — каталог контракта; выученные панель
 * пишет сама по тредам MR предложенными; принять их может только человек своей
 * кнопкой (`human:prompts`), а убрать — и через агента с подтверждением: сито,
 * которое не держит, иначе ехало бы в каждое задание звена.
 */

const SIEVES_URL = '/api/sieves';

const readSieves = (inject: InjectRoute) => readRoute<SievesView>(inject, SIEVES_URL);

async function learnedOf(inject: InjectRoute, id: string): Promise<LearnedSieve> {
  const found = (await readSieves(inject)).learned.find((sieve) => sieve.id === id);
  if (!found) throw new Error(`Learned sieve «${id}» not found. Call read_sieves.`);
  return found;
}

/** Выученное сито для модели: без полного списка тредов — их число и последний. */
const learnedView = (sieve: LearnedSieve) => ({
  id: sieve.id,
  class: sieve.class,
  status: sieve.status,
  scope: sieve.scope,
  ...(sieve.projectPath ? { projectPath: sieve.projectPath } : {}),
  ...(sieve.suggestedScope ? { suggestedScope: sieve.suggestedScope } : {}),
  trigger: sieve.trigger,
  check: sieve.check,
  seen: sieve.sources.length,
  lastSeenAt: sieve.lastSeenAt,
});

const readSievesAction = definePanelAction({
  name: 'read_sieves',
  section: 'settings',
  risk: 'read',
  description:
    'Pre-MR sieves of split groups (Settings → Groups): the built-in checks every group reports ' +
    'before its MR, the sieves the panel learned from reviewer threads of past MRs (class, scope, ' +
    'trigger, check, how often seen) and the monthly tally per blocker class — escaped = a blocker ' +
    'a reviewer found in an MR, caught = one the panel stopped before the MR. A learned sieve is ' +
    '"proposed" until the human accepts it in Settings → Groups (for its project or for all); ' +
    'only "active" ones reach group tasks. Accepting is the human’s own click — you cannot do it; ' +
    'point them to the card.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: SIEVES_URL }),
  shape: (_input, body) => {
    const view = body as SievesView;
    return maskDeep({
      builtIn: BUILTIN_SIEVES.map((sieve) => ({
        id: sieve.id,
        class: sieve.class,
        stage: sieve.stage,
        when: sieve.when.length > 0 ? sieve.when : ['any change'],
        ...(sieve.mechanical ? { checkedByPanel: true } : {}),
      })),
      learned: view.learned.map(learnedView),
      tally: view.tally,
    });
  },
  summary: 'journal-read-sieves',
});

const deleteLearnedSieve = definePanelAction({
  name: 'delete_learned_sieve',
  section: 'settings',
  risk: 'danger',
  title: 'journal-delete-learned-sieve',
  description:
    'Remove one learned sieve by id (from read_sieves): group tasks stop carrying it. Built-in ' +
    'sieves cannot be removed. The blocker tally stays. Needs the human’s confirmation.',
  input: z.object({ id: z.string().min(1).describe('Learned sieve id from read_sieves') }),
  route: (input) => ({
    method: 'DELETE',
    url: `${SIEVES_URL}/learned/${encodeURIComponent(input.id)}`,
  }),
  fingerprint: async (input, inject) => fingerprintOf(await learnedOf(inject, input.id)),
  preview: async (input, inject) => {
    const sieve = await learnedOf(inject, input.id);
    return stateCard(
      'sieves.json',
      maskDeep({
        class: sieve.class,
        scope: sieve.scope,
        trigger: sieve.trigger,
        check: sieve.check,
      }),
      {},
      card('summary-delete-learned-sieve', { class: sieve.class }),
      [dataField('label-sieve-sources', sieve.sources.map((source) => source.thread).join('\n'))],
    );
  },
  shape: () => ({ deleted: true }),
  page: () => ({ route: '/settings', focus: 'groups' }),
});

export const SIEVE_ACTIONS: readonly AnyPanelAction[] = [readSievesAction, deleteLearnedSieve];
