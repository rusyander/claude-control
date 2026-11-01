import { useTranslation } from 'react-i18next';
import type { SignalDetailView } from '@agentdeck/contracts/core/signal-view';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { factLabel, signalView } from '../../model/signalView';
import type { SignalLineProps } from './SignalLine.types';
import styles from './SignalLine.module.scss';

const SEVERITY_TONE = { info: 'info', warn: 'warning', stop: 'danger' } as const;

/**
 * Сигнал строкой — одна разметка для ленты и панели сигналов: заголовок по шаблону каталога,
 * действие ядра, предмет с подписью его вида и деталь. Проза ядра — дословно (P32), JSON —
 * фактами по форме сигнала; сигнал вне каталога назван своим id, а JSON его — только ключами.
 */
export function SignalLine({ signal, tone, withSeverity = false }: SignalLineProps) {
  const { t } = useTranslation();
  const view = signalView(signal);
  return (
    <Stack
      gap="var(--spacing-3xs)"
      data-signal-id={signal.signal}
      data-signal-known={view.known}
      data-signal-detail={view.detail.form}
    >
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        {withSeverity && (
          <Badge tone={SEVERITY_TONE[signal.severity]}>
            {t(`coreTimeline.signal.severity.${signal.severity}`)}
          </Badge>
        )}
        <Typography variant="body-sm" weight="medium" color={tone} as="span" data-signal-title>
          {t(view.title.key, view.title.params)}
        </Typography>
        {signal.action && (
          <Typography variant="caption" color="muted" as="span" data-signal-action>
            {t(`coreTimeline.signal.action.${signal.action}`, { defaultValue: signal.action })}
          </Typography>
        )}
      </Stack>
      {view.subject && (
        <Typography variant="caption" color="muted" className={styles.wrap} data-signal-subject>
          {t(view.subject.key)}: <span lang="en">{view.subject.value}</span>
        </Typography>
      )}
      <SignalDetail detail={view.detail} />
    </Stack>
  );
}

function SignalDetail({ detail }: { detail: SignalDetailView }) {
  const { t } = useTranslation();
  switch (detail.form) {
    case 'none':
      return null;
    case 'text':
      return (
        <Typography variant="caption" color="muted" lang="en" className={styles.text}>
          {detail.text}
        </Typography>
      );
    case 'facts':
      return (
        <dl className={styles.facts} data-signal-facts={detail.facts.length}>
          {detail.facts.map((fact, i) => {
            const label = factLabel(fact);
            return (
              <FactRow
                key={i}
                label={'key' in label ? t(label.key) : label.raw}
                raw={'raw' in label}
                value={fact.value}
                items={fact.items}
              />
            );
          })}
        </dl>
      );
    case 'keys':
      return (
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle">
            {t('coreTimeline.signal.keys')}
          </Typography>
          <ul className={styles.keys} data-signal-keys={detail.keys.length}>
            {detail.keys.map(({ key, value }) => (
              <li key={key}>
                <Typography variant="caption" color="muted" as="span" lang="en">
                  {key}: {value}
                </Typography>
              </li>
            ))}
          </ul>
        </Stack>
      );
  }
}

interface FactRowProps {
  label: string;
  raw: boolean;
  value?: string;
  items?: string[];
}

function FactRow({ label, raw, value, items }: FactRowProps) {
  return (
    <>
      <Typography variant="caption" color="subtle" as="dt" {...(raw ? { lang: 'en' } : {})}>
        {label}
      </Typography>
      <Typography variant="caption" color="muted" as="dd" lang="en">
        {value}
        {items && (
          <ul className={styles.items}>
            {items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        )}
      </Typography>
    </>
  );
}
