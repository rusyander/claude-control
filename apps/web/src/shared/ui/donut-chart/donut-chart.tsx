import { useState } from 'react';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { buildDonutArcs } from './donut-chart.model';
import type { DonutChartProps } from './donut-chart.types';
import styles from './donut-chart.module.scss';

const RADIUS = 40;
const CENTER = 50;
const STROKE = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Зазор-разделитель между сегментами в единицах viewBox (~2px на экране). */
const GAP = 1.5;

/**
 * Кольцевая диаграмма состава: доли одного целого. Уместна, когда сегментов
 * немного и в центре есть итоговый показатель — здесь это доля кэша. Точные
 * величины и проценты дублируются легендой, поэтому чтение не зависит от оценки
 * угла на глаз. Своя реализация на SVG: дуги — обычные обводки окружности со
 * сдвигом штриха, библиотека графиков ради этого не нужна.
 */
export function DonutChart({ segments, ariaLabel, centerValue, centerLabel }: DonutChartProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (segments.length === 0) return null;

  const arcs = buildDonutArcs(segments.map((segment) => segment.value));
  const active = hovered !== null ? segments[hovered] : undefined;
  const activeArc = hovered !== null ? arcs[hovered] : undefined;

  return (
    <div className={styles.root}>
      <div className={styles.chart}>
        <svg viewBox="0 0 100 100" className={styles.svg} role="img" aria-label={ariaLabel}>
          <circle
            className={styles.track}
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
          />
          <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
            {segments.map((segment, index) => {
              const arc = arcs[index]!;
              const length = arc.fraction * CIRCUMFERENCE - GAP;
              if (length <= 0) return null;
              const dimmed = hovered !== null && hovered !== index;
              return (
                <circle
                  key={segment.id}
                  className={dimmed ? styles.arcDimmed : styles.arc}
                  cx={CENTER}
                  cy={CENTER}
                  r={RADIUS}
                  fill="none"
                  stroke={`var(--series-${segment.seriesIndex})`}
                  strokeWidth={hovered === index ? STROKE + 3 : STROKE}
                  strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
                  strokeDashoffset={-arc.offset * CIRCUMFERENCE}
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered(null)}
                />
              );
            })}
          </g>
        </svg>

        <div className={styles.center}>
          <Typography variant="heading-sm" as="span">
            {active ? active.valueLabel : centerValue}
          </Typography>
          {(active ? active.label : centerLabel) && (
            <Typography variant="caption" color="subtle" as="span">
              {active ? active.label : centerLabel}
            </Typography>
          )}
        </div>

        {active && activeArc && (
          <div className={styles.tooltip}>
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="caption" color="subtle" as="span">
                {active.label}
              </Typography>
              <Typography variant="body-sm" weight="medium" as="span">
                {active.valueLabel} · {Math.round(activeArc.fraction * 100)}%
              </Typography>
            </Stack>
          </div>
        )}
      </div>

      <Stack gap="var(--spacing-2xs)" className={styles.legend}>
        {segments.map((segment, index) => (
          <div
            key={segment.id}
            className={hovered === index ? styles.legendRowActive : styles.legendRow}
            onMouseEnter={() => setHovered(index)}
            onMouseLeave={() => setHovered(null)}
          >
            <span
              className={styles.swatch}
              style={{ backgroundColor: `var(--series-${segment.seriesIndex})` }}
              aria-hidden="true"
            />
            <Typography variant="body-sm" as="span" className={styles.legendLabel}>
              {segment.label}
            </Typography>
            <Typography variant="body-sm" as="span" className={styles.legendValue}>
              {segment.valueLabel}
            </Typography>
            <Typography variant="caption" color="subtle" as="span" className={styles.legendPercent}>
              {Math.round(arcs[index]!.fraction * 100)}%
            </Typography>
          </div>
        ))}
      </Stack>
    </div>
  );
}
