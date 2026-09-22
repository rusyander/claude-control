import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SubscriptionDrift,
  SubscriptionDriftPlan,
  SubscriptionDriftResolution,
} from '@agentdeck/contracts/portable-subscribe';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import {
  RESOLUTION_ORDER,
  driftStateLabelKey,
  kindLabelKey,
  resolutionLabelKey,
  resolutionTextKey,
  useApplyDrift,
  usePlanDrift,
  type PortabilityLevel,
} from '@entities/Portability';
import { PlanFiles } from './PlanFiles';
import styles from './PortabilityPage.module.scss';

interface DriftCardProps {
  target: string;
  level: PortabilityLevel;
  drift: SubscriptionDrift;
  /**
   * Исход сделан — план пересборки наверху устарел.
   *
   * Карточка не пересчитывает его сама: «пересобрать» без показанного плана не
   * существует, и подсунуть человеку свежий план вместо разобранного им
   * значило бы показать решение, которого он не принимал. Наверху план
   * снимается, и кнопка возвращается к «показать».
   */
  onResolved: () => void;
}

/**
 * Один файл цели, тронутый рукой человека, и три исхода для него (П5.2).
 *
 * ТРИ ПРАВИЛА, ради которых карточка устроена именно так:
 *
 *  1. **Четвёртого исхода — «перезаписать молча» — нет.** Ровно его отсутствие и
 *     есть предмет П5.2: пересборка этот файл не трогает, пока человек не
 *     выберет, что с его правкой делать.
 *  2. **Исход не делается без показанного плана.** У `canon` и `projection` он
 *     тот же настоящий дифф, что у переноса; у `unsubscribe` плана нет, и это не
 *     упущение — он не трогает у цели ни одного байта, показывать в нём нечего,
 *     кроме слоёв, которых человек лишается.
 *  3. **У исчезнувшего файла «взять в канон» не предлагается вовсе.** Сервер на
 *     него отвечает отказом, но узнавать о порядке из отказа человек не должен:
 *     брать в канон пустоту значило бы стереть записи, которых он не трогал.
 */
export function DriftCard({ target, level, drift, onResolved }: DriftCardProps) {
  const { t } = useTranslation();
  const planning = usePlanDrift();
  const applying = useApplyDrift();

  /**
   * Показанный план и исход, которым он посчитан, — ОДНИМ значением.
   *
   * Двумя они разъезжаются молча: человек нажимает «взять в канон», смотрит
   * дифф, передумывает, выбирает «вернуть проекцию» — и применяет отпечаток
   * первого плана под подписью второго.
   */
  const [shown, setShown] = useState<SubscriptionDriftPlan | null>(null);

  // Исчезнувший файл нечего брать в канон — и кнопки такой нет, а не «она не
  // работает»: отказом объясняют ошибку, а не порядок действий.
  const offered = RESOLUTION_ORDER.filter(
    (resolution) => !(drift.state === 'missing' && resolution === 'canon'),
  );

  const showPlan = (resolution: SubscriptionDriftResolution) => {
    planning.mutate(
      { target, ...level, filePath: drift.filePath, resolution },
      {
        onSuccess: (answer) => setShown(answer.plan),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  const apply = () => {
    if (!shown) return;
    applying.mutate(
      {
        target,
        ...level,
        filePath: drift.filePath,
        resolution: shown.resolution,
        ...(shown.transfer ? { fingerprint: shown.transfer.fingerprint } : {}),
      },
      {
        onSuccess: (answer) => {
          setShown(null);
          onResolved();
          toast.success(
            answer.resolution === 'unsubscribe'
              ? t('portability.subscription.unsubscribedToast', {
                  count: answer.unsubscribed.length,
                })
              : t('portability.subscription.resolvedToast', {
                  file: answer.filePath,
                }),
          );
        },
        onError: (error) => {
          setShown(null);
          toast.error(toErrorMessage(error));
        },
      },
    );
  };

  return (
    <Stack gap="var(--spacing-xs)" className={styles.driftCard}>
      <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
        <Badge tone={drift.state === 'missing' ? 'danger' : 'warning'}>
          {t(driftStateLabelKey(drift.state))}
        </Badge>
        <Typography variant="caption" className={styles.source}>
          {drift.filePath}
        </Typography>
      </Stack>

      {/* Что именно удерживается этим файлом: записи и слои. Без них строка
          сообщала бы о правке, не называя её цены. */}
      <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
        <Badge tone="neutral">
          {t('portability.subscription.heldItems', { count: drift.itemIds.length })}
        </Badge>
        {drift.layers.map((layer) => (
          <Badge key={layer} tone="neutral">
            {t(kindLabelKey(layer), layer)}
          </Badge>
        ))}
      </Stack>

      {!shown && (
        <Stack gap="var(--spacing-2xs)">
          {offered.map((resolution) => (
            <Stack key={resolution} gap="var(--spacing-3xs)">
              <Typography variant="body-sm" color="subtle">
                {t(resolutionTextKey(resolution))}
              </Typography>
              <Stack direction="row" gap="var(--spacing-xs)">
                {/* Крутится ТА кнопка, которую нажали: общий `isPending` на трёх
                    кнопках сразу показывал человеку, что панель считает все три
                    исхода, — и какой из них он выбрал, экран забывал. */}
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={planning.isPending && planning.variables?.resolution === resolution}
                  disabled={planning.isPending && planning.variables?.resolution !== resolution}
                  onClick={() => showPlan(resolution)}
                >
                  {t(resolutionLabelKey(resolution))}
                </Button>
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}

      {shown && (
        <Stack gap="var(--spacing-xs)">
          <Typography variant="body-sm">
            {t('portability.subscription.chosen', {
              resolution: t(resolutionLabelKey(shown.resolution)),
            })}
          </Typography>

          {shown.transfer && <PlanFiles plan={shown.transfer} />}

          {/* У отписки плана нет: она не трогает у цели ни байта. Вместо диффа
              названы слои, которых человек лишается, — цена решения. */}
          {shown.resolution === 'unsubscribe' && (
            <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
              <Typography variant="body-sm" color="warning">
                {t('portability.subscription.willUnsubscribe')}
              </Typography>
              {shown.layers.map((layer) => (
                <Badge key={layer} tone="warning">
                  {t(kindLabelKey(layer), layer)}
                </Badge>
              ))}
            </Stack>
          )}

          <Stack direction="row" gap="var(--spacing-xs)">
            <Button
              variant={shown.resolution === 'unsubscribe' ? 'danger' : 'primary'}
              size="sm"
              isLoading={applying.isPending}
              onClick={apply}
            >
              {t('portability.subscription.doResolve')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShown(null)}>
              {t('common.cancel')}
            </Button>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
