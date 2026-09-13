import {
  DECK_FONT_CSS,
  DECK_INK,
  DECK_LINE,
  DECK_MUTED,
  DECK_ON_DEEP,
  DECK_ON_DEEP_MUTED,
  DECK_PAPER,
  type DeckPalette,
  hex,
} from '../theme.ts';
import { LAYOUT_CSS } from './styles-slides.ts';

/**
 * Стили колоды. Всё в одном теге `<style>` — ни ссылки на CDN, ни шрифта из
 * сети: страница открывается в песочнице с `default-src 'none'`, где внешнее
 * молча не загрузится, и уезжает человеку файлом.
 *
 * ЕДИНИЦА РАЗМЕРА — `1cqw`, сотая доля ширины слайда. Слайд объявлен
 * контейнером, поэтому одна и та же вёрстка даёт одинаковую картинку и в
 * маленьком окне панели, и на печати, где слайд ровно 13.333in (те же 1280
 * пикселей при 96 на дюйм). Запасное значение 12.8px стоит перед `@supports`:
 * браузер без единиц контейнера покажет колоду в её «родном» размере, а не
 * рассыпет текст.
 */
export function deckStyles(palette: DeckPalette): string {
  return `${paletteVars(palette)}${BASE_CSS}${LAYOUT_CSS}${PRINT_CSS}`;
}

