import type { EnvNeeds } from '@agentdeck/contracts/portable-env';
import { needsSummary } from '@entities/Portability';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import styles from './NeedsView.module.scss';

/** Что записи нужно от рантайма: факты — бейджами, причина — фразой. */
export function NeedsView({ needs }: { needs: EnvNeeds }) {
  const summary = needsSummary(needs);
  if (summary.why === null) {
    return (
      <>
        {summary.facts.map((fact) => (
          <Badge key={fact} tone="info">
            {fact}
          </Badge>
        ))}
      </>
    );
  }
  // Причина — целая фраза, а не ярлык: бейдж её не переносит
  // (`white-space: nowrap` чипа) и увёл бы хвост за край карточки. «Ничего не
  // нужно» и «определить не удалось» означают разное — различие несёт цвет.
  return (
    <Typography
      variant="caption"
      color={needs.resolution === 'none' ? 'muted' : 'warning'}
      className={styles.why}
    >
      {summary.why}
    </Typography>
  );
}
