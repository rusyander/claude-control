import { useState } from 'react';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './time-series.module.scss';
import { PADDING, VIEW_WIDTH } from './time-series.constants';
import type { TimeSeriesProps } from './time-series.types';

/**
 * Динамика во времени: линия с заливкой и подсказкой по наведению.
 * Своя реализация на SVG вместо библиотеки графиков — рисунок простой,
 * а зависимость потянула бы за собой свою систему стилей и тем.
 */
export function TimeSeries({ points, seriesName, height = 220 }: TimeSeriesProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (points.length === 0) return null;

  const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = height - PADDING.top - PADDING.bottom;
  const max = Math.max(...points.map((point) => point.value), 1);

  const positionOf = (index: number): number =>
    PADDING.left +
    (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);

  const heightOf = (value: number): number => PADDING.top + plotHeight - (value / max) * plotHeight;

  const linePath = points
    .map(
      (point, index) => `${index === 0 ? 'M' : 'L'} ${positionOf(index)} ${heightOf(point.value)}`,
    )
    .join(' ');

  const areaPath = `${linePath} L ${positionOf(points.length - 1)} ${PADDING.top + plotHeight} L ${positionOf(0)} ${PADDING.top + plotHeight} Z`;

  // Подписи оси прореживаем: на месяце данных все даты не помещаются.
  const labelStep = Math.max(1, Math.ceil(points.length / 8));
  const active = hovered !== null ? points[hovered] : undefined;

  return (
    <div className={styles.root}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={seriesName}
      >
        {[0, 0.5, 1].map((ratio) => (
          <line
            key={ratio}
            className={styles.grid}
            x1={PADDING.left}
            x2={VIEW_WIDTH - PADDING.right}
            y1={PADDING.top + plotHeight * ratio}
            y2={PADDING.top + plotHeight * ratio}
          />
        ))}

        <path className={styles.area} d={areaPath} />
        <path className={styles.line} d={linePath} />

        {active && hovered !== null && (
          <>
            <line
              className={styles.crosshair}
              x1={positionOf(hovered)}
              x2={positionOf(hovered)}
              y1={PADDING.top}
              y2={PADDING.top + plotHeight}
            />
            <circle
              className={styles.marker}
              cx={positionOf(hovered)}
              cy={heightOf(active.value)}
              r={5}
            />
          </>
        )}

        {points.map((point, index) =>
          index % labelStep === 0 ? (
            <text
              // Ключ по номеру точки, а не по подписи: подписи повторяются —
              // при почасовой разбивке «00:00» встречается каждый день.
              key={index}
              className={styles.axisLabel}
              x={positionOf(index)}
              y={height - 6}
              textAnchor="middle"
            >
              {point.label}
            </text>
          ) : null,
        )}

        {points.map((_point, index) => (
          <rect
            key={index}
            className={styles.hitArea}
            x={positionOf(index) - plotWidth / points.length / 2}
            y={PADDING.top}
            width={plotWidth / points.length}
            height={plotHeight}
            onMouseEnter={() => setHovered(index)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </svg>

      {active && hovered !== null && (
        <div
          className={styles.tooltip}
          style={{
            left: `${(positionOf(hovered) / VIEW_WIDTH) * 100}%`,
            top: `${(heightOf(active.value) / height) * 100 - 6}%`,
          }}
        >
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="caption" color="subtle" as="span">
              {active.label}
            </Typography>
            <Typography variant="body-sm" weight="medium" as="span">
              {active.valueLabel}
            </Typography>
          </Stack>
        </div>
      )}
    </div>
  );
}
