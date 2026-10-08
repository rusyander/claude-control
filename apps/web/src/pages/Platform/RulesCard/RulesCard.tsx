import { useTranslation } from 'react-i18next';
import type { Platform } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useSavePlatform } from '@entities/Platform';
import styles from './RulesCard.module.scss';
import { RulesChoice } from '../RulesChoice/RulesChoice';
import { OursRulesColumn } from './OursRulesColumn/OursRulesColumn';
import { PlatformRulesColumn } from './PlatformRulesColumn/PlatformRulesColumn';
import { RuleConflicts } from './RuleConflicts/RuleConflicts';
import { useRuleDrafts } from './useRuleDrafts';
import type { RulesCardProps } from './RulesCard.types';
import { rulesAppliesOf } from '../lib/rulesAppliesOf';
import { sideOff } from '../lib/sideOff';
import { toolExclusionLocks } from '../lib/toolExclusionLocks';

/**
 * Правила контура и матрица конфликтов (Т7).
 *
 * Сборка карточки: две колонки по тому, ЧЬЁ правило (`PlatformRulesColumn`,
 * `OursRulesColumn`), под ними отказ сохранения и матрица (`RuleConflicts`).
 * Здесь живёт то, что связывает части: сохранение, черновики полей и взаимное
 * исключение набора инструментов контура с прослойкой.
 */
export function RulesCard(props: RulesCardProps) {
  const { platform, rules = [], conflicts = [], layers, dataMask } = props;
  const { t } = useTranslation();
  const save = useSavePlatform();
  const drafts = useRuleDrafts(platform);
  const update = (next: Platform): void => {
    save.mutate({ platform: next });
  };

  /**
   * Две стороны взаимного исключения, и каждая запирает ТОЛЬКО добавление своей.
   *
   * Набор контура непуст — прослойку не включить, пока он не убран; прослойка
   * включена — набор контура не ДОБАВИТЬ, но уже записанный (его приносит
   * разворот чужого архива) правится и убирается: запертое наглухо поле было бы
   * тупиком, из которого человек выходит только удалением контура (ревью Т7).
   */
  const { toolsLocked, shimLocked } = toolExclusionLocks(platform);

  /** Какую колонку снял выбор «чьи правила действуют» (баг 11б). */
  const applies = rulesAppliesOf(platform);
  const off = sideOff(applies);

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium" as="h2">
            {t('platform.rulesTitle', { title: platform.title })}
          </Typography>
          <Typography variant="body-sm" color="subtle" className="prose">
            {t('platform.rulesText')}
          </Typography>
        </Stack>

        {/* Выбор стоит НАД колонками: он решает, какая из них вообще уходит в
            прогон, и читать колонки до него — читать не то, что случится. */}
        <RulesChoice platform={platform} withTitle />

        {/* Две колонки, подписанные по тому, ЧЬЁ правило: владелец раздела не
            находил, где выбираются правила, потому что правила платформы и наши
            слои шли одним списком без подписи стороны. Слева — что делает и
            принимает контур, справа — что панель везёт в прогон от себя. */}
        <div className={styles.rulesColumns}>
          <PlatformRulesColumn
            platform={platform}
            rules={rules}
            drafts={drafts}
            toolsLocked={toolsLocked}
            update={update}
            conflicts={conflicts}
            offBy={off.contour ? applies : undefined}
          />
          <OursRulesColumn
            platform={platform}
            layers={layers}
            dataMask={dataMask}
            shimLocked={shimLocked}
            update={update}
            rules={rules}
            conflicts={conflicts}
            offBy={off.ours ? applies : undefined}
          />
        </div>

        {/* Отказ сервера читается вслух: сохранение, ушедшее в никуда, человек
            замечает по вернувшемуся старому значению и винит панель. */}
        {save.isError && (
          <Typography variant="body-sm" color="danger" role="alert">
            {save.error instanceof Error ? save.error.message : t('platform.rulesSaveFailed')}
          </Typography>
        )}

        <RuleConflicts
          platform={platform}
          conflicts={conflicts}
          update={update}
          clearToolsDraft={() => drafts.setTools('')}
        />
      </Stack>
    </Card>
  );
}
