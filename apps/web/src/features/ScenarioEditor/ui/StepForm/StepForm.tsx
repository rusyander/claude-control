import { useTranslation } from 'react-i18next';
import {
  LAYER_HOOKS,
  LAYER_SKILLS,
  MID_CHECKS,
  MODEL_TIERS,
  OVER_BUDGET,
  STEP_KINDS,
  type StepDef,
  type StepKind,
} from '@agentdeck/contracts/core/scenario';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { intOf, linesOf, listOf } from '../../model/fields';
import { withKind } from '../../model/scenarioDraft';
import { DraftField } from '../DraftField/DraftField';
import { GateFields } from '../GateFields/GateFields';
import type { StepFormProps } from './StepForm.types';
import styles from './StepForm.module.scss';

const ROUND_CAPS = Array.from({ length: 11 }, (_, n) => String(n));
type KnowledgeList = 'skills' | 'rules' | 'hooks' | 'scripts';
const KNOWLEDGE: readonly KnowledgeList[] = ['skills', 'rules', 'hooks', 'scripts'];

/**
 * Форма одного шага: каждое поле схемы `StepDef` названо. Значения не проверяются здесь —
 * черновик целиком судит та же схема контрактов, что у ядра, и список «Пока не сохранить»
 * называет поле. Поля вида (`ask`, `publish`) появляются только у своего вида.
 */
