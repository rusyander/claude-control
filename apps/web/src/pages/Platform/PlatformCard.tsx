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
import { toast } from '@shared/lib/toast';
import {
  CapabilityMatrix,
  platformBudgetOf,
  platformCardState,
  platformSpendOf,
  toolRouteOf,
  useActivatePlatform,
  useCheckPlatform,
  useClearExhausted,
  useDeactivatePlatform,
  useDeletePlatform,
  useDisablePlatform,
  usePlatformApplyPlan,
} from '@entities/Platform';
import { AppliedTargets } from './AppliedTargets';
import { ApplyJournal } from './ApplyJournal';
import { GatewayDownLine } from './GatewayDownLine';
import { SmokeLine } from './SmokeLine';
import { SmokeToolsLine } from './SmokeToolsLine';
import { formatAgo } from './lib/formatAgo';
import styles from './PlatformPage.module.scss';
import { serverFieldText } from '@shared/config/i18n';

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
  // Активность приезжает в самой карточке, а не считается на странице: карточку
  // читают по одной, и второй источник этого признака разошёлся бы с первым.
  const isActive = status.active;
  const state = platformCardState(status);
  const check = useCheckPlatform();
  const disable = useDisablePlatform();
  const remove = useDeletePlatform();
  const clearExhausted = useClearExhausted();
  const activate = useActivatePlatform();
  const deactivate = useDeactivatePlatform();
  const plan = usePlatformApplyPlan(platform.id);

  /**
   * Активация удалась — а пробный запрос мог и не пройти: это одно состояние,
   * а не два. Поэтому исход всегда называется словами, и «контур активен, но
   * модель молчит» приезжает предупреждением, а не тихим зелёным.
   */
  const runActivate = (): void => {
    activate.mutate(platform.id, {
      onSuccess: (result) => {
        if (result.smoke.ok) toast.success(t('platform.activatedOk', { title: platform.title }));
        else
          toast.warning(
            t('platform.activatedSmokeFailed', {
              detail: serverFieldText(result.smoke, 'detail'),
            }),
          );
      },
      onError: () => toast.error(t('platform.activateFailed')),
    });
  };

  // Расход считает СЕРВЕР по постоянному учёту: счётчик живого шлюза обнуляется
  // вместе с процессом, и после перезапуска панели карточка сообщала бы
  // «потрачено $0» ключу, который уже упёрся в бюджет.
  const budget = platformBudgetOf(status);
  const periodSpend = platformSpendOf(status);
  const money = periodSpend.money;
  const health = status.health;
  const applied = plan.data?.targets.filter((target) => target.applied) ?? [];

  return (
    // Идентификатор контура на самой карточке: контуров на экране бывает
    // несколько, и живой прогон обязан отличать «этот погас» от «какой-то
    // погас» — по тексту всей страницы это неотличимо.
    <Card padding="md" data-platform-card={platform.id}>
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
              {/* «Активен» — про панель целиком, а не про эту карточку: через
                  этот контур идёт работа, и таких контуров не бывает двое. */}
              {isActive && <Badge tone="success">{t('platform.activeBadge')}</Badge>}
              <Badge tone="neutral">{t(`platform.driver.${platform.driver}`)}</Badge>
            </Stack>

            <TruncatedText text={platform.baseUrl} variant="caption" color="subtle" />

            <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
              <Typography variant="caption" color="muted">
                {status.hasToken
                  ? t('platform.tokenSaved', { masked: status.maskedToken })
                  : t('platform.tokenMissing')}
              </Typography>
              {/* Кто завёл пробу — часть факта, а не украшение (A-2): «проверен
                  минуту назад» без этого читается как «я нажимал», и строка,
                  появившаяся в журнале контура, остаётся без объяснения. */}
              {health && (
                <Typography variant="caption" color="muted">
                  {t(health.background ? 'platform.checkedAtBackground' : 'platform.checkedAt', {
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
            {/* Две кнопки на одно решение: сделать активным или вернуться к
                провайдеру по умолчанию. Без ключа активировать нечего — проба и
                пробный запрос упёрлись бы в него на первой же секунде, поэтому
                кнопка гаснет и называет причину, а не отвечает отказом. */}
            {isActive ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => deactivate.mutate(platform.id)}
                isLoading={deactivate.isPending}
              >
                {t('platform.deactivate')}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={runActivate}
                isLoading={activate.isPending}
                disabled={!status.hasToken}
                {...(status.hasToken ? {} : { title: t('platform.activateNoToken') })}
              >
                {t('platform.activate')}
              </Button>
            )}
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
            <Typography variant="body-sm">{serverFieldText(health, 'detail')}</Typography>
            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Typography variant="caption" color="muted">
                {t(`platform.fix.${health.outcome}`)}
              </Typography>
              {health.outcome === 'unauthorized' && <CompromiseMark id="key-cache-lag" />}
            </Stack>
          </Stack>
        )}

        {/* Итог пробного запроса живёт на сервере и переживает F5: «модель
            ответила» — свойство связки, а не события нажатия. Но только пока
            контур АКТИВЕН: у неактивного это итог прошлой активации, а сегодня
            шлюз отвечает на его адрес отказом «контур выключен в панели» — и
            зелёная строка под словом «не активен», и красная как будто про
            сейчас одинаково врут. Так же поступает телефон. */}
        {isActive && <GatewayDownLine />}
        {isActive && status.smoke && <SmokeLine smoke={status.smoke} />}
        {isActive && status.smoke?.tools && (
          <SmokeToolsLine platform={platform} tools={status.smoke.tools} />
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

          {/* Ответы, за которые контур не прислал счёта (MD-09): расход у них
              был — так приходит картинка, — но панель его не знает и выдумывать
              не станет. Молчаливый пропуск делал бы полосу выше по-настоящему
              лживой: занижена и ни одного признака этого на экране. */}
          {(periodSpend.unreportedAnswers ?? 0) > 0 && (
            <Typography variant="caption" color="subtle">
              {/* TODO код: строка ждёт ключа словаря (`platform.spendUnreported`). */}
              Ответов без счёта от контура: {periodSpend.unreportedAnswers} — оценка занижена.
            </Typography>
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

          {/* Отказ 402 — факт, и ЧЕЙ это лимит, сервер прочитал из тела по
              манифесту драйвера: бюджет ключа, названный лимит или ничего.
              Полоса — наша оценка, поэтому строка стоит рядом, а не красит её. */}
          {budget.exhausted && (
            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Typography variant="body-sm" color="warning">
                {t(exhaustedTextKey(budget), {
                  level: budget.exhaustedLevel,
                  when: budget.exhaustedAt
                    ? formatAgo(budget.exhaustedAt, i18n.language, t)
                    : t('platform.budgetExhaustedRecently'),
                })}
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

        {plan.data && (
          <AppliedTargets
            targets={plan.data.targets}
            model={plan.data.model}
            modelSource={plan.data.modelSource}
            toolRoute={toolRouteOf({ toolRoute: plan.data.toolRoute, platform })}
          />
        )}

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
  'no-key': 'warning',
} as const;

/** Строка отказа 402 по тому, что назвал манифест драйвера. */
function exhaustedTextKey(budget: PlatformStatus['budget']) {
  if (budget.exhaustedScope === 'key') return 'platform.budgetExhaustedKey';
  return budget.exhaustedLevel ? 'platform.budgetExhaustedLevel' : 'platform.budgetExhausted';
}