function paletteVars(palette: DeckPalette): string {
  return `:root{
--accent:${hex(palette.accent)};
--accent-deep:${hex(palette.accentDeep)};
--accent-bright:${hex(palette.accentBright)};
--tint:${hex(palette.tint)};
--deep:${hex(palette.deep)};
--deep-alt:${hex(palette.deepAlt)};
--ink:${hex(DECK_INK)};
--paper:${hex(DECK_PAPER)};
--muted:${hex(DECK_MUTED)};
--line:${hex(DECK_LINE)};
--on-deep:${hex(DECK_ON_DEEP)};
--on-deep-muted:${hex(DECK_ON_DEEP_MUTED)};
--font:${DECK_FONT_CSS};
}`;
}

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{scroll-snap-type:y proximity;background:#0e0f12}
body{margin:0;padding:3.2vh 0;display:flex;flex-direction:column;align-items:center;gap:2.4vh;
background:#0e0f12;font-family:var(--font);color:var(--ink);
-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.item{width:min(1280px,94vw)}
.slide{--u:12.8px;position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;
scroll-snap-align:center;
border-radius:14px;background:var(--paper);color:var(--ink);
box-shadow:0 18px 48px rgba(0,0,0,.45);
display:flex;flex-direction:column;
padding:calc(4.6*var(--u)) calc(6*var(--u));
font-size:calc(1.95*var(--u));line-height:1.45}
@supports (width:1cqw){.slide{container-type:size;--u:1cqw}}
.slide--deep{background:var(--deep);color:var(--on-deep)}
.slide--deep::before{content:"";position:absolute;inset:0;
background:
radial-gradient(66% 96% at 88% -8%,color-mix(in srgb,var(--accent-bright) 46%,transparent) 0,transparent 64%),
radial-gradient(52% 74% at 6% 104%,color-mix(in srgb,var(--accent) 52%,transparent) 0,transparent 66%),
linear-gradient(128deg,var(--deep) 0%,var(--deep-alt) 96%);
z-index:0}
.slide--deep::after{content:"";position:absolute;inset:0;z-index:0;opacity:.16;
background:repeating-linear-gradient(122deg,transparent 0 calc(3.4*var(--u)),
color-mix(in srgb,var(--on-deep) 42%,transparent) calc(3.4*var(--u)) calc(3.5*var(--u)))}
.slide--paper::before{content:"";position:absolute;inset:0;z-index:0;
background:
radial-gradient(54% 80% at 102% -6%,color-mix(in srgb,var(--accent) 16%,transparent) 0,transparent 72%),
radial-gradient(40% 64% at -6% 108%,color-mix(in srgb,var(--accent) 11%,transparent) 0,transparent 70%),
linear-gradient(158deg,var(--tint) 0%,#fff 46%,#fff 58%,var(--tint) 100%)}
.slide>*{position:relative;z-index:1}

/* Шапка слайда: планка акцента, заголовок, воздух под ним. */
.head{flex:0 0 auto;margin-bottom:calc(2.6*var(--u))}
.rule{width:calc(4.6*var(--u));height:calc(.42*var(--u));border-radius:999px;
background:var(--accent);transform-origin:left center}
.slide--deep .rule{background:var(--accent-bright)}
.title{margin:calc(1.5*var(--u)) 0 0;font-size:calc(3.3*var(--u));line-height:1.14;
font-weight:700;letter-spacing:-.012em}
.title--small{font-size:calc(2.6*var(--u))}
.eyebrow{margin:0 0 calc(.9*var(--u));font-size:calc(1.45*var(--u));font-weight:600;
letter-spacing:.09em;text-transform:uppercase;color:var(--accent-deep)}
.slide--deep .eyebrow{color:var(--accent-bright)}
.body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:center}
.body--top{justify-content:flex-start}

/* Нижняя планка: чья это колода и где мы в ней. Ничего мельче 18px на лице слайда. */
.foot{flex:0 0 auto;display:flex;align-items:center;gap:calc(1.4*var(--u));
margin-top:calc(2.2*var(--u));padding-top:calc(1.2*var(--u));
border-top:1px solid var(--line);font-size:calc(1.45*var(--u));color:var(--muted)}
.slide--deep .foot{border-top-color:color-mix(in srgb,var(--on-deep) 22%,transparent);
color:var(--on-deep-muted)}
.foot__name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.foot__bar{flex:0 0 calc(14*var(--u));height:calc(.34*var(--u));border-radius:999px;
background:var(--line);overflow:hidden}
.slide--deep .foot__bar{background:color-mix(in srgb,var(--on-deep) 24%,transparent)}
.foot__bar i{display:block;height:100%;border-radius:999px;background:var(--accent)}
.slide--deep .foot__bar i{background:var(--accent-bright)}
.foot__num{flex:0 0 auto;font-variant-numeric:tabular-nums;font-weight:600;color:var(--ink)}
.slide--deep .foot__num{color:var(--on-deep)}

/* Сноски слайда: источники именно этого слайда, мелко, но читаемо. */
.cites{flex:0 0 auto;margin:calc(1.6*var(--u)) 0 0;padding:0;list-style:none;
display:flex;flex-wrap:wrap;gap:calc(.5*var(--u)) calc(1.8*var(--u));
font-size:calc(1.4*var(--u));color:var(--muted)}
.cites li{max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cites b{font-weight:600;color:var(--accent-deep)}
.slide--deep .cites{color:var(--on-deep-muted)}
.slide--deep .cites b{color:var(--accent-bright)}

/* Заметки докладчику — ПОД слайдом и никогда на его лице. */
.notes{width:min(1280px,94vw);margin:0 auto;color:#c9ced8;font-size:15px;line-height:1.55}
.notes summary{cursor:pointer;padding:10px 14px;border-radius:10px;background:#181b21;
color:#e7eaf0;font-weight:600;font-size:14px;letter-spacing:.02em;list-style:none}
.notes summary::-webkit-details-marker{display:none}
.notes summary::before{content:"▸ ";color:var(--accent-bright)}
.notes[open] summary::before{content:"▾ "}
.notes__text{margin:8px 0 0;padding:12px 16px;border-left:3px solid var(--accent-bright);
background:#14161b;border-radius:0 10px 10px 0}
.notes__text p{margin:0 0 8px}
.notes__text p:last-child{margin:0}

/* Движение: только CSS, только по прокрутке. Ни одного скрипта на странице. */
@keyframes rise{from{opacity:0;transform:translateY(calc(2.4*var(--u)))}to{opacity:1;transform:none}}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes zoom{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}
@supports (animation-timeline:view()){
.slide .head,.slide .body>*,.slide .cites,.slide .foot,
.slide .list li,.slide .srcs li,.slide .stat,.slide .col{
animation:rise both;animation-timeline:view();
animation-range:cover calc(4% + var(--i,0)*3%) cover calc(40% + var(--i,0)*3%)}
.slide .rule{animation:grow both;animation-timeline:view();animation-range:cover 4% cover 34%}
.slide .shot,.slide .fig{animation:zoom both;animation-timeline:view();
animation-range:cover 6% cover 42%}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

const PRINT_CSS = `
@page{size:13.333in 7.5in;margin:0}
@media print{
html,body{background:#fff}
body{display:block;padding:0;gap:0}
.item{width:100%;margin:0;break-after:page;page-break-after:always}
.item:last-child{break-after:auto;page-break-after:auto}
.slide{width:100%;height:7.5in;aspect-ratio:auto;border-radius:0;box-shadow:none;
break-inside:avoid;page-break-inside:avoid}
.notes{display:none!important}
*{animation:none!important;transition:none!important;
-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;
