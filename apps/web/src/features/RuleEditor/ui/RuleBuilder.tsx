import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { RuleSection, SectionKind } from '../model/ruleSections';
import type { RuleBuilderProps } from './RuleBuilder.types';
import { SECTION_ICON } from './RuleBuilder.constants';
import styles from './RuleBuilder.module.scss';

/**
 * Конструктор составного правила.
 *
 * Правило нередко устроено как набор условий «что можно, что нельзя, что —
 * с осторожностью». Собирать это руками в markdown утомительно и легко
 * забыть пункт, поэтому здесь правило складывается из блоков: у каждого блока
 * свой смысл и список пунктов, а на выходе получается аккуратный текст.
 */
export function RuleBuilder({ sections, onChange }: RuleBuilderProps) {
  const { t } = useTranslation();

  const patch = (index: number, next: Partial<RuleSection>): void => {
    onChange(sections.map((section, i) => (i === index ? { ...section, ...next } : section)));
  };

  const addSection = (kind: SectionKind): void => {
    onChange([...sections, { kind, title: '', items: [''] }]);
  };

  const removeSection = (index: number): void => {
    onChange(sections.filter((_, i) => i !== index));
  };

  return (
    <Stack gap="var(--spacing-sm)">
      {sections.map((section, index) => (
        <div key={index} className={`${styles.section} ${styles[section.kind]}`}>
          <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)">
            <Stack direction="row" align="center" gap="var(--spacing-2xs)">
              <Icon name={SECTION_ICON[section.kind]} size={20} />
              {section.kind === 'custom' ? (
                <input
                  className={styles.sectionTitle}
                  value={section.title ?? ''}
                  placeholder={t('rules.sectionTitlePlaceholder')}
                  onChange={(event) => patch(index, { title: event.target.value })}
                />
              ) : (
                <Typography variant="body-sm" weight="medium" as="span">
                  {t(`rules.section_${section.kind}`)}
                </Typography>
              )}
            </Stack>

            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Icon name="trash" size={16} />}
              aria-label={t('common.delete')}
              onClick={() => removeSection(index)}
            />
          </Stack>

          <Stack gap="var(--spacing-3xs)">
            {section.items.map((item, itemIndex) => (
              <Stack key={itemIndex} direction="row" align="center" gap="var(--spacing-2xs)">
                <span className={styles.bullet}>—</span>
                <input
                  className={styles.itemInput}
                  value={item}
                  placeholder={t('rules.itemPlaceholder')}
                  onChange={(event) => {
                    const items = section.items.map((it, i) =>
                      i === itemIndex ? event.target.value : it,
                    );
                    patch(index, { items });
                  }}
                  onKeyDown={(event) => {
                    // Enter добавляет следующий пункт — вводить список подряд удобнее.
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      patch(index, { items: [...section.items, ''] });
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="close" size={14} />}
                  aria-label={t('common.delete')}
                  onClick={() =>
                    patch(index, { items: section.items.filter((_, i) => i !== itemIndex) })
                  }
                />
              </Stack>
            ))}

            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Icon name="plus" size={14} />}
              onClick={() => patch(index, { items: [...section.items, ''] })}
            >
              {t('rules.addItem')}
            </Button>
          </Stack>
        </div>
      ))}

      <Stack direction="row" gap="var(--spacing-2xs)" wrap>
        <Typography variant="caption" color="subtle" as="span">
          {t('rules.addSection')}
        </Typography>
        {(['allow', 'deny', 'caution', 'custom'] as SectionKind[]).map((kind) => (
          <Button
            key={kind}
            size="sm"
            variant="secondary"
            leftIcon={<Icon name={SECTION_ICON[kind]} size={14} />}
            onClick={() => addSection(kind)}
          >
            {t(`rules.section_${kind}`)}
          </Button>
        ))}
      </Stack>
    </Stack>
  );
}
