import { useTranslation } from 'react-i18next';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { ScenarioView, parseRef, refText, useScenarioRead } from '@features/ScenarioEditor';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { LibraryTabProps } from './LibraryTab.types';
import styles from './LibraryTab.module.scss';

/**
 * Библиотека ядра: пресеты из кода и версии человека слева, выбранный сценарий справа. Выбор —
 * в адресе (`?id=id@v`), так что ссылку на сценарий можно передать; «Создать на основе» уводит
 * на вкладку нового сценария с этой основой.
 */
export function LibraryTab({ listing, selected, onSelect, onBase }: LibraryTabProps) {
  const { t } = useTranslation();
  const ref = parseRef(selected);
  const read = useScenarioRead(ref);

  const renderItem = (scenario: Scenario) => {
    const text = refText(scenario);
    return (
      <li key={text}>
        <button
          type="button"
          className={styles.item}
          aria-pressed={text === selected}
          aria-label={t('coreScenario.library.open', { ref: text })}
          data-scenario-item={text}
          onClick={() => onSelect(text)}
        >
          <span className={styles.title}>{scenario.title}</span>
          <span className={styles.meta}>
            {text} · {t('coreScenario.library.steps', { count: scenario.steps.length })}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className={styles.columns}>
      <Stack gap="var(--spacing-sm)" data-scenario-library>
        <Typography variant="body-sm" weight="semibold" as="h2">
          {t('coreScenario.library.presets')}
        </Typography>
        <ul className={styles.list}>{listing.presets.map(renderItem)}</ul>
        <Typography variant="body-sm" weight="semibold" as="h2">
          {t('coreScenario.library.own')}
        </Typography>
        {listing.library.length > 0 ? (
          <ul className={styles.list}>{listing.library.map(renderItem)}</ul>
        ) : (
          <Typography variant="caption" color="subtle" as="p">
            {t('coreScenario.library.ownEmpty')}
          </Typography>
        )}
        {listing.problems.length > 0 && (
          <Stack gap="var(--spacing-3xs)" role="note">
            <Typography variant="caption" weight="semibold" color="warning" as="span">
              {t('coreScenario.library.problems')}
            </Typography>
            {listing.problems.map((problem) => (
              <Typography key={problem.file} variant="caption" color="subtle" as="span">
                {problem.file}: {problem.reason}
              </Typography>
            ))}
          </Stack>
        )}
      </Stack>

      <div className={styles.view}>
        {!ref && (
          <Typography variant="body-sm" color="subtle" as="p">
            {t('coreScenario.library.pick')}
          </Typography>
        )}
        {ref && read.isLoading && <SkeletonList rows={5} />}
        {ref && read.isError && (
          <LoadErrorCard title={t('coreScenario.readError')} onRetry={() => void read.refetch()} />
        )}
        {read.data && (
          <Stack gap="var(--spacing-sm)">
            <ScenarioView scenario={read.data.scenario} source={read.data.source} />
            <div>
              <Button
                variant="secondary"
                leftIcon={<Icon name="copy" size={14} />}
                onClick={() => onBase(refText(read.data.scenario))}
              >
                {t('coreScenario.library.basedOn')}
              </Button>
            </div>
          </Stack>
        )}
      </div>
    </div>
  );
}
