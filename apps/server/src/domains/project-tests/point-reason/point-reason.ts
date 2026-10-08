import type { ProjectTestPointResult } from '@agentdeck/contracts';
import { resultReason } from '@agentdeck/contracts/test-format';
import { RUN_TEXTS, type ExportLanguage } from '../export-run-texts.ts';

/**
 * Что видел исполнитель — строкой для выгрузки и отчёта вехи. Порядок общий с
 * вебом (`resultReason`): разбор провала первым, заметка — когда «что вышло» не
 * записано. Человек часто пишет только к красному шагу, и провал без этой
 * подстановки уходил наружу безымянным.
 */
export function reasonOf(result: ProjectTestPointResult, lang: ExportLanguage = 'ru'): string {
  const reason = resultReason(result);
  if (!reason) return '';
  if (reason.source === 'note') return reason.text;
  const texts = RUN_TEXTS[lang];
  if (reason.source === 'flaky') return texts.flaky(reason.attempts ?? 1);
  const where = reason.step !== undefined ? texts.step(reason.step) : '';
  const wanted = reason.expected ? texts.expected(reason.expected) : '';
  return `${where}${reason.text || texts.failure}${wanted}`;
}
