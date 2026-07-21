import { useState } from 'react';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { cellIntensity, gridPosition, labelStep } from './heatmap.model';
import type { HeatmapProps } from './heatmap.types';
import styles from './heatmap.module.scss';

/** Высота одной строки ячеек в пикселях: сетка тянется по ширине контейнера. */
const ROW_HEIGHT = 34;
/** Зазор между ячейками в единицах сетки: фон-разделитель, а не рамка. */
const GAP = 0.08;
const RADIUS = 0.14;

/**
 * Тепловая шкала: величина кодируется насыщенностью одного тона. Форма выбрана
 * под «активность по часам» — 24 ячейки читаются как ритм суток, а не как
 * ломаная линия. Своя реализация на SVG вместо библиотеки: рисунок — сетка
 * прямоугольников, тащить ради неё чужую систему стилей и тем незачем.
 */
export function Heatmap({ cells, ariaLabel, columns, maxAxisLabels = 8, scale }: HeatmapProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (cells.length === 0) return null;

  const cols = columns ?? cells.length;
  const rows = Math.ceil(cells.length / cols);
  const max = Math.max(...cells.map((cell) => cell.value), 0);
  const step = labelStep(cells.length, maxAxisLabels);
  const active = hovered !== null ? cells[hovered] : undefined;
  const activePos = hovered !== null ? gridPosition(hovered, cols) : undefined;

  return (
    <div className={styles.root}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${cols} ${rows}`}
        preserveAspectRatio="none"
        style={{ height: `${rows * ROW_HEIGHT}px` }}
        role="img"
        aria-label={ariaLabel}
      >
        {cells.map((cell, index) => {
          const { row, col } = gridPosition(index, cols);
          return (
            <rect
              key={cell.id}
              className={styles.track}
              x={col + GAP}
              y={row + GAP}
              width={1 - GAP * 2}
              height={1 - GAP * 2}
              rx={RADIUS}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
            />
          );
        })}

        {cells.map((cell, index) => {
          if (cell.value <= 0) return null;
          const { row, col } = gridPosition(index, cols);
          return (
            <rect
              key={cell.id}
              className={styles.cell}
              x={col + GAP}
              y={row + GAP}
              width={1 - GAP * 2}
              height={1 - GAP * 2}
              rx={RADIUS}
              fillOpacity={cellIntensity(cell.value, max)}
            />
          );
        })}

        {activePos && (
          <rect
            className={styles.marker}
            x={activePos.col + GAP}
            y={activePos.row + GAP}
            width={1 - GAP * 2}
            height={1 - GAP * 2}
            rx={RADIUS}
          />
        )}
      </svg>

      <div className={styles.axis} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: cols }, (_, col) => (
          <span key={col} className={styles.axisLabel}>
            {col % step === 0 ? (cells[col]?.label ?? '') : ''}
          </span>
        ))}
      </div>

      {scale && (
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.scale}>
          <Typography variant="caption" color="subtle" as="span">
            {scale.min}
          </Typography>
          <span className={styles.scaleBar} aria-hidden="true" />
          <Typography variant="caption" color="subtle" as="span">
            {scale.max}
          </Typography>
        </Stack>
      )}

      {active && activePos && (
        <div
          className={styles.tooltip}
          style={{
            left: `${((activePos.col + 0.5) / cols) * 100}%`,
            top: `${activePos.row * ROW_HEIGHT}px`,
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
