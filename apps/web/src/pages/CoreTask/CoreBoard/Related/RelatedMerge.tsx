import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './Related.module.scss';
import {
  MERGE_PICK_MAX,
  canMerge,
  mergeRefusalOf,
  pickedOf,
  reasonKeys,
  useBoardMerge,
} from './relatedMerge.lib';

interface RelatedMergeProps {
  card: BoardCard;
}

/**
 * «Связанные карточки» в окне записи (D26, P186): связанные записи «Входящих» с причинами (общий
 * эпик, связь задач, общий путь) и «Объединить» — ход человека: отмеченные записи складываются в
 * эту, их тикеты остаются на ней и одной задачей уходят в работу. По умолчанию отмечены все; ядро
 * ничего не сливает само. Отказ ядра (запись успела уйти в очередь) — его причиной.
 */
export function RelatedMerge({ card }: RelatedMergeProps) {
  const { t } = useTranslation();
  const merge = useBoardMerge();
  // Переключённые отметки, а не выбранные: доска перечитывается раз в 5 с (`pickedOf`).
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const titleId = useId();
  const capId = useId();
  if (!canMerge(card)) return null;
  const related = card.related ?? [];
  const picked = pickedOf(related, toggled);
  const full = picked.length >= MERGE_PICK_MAX;
  const capped = related.length > MERGE_PICK_MAX;
  const refusal = merge.isError ? mergeRefusalOf(merge.error) : null;
  const toggle = (entryId: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  const R = 'coreBoard.related';

  return (
    <section className={styles.section} aria-labelledby={titleId} data-related-merge>
      <Stack gap="var(--spacing-xs)">
        <Typography variant="body-sm" weight="medium" as="h3" id={titleId}>
          {t(`${R}.title`)}
        </Typography>
        <Typography variant="caption" color="subtle" as="p">
          {t(`${R}.lead`)}
        </Typography>
        {capped && (
          <Typography variant="caption" color="subtle" as="p" id={capId} data-related-merge-cap>
            {t(`${R}.cap`, {
              max: MERGE_PICK_MAX + 1,
              cap: MERGE_PICK_MAX,
              count: picked.length,
              total: related.length,
            })}
          </Typography>
        )}
        <ul className={styles.list}>
          {related.map((h) => {
            const on = picked.includes(h.entryId);
            return (
              <li key={h.entryId} data-related-item={h.entryId}>
                <label className={styles.item}>
                  <input
                    type="checkbox"
                    checked={on}
                    // Сверх предела не отметить: причина — строкой предела над списком.
                    disabled={merge.isPending || (!on && full)}
                    aria-describedby={capped ? capId : undefined}
                    onChange={() => toggle(h.entryId)}
                  />
                  <span className={styles.itemText}>
                    <Typography variant="body-sm" as="span">
                      {h.title}
                    </Typography>
                    <Typography variant="caption" color="subtle" as="span">
                      {reasonKeys(h.reasons)
                        .map((r) => t(`${R}.reason.${r}`))
                        .join(', ')}
                    </Typography>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={picked.length === 0}
            isLoading={merge.isPending}
            onClick={() => merge.mutate({ entryId: card.entryId ?? card.id, entryIds: picked })}
            data-related-merge-submit
          >
            {t(`${R}.merge`, { count: picked.length })}
          </Button>
        </div>
        {refusal && (
          <Typography
            variant="body-sm"
            color="danger"
            as="p"
            role="alert"
            title={refusal.raw}
            data-related-merge-refused={refusal.code}
          >
            {t(`${R}.refused`, { reason: t(`${R}.refusals.${refusal.key}`, refusal.values) })}
          </Typography>
        )}
      </Stack>
    </section>
  );
}
