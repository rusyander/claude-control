import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, FieldTable, Callout, OptionCards } from '../ui';
import { SearchGuideSections } from './SearchGuideSections';
import { SearchLimitsSections } from './SearchLimitsSections';

/**
 * Документ раздела «Поиск» — глобальный поиск по разделам конфигурации.
 *
 * Порядок тот же, что у соседей: зачем это вообще → схема охвата → путь в снимках
 * → чем раздел НЕ является → что читает и пишет → что умеет и чего нет → пределы
 * → по каким полям идёт перебор → тонкости.
 *
 * Таблица полей стоит после пределов сознательно: она отвечает на вопрос «почему
 * не нашлось», который возникает уже ПОСЛЕ пустой выдачи, а не до неё.
 */
export function SearchTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.search.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);

  return (
    <>
      {/* Страница длинная: первое, что ей нужно сказать, — из чего она состоит. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyOne'), text: tr('whyOneText') },
            { title: tr('whyCross'), text: tr('whyCrossText') },
            { title: tr('whySafe'), text: tr('whySafeText') },
          ]}
        />
      </HelpSection>

      <SearchGuideSections tr={tr} />

      <SearchLimitsSections tr={tr} common={common} />

      <HelpSection title={tr('fieldsTitle')} caption={tr('fieldsCaption')}>
        <FieldTable
          nameHeader={common('fieldName')}
          descriptionHeader={tr('fieldsMatchColumn')}
          rows={[
            { name: tr('fieldRules'), description: tr('fieldRulesText'), isMono: false },
            { name: tr('fieldSkills'), description: tr('fieldSkillsText'), isMono: false },
            { name: tr('fieldHooks'), description: tr('fieldHooksText'), isMono: false },
            { name: tr('fieldScripts'), description: tr('fieldScriptsText'), isMono: false },
            {
              name: tr('fieldPermissions'),
              description: tr('fieldPermissionsText'),
              isMono: false,
            },
            {
              name: tr('fieldEnv'),
              description: tr('fieldEnvText'),
              isMono: false,
              badge: '!',
              badgeTone: 'danger',
            },
            { name: tr('fieldMcp'), description: tr('fieldMcpText'), isMono: false },
            { name: tr('fieldPlugins'), description: tr('fieldPluginsText'), isMono: false },
            { name: tr('fieldGroups'), description: tr('fieldGroupsText'), isMono: false },
            { name: tr('fieldTests'), description: tr('fieldTestsText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={common('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="danger" title={tr('noteSecretTitle')}>
            {tr('noteSecretText')}
          </Callout>
          <Callout tone="info" title={tr('noteSubstringTitle')}>
            {tr('noteSubstringText')}
          </Callout>
          <Callout tone="info" title={tr('noteSnippetTitle')}>
            {tr('noteSnippetText')}
          </Callout>
          <Callout tone="info" title={tr('noteChatTitle')}>
            {tr('noteChatText')}
          </Callout>
          <Callout tone="info" title={tr('notePauseTitle')}>
            {tr('notePauseText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
