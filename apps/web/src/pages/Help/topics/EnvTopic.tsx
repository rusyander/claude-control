import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, FieldTable, Callout, OptionCards } from '../ui';
import { EnvGuideSections } from './EnvGuideSections';
import { EnvLimitsSections } from './EnvLimitsSections';

/**
 * Документ раздела «Переменные».
 *
 * Порядок тот же, что у соседей по пачке «Доступы»: зачем это вообще → как
 * устроено (схема трёх файлов) → два пути в снимках → чем раздел НЕ является →
 * что пишет на диске → пределы и отказы → справочные таблицы → тонкости.
 *
 * Рукодельной цепочки «имя → похоже на секрет? → файл» здесь больше нет: она
 * утверждала, что файл угадывается по имени, а в форме ОДНОЙ переменной его
 * выбирает человек. Сгенерированная схема показывает три файла с их читателями
 * — то, из-за чего значение «не доходит».
 */
export function EnvTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.env.${key}`);
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
            { title: tr('whySeparate'), text: tr('whySeparateText') },
            { title: tr('whyMasked'), text: tr('whyMaskedText') },
            { title: tr('whyBulk'), text: tr('whyBulkText') },
          ]}
        />
      </HelpSection>

      <EnvGuideSections tr={tr} />

      <EnvLimitsSections tr={tr} common={common} />

      <HelpSection title={tr('placesTitle')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('placeSettings'), text: tr('placeSettingsText') },
            { title: tr('placeLocal'), text: tr('placeLocalText') },
            { title: tr('placeSecrets'), text: tr('placeSecretsText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          caption={tr('fieldsCaption')}
          nameHeader={common('fieldName')}
          descriptionHeader={common('fieldPurpose')}
          rows={[
            {
              name: 'key',
              description: tr('fieldKey'),
              badge: common('required'),
              badgeTone: 'accent',
            },
            {
              name: 'value',
              description: tr('fieldValue'),
              badge: common('required'),
              badgeTone: 'accent',
            },
            { name: 'source', description: tr('fieldSource') },
            { name: 'isSecret', description: tr('fieldIsSecret') },
            { name: 'comment', description: tr('fieldComment') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteRewriteTitle')}>
            {tr('noteRewriteText')}
          </Callout>
          <Callout tone="warning" title={tr('noteDetectTitle')}>
            {tr('noteDetectText')}
          </Callout>
          <Callout tone="danger" title={tr('noteReaderTitle')}>
            {tr('noteReaderText')}
          </Callout>
          <Callout tone="info" title={tr('noteLocalTitle')}>
            {tr('noteLocalText')}
          </Callout>
          <Callout tone="info" title={tr('noteGroupTitle')}>
            {tr('noteGroupText')}
          </Callout>
          <Callout tone="info" title={tr('noteRevealTitle')}>
            {tr('noteRevealText')}
          </Callout>
          <Callout tone="success" title={tr('noteCommentsTitle')}>
            {tr('noteCommentsText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
