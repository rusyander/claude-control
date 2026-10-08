import { z } from 'zod';
import type { DlpJournalEntry, DlpPreviewResult } from '@agentdeck/contracts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import { card, readRoute } from '../action-kit/action-kit.ts';
import { dataField, textField } from '../texts/texts.ts';

/**
 * Защита данных сверх `get_dlp`/`save_dlp_rules`/`toggle_dlp_proxy`: проверить
 * текст сохранёнными правилами, прочитать журнал прокси, очистить его.
 *
 * Журнал значений не несёт по построению (`DlpJournalEntry`: правило, метка,
 * счётчик). Проба отдаёт уже замаскированный текст — ровно то, что увидела бы
 * модель за прокси; исходный текст в ответ не возвращается.
 */

const JOURNAL_URL = '/api/dlp/journal';

interface JournalAnswer {
  entries: DlpJournalEntry[];
}

const dlpPreview = definePanelAction({
  name: 'dlp_preview',
  section: 'dlp',
  risk: 'read',
  description:
    'Check a sample text against the SAVED data protection rules: what the model behind the proxy ' +
    'would see (masked text), which rules hit and how often, and whether the request would be ' +
    'blocked. Writes nothing.',
  input: z.object({ text: z.string().min(1).max(20_000).describe('Sample text to check') }),
  route: (input) => ({ method: 'POST', url: '/api/dlp/preview', body: { text: input.text } }),
  shape: (_input, body) => {
    const result = body as DlpPreviewResult;
    return {
      blocked: result.blocked,
      masked: result.masked,
      hits: result.hits.map((hit) => ({
        rule: hit.ruleName,
        action: hit.action,
        count: hit.count,
        ...(hit.placeholder ? { placeholder: hit.placeholder } : {}),
      })),
    };
  },
  summary: 'journal-dlp-preview',
});

const dlpJournal = definePanelAction({
  name: 'dlp_journal',
  section: 'dlp',
  risk: 'read',
  description:
    'Data protection proxy journal, newest first: time, request path, passed | masked | blocked, ' +
    'which rules hit and how many times. Values are never recorded.',
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
  route: (input) => ({ method: 'GET', url: `${JOURNAL_URL}?limit=${input.limit}` }),
  shape: (_input, body) => {
    const { entries } = body as JournalAnswer;
    return {
      count: entries.length,
      entries: entries.map((entry) => ({
        at: entry.at,
        path: entry.path,
        decision: entry.decision,
        rules: entry.hits.map((hit) => `${hit.ruleName} ×${hit.count}`),
        ...(entry.reason ? { reason: entry.reason } : {}),
      })),
    };
  },
  summary: 'journal-dlp-journal',
});

/** Сколько записей в журнале сейчас — строка карточки и отпечаток. */
async function journalSize(inject: InjectRoute): Promise<number> {
  return (await readRoute<JournalAnswer>(inject, `${JOURNAL_URL}?limit=100000`)).entries.length;
}

const clearDlpJournal = definePanelAction({
  name: 'clear_dlp_journal',
  section: 'dlp',
  risk: 'danger',
  title: 'journal-clear-dlp-journal',
  description:
    'Delete every entry of the data protection proxy journal for good. Rules and the proxy stay. ' +
    'Needs the human’s confirmation.',
  input: z.object({}),
  route: () => ({ method: 'DELETE', url: JOURNAL_URL }),
  fingerprint: async (_input, inject) => fingerprintOf(await journalSize(inject)),
  preview: async (_input, inject) => {
    const size = await journalSize(inject);
    if (size === 0) throw new Error('Nothing would change: the journal is already empty.');
    return {
      ...card('summary-clear-dlp-journal'),
      fields: [
        dataField('label-entries', String(size)),
        textField('label-what-happens', 'value-clear-dlp-journal'),
      ],
    };
  },
  shape: () => ({ cleared: true }),
  page: () => ({ route: '/dlp' }),
});

/** Защита данных сверх общих: в порядке показа. */
export const DLP_EXTRA_ACTIONS: readonly AnyPanelAction[] = [
  dlpPreview,
  dlpJournal,
  clearDlpJournal,
];
