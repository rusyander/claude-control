import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { RULE_HEADING_EXAMPLE } from '@agentdeck/contracts/rule-format';
import { HELP_ROUTE } from '@shared/config/routes';
import { Stack } from '@shared/ui/stack';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { useCreateParam } from '@shared/hooks/use-create-param';
import { SkeletonList } from '@shared/ui/skeleton';
import { EmptyState } from '@shared/ui/empty-state';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SearchField } from '@shared/ui/search-field';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { RuleFormModal } from '@features/RuleEditor';
import { DeleteButton } from '@features/EntityDelete';
import { SandboxButton } from '@features/SandboxRunner';
import { ruleApi } from '@entities/Rule';
import { useClaudeMd } from '@entities/AppConfig';
import { useProviders, activeProvider } from '@entities/Provider';
import type { Rule } from '@agentdeck/contracts';
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import { usePageTab } from '@shared/hooks/use-page-tab';
import { resolveRulesEmptyState } from '../model/rulesEmptyState';
import { RULES_TAB_ICONS, rulesInTab } from '../model/tabs';
import styles from './RulesPage.module.scss';
import { EMPTY_IDS, CLAUDE_MD_ROUTE } from './RulesPage.constants';
import { RULES_TABS, type RulesTabId } from '../model/tabs.types';
import { rulesShownInTab } from '../model/rulesShownInTab';

