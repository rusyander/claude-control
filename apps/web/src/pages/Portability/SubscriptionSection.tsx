import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvItemKind } from '@agentdeck/contracts/portable-env';
import type { SubscriptionSyncPlan } from '@agentdeck/contracts/portable-subscribe';
import { PANEL_CANON_PROVIDER } from '@agentdeck/contracts/portable-subscribe';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { toErrorMessage } from '@shared/api/client';
import { formatDateTime } from '@shared/lib/format';
import { toast } from '@shared/lib/toast';
import {
  KIND_ORDER,
  ROW_STATE_ORDER,
  ROW_STATE_TONE,
  findSubscription,
  hasLayers,
  holdLabelKey,
  rebuildLabelKey,
  isLayerOn,
  kindLabelKey,
  rowStateLabelKey,
  summarizeRows,
  toggleLayer,
  useApplySubscription,
  useForgetSubscription,
  usePlanSubscription,
  useSaveSubscription,
  useSubscriptions,
  type PortabilityLevel,
} from '@entities/Portability';
import { DriftCard } from './DriftCard';
import { PlanFiles } from './PlanFiles';
import styles from './PortabilityPage.module.scss';

interface SubscriptionSectionProps {
  target: string;
  targetName: string;
  level: PortabilityLevel;
  /** Провайдер, выбранный источником на экране, — нужен ОДНОЙ строке. */
  source: string;
}

/**
 * Подписка цели на канон панели и разбор расхождений (П5.1, П5.2).
 *
 * ЧЕТЫРЕ ПРАВИЛА, ради которых раздел устроен именно так:
 *
 *  1. **Источник здесь не выбирается и выбран быть не может.** Канон подписки —
 *     собственная среда панели, и он назван вслух: раздел стоит на странице, где
 *     источник выбирают, и промолчи он — человек прочитал бы пересборку как
 *     «переносим из того, что выбрано наверху».
 *  2. **Кнопки «пересобрать» без показанного плана не существует.** То же
 *     правило, что у разового переноса, и по той же причине: сервер и так
 *     ответит 409 без отпечатка, но узнавать о порядке из отказа человек не
 *     должен.
 *  3. **Удержание — это ответ с причиной, а не пустая пересборка.** Проекция,
 *     собранная другой версией канона, не пересобирается молча, и строка о
 *     причине стоит на месте кнопки, а не в тосте, который исчезнет.
 *  4. **Совпавшие строки скрыты, но сосчитаны.** Список из двухсот «не
 *     изменилась» нечитаем, а список без них человек прочитал бы как «в каноне
 *     только это». Метка называет число, кнопка раскрывает.
 */
