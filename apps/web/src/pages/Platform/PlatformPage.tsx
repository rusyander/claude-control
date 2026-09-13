import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformStatus } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { CompromiseList } from '@features/CompromiseList';
import { PlatformWizard } from '@features/PlatformEditor';
import { useCompromises } from '@entities/Compromise';
import { toolRouteOf, usePlatformGateway, usePlatformsInfo } from '@entities/Platform';
import { PlatformCard } from './PlatformCard';
import { ActivationNotice } from './ActivationNotice';
import { ViolationsCard } from './ViolationsCard';
import { ToolShimCard } from './ToolShimCard';
import { AgentsCard } from './AgentsCard';
import { ModelCard } from './ModelCard';
import { RulesCard } from './RulesCard';
import { BridgeRow } from './BridgeRow';
import { showsViolations } from './lib/violationsView';
import { showsToolShim, showsToolsFact } from './lib/toolShimView';
import { showsAgents } from './lib/agentsView';
import styles from './PlatformPage.module.scss';

/**
 * Раздел «Контур»: корпоративная платформа, к которой панель ходит по ключу.
 *
 * Пустой экран здесь не заглушка: он объясняет пользу двумя строками и ведёт в
 * мастер одной кнопкой — раздел, показывающий «нет данных», человек закрывает и
 * не возвращается.
 *
 * Значки компромиссов приходят ДАННЫМИ: у матрицы возможностей их проставляет
 * проба, у целей — план применения. Снятая подпись обязана погаснуть на экране
 * без правки разметки, поэтому зашитых в неё идентификаторов ровно столько,
 * сколько утверждений делает сама страница.
 */
