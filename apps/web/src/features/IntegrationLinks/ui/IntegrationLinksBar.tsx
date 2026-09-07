import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { IntegrationLinkRows, useIntegrationLinks } from '@entities/Integration';
import { pickLink } from '../model/linkDraft';
import { IntegrationLinkModal } from './IntegrationLinkModal';
import type { IntegrationLinksBarProps } from './IntegrationLinksBar.types';

/**
 * Строка «к чему это привязано» плюс кнопка правки.
 *
 * Показывает привязку проекта И привязку открытой группы: у группы своя, и
 * знать, что дефекты этой вкладки уедут в другой эпик, надо ДО запуска
 * прогона, а не после.
 *
 * Ничего не грузит, пока путь проекта неизвестен: раздел тестов открывается
 * раньше, чем в нём выбран проект.
 */
export function IntegrationLinksBar({
  projectPath,
  scopes = [],
  activeScope = '',
}: IntegrationLinksBarProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);
  const links = useIntegrationLinks(projectPath);

  const projectLink = pickLink(links.data, '');
  const groupLink = activeScope ? pickLink(links.data, activeScope) : undefined;
  const groupTitle = scopes.find((item) => item.id === activeScope)?.title ?? '';

  const allScopes = [{ id: '', title: t('integrations.links.scopeProject') }, ...scopes];

  return (
    <Stack gap="var(--spacing-3xs)">
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Typography variant="caption" color="subtle" as="span">
          {t('integrations.links.barTitle')}
        </Typography>
        <IntegrationLinkRows link={projectLink} withEmpty />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Icon name="link" size={18} />}
          onClick={() => setOpen(true)}
          disabled={!projectPath}
        >
          {t('integrations.links.attach')}
        </Button>
      </Stack>

      {groupLink && (
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Typography variant="caption" color="subtle" as="span">
            {t('integrations.links.barGroup', { title: groupTitle })}
          </Typography>
          <IntegrationLinkRows link={groupLink} />
        </Stack>
      )}

      <IntegrationLinkModal
        isOpen={isOpen}
        onOpenChange={setOpen}
        projectPath={projectPath}
        scopes={allScopes}
        initialScope={activeScope}
      />
    </Stack>
  );
}
