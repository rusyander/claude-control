import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { useCreateParam } from '@shared/hooks/use-create-param';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SearchField } from '@shared/ui/search-field';
import { formatSize, formatDateTime } from '@shared/lib/format';
import { ScriptFormModal } from '@features/ScriptEditor';
import { DeleteButton } from '@features/EntityDelete';
import { SandboxButton } from '@features/SandboxRunner';
import { ResourceFileTree } from '@features/ResourceFiles';
import { useScripts, useDeleteScript, type ScriptFile } from '@entities/Script';
import { useIsCapabilityReady } from '@entities/Provider';
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import { usePageTab } from '@shared/hooks/use-page-tab';
import { SCRIPTS_TABS, SCRIPTS_TAB_ICONS, scriptsInTab } from './model/tabs';
import styles from './ScriptsPage.module.scss';

/**
 * Скрипты из каталога hooks/. Хуки на странице «Хуки» задают, когда скрипт
 * запускается; здесь правится сам код — включая файлы, которые пока ни к
 * какому событию не привязаны.
 *
 * Раздел работает при любом провайдере (COMMON-1): это файлы самой панели, а не
 * чужой конфиг. Claude-специфичны здесь ровно две вещи — песочница и отметка
 * «вызывается хуком»; они гейтятся по возможностям `sandbox` и `hooks`, поэтому
 * у Claude страница выглядит и работает ровно как раньше.
 */
