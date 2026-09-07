import { useTranslation } from 'react-i18next';
import type { ProjectTestLink } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import type { TestCaseLinksProps } from './TestCaseParams.types';
import styles from './ProjectTests.module.scss';

/**
 * Внешние ссылки кейса: требование, задача, MR, документ.
 *
 * Тип ссылки — не украшение: по нему отчёт отличает «кейс закрывает требование»
 * от «кейс завёл дефект», и трассировка требований строится именно на этом
 * поле, а не на угадывании по адресу.
 */
export function TestCaseLinks({ links, onChange }: TestCaseLinksProps) {
  const { t } = useTranslation();

  const update = (index: number, part: Partial<ProjectTestLink>): void => {
    onChange(links.map((link, position) => (position === index ? { ...link, ...part } : link)));
  };

  return (
    <Stack gap="var(--spacing-2xs)">
      <Typography variant="body-sm" weight="medium">
        {t('tests.editor.links')}
      </Typography>

      {links.map((link, index) => (
        <div key={index} className={styles.linkRow}>
          <SelectField
            label={t('tests.editor.linkType')}
            value={link.type}
            onChange={(value) => update(index, { type: value as ProjectTestLink['type'] })}
            options={LINK_TYPES.map((type) => ({
              value: type,
              label: t(`tests.editor.linkTypes.${type}`),
            }))}
          />
          <div className={styles.linkUrl}>
            <TextField
              label={t('tests.editor.linkUrl')}
              value={link.url}
              onChange={(value) => update(index, { url: value })}
              isMono
            />
          </div>
          <div className={styles.linkTitle}>
            <TextField
              label={t('tests.editor.linkTitle')}
              value={link.title ?? ''}
              onChange={(value) => update(index, { title: value })}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="trash" size={16} />}
            aria-label={t('tests.editor.linkRemove')}
            onClick={() => onChange(links.filter((_, position) => position !== index))}
          />
        </div>
      ))}

      <Stack direction="row">
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="plus" size={16} />}
          onClick={() => onChange([...links, { type: 'issue', url: '' }])}
        >
          {t('tests.editor.linkAdd')}
        </Button>
      </Stack>
    </Stack>
  );
}

const LINK_TYPES: readonly ProjectTestLink['type'][] = ['requirement', 'issue', 'mr', 'doc'];
