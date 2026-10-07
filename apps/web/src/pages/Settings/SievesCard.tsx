import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BUILTIN_SIEVES,
  LEARNED_SIEVES_MAX,
  SIEVE_CLASSES,
  type LearnedSieve,
  type SieveTally,
} from '@agentdeck/contracts/sieves';
import { useAcceptLearnedSieve, useDeleteLearnedSieve, useSieves } from '@entities/ProjectGit';
import { toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './SievesCard.module.scss';

/** Сколько последних месяцев счёта показывать: дольше — уже не про нынешние сита. */
const TALLY_MONTHS = 6;

/** Строки счёта: месяц × класс, только классы, где что-то было. */
function tallyRows(tally: SieveTally) {
  return Object.keys(tally)
    .sort()
    .reverse()
    .slice(0, TALLY_MONTHS)
    .flatMap((month) =>
      SIEVE_CLASSES.flatMap((cls) => {
        const cell = tally[month]?.[cls];
        return cell ? [{ month, cls, ...cell }] : [];
      }),
    );
}

/**
 * Сита перед MR (решение владельца 28.09): что группа сдаёт до MR, что панель
 * выучила по тредам ревьюеров и окупается ли это — счёт блокеров «ушло в MR»
 * против «поймано до MR». Убрать можно только выученное сито: встроенные —
 * каталог, по которому судит доставка.
 */
export function SievesCard() {
  const { t } = useTranslation();
  const query = useSieves();
  const remove = useDeleteLearnedSieve();
  const accept = useAcceptLearnedSieve();
  const busy = remove.isPending || accept.isPending;

  const acceptAs = (sieve: LearnedSieve, scope: 'project' | 'global') =>
    accept.mutate(
      { id: sieve.id, scope },
      {
        onSuccess: () => toast.success(t('settings.sieves.accepted')),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );

  /** Кнопки сита: предложенное — принять (для проекта или всех), принятое проектное — сделать общим. */
  const actions = (sieve: LearnedSieve) => {
    const proposed = sieve.status !== 'active';
    const canWiden = sieve.scope === 'project';
    return (
      <div className={styles.actions}>
        {proposed && (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => acceptAs(sieve, 'project')}
          >
            {t('settings.sieves.acceptProject')}
          </Button>
        )}
        {canWiden && (proposed || sieve.suggestedScope === 'global') && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => acceptAs(sieve, 'global')}
          >
            {t(proposed ? 'settings.sieves.acceptGlobal' : 'settings.sieves.makeGlobal')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          aria-label={`${t('settings.sieves.remove')}: ${sieve.trigger}`}
          onClick={() => setPending(sieve)}
        >
          {t('settings.sieves.remove')}
        </Button>
      </div>
    );
  };
  const [pending, setPending] = useState<LearnedSieve>();

  const scope = (sieve: LearnedSieve): string =>
    sieve.scope === 'global'
      ? t('settings.sieves.scopeGlobal')
      : t('settings.sieves.scopeProject', { path: sieve.projectPath ?? '' });
  const rows = query.data ? tallyRows(query.data.tally) : [];

  const note = (text: string) => (
    <Typography variant="body-sm" color="subtle">
      {text}
    </Typography>
  );

  const learnedList = () => {
    if (!query.data) {
      return note(query.isError ? toErrorMessage(query.error) : t('settings.sieves.loading'));
    }
    if (query.data.learned.length === 0) return note(t('settings.sieves.learnedEmpty'));
    return (
      <ul className={styles.list}>
        {query.data.learned.map((sieve) => (
          <li key={sieve.id} className={styles.learned} data-learned-sieve={sieve.id}>
            <div className={styles.learnedBody}>
              <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                <Badge tone="accent">{t(`settings.sieves.class.${sieve.class}`)}</Badge>
                {sieve.status !== 'active' && (
                  <Badge tone="warning">{t('settings.sieves.proposed')}</Badge>
                )}
                <Typography variant="caption" color="subtle" as="span">
                  {scope(sieve)} · {t('settings.sieves.seen', { count: sieve.sources.length })}
                  {sieve.suggestedScope === 'global' && sieve.scope === 'project'
                    ? ` · ${t('settings.sieves.suggestedGlobal')}`
                    : ''}
                </Typography>
              </Stack>
              <Typography variant="body-sm" className={styles.modelText} lang="en">
                <b>{t('settings.sieves.when')}:</b> {sieve.trigger}
              </Typography>
              <Typography variant="body-sm" className={styles.modelText} lang="en">
                <b>{t('settings.sieves.check')}:</b> {sieve.check}
              </Typography>
            </div>
            {actions(sieve)}
          </li>
        ))}
      </ul>
    );
  };

  const tallyTable = () => {
    if (!query.data) return null;
    if (rows.length === 0) return note(t('settings.sieves.tallyEmpty'));
    return (
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('settings.sieves.month')}</th>
              <th scope="col">{t('settings.sieves.classColumn')}</th>
              <th scope="col">{t('settings.sieves.escaped')}</th>
              <th scope="col">{t('settings.sieves.caught')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.month}-${row.cls}`}>
                <th scope="row">{row.month}</th>
                <td>{t(`settings.sieves.class.${row.cls}`)}</td>
                <td>{row.escaped}</td>
                <td>{row.caught}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium">
            {t('settings.sieves.title')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('settings.sieves.hint')}
          </Typography>
        </Stack>

        <Stack gap="var(--spacing-xs)">
          <Typography variant="body-sm" weight="medium">
            {t('settings.sieves.builtinTitle')}
          </Typography>
          <ul className={styles.list}>
            {BUILTIN_SIEVES.map((sieve) => (
              <li key={sieve.id} className={styles.item}>
                <Badge tone="neutral">{t(`settings.sieves.class.${sieve.class}`)}</Badge>
                <Typography variant="body-sm" as="span">
                  {t(`settings.sieves.builtin.${sieve.id}`)}
                </Typography>
                {sieve.mechanical && (
                  <Typography variant="caption" color="subtle" as="span">
                    {t('settings.sieves.byPanel')}
                  </Typography>
                )}
              </li>
            ))}
          </ul>
        </Stack>

        <Stack gap="var(--spacing-xs)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium">
              {t('settings.sieves.learnedTitle')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('settings.sieves.learnedHint')}
            </Typography>
          </Stack>
          {/* Принятое не вытесняется (Ф4): полное хранилище отказывает новым ситам вслух. */}
          {query.data?.refused && (
            <Typography variant="body-sm" color="danger" role="alert" data-sieves-refused>
              {t('settings.sieves.refused', {
                count: query.data.refused.count,
                max: LEARNED_SIEVES_MAX,
                at: new Date(query.data.refused.at).toLocaleString(),
              })}
            </Typography>
          )}
          {learnedList()}
        </Stack>

        <Stack gap="var(--spacing-xs)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium">
              {t('settings.sieves.tallyTitle')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('settings.sieves.tallyHint')}
            </Typography>
          </Stack>
          {tallyTable()}
        </Stack>
      </Stack>

      <ConfirmDialog
        isOpen={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(undefined)}
        title={t('settings.sieves.removeTitle')}
        description={t('settings.sieves.removeText')}
        confirmLabel={t('settings.sieves.remove')}
        isPending={remove.isPending}
        onConfirm={() => {
          if (pending) {
            remove.mutate(pending.id, {
              onSuccess: () => toast.success(t('settings.sieves.removed')),
              onError: (error) => toast.error(toErrorMessage(error)),
            });
          }
          setPending(undefined);
        }}
      />
    </Card>
  );
}
