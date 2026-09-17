import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { PlatformStatus } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SelectField } from '@shared/ui/select-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { PlatformWizard } from '@features/PlatformEditor';
import { useCompromises } from '@entities/Compromise';
import { toolRouteOf, usePlatformGateway, usePlatformsInfo } from '@entities/Platform';
import { CONTOUR_KEY_TAB } from '@entities/PanelAgent';
import type { WizardStep } from '@features/PlatformEditor';
import { PlatformCard } from './PlatformCard';
import { PlatformFacts } from './PlatformFacts';
import { PlatformTabs } from './PlatformTabs';
import { ActivationNotice } from './ActivationNotice';
import { ViolationsCard } from './ViolationsCard';
import { ToolShimCard } from './ToolShimCard';
import { AgentsCard } from './AgentsCard';
import { ModelCard } from './ModelCard';
import { RulesCard } from './RulesCard';
import { AccessCard } from './AccessCard';
import { BridgeRow } from './BridgeRow';
import { showsViolations } from './lib/violationsView';
import { showsToolShim } from './lib/toolShimView';
import { showsAgents } from './lib/agentsView';
import { activeFirst } from './lib/platformOrder';
import {
  PER_CONTOUR_TABS,
  findPlatformTab,
  pickContour,
  platformPanelDomId,
  platformTabDomId,
  type PlatformTabId,
} from './model/tabs';

/**
 * Раздел «Контур»: корпоративная платформа, к которой панель ходит по ключу.
 *
 * Разложен по вкладкам (`?tab=`): одна колонка из десятка карточек на каждый
 * контур не просматривалась, и правила контура человек не находил вовсе. Первая
 * вкладка — список контуров; модель, правила и доступ разделов относятся к
 * ОДНОМУ контуру и выбирают его над собой (`?id=`); проверки, инструменты и
 * агенты существуют только у включённого контура.
 *
 * Пустой экран здесь не заглушка: он объясняет пользу двумя строками и ведёт в
 * мастер одной кнопкой — раздел, показывающий «нет данных», человек закрывает и
 * не возвращается. Вкладок у пустого раздела нет: выбирать в них нечего.
 *
 * Значки компромиссов приходят ДАННЫМИ: у матрицы возможностей их проставляет
 * проба, у целей — план применения. Снятая подпись обязана погаснуть на экране
 * без правки разметки, поэтому зашитых в неё идентификаторов ровно столько,
 * сколько утверждений делает сама страница.
 */