export function StepForm({ step, number, onChange }: StepFormProps) {
  const { t } = useTranslation();
  const set = (patch: Partial<StepDef>): void => onChange({ ...step, ...patch });
  const options = <T extends string>(values: readonly T[], prefix: string) =>
    values.map((value) => ({ value, label: t(`${prefix}.${value}`) }));

  return (
    <Stack gap="var(--spacing-sm)" data-step-form={step.id}>
      <Typography variant="heading-sm" as="h3">
        {t('coreScenario.step.heading', { number })}
      </Typography>
      <div className={styles.grid}>
        <TextField
          label={t('coreScenario.step.title')}
          value={step.title}
          onChange={(title) => set({ title })}
        />
        <TextField
          label={t('coreScenario.step.id')}
          value={step.id}
          isMono
          onChange={(id) => set({ id })}
        />
        <SelectField
          label={t('coreScenario.step.kind')}
          value={step.kind}
          options={options(STEP_KINDS, 'coreScenario.kind')}
          onChange={(kind) => onChange(withKind(step, kind as StepKind))}
        />
        <SelectField
          label={t('coreScenario.step.tier')}
          value={step.model.tier}
          options={options(MODEL_TIERS, 'coreScenario.tier')}
          onChange={(tier) =>
            set({ model: { ...step.model, tier: tier as StepDef['model']['tier'] } })
          }
        />
        <DraftField
          label={t('coreScenario.step.effort')}
          hint={t('coreScenario.step.effortHint')}
          value={step.model.effort ?? ''}
          isMono
          onCommit={(text) => {
            const { effort: _drop, ...model } = step.model;
            set({ model: text.trim() ? { ...model, effort: text.trim() } : model });
          }}
        />
        <SelectField
          label={t('coreScenario.step.roundCap')}
          value={String(step.roundCap)}
          options={ROUND_CAPS.map((value) => ({ value, label: value }))}
          onChange={(value) => set({ roundCap: Number(value) })}
        />
      </div>

      <DraftField
        label={t('coreScenario.step.text')}
        hint={t('coreScenario.step.textHint')}
        value={step.knowledge.text ?? ''}
        multiline
        rows={4}
        onCommit={(text) => {
          const { text: _drop, ...knowledge } = step.knowledge;
          set({ knowledge: text.trim() ? { ...knowledge, text } : knowledge });
        }}
      />

      <div className={styles.grid}>
        {KNOWLEDGE.map((key) => (
          <DraftField
            key={key}
            label={t(`coreScenario.step.${key}`)}
            hint={t('coreScenario.step.listHint')}
            value={step.knowledge[key].join(', ')}
            isMono
            onCommit={(text) => set({ knowledge: { ...step.knowledge, [key]: listOf(text) } })}
          />
        ))}
        <SelectField
          label={t('coreScenario.step.mid')}
          value={step.checks.mid}
          options={options(MID_CHECKS, 'coreScenario.mid')}
          onChange={(mid) =>
            set({ checks: { ...step.checks, mid: mid as StepDef['checks']['mid'] } })
          }
        />
        <DraftField
          label={t('coreScenario.step.required')}
          hint={t('coreScenario.step.listHint')}
          value={step.checks.required.join(', ')}
          isMono
          onCommit={(text) => set({ checks: { ...step.checks, required: listOf(text) } })}
        />
        <DraftField
          label={t('coreScenario.step.tokens')}
          hint={t('coreScenario.step.budgetHint')}
          value={step.budget.tokens === undefined ? '' : String(step.budget.tokens)}
          onCommit={(text) => {
            const { tokens: _drop, ...budget } = step.budget;
            const tokens = intOf(text);
            set({ budget: tokens === undefined ? budget : { ...budget, tokens } });
          }}
        />
        <DraftField
          label={t('coreScenario.step.minutes')}
          hint={t('coreScenario.step.budgetHint')}
          value={step.budget.minutes === undefined ? '' : String(step.budget.minutes)}
          onCommit={(text) => {
            const { minutes: _drop, ...budget } = step.budget;
            const minutes = intOf(text);
            set({ budget: minutes === undefined ? budget : { ...budget, minutes } });
          }}
        />
        <SelectField
          label={t('coreScenario.step.overBudget')}
          value={step.overBudget}
          options={options(OVER_BUDGET, 'coreScenario.overBudget')}
          onChange={(value) => set({ overBudget: value as StepDef['overBudget'] })}
        />
        <SelectField
          label={t('coreScenario.step.userHooks')}
          value={step.userLayer.hooks}
          options={options(LAYER_HOOKS, 'coreScenario.layer')}
          onChange={(hooks) =>
            set({ userLayer: { ...step.userLayer, hooks: hooks as StepDef['userLayer']['hooks'] } })
          }
        />
        <SelectField
          label={t('coreScenario.step.userSkills')}
          value={step.userLayer.skills}
          options={options(LAYER_SKILLS, 'coreScenario.layer')}
          onChange={(skills) =>
            set({
              userLayer: { ...step.userLayer, skills: skills as StepDef['userLayer']['skills'] },
            })
          }
        />
      </div>

      <GateFields gates={step.gate} onChange={(gate) => set({ gate })} />

      {step.ask && (
        <Stack gap="var(--spacing-xs)">
          <TextField
            label={t('coreScenario.step.question')}
            value={step.ask.question}
            onChange={(question) => step.ask && set({ ask: { ...step.ask, question } })}
          />
          <DraftField
            label={t('coreScenario.step.options')}
            hint={t('coreScenario.step.optionsHint')}
            value={step.ask.options.join('\n')}
            multiline
            rows={3}
            onCommit={(text) => step.ask && set({ ask: { ...step.ask, options: linesOf(text) } })}
          />
          <TextField
            label={t('coreScenario.step.recommendation')}
            value={step.ask.recommendation}
            onChange={(recommendation) => step.ask && set({ ask: { ...step.ask, recommendation } })}
          />
        </Stack>
      )}

      {step.kind === 'publish' && (
        <Stack direction="row" align="center" gap="var(--spacing-xs)">
          <Toggle
            checked={step.publish?.draft === true}
            aria-label={t('coreScenario.step.draft')}
            onCheckedChange={(draft) => set({ publish: { draft } })}
          />
          <Typography variant="body-sm" as="span">
            {t('coreScenario.step.draft')}
          </Typography>
        </Stack>
      )}
    </Stack>
  );
}
