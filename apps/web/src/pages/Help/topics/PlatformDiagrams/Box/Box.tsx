import styles from './Box.module.scss';

/** Прямоугольник с подписью в один или два ряда. */
export function Box({
  x,
  y,
  w,
  h,
  lines,
  tone = 'plain',
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  tone?: 'plain' | 'accent' | 'muted' | 'danger';
}) {
  const cx = x + w / 2;
  const first = y + h / 2 - (lines.length - 1) * 9;
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx={8} className={styles[tone]} />
      <text x={cx} y={first} className={styles.label} textAnchor="middle" dominantBaseline="middle">
        {lines.map((line, index) => (
          <tspan key={line} x={cx} dy={index === 0 ? 0 : 18}>
            {line}
          </tspan>
        ))}
      </text>
    </>
  );
}
