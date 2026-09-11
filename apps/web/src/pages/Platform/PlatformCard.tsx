import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformStatus } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { StatusDot } from '@shared/ui/status-dot';
import { TruncatedText } from '@shared/ui/truncated-text';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import {
  CapabilityMatrix,
  platformBudgetOf,
  platformCardState,
  platformSpendOf,
  useCheckPlatform,
  useClearExhausted,
  useDeletePlatform,
  useDisablePlatform,
  usePlatformApplyPlan,
} from '@entities/Platform';
import { AppliedTargets } from './AppliedTargets';
import { ApplyJournal } from './ApplyJournal';
import { formatAgo } from './lib/formatAgo';
import styles from './PlatformPage.module.scss';

interface PlatformCardProps {
  status: PlatformStatus;
  onEdit: () => void;
}

/**
 * Карточка контура: состояние, что панель нашла и к кому это применено.
 *
 * Состояний пять, а не два, и каждое чинится в своём месте: выключен, не
 * проверялся, отвечает, ключ отклонён, не отвечает. Показывать «ошибку» одним
 * словом на все случаи значит отправлять человека искать причину наугад — а
 * отклонённый ключ перевыпускают в админке, недоступный адрес чинят в сети, и
 * это разные люди в разные дни.
 */
export function PlatformCard({ status, onEdit }: PlatformCardProps) {
  const { t, i18n } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const platform = status.platform;
  const state = platformCardState(status);
  const check = useCheckPlatform();
  const disable = useDisablePlatform();
  const remove = useDeletePlatform();
  const clearExhausted = useClearExhausted();
  const plan = usePlatformApplyPlan(platform.id);

  // Расход считает СЕРВЕР по постоянному учёту: счётчик живого шлюза обнуляется
  // вместе с процессом, и после перезапуска панели карточка сообщала бы
  // «потрачено $0» ключу, который уже упёрся в бюджет.
  const budget = platformBudgetOf(status);
  const money = platformSpendOf(status).money;
  const health = status.health;
  const applied = plan.data?.targets.filter((target) => target.applied) ?? [];

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack direction="row" gap="var(--spacing-sm)" justify="between" align="start" wrap>
          <Stack gap="var(--spacing-3xs)" minWidth="14rem" flex={1}>
            <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
              <Typography variant="heading-sm" as="h2">
                {platform.title}
              </Typography>
              <StatusDot tone={TONE[state]} />
              <Typography variant="body-sm" color="muted" as="span">
                {t(`platform.state.${state}`)}
              </Typography>
              <Badge tone="neutral">{t(`platform.driver.${platform.driver}`)}</Badge>
            </Stack>

            <TruncatedText text={platform.baseUrl} variant="caption" color="subtle" />

            <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
              <Typography variant="caption" color="muted">
                {status.hasToken
                  ? t('platform.tokenSaved', { masked: status.maskedToken })
                  : t('platform.tokenMissing')}
              </Typography>
              {health && (
                <Typography variant="caption" color="muted">
                  {t('platform.checkedAt', {
                    when: formatAgo(health.checkedAt, i18n.language, t),
                  })}
                </Typography>
              )}
              {/* «Не отвечает сейчас» и «не отвечал никогда» — разные беды. */}
              {health && health.outcome !== 'ok' && health.lastOkAt && (
                <Typography variant="caption" color="muted">
                  {t('platform.lastOkAt', {
                    when: formatAgo(health.lastOkAt, i18n.language, t),
                  })}
                </Typography>
              )}
            </Stack>
          </Stack>

          <Stack direction="row" gap="var(--spacing-2xs)" wrap>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => check.mutate(platform.id)}
              isLoading={check.isPending}
            >
              {t('platform.check')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onEdit}>
              {t('platform.configure')}
            </Button>
            {applied.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => disable.mutate({ id: platform.id })}
                isLoading={disable.isPending}
              >
                {t('platform.disableAll')}
              </Button>
            )}
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
              {t('common.delete')}
            </Button>
          </Stack>
        </Stack>

        {/* Причина отказа — словами контура, не переводом: «ключ отклонён» и
            «реестр моделей ещё не поднялся» чинятся в разных местах. */}
        {health && health.outcome !== 'ok' && (
          <Stack gap="var(--spacing-3xs)" className={styles.problem}>
            <Typography variant="body-sm">{health.detail}</Typography>
            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Typography variant="caption" color="muted">
                {t(`platform.fix.${health.outcome}`)}
              </Typography>
              {health.outcome === 'unauthorized' && <CompromiseMark id="key-cache-lag" />}
            </Stack>
          </Stack>
        )}

        <Stack gap="var(--spacing-3xs)">
          {/* Величина ОДНА и она оценка: деньги по нашему прайсу. «Внутренней
              единицы контура» (токены × 0.00001 $) больше не существует — контур
              тарифицирует по ценам своего реестра, поэтому вторая цифра рядом
              была бы не второй величиной, а тем же числом под чужим именем.
              Отсюда обе подписи разом: бюджет введён руками, прайс наш. */}
          <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
            <Typography variant="body-sm" as="span">
              {budget.tracked
                ? t('platform.budgetLine', {
                    spent: budget.spentUsd.toFixed(2),
                    budget: budget.budgetUsd,
                  })
                : t('platform.spentLine', { spent: budget.spentUsd.toFixed(2) })}
            </Typography>
            <CompromiseMark id="budget-manual" />
            <CompromiseMark id="pricing-local" />
            {budget.overEstimate && !budget.exhausted && (
              <Typography variant="caption" color="warning">
                {t('platform.budgetOverEstimate')}
              </Typography>
            )}
            {/* Предупреждение на 85 % — СЛОВАМИ, а не только цветом полосы:
                шесть пикселей, сменившие оттенок, не видит ни человек, глядящий
                на другую страницу, ни скринридер. */}
            {budget.nearLimit && !budget.overEstimate && !budget.exhausted && (
              <Typography variant="caption" color="warning">
                {t('platform.budgetNearLimit', { percent: Math.round(budget.share * 100) })}
              </Typography>
            )}
          </Stack>

          {/* Период считается от дня, который назвал человек: когда контур
              обнуляет свой счёт, снаружи не видно никак. */}
          <Typography variant="caption" color="subtle">
            {platform.budgetSince
              ? t('platform.spendSince', { since: platform.budgetSince })
              : t('platform.spendSinceStart')}
          </Typography>

          {budget.tracked && (
            <div
              className={styles.bar}
              role="meter"
              aria-valuenow={Math.round(budget.share * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              // Своя подпись и своё значение словами: под подписью поля
              // «Бюджет ключа, $» скринридер объявлял бы проценты как доллары.
              aria-label={t('platform.budgetMeterLabel')}
              aria-valuetext={t('platform.budgetMeterValue', {
                spent: budget.spentUsd.toFixed(2),
                budget: budget.budgetUsd,
                percent: Math.round(budget.share * 100),
              })}
            >
              <span
                className={budget.nearLimit ? styles.barFillWarn : styles.barFill}
                style={{ width: `${budget.share * 100}%` }}
              />
            </div>
          )}

          {/* Токены моделей без цены в оценку НЕ входят — ровно как у контура,
              который модель без цены тоже не списывает. Такие модели названы
              поимённо: подставить им ставку «неизвестной» значило бы показать
              выдуманное число рядом с настоящим. */}
          {money.unpricedModels.length > 0 && (
            <Typography variant="caption" color="subtle">
              {t('platform.moneyUnpriced', { models: money.unpricedModels.join(', ') })}
            </Typography>
          )}

          {/* Отказ 402 — факт, но НЕ про бюджет ключа: контур отдаёт его с
              дневного лимита пользователя, месячного команды или месячного
              инстанса, и называет уровень в теле. Бюджет же самого ключа он
              отдаёт кодом 401, неотличимым от отозванного ключа, — поэтому эта
              строка стоит рядом с полосой, а не красит её. */}
          {budget.exhausted && (
            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Typography variant="body-sm" color="warning">
                {t(
                  budget.exhaustedLevel
                    ? 'platform.budgetExhaustedLevel'
                    : 'platform.budgetExhausted',
                  {
                    level: budget.exhaustedLevel,
                    when: budget.exhaustedAt
                      ? formatAgo(budget.exhaustedAt, i18n.language, t)
                      : t('platform.budgetExhaustedRecently'),
                  },
                )}
              </Typography>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => clearExhausted.mutate(platform.id)}
                isLoading={clearExhausted.isPending}
              >
                {t('platform.budgetExhaustedClear')}
              </Button>
            </Stack>
          )}
        </Stack>

        {health && health.capabilities.length > 0 ? (
          <CapabilityMatrix findings={health.capabilities} />
        ) : (
          <Typography variant="body-sm" color="muted">
            {t('platform.notCheckedText')}
          </Typography>
        )}

        {plan.data && <AppliedTargets targets={plan.data.targets} />}

        {plan.data && (
          <ApplyJournal
            targets={plan.data.targets}
            onRollback={(targetId) => disable.mutate({ id: platform.id, targets: [targetId] })}
            isPending={disable.isPending}
          />
        )}
      </Stack>

      <ConfirmDialog
        isOpen={confirmDelete}
        onOpenChange={setConfirmDelete}
        onConfirm={() => {
          remove.mutate(platform.id, { onSuccess: () => setConfirmDelete(false) });
        }}
        title={t('platform.deleteTitle')}
        description={t('platform.deleteText')}
        confirmationName={platform.title}
        confirmLabel={t('common.delete')}
        isPending={remove.isPending}
      />
    </Card>
  );
}

const TONE = {
  disabled: 'neutral',
  unchecked: 'neutral',
  ok: 'success',
  unauthorized: 'danger',
  unreachable: 'warning',
} as const;
