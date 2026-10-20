import { useRef, type CSSProperties, type ReactNode } from 'react';
import type { MascotMood, MascotProps } from './mascot.types';
import { useMascotActs } from './use-mascot-acts';
import styles from './mascot.module.scss';

/** Холст рисунка: 64 единицы, все координаты ниже — в них. */
const VIEW = '0 0 64 64';

/** Рот под каждое настроение: мимика держится на нём не меньше, чем на глазе. */
const MOUTH: Record<MascotMood, string> = {
  idle: 'M27 48 Q32 52.5 37 48',
  working: 'M28.5 49.5 H35.5',
  waiting: '',
  error: 'M27 51.5 Q32 46.5 37 51.5',
  happy: 'M25.5 47 Q32 56 38.5 47 Z',
  sleeping: 'M30 49.5 H34',
  thinking: 'M29 50 Q32 48 35 50',
  waving: 'M25.5 47 Q32 56 38.5 47 Z',
  lost: 'M26 49.5 q1.5 -2 3 0 t3 0 t3 0 t3 0',
  dizzy: 'M26 49.5 q1.5 -2 3 0 t3 0 t3 0 t3 0',
};

/** Бровь — только там, где без неё эмоция не читается. */
const BROW: Partial<Record<MascotMood, string>> = {
  error: 'M25 15.5 L39 13',
  waiting: 'M26 14 Q32 10.5 38 14',
  thinking: 'M27 14.5 Q33 11 38 13.5',
  lost: 'M26 13.5 L38 15.5',
};

/** Закрытый глаз (сон) и глаз-улыбка (радость, привет) — дуги вместо зрачка. */
const EYE_ARC: Partial<Record<MascotMood, string>> = {
  sleeping: 'M23.5 31 Q32 37.5 40.5 31',
  happy: 'M23.5 34 Q32 24 40.5 34',
  waving: 'M23.5 34 Q32 24 40.5 34',
};

/** Глаз-спираль: от центра наружу, четыре полуоборота. */
const SPIRAL =
  'M32 31 a1.6 1.6 0 1 1 1.6 1.6 a3.4 3.4 0 1 1 -3.4 -3.4 a5.4 5.4 0 1 1 5.4 5.4 a7.2 7.2 0 1 1 -7.2 -7.2';

/**
 * Деления шкалы: ровно девять на окружность (2π·13,5 ≈ 84,82), поэтому поворот
 * на 40° совпадает с исходным рисунком — «щелчок» шкалы возвращается без скачка.
 */
const RING_DASH = '4.4 5.0248';

/** Искры радости: центр и радиус в единицах холста. */
const SPARKS: readonly (readonly [number, number, number])[] = [
  [6, 14, 4],
  [58, 20, 3.2],
  [4, 50, 2.6],
  [60, 46, 3.6],
];

/** Четырёхлучевая искра в квадрате −1…1. */
const SPARK = 'M0 -1 Q0.28 -0.28 1 0 Q0.28 0.28 0 1 Q-0.28 0.28 -1 0 Q-0.28 -0.28 0 -1 Z';

const pct = (units: number): string => `${(units / 64) * 100}%`;

/** Слой во весь холст: свой SVG, чтобы двигаться отдельно от корпуса. */
function Layer({ className, children }: { className: string | undefined; children: ReactNode }) {
  return (
    <svg viewBox={VIEW} fill="none" className={`${styles.layer} ${className}`} aria-hidden="true">
      {children}
    </svg>
  );
}

/** Глаз под настроение: спираль, дуга или склера со зрачком. */
function Eye({ mood }: { mood: MascotMood }) {
  if (mood === 'dizzy') {
    return (
      <Layer className={styles.spiral}>
        <path className={styles.ink} d={SPIRAL} strokeWidth="2" />
      </Layer>
    );
  }
  const arc = EYE_ARC[mood];
  if (arc) {
    return (
      <Layer className={styles.arc}>
        <path className={styles.ink} d={arc} strokeWidth="2.8" />
      </Layer>
    );
  }
  return (
    <>
      <Layer className={styles.sclera}>
        <circle className={styles.white} cx="32" cy="31" r="9.5" />
      </Layer>
      <Layer className={styles.pupil}>
        <circle className={styles.iris} cx="32" cy="31" r={mood === 'error' ? 3.4 : 4.6} />
        <circle className={styles.white} cx="33.7" cy="29.3" r="1.4" />
      </Layer>
    </>
  );
}

