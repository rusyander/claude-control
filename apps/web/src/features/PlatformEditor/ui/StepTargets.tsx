import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PLATFORM_ASSISTANT_TARGET, type PlatformApplyTarget } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { StatusDot } from '@shared/ui/status-dot';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { TruncatedText } from '@shared/ui/truncated-text';
import { sortApplyTargets, validatePlatform } from '@entities/Platform';
import { budgetFromText } from '../model/wizard-logic';
import type { WizardStepProps } from './PlatformWizard.types';
import styles from './PlatformWizard.module.scss';

/**
 * Шаг 4 — куда применить. Ассистент панели предвыбран: это единственный
 * сценарий, работающий полностью, — у CLI через контур нет своих инструментов,
 * и галка у него ставится только руками, сразу с предупреждением.
 *
 * Режим «обязательно» показывает цену ДО включения: выключенная панель — это
 * закрытый порт, и направленный на него CLI останется без модели. Скрыть это и
 * дать человеку узнать самому на утренней летучке было бы худшим из решений.
 */
export function StepTargets({ model }: WizardStepProps) {
  const { t } = useTranslation();
  const plan = model.plan.data;
  const gatewayRunning = model.gateway?.status.running ?? false;

  // Бюджет держим СТРОКОЙ, пока человек его набирает: почему именно так —
  // в `budgetFromText`.
  const [budgetText, setBudgetText] = useState(
    model.draft.budgetUsd ? String(model.draft.budgetUsd) : '',
  );
  const budget = budgetFromText(budgetText);

  return (
    <Stack gap="var(--spacing-md)">
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium" as="h3">
          {t('platform.targetsTitle')}
        </Typography>

        {model.plan.isLoading && <SkeletonList rows={3} withActions={false} />}

        {plan &&
          sortApplyTargets(plan.targets).map((target) => (
            <TargetRow
              key={target.targetId}
              target={target}
              checked={model.targets.includes(target.targetId)}
              overwrite={model.overwrite.includes(target.targetId)}
              onToggle={() => model.toggleTarget(target.targetId)}
              onToggleOverwrite={() => model.toggleOverwrite(target.targetId)}
            />
          ))}
      </Stack>

      <Card padding="md">
        <Stack gap="var(--spacing-xs)">
          <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
            <StatusDot tone={gatewayRunning ? 'success' : 'warning'} />
            <Typography variant="body-sm" as="span">
              {gatewayRunning
                ? t('platform.gatewayUp', { address: model.gateway?.status.address ?? '' })
                : t('platform.gatewayDown')}
            </Typography>
            {/* Доставшийся порт отличается от задуманного — это надо СКАЗАТЬ:
                иначе человек, помнящий свои 5179 в настройках, читает в плане
                другой адрес и считает его ошибкой панели. */}
            {gatewayRunning &&
              model.gateway?.status.requestedPort !== undefined &&
              model.gateway.status.port !== model.gateway.status.requestedPort && (
                <Typography variant="body-sm" color="muted" as="span">
                  {t('platform.gatewayPortTaken', {
                    requested: model.gateway.status.requestedPort,
                  })}
                </Typography>
              )}
            {!gatewayRunning && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void model.startGateway()}
                disabled={model.isBusy}
              >
                {t('platform.gatewayStart')}
              </Button>
            )}
          </Stack>

          <SelectField
            label={t('platform.modeLabel')}
            value={model.draft.mode}
            onChange={(value) => model.patch({ mode: value as 'required' | 'best-effort' })}
            options={[
              { value: 'required', label: t('platform.mode.required') },
              { value: 'best-effort', label: t('platform.mode.best-effort') },
            ]}
            hint={t(`platform.modeHint.${model.draft.mode}`)}
          />

          {/* Цена режима «обязательно» — на экране, а не в справке: панель
              выключена ⇒ CLI, направленный на шлюз, получает отказ соединения. */}
          {model.draft.mode === 'required' && (
            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Typography variant="body-sm" color="warning">
                {t('platform.modeRequiredWarning')}
              </Typography>
              <CompromiseMark id="gateway-required" />
            </Stack>
          )}
        </Stack>
      </Card>

      <Stack gap="var(--spacing-2xs)">
        <TextField
          label={t('platform.budgetLabel')}
          value={budgetText}
          onChange={(value) => {
            setBudgetText(value);
            model.patch({ budgetUsd: budgetFromText(value).usd });
          }}
          placeholder="100"
          hint={t('platform.budgetHint')}
          error={budget.broken ? t('platform.error.budgetUsd_number') : undefined}
        />
        {/* День начала периода — тоже руками: когда контур обнуляет свой счёт,
            снаружи не видно никак, а придумать дату за человека значило бы
            молча выбрать, какой расход ему не показывать. */}
        <TextField
          label={t('platform.budgetSinceLabel')}
          value={model.draft.budgetSince}
          onChange={(value) => model.patch({ budgetSince: value.trim() })}
          placeholder="2026-09-01"
          isMono
          hint={t('platform.budgetSinceHint')}
          error={
            validatePlatform(model.draft).budgetSince
              ? t('platform.error.budgetSince_pattern')
              : undefined
          }
        />
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <Typography variant="caption" color="muted">
            {t('platform.budgetManual')}
          </Typography>
          <CompromiseMark id="budget-manual" />
        </Stack>
      </Stack>

      {model.applied && model.applied.skipped.length > 0 && (
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" color="warning">
            {t('platform.skippedTitle')}
          </Typography>
          {model.applied.skipped.map((item) => (
            <Typography key={item.targetId} variant="caption" color="muted">
              {item.targetId} — {t(`platform.skipReason.${item.reason}`)}
            </Typography>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

interface TargetRowProps {
  target: PlatformApplyTarget;
  checked: boolean;
  overwrite: boolean;
  onToggle: () => void;
  onToggleOverwrite: () => void;
}

/**
 * Строка цели. У неподдержанной — прочерк с ПРИЧИНОЙ и подписью: «нельзя» без
 * объяснения выглядит недоделкой, а причины здесь четыре и они разные (файла
 * переменных нет, переменная не задокументирована, диалект шлюзу не по зубам,
 * шлюз не поднят).
 */
function TargetRow({ target, checked, overwrite, onToggle, onToggleOverwrite }: TargetRowProps) {
  const { t } = useTranslation();
  const isAssistant = target.targetId === PLATFORM_ASSISTANT_TARGET;

  if (!target.supported) {
    return (
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap className={styles.row}>
        <Typography variant="body-sm" color="subtle" as="span">
          — {target.title}
        </Typography>
        <Typography variant="caption" color="muted" as="span">
          {t(`platform.targetReason.${target.reason ?? 'no_env_section'}`)}
        </Typography>
        <CompromiseMark id="cli-no-endpoint" />
      </Stack>
    );
  }

  return (
    <Stack gap="var(--spacing-3xs)" className={styles.row}>
      <label className={styles.check}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <Typography variant="body-sm" as="span">
          {target.title}
        </Typography>
        {isAssistant ? (
          <Typography variant="caption" color="muted" as="span">
            {t('platform.targetRecommended')}
          </Typography>
        ) : (
          <CompromiseMark id="no-client-tools" />
        )}
      </label>

      {target.filePath && <TruncatedText text={target.filePath} variant="caption" color="subtle" />}

      {checked &&
        target.plan.map((item) => (
          <Typography key={item.key} variant="caption" color="subtle" as="div">
            <code>{item.key}</code>
            {' = '}
            {item.value}
            {item.placeholder ? ` (${t('platform.planPlaceholder')})` : ''}
          </Typography>
        ))}

      {/* Занятое место не перебивается молча: пока человек не увидел, что там
          стоит, и не подтвердил — цель уйдёт в пропущенные с причиной. */}
      {checked && target.conflicts.length > 0 && (
        <Stack gap="var(--spacing-3xs)">
          {target.conflicts.map((conflict) => (
            <Typography key={conflict.key} variant="caption" color="warning" as="div">
              {t('platform.conflictLine', { key: conflict.key, current: conflict.current })}
            </Typography>
          ))}
          <label className={styles.check}>
            <input type="checkbox" checked={overwrite} onChange={onToggleOverwrite} />
            <Typography variant="caption" as="span">
              {t('platform.overwriteLabel')}
            </Typography>
          </label>
        </Stack>
      )}
    </Stack>
  );
}
