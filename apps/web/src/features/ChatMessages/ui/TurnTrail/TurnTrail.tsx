import { useTranslation } from 'react-i18next';
import type { TrailAgent, TrailHookGroup } from '../../lib/turnTrail.types';
import type { TurnTrailProps } from './TurnTrail.types';
import styles from './TurnTrail.module.scss';

/** Сколько строк добавленного контекста показывать: для узнавания, не для чтения. */
const CONTEXT_LINES = 6;

const agentLabel = (agent: TrailAgent): string =>
  [agent.type, agent.description && `«${agent.description}»`, agent.model]
    .filter(Boolean)
    .join(' · ');

const times = (count: number): string => (count > 1 ? ` ×${count}` : '');

const firstLines = (text: string): string => text.split('\n').slice(0, CONTEXT_LINES).join('\n');

/**
 * След хода — одна свёрнутая строка в конце ответа: сколько скиллов, агентов,
 * скриптов и хуков было в ходе. Развёрнутая — что именно. Пустые разделы не
 * показываются, а ход без следа строки не получает вовсе.
 */
export function TurnTrail({ trail }: TurnTrailProps) {
  const { t, i18n } = useTranslation();
  if (!trail) return null;

  const seconds = (ms: number): string =>
    t('turnTrail.seconds', {
      value: new Intl.NumberFormat(i18n.language, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(ms / 1000),
    });

  const hooksPart =
    trail.contextCount > 0
      ? t('turnTrail.hooksWithContext', { total: trail.hookCount, count: trail.contextCount })
      : t('turnTrail.hooks', { count: trail.hookCount });
  const parts = [
    trail.skills.length > 0 && t('turnTrail.skills', { count: trail.skills.length }),
    trail.agents.length > 0 && t('turnTrail.agents', { count: trail.agents.length }),
    trail.scripts.length > 0 &&
      t('turnTrail.scripts', {
        count: trail.scripts.reduce((sum, script) => sum + script.count, 0),
      }),
    trail.hookCount > 0 && hooksPart,
    trail.hookMs > 0 && seconds(trail.hookMs),
  ].filter(Boolean);

  const hookRow = (group: TrailHookGroup) => (
    <div key={group.hookName} className={styles.line} data-trail-hook={group.hookName}>
      <span className={styles.event}>{group.hookName}</span>
      {group.names.length > 0 && (
        <span className={styles.mono}>
          {group.names.map((entry) => `${entry.name}${times(entry.count)}`).join(', ')}
        </span>
      )}
      {group.durationMs > 0 && <span>{seconds(group.durationMs)}</span>}
      {group.failure && (
        <span className={styles.failure} data-trail-failure>
          {group.failure.exitCode
            ? t('turnTrail.failedExit', { code: group.failure.exitCode })
            : t('turnTrail.failedBlocked')}
        </span>
      )}
      {group.contexts.length > 0 && (
        <details className={styles.context}>
          <summary>{t('turnTrail.contextAdded', { count: group.contexts.length })}</summary>
          {group.contexts.map((context, index) => (
            <div key={index} className={styles.contextText}>
              {firstLines(context)}
            </div>
          ))}
        </details>
      )}
    </div>
  );

  return (
    <details className={styles.trail} data-turn-trail>
      <summary aria-label={`${t('turnTrail.label')}: ${parts.join(' · ')}`}>
        {parts.join(' · ')}
      </summary>
      <dl className={styles.rows}>
        {trail.skills.length > 0 && (
          <>
            <dt>{t('turnTrail.rowSkills')}</dt>
            <dd className={styles.mono}>{trail.skills.join(', ')}</dd>
          </>
        )}
        {trail.agents.length > 0 && (
          <>
            <dt>{t('turnTrail.rowAgents')}</dt>
            <dd>
              {trail.agents.map((agent, index) => (
                <span key={index} className={styles.line}>
                  {agentLabel(agent)}
                </span>
              ))}
            </dd>
          </>
        )}
        {trail.scripts.length > 0 && (
          <>
            <dt>{t('turnTrail.rowScripts')}</dt>
            <dd>
              {trail.scripts.map((script) => (
                <span key={script.command} className={styles.line} data-trail-script>
                  <span className={styles.mono}>
                    {script.command}
                    {times(script.count)}
                  </span>
                  {script.description && <span>{script.description}</span>}
                </span>
              ))}
            </dd>
          </>
        )}
        {trail.hooks.length > 0 && (
          <>
            <dt>{t('turnTrail.rowHooks')}</dt>
            <dd>{trail.hooks.map(hookRow)}</dd>
          </>
        )}
      </dl>
    </details>
  );
}
