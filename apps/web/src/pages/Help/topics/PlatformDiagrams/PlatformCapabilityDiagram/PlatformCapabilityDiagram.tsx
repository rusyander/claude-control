import styles from './PlatformCapabilityDiagram.module.scss';
import { Figure } from '../Figure/Figure';
import type { CapabilityRow } from '../PlatformDiagrams.types';

/** Диаграмма «что доступно»: что через контур работает, а что нет. Причины — в таблице под ней. */
export function PlatformCapabilityDiagram({
  title,
  rows,
}: {
  title: string;
  rows: CapabilityRow[];
}) {
  const glyph = { yes: '✓', partial: '~', no: '✕' };
  const markStyle = { yes: styles.markYes, partial: styles.markPartial, no: styles.markNo };
  const height = 16 + rows.length * 40;
  return (
    <Figure title={title} viewBox={`0 0 700 ${height}`}>
      {rows.map((row, index) => {
        const y = 8 + index * 40;
        return (
          <g key={row.label}>
            <rect x={8} y={y} width={684} height={34} rx={6} className={styles.row} />
            <text x={20} y={y + 22} className={styles.label}>
              {row.label}
            </text>
            <text x={664} y={y + 22} className={markStyle[row.mark]} textAnchor="middle">
              {glyph[row.mark]}
            </text>
          </g>
        );
      })}
    </Figure>
  );
}