/**
 * Дека — маскот панели: знак приложения, который ожил. Корпус — тот же
 * скруглённый квадрат цвета акцента, кольцо с делениями — шкала вокруг
 * единственного глаза, точка отсчёта — зрачок. Поэтому он перекрашивается вместе
 * с темой и акцентом и узнаётся как «свой», а не как наклейка поверх панели.
 *
 * Каждая подвижная часть — отдельный слой-элемент (не группа внутри одного SVG):
 * так браузер двигает её на видеокарте, не перерисовывая рисунок. Постоянно
 * движется только `working`; остальные настроения неподвижны между разовыми
 * действиями (`data-act`, см. `use-mascot-acts`). «Меньше движения» гасит всё.
 */
export function Mascot({ mood = 'idle', size = 48, look, label, className }: MascotProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  useMascotActs(rootRef, mood);
  const brow = BROW[mood];
  const mouth = MOUTH[mood];
  const style = {
    width: size,
    height: size,
    '--mascot-unit': `${size / 64}px`,
    ...(look && {
      '--look-x': Math.max(-1, Math.min(1, look.x)),
      '--look-y': Math.max(-1, Math.min(1, look.y)),
    }),
  } as CSSProperties;

  return (
    <span
      ref={rootRef}
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-mood={mood}
      data-mascot
      style={style}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <span className={styles.shadow} />
      <span className={styles.figure}>
        <Layer className={styles.armLeft}>
          <path className={styles.limb} d="M11 36 Q5.5 40 6 47" strokeWidth="4" />
        </Layer>
        <Layer className={styles.armRight}>
          <path className={styles.limb} d="M53 36 Q58.5 40 58 47" strokeWidth="4" />
        </Layer>

        <Layer className={styles.body}>
          <line x1="32" y1="12" x2="32" y2="5.5" className={styles.limb} strokeWidth="2.4" />
          <rect className={styles.foot} x="20.5" y="54" width="8" height="6" rx="3" />
          <rect className={styles.foot} x="35.5" y="54" width="8" height="6" rx="3" />
          <rect className={styles.shell} x="9" y="11" width="46" height="46" rx="14" />
          <path className={styles.gloss} d="M15.5 21 Q17 15.5 23 14.5" strokeWidth="2.4" />
          {brow && <path className={styles.ink} d={brow} strokeWidth="2.2" />}
          <ellipse className={styles.cheek} cx="17" cy="44" rx="3.2" ry="2" />
          <ellipse className={styles.cheek} cx="47" cy="44" rx="3.2" ry="2" />
          {mood === 'waiting' ? (
            <ellipse className={styles.mouthFill} cx="32" cy="49.5" rx="2.4" ry="2.8" />
          ) : (
            <path
              className={mouth.endsWith('Z') ? styles.mouthFill : styles.mouth}
              d={mouth}
              strokeWidth="2.2"
            />
          )}
        </Layer>

        <Layer className={styles.ring}>
          <circle
            cx="32"
            cy="31"
            r="13.5"
            className={styles.ink}
            strokeWidth="2.6"
            strokeDasharray={RING_DASH}
            transform="rotate(-75 32 31)"
          />
        </Layer>

        <span className={styles.eye}>
          <Eye mood={mood} />
        </span>
        <span className={styles.led} />
      </span>

      {mood === 'waiting' && (
        <Layer className={styles.alert}>
          <circle className={styles.alertDot} cx="55" cy="9" r="7" />
          <path className={styles.alertMark} d="M55 5 V10" strokeWidth="2.4" />
          <circle className={styles.white} cx="55" cy="13" r="1.3" />
        </Layer>
      )}
      {mood === 'sleeping' && (
        <span className={styles.snore}>
          <span>z</span>
          <span>z</span>
          <span>z</span>
        </span>
      )}
      {(mood === 'thinking' || mood === 'lost') && <span className={styles.question}>?</span>}
      {mood === 'happy' &&
        SPARKS.map(([x, y, r], index) => (
          <svg
            key={`${x}-${y}`}
            viewBox="-1 -1 2 2"
            className={styles.spark}
            style={{
              left: pct(x - r),
              top: pct(y - r),
              width: pct(2 * r),
              height: pct(2 * r),
              animationDelay: `${index * 220}ms`,
            }}
            aria-hidden="true"
          >
            <path d={SPARK} />
          </svg>
        ))}
    </span>
  );
}