export function PlatformPage() {
  const { t } = useTranslation();
  const { data: info, isLoading, isError, refetch } = usePlatformsInfo();
  // Активный контур первым: через него сейчас идёт работа, и он же — контур
  // вкладок по умолчанию.
  const data = activeFirst(info?.platforms);
  const gateway = usePlatformGateway();
  const compromises = useCompromises();
  const [wizard, setWizard] = useState<{
    open: boolean;
    existing?: PlatformStatus;
    initialStep?: WizardStep;
  }>({
    open: false,
  });

  const search = useSearch({ strict: false }) as { id?: string; tab?: string };
  const navigate = useNavigate();
  const activeTab = findPlatformTab(search.tab);

  // Агент панели сохранил черновик без ключа и открыл `?id=<контур>&tab=key`:
  // мастер этого контура открывается сразу на шаге ключа. Параметры снимаются,
  // чтобы закрытый мастер не открылся снова от того же адреса.
  useEffect(() => {
    if (search.tab !== CONTOUR_KEY_TAB || !search.id) return;
    const target = info?.platforms.find((status) => status.platform.id === search.id);
    if (!target) return;
    setWizard({ open: true, existing: target, initialStep: 'token' });
    void navigate({ to: '/platform', search: {}, replace: true } as never);
  }, [search.tab, search.id, info, navigate]);

  // Замена записи в истории: «назад» уводит со страницы, а не листает вкладки.
  // Выбранный контур переживает смену вкладки — человек сравнивает его модель
  // и правила, а не выбирает заново на каждой.
  const selectTab = (tab: PlatformTabId): void => {
    void navigate({
      to: '/platform',
      search: { tab, ...(search.id ? { id: search.id } : {}) },
      replace: true,
    } as never);
  };
  const selectContour = (id: string): void => {
    void navigate({ to: '/platform', search: { tab: activeTab, id }, replace: true } as never);
  };

  const openCreate = (): void => setWizard({ open: true });
  const openEdit = (existing: PlatformStatus): void => setWizard({ open: true, existing });

  const platforms = data ?? [];
  const selected = pickContour(platforms, search.id);
  const enabled = platforms.filter((status) => status.platform.enabled);
  const gatewayRunning = gateway.data?.status.running ?? false;

  const showViolations = showsViolations(
    enabled.length > 0,
    gatewayRunning,
    gateway.data?.status.violations,
  );
  const showShim = showsToolShim(
    enabled.some((status) => toolRouteOf(status) === 'shim'),
    gatewayRunning,
    gateway.data?.status.toolShim,
  );

  /** Пустая вкладка говорит почему, а не показывает белый лист. */
  const emptyTab = (text: string): ReactNode => (
    <Typography variant="body-sm" color="muted" style={{ maxWidth: 'var(--text-measure)' }}>
      {text}
    </Typography>
  );

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={t('platform.title')}
        subtitle={t('platform.subtitle')}
        helpTopic="platform"
        actions={
          <Button leftIcon={<Icon name="plus" size={16} />} onClick={openCreate}>
            {t('platform.connect')}
          </Button>
        }
      />

      {isError && !data && <LoadErrorCard onRetry={() => void refetch()} />}
      {isLoading && <SkeletonList rows={2} />}

      {data?.length === 0 && (
        <>
          <ExplainBox title={t('platform.explainTitle')} text={t('platform.explainText')} />
          <EmptyState
            icon="plug"
            title={t('platform.emptyTitle')}
            text={t('platform.emptyText')}
            action={<Button onClick={openCreate}>{t('platform.connect')}</Button>}
          />
        </>
      )}

      {platforms.length > 0 && (
        <>
          <PlatformTabs active={activeTab} onSelect={selectTab} />

          <Stack
            gap="var(--spacing-lg)"
            role="tabpanel"
            id={platformPanelDomId(activeTab)}
            aria-labelledby={platformTabDomId(activeTab)}
          >
            {/* Подпись вкладки: полоса отвечает «где я», строка — «что здесь». */}
            <Typography
              variant="body-sm"
              color="subtle"
              style={{ maxWidth: 'var(--text-measure)' }}
            >
              {t(`platform.tabHint.${activeTab}`)}
            </Typography>

            {/* Выбор контура — только у вкладок одного контура и только когда
                выбирать есть из чего. */}
            {PER_CONTOUR_TABS.includes(activeTab) && selected && platforms.length > 1 && (
              <div style={{ maxWidth: 'var(--text-measure)' }} data-contour-picker="">
                <SelectField
                  label={t('platform.contourPicker')}
                  value={selected.platform.id}
                  onChange={selectContour}
                  options={platforms.map((status) => ({
                    value: status.platform.id,
                    label: status.active
                      ? t('platform.contourPickerActive', { title: status.platform.title })
                      : status.platform.title,
                  }))}
                />
              </div>
            )}

            {activeTab === 'contours' && (
              <>
                <ExplainBox title={t('platform.explainTitle')} text={t('platform.explainText')} />
                {/* Разовый рассказ о переносе: включённых контуров могло быть
                    несколько, активный теперь ровно один. Стоит ВЫШЕ карточек —
                    он объясняет, почему тумблеры соседей погасли сами. */}
                {info?.activationNotice && <ActivationNotice notice={info.activationNotice} />}
                {platforms.map((status) => (
                  <PlatformCard
                    key={status.platform.id}
                    status={status}
                    onEdit={() => openEdit(status)}
                  />
                ))}
                <PlatformFacts
                  platforms={platforms}
                  compromisesTotal={compromises.data?.length ?? 0}
                />
              </>
            )}

            {/* Модель и усилие (Т6). Пока связь не проверена, каталога моделей
                нет и выбирать не из чего — карточка скажет это сама. */}
            {activeTab === 'model' && selected && (
              <ModelCard
                key={selected.platform.id}
                platform={selected.platform}
                health={selected.health}
                effort={selected.effort}
              />
            )}

            {/* Правила контура, наши слои и матрица конфликтов (Т7/Т8). */}
            {activeTab === 'rules' && selected && (
              <RulesCard
                key={selected.platform.id}
                platform={selected.platform}
                rules={selected.rules}
                conflicts={selected.conflicts}
                layers={selected.layers}
                dataMask={selected.dataMask}
              />
            )}

            {/* Ключ карточки — сохранённый выбор: пришёл другой (мастер,
                телефон, агент панели) — черновик заводится заново. */}
            {activeTab === 'access' && selected && (
              <AccessCard
                key={`${selected.platform.id}:${selected.platform.consumers.join(',')}:${selected.platform.targets.join(',')}`}
                status={selected}
              />
            )}

            {/* Проверки и прослойка — только при живом шлюзе и включённом
                контуре: выключенный контур обязан вернуть панель к прежнему
                поведению побайтно. Две карточки: в «Проверках» чужая работа
                (гардрейлы компании), в прослойке — своя. */}
            {activeTab === 'tools' && (
              <>
                {showViolations && (
                  <ViolationsCard
                    report={gateway.data?.status.violations}
                    platformTitles={Object.fromEntries(
                      enabled.map((status) => [status.platform.id, status.platform.title]),
                    )}
                  />
                )}
                {showShim && <ToolShimCard report={gateway.data?.status.toolShim} />}
                {!showViolations && !showShim && emptyTab(t('platform.tabEmpty.tools'))}
              </>
            )}

            {/* Агенты — у включённого контура: список ведёт человек, и спросить
                агента одного контура через другой нельзя. Переходник MCP один на
                все контуры, поэтому стоит ровно один раз. */}
            {activeTab === 'agents' && (
              <>
                {platforms.filter(showsAgents).map((status) => (
                  <AgentsCard
                    key={status.platform.id}
                    platform={status.platform}
                    hasToken={status.hasToken}
                  />
                ))}
                {enabled.length > 0 && <BridgeRow />}
                {enabled.length === 0 && emptyTab(t('platform.tabEmpty.agents'))}
              </>
            )}
          </Stack>
        </>
      )}

      {wizard.open && (
        <PlatformWizard
          isOpen={wizard.open}
          onOpenChange={(open) => setWizard(open ? wizard : { open: false })}
          {...(wizard.existing ? { existing: wizard.existing } : {})}
          {...(wizard.initialStep ? { initialStep: wizard.initialStep } : {})}
        />
      )}
    </Stack>
  );
}