export function ScriptsPage() {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState<ScriptFile | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Раскрытый скрипт показывает своё содержимое тем же деревом, что и скилл.
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  const { data: scripts = [], isLoading } = useScripts();
  const removeScript = useDeleteScript();

  const hasHooks = useIsCapabilityReady('hooks');
  const hasSandbox = useIsCapabilityReady('sandbox');

  const { active: chosenTab, select: selectTab } = usePageTab('scripts', SCRIPTS_TABS);
  // Без хуков отбору не по чему делить: «используется» берётся из привязки к
  // хуку. Тогда вкладок нет вовсе, а адрес с ?tab= показывает весь список.
  const hasTabs = hasHooks && scripts.length > 0;
  const activeTab = hasTabs ? chosenTab : 'all';

  const openForm = (script?: ScriptFile): void => {
    setEditing(script);
    setIsFormOpen(true);
    writeUrl(script?.id);
  };

  // Ссылка /scripts?id=<имя файла> открывает этот скрипт в редакторе.
  const writeUrl = useEntityUrlWriter();
  useEntityUrl<ScriptFile>({ items: scripts, getId: (script) => script.id, onOpen: openForm });
  // Быстрое действие «Добавить» с обзора: /scripts?create=1 открывает форму создания.
  useCreateParam(() => openForm());

  const closeForm = (open: boolean): void => {
    setIsFormOpen(open);
    if (!open) writeUrl(undefined);
  };

  // Сводка та же, что на обзоре: сколько файлов и сколько из них ни к чему не
  // привязано. Тесты и фикстуры в «не привязано» не входят — их и не привязывают.
  const unusedCount = scripts.filter((script) => !script.isUsed && !script.isTest).length;
  const summary = ((): string => {
    if (!hasHooks) return t('scripts.summaryNoHooks', { count: scripts.length });
    if (unusedCount === 0) return t('scripts.summaryAllUsed', { count: scripts.length });
    return t('scripts.summary', { count: scripts.length, unused: unusedCount });
  })();

  // Поиск идёт внутри открытой вкладки: «Не привязаны» + имя — это вопрос
  // «забыт ли вот этот файл», и ответ не должен тонуть в привязанных.
  const inTab = scriptsInTab(scripts, activeTab);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? inTab.filter(
        (script) =>
          script.name.toLowerCase().includes(needle) ||
          (script.description ?? '').toLowerCase().includes(needle),
      )
    : inTab;

  // «Используется» — про привязку к хуку; тест помечен отдельно, чтобы не
  // читаться забытым файлом; без хуков отметке неоткуда взяться.
  const badgeFor = (
    script: ScriptFile,
  ): { tone: 'success' | 'neutral' | 'info'; label: string } => {
    if (script.isUsed) return { tone: 'success', label: t('scripts.used') };
    if (script.isTest) return { tone: 'info', label: t('scripts.test') };
    return { tone: 'neutral', label: t('scripts.unused') };
  };

  const tabs = SCRIPTS_TABS.map((id) => ({
    id,
    label: t(`pageTabs.scripts.tab.${id}`),
    icon: SCRIPTS_TAB_ICONS[id],
    count: scriptsInTab(scripts, id).length,
  }));

  // Поиск, список и пустые состояния одни и те же с вкладками и без них.
  const listBody = (
    <>
      {!isLoading && scripts.length > 0 && (
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <div className={styles.search}>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder={t('scripts.searchPlaceholder')}
              label={t('scripts.search')}
            />
          </div>
          <Typography variant="body-sm" color="subtle" as="span">
            {summary}
          </Typography>
        </Stack>
      )}

      {visible.length > 0 && (
        <Card padding="none">
          <Stack>
            {visible.map((script) => {
              const badge = badgeFor(script);
              const isExpanded = expanded === script.id;
              return (
                <Stack
                  key={script.id}
                  data-agent-anchor={script.id}
                  direction="row"
                  align="center"
                  justify="between"
                  gap="var(--spacing-sm)"
                  className={styles.row}
                >
                  <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
                    <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                      <button
                        type="button"
                        className={styles.nameToggle}
                        aria-expanded={isExpanded}
                        onClick={() => setExpanded(isExpanded ? undefined : script.id)}
                      >
                        <Icon
                          name="chevronRight"
                          size={16}
                          className={isExpanded ? styles.chevronOpen : undefined}
                        />
                        <Typography variant="mono" weight="medium" as="span">
                          {script.name}
                        </Typography>
                      </button>
                      {hasHooks && <Badge tone={badge.tone}>{badge.label}</Badge>}
                    </Stack>

                    {script.description && (
                      <Typography
                        variant="caption"
                        color="subtle"
                        clamp={1}
                        className={styles.description}
                      >
                        {script.description}
                      </Typography>
                    )}

                    <Typography variant="caption" color="subtle" as="span">
                      {formatSize(script.sizeBytes)} ·{' '}
                      {formatDateTime(script.modifiedAt, i18n.language)}
                    </Typography>

                    {isExpanded && <ResourceFileTree kind="script" id={script.name} />}
                  </Stack>

                  <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                    {/* Песочница поднимает изолированный Claude Code — у других
                        провайдеров такой возможности нет, кнопку не показываем. */}
                    {hasSandbox && (
                      <SandboxButton
                        kind="script"
                        title={script.name}
                        scriptName={script.name}
                        selection={{ scriptNames: [script.name] }}
                      />
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Icon name="edit" size={24} />}
                      aria-label={`${t('common.edit')}: ${script.name}`}
                      onClick={() => openForm(script)}
                    />
                    <DeleteButton
                      entityName={script.name}
                      description={
                        script.isUsed ? t('scripts.deleteUsedWarning') : t('scripts.deleteScript')
                      }
                      onDelete={() => removeScript.mutate(script.id)}
                      isPending={removeScript.isPending}
                    />
                  </Stack>
                </Stack>
              );
            })}
          </Stack>
        </Card>
      )}

      {activeTab !== 'all' && scripts.length > 0 && inTab.length === 0 && (
        <Typography color="subtle">{t(`pageTabs.scripts.empty.${activeTab}`)}</Typography>
      )}

      {!isLoading && scripts.length === 0 && (
        <Typography color="subtle">{t('common.empty')}</Typography>
      )}

      {inTab.length > 0 && visible.length === 0 && (
        <Typography color="subtle">{t('scripts.noMatches', { query: query.trim() })}</Typography>
      )}
    </>
  );

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('scripts.title')}
        subtitle={hasHooks ? t('scripts.subtitle') : t('scripts.subtitleNoHooks')}
        helpTopic="scripts"
        actions={
          <Button
            variant="primary"
            leftIcon={<Icon name="plus" size={24} />}
            onClick={() => openForm()}
          >
            {t('scripts.addScript')}
          </Button>
        }
      />

      <ExplainBox
        title={t('scripts.explainTitle')}
        text={hasHooks ? t('scripts.explain') : t('scripts.explainNoHooks')}
      />

      {isLoading && <SkeletonList rows={5} />}

      {hasTabs && (
        <PageTabs
          page="scripts"
          label={t('pageTabs.scripts.tabsLabel')}
          tabs={tabs}
          active={activeTab}
          onSelect={selectTab}
        />
      )}

      {hasTabs ? (
        <PageTabPanel page="scripts" tab={activeTab} hint={t(`pageTabs.scripts.hint.${activeTab}`)}>
          {listBody}
        </PageTabPanel>
      ) : (
        listBody
      )}

      <ScriptFormModal isOpen={isFormOpen} onOpenChange={closeForm} script={editing} />
    </Stack>
  );
}
