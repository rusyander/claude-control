import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PLATFORM_ASSISTANT_TARGET, PLATFORM_TERMINAL_CONSUMER } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { StatusDot } from '@shared/ui/status-dot';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { sortApplyTargets, toolRouteMark, toolRouteOf, validatePlatform } from '@entities/Platform';
import { appliedFileTargets, budgetFromText, consumerFileWins } from '../model/wizard-logic';
import type { WizardStepProps } from './PlatformWizard.types';
import { ConsumerRow, TargetRow } from './ConsumerRows';

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
  // Подпись у CLI — по решению шлюза из плана (DRV-13): совместимому шлюзу
  // инструменты уходят полем, и «работает как чат» там было бы неправдой.
  const toolMark = toolRouteMark(
    toolRouteOf({ toolRoute: plan?.toolRoute, platform: model.draft }),
  );

  // Бюджет держим СТРОКОЙ, пока человек его набирает: почему именно так —
  // в `budgetFromText`.
  const [budgetText, setBudgetText] = useState(
    model.draft.budgetUsd ? String(model.draft.budgetUsd) : '',
  );
  const budget = budgetFromText(budgetText);

  const terminalOn = model.draft.consumers.includes(PLATFORM_TERMINAL_CONSUMER);

  // Снятая галочка «Терминал» прячет список файловых целей — и этим создаёт
  // впечатление, что файлов больше нет. Они остались: снятый потребитель не
  // трогает уже записанное (это делает «Снять применение» на карточке). Пока
  // хоть одна файловая цель применена, об этом сказано прямо здесь.
  const appliedFiles = appliedFileTargets(plan?.targets ?? []);
  const filesStayApplied = !terminalOn && appliedFiles.size > 0;

  return (
    <Stack gap="var(--spacing-md)">
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium" as="h3">
          {t('platform.consumersTitle')}
        </Typography>
        <Typography variant="caption" color="muted">
          {t('platform.consumersHint')}
        </Typography>

        {model.plan.isLoading && <SkeletonList rows={3} withActions={false} />}

        {plan?.consumers.map((consumer) => (
          <ConsumerRow
            key={consumer.id}
            consumer={consumer}
            // Отмечено берётся из ЧЕРНОВИКА, а не из плана: план построен по
            // сохранённому контуру, и галочка, поставленная минуту назад,
            // отскакивала бы обратно при каждом обновлении плана.
            checked={model.draft.consumers.includes(consumer.id)}
            toolMark={toolMark}
            fileWins={consumerFileWins(consumer, model.draft.consumers, appliedFiles)}
            onToggle={() => model.toggleConsumer(consumer.id)}
          />
        ))}

        {filesStayApplied && (
          <Typography variant="caption" color="warning">
            {t('platform.consumersFilesStay')}
          </Typography>
        )}
      </Stack>

      {/* Список файловых целей — только когда человек попросил терминал: до Т3
          он был единственным смыслом этого шага, теперь это один потребитель из
          списка, и показывать его записи, пока галочка снята, значило бы звать
          нажать то, что всё равно не запишется. */}
      {terminalOn && (
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium" as="h3">
            {t('platform.targetsTitle')}
          </Typography>

          {plan &&
            sortApplyTargets(plan.targets)
              // Ассистент панели — потребитель, а не файловая цель: его галочка
              // стоит выше, в списке «Где работает контур».
              .filter((target) => target.targetId !== PLATFORM_ASSISTANT_TARGET)
              .map((target) => (
                <TargetRow
                  key={target.targetId}
                  target={target}
                  checked={model.targets.includes(target.targetId)}
                  overwrite={model.overwrite.includes(target.targetId)}
                  toolMark={toolMark}
                  onToggle={() => model.toggleTarget(target.targetId)}
                  onToggleOverwrite={() => model.toggleOverwrite(target.targetId)}
                />
              ))}
        </Stack>
      )}

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