/** Раздел личных правил из CLAUDE.md. */
export function RulesPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Rule | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const { data: rules = [], isLoading } = ruleApi.useList();
  const setEnabled = ruleApi.useSetEnabled();
  const deleteRule = ruleApi.useDelete();

  const { active: chosenTab, select: selectTab } = usePageTab('rules', RULES_TABS);
  // Без правил делить нечего: пустоту объясняют заглушки ниже, а полоса из трёх
  // нулей только отвлекала бы от них. Адрес с ?tab= тогда показывает весь список.
  const hasTabs = rules.length > 0;
  const activeTab = hasTabs ? chosenTab : 'all';
  // Переключённые на открытой вкладке: помнятся вместе с вкладкой, и уход с неё
  // их сбрасывает — вернувшись, человек видит честный отбор. Сброс — во время
  // отрисовки (сравнение с прошлой вкладкой), а не эффектом: эффект успел бы
  // показать один кадр со старыми карточками.
  const [toggled, setToggled] = useState<{ tab: RulesTabId; ids: ReadonlySet<string> }>({
    tab: activeTab,
    ids: EMPTY_IDS,
  });
  if (toggled.tab !== activeTab) setToggled({ tab: activeTab, ids: EMPTY_IDS });
  const kept = toggled.tab === activeTab ? toggled.ids : EMPTY_IDS;
  const inTab = useMemo(() => rulesShownInTab(rules, activeTab, kept), [rules, activeTab, kept]);
  const toggleRule = (id: string, isEnabled: boolean): void => {
    setToggled({ tab: activeTab, ids: new Set([...kept, id]) });
    setEnabled.mutate({ id, isEnabled });
  };

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };

  const openEdit = (rule: Rule): void => {
    setEditing(rule);
    setIsFormOpen(true);
    writeUrl(rule.id);
  };

  // Ссылка /rules?id=<id> открывает это правило сразу в редакторе.
  const writeUrl = useEntityUrlWriter();
  useEntityUrl<Rule>({ items: rules, getId: (rule) => rule.id, onOpen: openEdit });
  // Быстрое действие «Добавить» с обзора: /rules?create=1 сразу открывает форму.
  useCreateParam(openCreate);

  const closeForm = (open: boolean): void => {
    setIsFormOpen(open);
    if (!open) writeUrl(undefined);
  };

  // Поиск идёт внутри открытой вкладки: «Выключены» + слово — это вопрос «не
  // выключено ли вот это правило», и ответ не должен тонуть во включённых.
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return inTab;
    return inTab.filter(
      (rule) =>
        rule.title.toLowerCase().includes(needle) || rule.body.toLowerCase().includes(needle),
    );
  }, [inTab, query]);

  const isEmpty = !isLoading && filtered.length === 0;
  const hasQuery = query.trim().length > 0;
  // Вкладка-отбор пуста сама по себе, а не из-за поиска: сказать это словами.
  const isTabEmpty = isEmpty && activeTab !== 'all' && inTab.length === 0;

  // Тот же файл, что открыт на странице CLAUDE.md (общий ключ запроса, обновляется
  // наблюдателем вместе с правилами): по нему решаем, какую пустоту показывать.
  // Файл есть только у модели инструкций `file`: у Continue раздел «готов», но
  // это СПИСОК файлов, и сервер отвечал 400 на каждый заход в правила. Решает
  // модель, не возможность и не id провайдера.
  const { data: providers } = useProviders();
  const hasInstructionsFile = activeProvider(providers)?.instructionsModel === 'file';
  const { data: instructions } = useClaudeMd({ enabled: hasInstructionsFile });
  const emptyState = useMemo(
    () => resolveRulesEmptyState(instructions?.content),
    [instructions?.content],
  );

  const tabs = RULES_TABS.map((id) => ({
    id,
    label: t(`pageTabs.rules.tab.${id}`),
    icon: RULES_TAB_ICONS[id],
    count: rulesInTab(rules, id).length,
  }));

  // Поиск, список и пустые состояния одни и те же с вкладками и без них.
  const listBody = (
    <>
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder={t('common.search')}
        label={t('common.search')}
      />

      <Stack gap="var(--spacing-sm)">
        {filtered.map((rule) => (
          <Card key={rule.id} padding="md" data-agent-anchor={rule.id}>
            <Stack direction="row" gap="var(--spacing-md)" align="start" width="100%">
              <Stack gap="var(--spacing-2xs)" flex={1} minWidth={0}>
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Typography variant="body" weight="medium" as="span">
                    {rule.title}
                  </Typography>
                  {!rule.isEnabled && <Badge tone="neutral">{t('common.disabled')}</Badge>}
                </Stack>
                <Typography variant="body-sm" color="muted" clamp={3} className={styles.body}>
                  {rule.body}
                </Typography>
              </Stack>

              <Stack direction="row" align="center" gap="var(--spacing-xs)" flexShrink={0}>
                <SandboxButton
                  kind="rule"
                  title={rule.title}
                  selection={{ ruleIds: [rule.id] }}
                  context={{ body: rule.body }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<Icon name="edit" size={24} />}
                  aria-label={`${t('common.edit')}: ${rule.title}`}
                  onClick={() => openEdit(rule)}
                />
                <DeleteButton
                  entityName={rule.title}
                  description={t('common.deleteRule')}
                  onDelete={() => deleteRule.mutate(rule.id)}
                  isPending={deleteRule.isPending}
                />
                <Toggle
                  checked={rule.isEnabled}
                  onCheckedChange={(isEnabled) => toggleRule(rule.id, isEnabled)}
                  aria-label={rule.title}
                />
              </Stack>
            </Stack>
          </Card>
        ))}
      </Stack>

      {/* Пусто здесь означает три разные вещи, и одна заглушка на все путала.
          Промах поиска — своя заглушка с запросом (раньше страница уверяла, что
          «правил пока нет», хотя правила есть). Пустой или отсутствующий файл —
          обычное «правил пока нет». А самый частый случай на живом CLAUDE.md —
          файл непустой, но размечен обычными «## » разделами: панель считает
          правилами только «## ПРАВИЛО: …» (contracts/rule-format), и голый «0»
          читался как сломанный счётчик. Поэтому здесь — сколько таких разделов
          в файле, какой заголовок ждёт панель, и куда идти править. */}
      {isTabEmpty && (
        <Typography color="subtle">{t(`pageTabs.rules.empty.${activeTab}`)}</Typography>
      )}
      {isEmpty && hasQuery && !isTabEmpty && (
        <EmptyState
          icon="search"
          title={t('rules.noMatchTitle')}
          text={t('rules.noMatchText', { query: query.trim() })}
        />
      )}
      {isEmpty && !hasQuery && !hasTabs && emptyState.kind === 'blank' && (
        <EmptyState icon="rules" title={t('rules.emptyTitle')} text={t('rules.emptyText')} />
      )}
      {isEmpty && !hasQuery && !hasTabs && emptyState.kind === 'unformatted' && (
        <EmptyState
          icon="rules"
          title={t('rules.emptyPlainTitle')}
          text={
            emptyState.plainSections > 0
              ? t('rules.emptyPlainText', { count: emptyState.plainSections })
              : t('rules.emptyPlainNoSections')
          }
          action={
            <Stack align="center" gap="var(--spacing-sm)" data-testid="rules-unformatted">
              <Typography variant="mono" as="code" className={styles.example}>
                {RULE_HEADING_EXAMPLE}
              </Typography>
              <Typography variant="body-sm" color="muted" className={styles.hint}>
                {t('rules.emptyPlainHint')}
              </Typography>
              <Stack direction="row" gap="var(--spacing-xs)" justify="center" wrap>
                <Link to={CLAUDE_MD_ROUTE} className={styles.link}>
                  <Icon name="edit" size={20} />
                  {t('rules.openClaudeMd')}
                </Link>
                <Link to={HELP_ROUTE} search={{ topic: 'rules' }} className={styles.link}>
                  <Icon name="help" size={20} />
                  {t('rules.openRulesHelp')}
                </Link>
              </Stack>
            </Stack>
          }
        />
      )}
    </>
  );

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('rules.title')}
        subtitle={t('rules.subtitle')}
        helpTopic="rules"
        actions={
          <Button variant="primary" leftIcon={<Icon name="plus" size={24} />} onClick={openCreate}>
            {t('rules.addRule')}
          </Button>
        }
      />

      <ExplainBox title={t('rules.explainTitle')} text={t('rules.explain')} />

      {isLoading && <SkeletonList rows={5} />}

      {hasTabs && (
        <PageTabs
          page="rules"
          label={t('pageTabs.rules.tabsLabel')}
          tabs={tabs}
          active={activeTab}
          onSelect={selectTab}
        />
      )}

      {hasTabs ? (
        <PageTabPanel page="rules" tab={activeTab} hint={t(`pageTabs.rules.hint.${activeTab}`)}>
          {listBody}
        </PageTabPanel>
      ) : (
        listBody
      )}

      <RuleFormModal isOpen={isFormOpen} onOpenChange={closeForm} rule={editing} />
    </Stack>
  );
}