export function PlatformPage() {
  const { t } = useTranslation();
  const { data: info, isLoading, isError, refetch } = usePlatformsInfo();
  const data = info?.platforms;
  const gateway = usePlatformGateway();
  const compromises = useCompromises();
  const [wizard, setWizard] = useState<{ open: boolean; existing?: PlatformStatus }>({
    open: false,
  });

  const openCreate = (): void => setWizard({ open: true });
  const openEdit = (existing: PlatformStatus): void => setWizard({ open: true, existing });

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
      <ExplainBox title={t('platform.explainTitle')} text={t('platform.explainText')} />

      {isError && !data && <LoadErrorCard onRetry={() => void refetch()} />}
      {isLoading && <SkeletonList rows={2} />}

      {data?.length === 0 && (
        <EmptyState
          icon="plug"
          title={t('platform.emptyTitle')}
          text={t('platform.emptyText')}
          action={<Button onClick={openCreate}>{t('platform.connect')}</Button>}
        />
      )}

      {/* Разовый рассказ о переносе: включённых контуров могло быть несколько,
          активный теперь ровно один. Стоит ВЫШЕ карточек — он объясняет, почему
          тумблеры соседей погасли сами. */}
      {info?.activationNotice && <ActivationNotice notice={info.activationNotice} />}

      {data?.map((status) => (
        <PlatformCard key={status.platform.id} status={status} onEdit={() => openEdit(status)} />
      ))}

      {/* Модель и усилие (Т6) — у каждого контура свои, поэтому карточка на
          каждый, как и агенты. Ниже карточки контура намеренно: пока связь не
          проверена, каталога моделей нет и выбирать не из чего. */}
      {(data ?? []).map((status) => (
        <ModelCard
          key={status.platform.id}
          platform={status.platform}
          health={status.health}
          effort={status.effort}
        />
      ))}

      {/* Правила контура и матрица конфликтов (Т7) — ниже модели: сперва «чем
          отвечает», потом «что он делает с запросом по дороге». */}
      {(data ?? []).map((status) => (
        <RulesCard
          key={status.platform.id}
          platform={status.platform}
          rules={status.rules}
          conflicts={status.conflicts}
          layers={status.layers}
        />
      ))}

      {/* Агенты — у каждого включённого контура свои: список ведёт человек, и
          спросить агента одного контура через другой нельзя. А переходник MCP
          один на все контуры, поэтому стоит отдельно и ровно один раз; модели
          через него спрашиваются у любого типа, поэтому и стоит он у любого
          включённого контура, а не только у контура с агентами. */}
      {(data ?? []).filter(showsAgents).map((status) => (
        <AgentsCard
          key={status.platform.id}
          platform={status.platform}
          hasToken={status.hasToken}
        />
      ))}
      {(data ?? []).some((status) => status.platform.enabled) && <BridgeRow />}

      {/* Карточка проверок появляется только при живом шлюзе и включённом
          контуре: выключенный контур обязан вернуть панель к сегодняшнему
          поведению побайтно, а раздел о проверках платформы, к которой панель
          не подключена, объясняет несуществующее. */}
      {showsViolations(
        (data ?? []).some((status) => status.platform.enabled),
        gateway.data?.status.running ?? false,
        gateway.data?.status.violations,
      ) && (
        <ViolationsCard
          report={gateway.data?.status.violations}
          platformTitles={Object.fromEntries(
            (data ?? [])
              .filter((status) => status.platform.enabled)
              .map((status) => [status.platform.id, status.platform.title]),
          )}
        />
      )}

      {/* Прослойка инструментов — рядом с проверками и по тем же правилам:
          выключенный контур или мёртвый шлюз возвращают раздел к прежнему виду.
          Отдельная карточка, а не строка в «Проверках»: там чужая работа
          (гардрейлы компании), здесь своя. */}
      {showsToolShim(
        (data ?? []).some((status) => status.platform.enabled && toolRouteOf(status) === 'shim'),
        gateway.data?.status.running ?? false,
        gateway.data?.status.toolShim,
      ) && <ToolShimCard report={gateway.data?.status.toolShim} />}

      {/* Два решения, которые уже приняты и уже стоят денег: ключ живёт в
          панели, и через контур CLI работает как чат. Оба подписаны прямо
          здесь — подпись стоит вплотную к утверждению, которое объясняет. */}
      <Stack gap="var(--spacing-xs)" as="section">
        <Typography variant="body-sm" weight="medium" as="h2">
          {t('platform.factsTitle')}
        </Typography>
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <Typography variant="body-sm" color="muted">
            {t('platform.factKey')}
          </Typography>
          <CompromiseMark id="gateway-required" />
        </Stack>
        {showsToolsFact((data ?? []).map((status) => toolRouteOf(status))) && (
          <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
            <Typography variant="body-sm" color="muted">
              {t('platform.factTools')}
            </Typography>
            <CompromiseMark id="no-client-tools" />
          </Stack>
        )}
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <Typography variant="body-sm" color="muted">
            {t('platform.factCli')}
          </Typography>
          <CompromiseMark id="cli-no-endpoint" />
        </Stack>
      </Stack>

      {/* Свёрнутое состояние — на `<details>`: раскрытие работает без нашего
          состояния, а доступность браузер обеспечивает сам. */}
      <details className={styles.compromises}>
        <summary className={styles.summary}>
          {/* Стрелка обязательна: своего маркера у `summary` тут нет (он снят
              стилями), а заголовок над пустым местом читается как раздел,
              потерявший содержимое, — а не как свёрнутый список. */}
          <Icon name="chevronRight" size={16} className={styles.chevron} />
          <Typography variant="heading-sm" as="h2">
            {/* Число подставляем как обычную переменную, а не как `count`:
                `count` в i18next включает выбор формы множественного числа, а
                здесь в скобках стоит просто счёт. */}
            {t('platform.compromisesTitle', { total: compromises.data?.length ?? 0 })}
          </Typography>
        </summary>
        <Stack gap="var(--spacing-sm)" marginTop="var(--spacing-sm)">
          <Typography variant="body-sm" color="muted">
            {t('platform.compromisesText')}
          </Typography>
          <CompromiseList />
        </Stack>
      </details>

      {wizard.open && (
        <PlatformWizard
          isOpen={wizard.open}
          onOpenChange={(open) => setWizard(open ? wizard : { open: false })}
          {...(wizard.existing ? { existing: wizard.existing } : {})}
        />
      )}
    </Stack>
  );
}
