import type { ReactNode } from 'react';
import styles from './platform-diagrams.module.scss';

/**
 * Встроенные диаграммы документа «Контур».
 *
 * Рисуются встроенным SVG: внешних библиотек для четырёх картинок заводить
 * незачем, а бандл справки они бы утяжелили на каждый её открытый раздел.
 *
 * Три правила, которые здесь важнее красоты:
 *
 * 1. Цвета — только переменные темы. Захардкоженный `#fff` на тёмной теме даёт
 *    белый прямоугольник с белым текстом, и заметить это можно лишь глазами.
 * 2. У каждой картинки есть `<title>`, и она объявлена `role="img"`: без имени
 *    SVG для чтения с экрана — пустое место. Сами факты картинкой не
 *    заканчиваются: под каждой в документе стоит тот же текст словами, потому
 *    что читатель справки вполне может не видеть картинку вовсе.
 * 3. Подписи короткие и не переносятся: в SVG нет переноса строк, длинная
 *    строка молча уезжает за рамку. Длинное — в `<tspan>` второй строкой.
 */

/** Общая рамка: масштабируется по ширине, имя обязательно. */
function Figure({
  title,
  viewBox,
  children,
}: {
  title: string;
  viewBox: string;
  children: ReactNode;
}) {
  return (
    <svg className={styles.figure} viewBox={viewBox} role="img" aria-label={title}>
      <title>{title}</title>
      {children}
    </svg>
  );
}

/** Прямоугольник с подписью в один или два ряда. */
function Box({
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

/** Стрелка со стрелочным наконечником, нарисованным как треугольник. */
function Arrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 7;
  const tip = `${x2},${y2}`;
  const left = `${x2 - size * Math.cos(angle - 0.4)},${y2 - size * Math.sin(angle - 0.4)}`;
  const right = `${x2 - size * Math.cos(angle + 0.4)},${y2 - size * Math.sin(angle + 0.4)}`;
  return (
    <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} className={styles.arrow} />
      <polygon points={`${tip} ${left} ${right}`} className={styles.arrowHead} />
    </>
  );
}

interface DiagramProps {
  /** Перевод ключа `help.topics.platform.<key>` — словарь остаётся один. */
  tr: (key: string) => string;
}

/** Диаграмма «путь одного запроса»: путь одного запроса и три места, где он может кончиться отказом. */
export function PlatformRequestDiagram({ tr }: DiagramProps) {
  return (
    <Figure title={tr('d2Title')} viewBox="0 0 700 470">
      <Box x={20} y={8} w={300} h={48} lines={[tr('d2Dialect')]} />
      <Arrow x1={170} y1={56} x2={170} y2={76} />
      <Box x={20} y={78} w={300} h={48} lines={[tr('d2Dlp')]} />
      <Arrow x1={170} y1={126} x2={170} y2={146} />
      <Box x={20} y={148} w={300} h={48} lines={[tr('d2Key')]} tone="accent" />
      <Arrow x1={170} y1={196} x2={170} y2={216} />

      <rect x={20} y={218} width={300} height={86} rx={8} className={styles.muted} />
      <text x={170} y={246} className={styles.label} textAnchor="middle">
        {tr('d2Contour')}
      </text>
      <text x={170} y={274} className={styles.note} textAnchor="middle">
        {tr('d2Inside')}
      </text>

      <Arrow x1={170} y1={304} x2={170} y2={324} />
      <Box x={20} y={326} w={300} h={48} lines={[tr('d2Translate')]} />
      <Arrow x1={170} y1={374} x2={170} y2={394} />
      <Box x={20} y={396} w={300} h={48} lines={[tr('d2Spend')]} />

      <Arrow x1={320} y1={252} x2={396} y2={212} />
      <Arrow x1={320} y1={261} x2={396} y2={281} />
      <Arrow x1={320} y1={270} x2={396} y2={350} />
      <Box x={398} y={188} w={288} h={48} lines={[tr('d2Blocked')]} tone="danger" />
      <Box x={398} y={257} w={288} h={48} lines={[tr('d2Budget')]} tone="danger" />
      <Box x={398} y={326} w={288} h={48} lines={[tr('d2Limit')]} tone="danger" />
    </Figure>
  );
}

/** Диаграмма «что происходит с ключом»: где живёт ключ и куда он не попадает. */
export function PlatformKeyDiagram({ tr }: DiagramProps) {
  return (
    <Figure title={tr('d3Title')} viewBox="0 0 700 270">
      <rect x={8} y={20} width={302} height={190} rx={10} className={styles.zone} />
      <text x={159} y={44} className={styles.zoneLabel} textAnchor="middle">
        {tr('d3Panel')}
      </text>
      <Box x={30} y={62} w={258} h={52} lines={[tr('d3Vault')]} />
      <Box x={30} y={134} w={258} h={52} lines={[tr('d3Key')]} tone="accent" />

      <rect x={390} y={20} width={302} height={190} rx={10} className={styles.zone} />
      <text x={541} y={44} className={styles.zoneLabel} textAnchor="middle">
        {tr('d3Files')}
      </text>
      <Box x={412} y={62} w={258} h={52} lines={[tr('d3Address')]} />
      <Box x={412} y={134} w={258} h={52} lines={[tr('d3Stub')]} />

      <line x1={312} y1={115} x2={388} y2={115} className={styles.arrow} />
      <line x1={338} y1={99} x2={362} y2={131} className={styles.cross} />
      <line x1={362} y1={99} x2={338} y2={131} className={styles.cross} />
      <text x={350} y={246} className={styles.note} textAnchor="middle">
        {tr('d3Never')}
      </text>
    </Figure>
  );
}

/** Одна строка матрицы диаграммы 4. */
export interface CapabilityRow {
  label: string;
  /** Полностью · только как собеседник · не работает. */
  mark: 'yes' | 'partial' | 'no';
}

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
