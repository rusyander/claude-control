import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, CapabilityGrid, FieldTable, Callout, OptionCards } from '../ui';

/**
 * Хвост документа «Плагины»: граница возможностей, числа, тонкости и отмена.
 *
 * Порядок здесь и есть смысл файла. Сначала что раздел умеет и чего не делает,
 * потом таблица границ — числа и условия, которые иначе пришлось бы вылавливать
 * из текста, — потом отказы по одному, и только в конце отмена. Человек
 * приходит сюда с вопросом «почему команда плагина не появилась» и уходит с
 * ответом «вот как вернуть как было»; переставленные местами, эти блоки
 * отвечают на второй вопрос раньше первого.
 */
export function PluginsLimitsSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.plugins.${key}`);

  return (
    <>
      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canCatalog'),
            tr('canInstall'),
            tr('canUpdate'),
            tr('canToggle'),
            tr('canUninstall'),
            tr('canMarketplaces'),
            tr('canSee'),
            tr('canView'),
            tr('canScaffold'),
          ]}
          cant={[
            tr('cantEdit'),
            tr('cantPick'),
            tr('cantOffline'),
            tr('cantNoCli'),
            tr('cantPublish'),
          ]}
        />
      </HelpSection>

      {/* Числа таблицей, а не россыпью по абзацам: за ними приходят повторно и
          ищут глазами, а не чтением. */}
      <HelpSection title={tr('limitsTitle')} caption={tr('limitsCaption')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: tr('limitCli'), description: tr('limitCliValue'), isMono: false },
            { name: tr('limitRegistry'), description: tr('limitRegistryValue'), isMono: false },
            { name: tr('limitSerial'), description: tr('limitSerialValue'), isMono: false },
            { name: tr('limitSlow'), description: tr('limitSlowValue'), isMono: false },
            { name: tr('limitWrite'), description: tr('limitWriteValue'), isMono: false },
            { name: tr('limitApply'), description: tr('limitApplyValue'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="danger" title={tr('noteMarketplaceTitle')}>
            {tr('noteMarketplaceText')}
          </Callout>
          <Callout tone="warning" title={tr('noteCliTitle')}>
            {tr('noteCliText')}
          </Callout>
          <Callout tone="warning" title={tr('noteMissingTitle')}>
            {tr('noteMissingText')}
          </Callout>
          <Callout tone="info" title={tr('noteSlowTitle')}>
            {tr('noteSlowText')}
          </Callout>
          <Callout tone="info" title={tr('noteContentTitle')}>
            {tr('noteContentText')}
          </Callout>
          <Callout tone="info" title={tr('noteManualTitle')}>
            {tr('noteManualText')}
          </Callout>
          {/* Плагины OpenCode и Kimi — принципиально другая модель; говорим об
              этом здесь, чтобы страница не выглядела описанием «плагинов
              вообще». */}
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>

      {/* Отмена — последним блоком и одним списком: человек ищет её после того,
          как что-то уже сделал, и листать за ней весь путь заново не станет. */}
      <HelpSection title={tr('undoTitle')} caption={tr('undoCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('undoToggle'), text: tr('undoToggleText') },
            { title: tr('undoUninstall'), text: tr('undoUninstallText') },
            { title: tr('undoMarketplace'), text: tr('undoMarketplaceText') },
            { title: tr('undoScaffold'), text: tr('undoScaffoldText') },
          ]}
        />
      </HelpSection>
    </>
  );
}