export function SubscriptionSection({
  target,
  targetName,
  level,
  source,
}: SubscriptionSectionProps) {
  const { t, i18n } = useTranslation();

  const subscriptions = useSubscriptions();
  const saving = useSaveSubscription();
  const forgetting = useForgetSubscription();
  const planning = usePlanSubscription();
  const applying = useApplySubscription();

  const subscription = findSubscription(
    subscriptions.data?.items ?? [],
    target,
    level.scope,
    level.project ?? '',
  );

  const [plan, setPlan] = useState<SubscriptionSyncPlan | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);

  // Смена цели или уровня обнуляет показанный план: он посчитан для другой
  // подписки, и «пересобрать» по нему записало бы не туда, куда смотрит человек.
  const shownKey = `${target}:${level.scope}@${level.project ?? ''}`;
  const [shownFor, setShownFor] = useState(shownKey);
  if (shownFor !== shownKey) {
    setShownFor(shownKey);
    setPlan(null);
    setShowUnchanged(false);
  }

  const summary = useMemo(() => (plan ? summarizeRows(plan.rows) : null), [plan]);

  const visibleRows = useMemo(() => {
    if (!plan) return [];
    const ordered = [...plan.rows].sort(
      (left, right) => ROW_STATE_ORDER.indexOf(left.state) - ROW_STATE_ORDER.indexOf(right.state),
    );
    return showUnchanged ? ordered : ordered.filter((row) => row.state !== 'unchanged');
  }, [plan, showUnchanged]);

  const setLayer = (layer: EnvItemKind) => {
    const next = toggleLayer(subscription?.layers ?? [], layer, KIND_ORDER);
    saving.mutate(
      { target, ...level, layers: next },
      {
        // План посчитан по ПРЕЖНЕМУ набору слоёв: оставить его на экране значило
        // бы показать пересборку, которой уже не будет.
        onSuccess: () => setPlan(null),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  const showPlan = () => {
    planning.mutate(
      { target, ...level },
      {
        onSuccess: (answer) => setPlan(answer.plan),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  const apply = () => {
    if (!plan) return;
    applying.mutate(
      { target, ...level, fingerprint: plan.transfer?.fingerprint ?? '' },
      {
        onSuccess: (answer) => {
          setPlan(null);
          toast.success(
            t('portability.subscription.syncedToast', {
              count: answer.rows.filter((row) => row.state !== 'unchanged').length,
            }),
          );
        },
        onError: (error) => {
          setPlan(null);
          toast.error(toErrorMessage(error));
        },
      },
    );
  };

  const forget = () => {
    forgetting.mutate(
      { target, ...level },
      {
        onSuccess: () => {
          setPlan(null);
          toast.success(t('portability.subscription.forgotToast'));
        },
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  // Список подписок не дочитан — тумблеры слоёв нельзя показывать погашенными:
  // «ни один слой не подписан» человек прочитает как ответ, щёлкнет тумблер и
  // запишет набор слоёв поверх настоящего. Поэтому незавершённое чтение названо
  // своими словами, ровно как у паспорта на этой же странице.
  if (subscriptions.isLoading || subscriptions.isError) {
    return (
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="heading-sm">
            {t('portability.subscription.title', { target: targetName })}
          </Typography>
          {subscriptions.isError ? (
            <LoadErrorCard
              title={t('portability.subscription.loadError')}
              text={t('portability.subscription.loadErrorText')}
              onRetry={() => {
                void subscriptions.refetch();
              }}
            />
          ) : (
            <SkeletonList rows={3} />
          )}
        </Stack>
      </Card>
    );
  }

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm">
          {t('portability.subscription.title', { target: targetName })}
        </Typography>

        <Typography variant="body-sm" color="subtle">
          {t('portability.subscription.intro')}
        </Typography>

        {/* Источник наверху страницы выбран не тот, что служит каноном: сказать
            это надо прямо, иначе человек прочитает пересборку как перенос из
            выбранного им CLI. */}
        {source !== PANEL_CANON_PROVIDER && (
          <Typography variant="body-sm" color="warning">
            {t('portability.subscription.canonNotSource')}
          </Typography>
        )}

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm">{t('portability.subscription.layers')}</Typography>
          <div className={styles.layers}>
            {KIND_ORDER.map((layer) => (
              <label key={layer} className={styles.layer}>
                <Toggle
                  checked={isLayerOn(subscription, layer)}
                  onCheckedChange={() => setLayer(layer)}
                  disabled={saving.isPending}
                  size="sm"
                  aria-label={t(kindLabelKey(layer), layer)}
                />
                <span>{t(kindLabelKey(layer), layer)}</span>
              </label>
            ))}
          </div>
        </Stack>

        {/* След подписки: когда собиралась и куда. Человек, вернувшийся к
            экрану, первым делом спрашивает именно это. */}
        {subscription?.syncedAt && (
          <Typography variant="body-sm">
            {t('portability.subscription.synced', {
              date: formatDateTime(subscription.syncedAt, i18n.language),
            })}
          </Typography>
        )}
        {subscription?.root && (
          <Typography variant="caption" color="muted" className={styles.source}>
            {subscription.root}
          </Typography>
        )}

        {/* Ни одного слоя — пересобирать нечего, и это не ошибка: подписка,
            снятая со всех слоёв, законное состояние, а память о спроецированном
            в ней остаётся. */}
        {!hasLayers(subscription) ? (
          <Typography variant="body-sm" color="subtle">
            {t('portability.subscription.noLayers')}
          </Typography>
        ) : (
          !plan && (
            <Stack direction="row" gap="var(--spacing-xs)">
              <Button variant="primary" isLoading={planning.isPending} onClick={showPlan}>
                {t('portability.subscription.plan')}
              </Button>
            </Stack>
          )
        )}

        {plan && summary && (
          <Stack gap="var(--spacing-sm)">
            <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
              {/* Ноль показывается наравне с числом: отсутствие метки человек
                  читает как «такого здесь не бывает». */}
              {ROW_STATE_ORDER.map((state) => (
                <Badge
                  key={state}
                  tone={summary.counts[state] === 0 ? 'neutral' : ROW_STATE_TONE[state]}
                >
                  {`${t(rowStateLabelKey(state))}: ${summary.counts[state]}`}
                </Badge>
              ))}
              {summary.held > 0 && (
                <Badge tone="warning">
                  {t('portability.subscription.heldCount', { count: summary.held })}
                </Badge>
              )}
            </Stack>

            {/* Пересборка целиком: строка «изменилось» у ВСЕЙ подписки без
                причины читалась бы как беда канона, а не как смена словаря. */}
            {plan.rebuild && (
              <Typography variant="body-sm" color="warning">
                {t(rebuildLabelKey(plan.rebuild))}
              </Typography>
            )}

            {/* Удержание — ответ «не буду и вот почему» на месте кнопки. */}
            {plan.hold ? (
              <Typography variant="body-sm" color="warning">
                {t(holdLabelKey(plan.hold))}
              </Typography>
            ) : (
              <Stack gap="var(--spacing-sm)">
                {plan.transfer ? (
                  <PlanFiles plan={plan.transfer} />
                ) : (
                  <Typography variant="body-sm" color="subtle">
                    {t('portability.subscription.nothingToWrite')}
                  </Typography>
                )}

                <Stack direction="row" gap="var(--spacing-xs)">
                  <Button
                    variant={plan.transfer ? 'primary' : 'secondary'}
                    isLoading={applying.isPending}
                    onClick={apply}
                  >
                    {t(
                      plan.transfer
                        ? 'portability.subscription.apply'
                        : 'portability.subscription.agree',
                    )}
                  </Button>
                  <Button variant="secondary" isLoading={planning.isPending} onClick={showPlan}>
                    {t('portability.subscription.replan')}
                  </Button>
                </Stack>
              </Stack>
            )}

            {/* Расхождения — ПОД планом: пересборка их не касается, и человек
                должен сперва увидеть, что поедет, а потом — что удержано. */}
            {plan.drift.length > 0 && (
              <Stack gap="var(--spacing-xs)">
                <Typography variant="body-sm" color="warning">
                  {t('portability.subscription.driftTitle', { count: plan.drift.length })}
                </Typography>
                <Typography variant="body-sm" color="subtle">
                  {t('portability.subscription.driftIntro')}
                </Typography>
                {plan.drift.map((drift) => (
                  <DriftCard
                    key={drift.filePath}
                    target={target}
                    level={level}
                    drift={drift}
                    onResolved={() => setPlan(null)}
                  />
                ))}
              </Stack>
            )}

            {/* Совпавшие строки скрыты, но сосчитаны: список без них читался бы
                как «в каноне только это». */}
            {summary.counts.unchanged > 0 && (
              <Stack direction="row" gap="var(--spacing-xs)">
                <Button variant="ghost" size="sm" onClick={() => setShowUnchanged(!showUnchanged)}>
                  {t(
                    showUnchanged
                      ? 'portability.subscription.hideUnchanged'
                      : 'portability.subscription.showUnchanged',
                    { count: summary.counts.unchanged },
                  )}
                </Button>
              </Stack>
            )}

            {visibleRows.length > 0 && (
              <Stack gap="var(--spacing-3xs)" className={styles.rows}>
                {visibleRows.map((row) => (
                  <div key={row.itemId} className={styles.fileRow}>
                    <Stack gap="var(--spacing-3xs)" className={styles.intent}>
                      <Typography variant="caption" className={styles.source}>
                        {row.itemId}
                      </Typography>
                      {/* Удержание названо файлом: «изменилась» и «изменилась,
                          но не поедет» — разные ответы. */}
                      {row.heldBy && (
                        <Typography variant="caption" color="warning">
                          {t('portability.subscription.heldBy', { file: row.heldBy })}
                        </Typography>
                      )}
                    </Stack>
                    <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
                      {row.kind && (
                        <Badge tone="neutral">{t(kindLabelKey(row.kind), row.kind)}</Badge>
                      )}
                      <Badge tone={ROW_STATE_TONE[row.state]}>
                        {t(rowStateLabelKey(row.state))}
                      </Badge>
                    </Stack>
                  </div>
                ))}
              </Stack>
            )}
          </Stack>
        )}

        {/* Забыть подписку — рядом, но последним и негромко: оно не удаляет у
            цели ни байта, зато стирает память о спроецированном, и следующая
            подписка объявит новым каждый уже написанный файл. */}
        {subscription && (
          <Stack direction="row" gap="var(--spacing-xs)">
            <Button variant="ghost" size="sm" isLoading={forgetting.isPending} onClick={forget}>
              {t('portability.subscription.forget')}
            </Button>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
