import type { TmsPullResult, TmsPushResult } from '@agentdeck/contracts';
import { readGroup, readGroups, upsertCase } from '../../project-tests/store.ts';
import { readRun } from '../../project-tests/runs-store.ts';
import { IntegrationError } from '../errors.ts';
import type { TmsCase, TmsClient } from './types.ts';
import { externalKeys, keyFromTags, keyLookup, sourceTag } from './types.ts';

/**
 * Обмен с тест-менеджментом: кейсы оттуда, результаты туда.
 *
 * Место истины по кейсам остаётся ТАМ. Панель забирает копию, помечает её
 * `tms:<ключ>` и по этой же пометке решает, что уже привезено. Отсюда два
 * свойства, ради которых всё и написано: повторный забор не плодит дубликаты, а
 * отправка знает, какому кейсу внешней системы принадлежит результат.
 *
 * Кейс, уже лежащий в группе, НЕ перезаписывается: человек мог дописать в него
 * шаг, зону или свои поля, и затирать это ради синхронизации нельзя. Такой кейс
 * считается пропущенным — число видно в ответе.
 */

export function pullIntoGroup(
  root: string,
  groupId: string,
  cases: TmsCase[],
  now: string,
): TmsPullResult {
  const group = readGroup(root, groupId);
  const known = new Set(
    group.cases.map((item) => keyFromTags(item.tags)).filter((key): key is string => Boolean(key)),
  );

  let imported = 0;
  let skipped = 0;
  for (const item of cases) {
    if (!item.key || known.has(item.key)) {
      skipped += 1;
      continue;
    }
    upsertCase(
      root,
      groupId,
      {
        title: item.title,
        precondition: item.precondition,
        steps: item.steps.map((step) => ({
          action: step.action,
          expected: step.expected,
          data: step.data,
        })),
        expected: item.expected,
        tags: [sourceTag(item.key)],
        links: item.url ? [{ type: 'requirement', url: item.url, title: item.key }] : undefined,
      },
      now,
    );
    known.add(item.key);
    imported += 1;
  }

  return { imported, skipped };
}

/**
 * Отправить прогон. Кейс без пометки `tms:` пропускается молча — придумывать
 * соответствие панель не имеет права: чужой отчёт получил бы результат не того
 * теста, и заметили бы это не скоро.
 */
export async function pushRunToTms(
  client: TmsClient,
  root: string,
  runId: string,
): Promise<TmsPushResult> {
  const run = readRun(root, runId);
  if (!run) {
    throw new IntegrationError('integration_not_found', `Прогон «${runId}» не найден.`);
  }
  const keys = externalKeys(readGroups(root).filter((group) => !group.error));
  return client.pushRun({ run, keyOf: keyLookup(keys) });
}
