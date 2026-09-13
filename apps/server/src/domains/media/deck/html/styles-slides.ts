/**
 * Стили раскладок. Отдельным модулем от базовых: базовые описывают ЛИСТ (размер,
 * планка, печать), эти — что на нём стоит. Растащено, чтобы правка одной
 * раскладки не заставляла перечитывать сетку и печать.
 *
 * Размеры везде в `var(--u)` — сотой доле ширины слайда: 1.5u ≈ 19px, и это
 * нижняя граница на лице слайда. Мельче на проекторе не читается.
 */
export const LAYOUT_CSS = `
/* Обложка */
.slide--cover{justify-content:center;padding:calc(6*var(--u)) calc(7*var(--u))}
.cover__kicker{display:flex;align-items:center;gap:calc(1.1*var(--u));
font-size:calc(1.5*var(--u));font-weight:600;letter-spacing:.14em;text-transform:uppercase;
color:var(--accent-bright)}
.cover__kicker i{display:block;width:calc(.9*var(--u));height:calc(.9*var(--u));
border-radius:999px;background:var(--accent-bright)}
.cover__title{margin:calc(2.4*var(--u)) 0 0;font-size:calc(5.6*var(--u));line-height:1.04;
font-weight:700;letter-spacing:-.022em;max-width:22ch}
.cover__title--long{font-size:calc(4.3*var(--u))}
.cover__sub{margin:calc(2.2*var(--u)) 0 0;font-size:calc(2.1*var(--u));line-height:1.35;
color:var(--on-deep-muted);max-width:44ch}
.cover__rule{margin-top:calc(3.4*var(--u));width:calc(18*var(--u));height:calc(.42*var(--u));
border-radius:999px;background:linear-gradient(90deg,var(--accent-bright),transparent);
transform-origin:left center}
.cover__count{position:absolute;right:calc(5.4*var(--u));bottom:calc(3.8*var(--u));
font-size:calc(9*var(--u));font-weight:800;line-height:1;letter-spacing:-.05em;z-index:0;
color:color-mix(in srgb,var(--on-deep) 13%,transparent);user-select:none}

/* Разделитель части */
.slide--section{justify-content:center}
.section__ghost{position:absolute;right:calc(3*var(--u));top:calc(-1.2*var(--u));
font-size:calc(22*var(--u));font-weight:800;line-height:1;letter-spacing:-.04em;
color:color-mix(in srgb,var(--on-deep) 10%,transparent);z-index:0;user-select:none}
.section__title{margin:calc(2*var(--u)) 0 0;font-size:calc(5.2*var(--u));line-height:1.08;
font-weight:700;letter-spacing:-.018em;max-width:24ch}
.section__lede{margin:calc(1.8*var(--u)) 0 0;font-size:calc(2*var(--u));
color:var(--on-deep-muted);max-width:46ch}

/* Один тезис. Слайд-восклицание: широкая полоса акцента слева и крупный набор. */
.slide--statement{padding-left:calc(8.4*var(--u))}
.slide--statement::after{content:"";position:absolute;left:0;top:0;bottom:0;
width:calc(1.5*var(--u));background:linear-gradient(180deg,var(--accent),var(--accent-deep));
z-index:1}
.slide--statement .body{justify-content:center}
.statement__text{margin:0;font-size:calc(4.7*var(--u));line-height:1.14;font-weight:700;
letter-spacing:-.02em;max-width:24ch}
.statement__text--mid{font-size:calc(3.8*var(--u));max-width:28ch}
.statement__text--long{font-size:calc(3*var(--u));max-width:32ch}
.statement__note{margin:calc(2.4*var(--u)) 0 0;font-size:calc(1.9*var(--u));color:var(--muted);
max-width:44ch;padding-left:calc(1.6*var(--u));border-left:calc(.34*var(--u)) solid var(--accent)}

/* Числа */
.stats{display:flex;align-items:stretch;gap:calc(2.6*var(--u));width:100%}
.stat{flex:1 1 0;min-width:0;padding:calc(2*var(--u)) 0 0;border-top:calc(.34*var(--u)) solid var(--accent)}
.stat__value{font-size:calc(6.4*var(--u));line-height:1;font-weight:700;letter-spacing:-.03em;
color:var(--accent-deep);font-variant-numeric:tabular-nums}
.stat__value--mid{font-size:calc(4.8*var(--u))}
.stat__value--long{font-size:calc(3.4*var(--u))}
.stat__label{margin-top:calc(1.2*var(--u));font-size:calc(1.65*var(--u));line-height:1.3;
color:var(--muted)}
.stats__after{margin:calc(3*var(--u)) 0 0;padding:0;list-style:none;
font-size:calc(1.7*var(--u));color:var(--muted);display:flex;gap:calc(2.4*var(--u));flex-wrap:wrap}

/* Две колонки. Панели тянутся на всю высоту: иначе сравнение висит в пустоте. */
.slide--columns .body{justify-content:stretch}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:calc(2.4*var(--u));width:100%;
min-height:0;height:100%}
.col{min-width:0;padding:calc(2.2*var(--u));border-radius:12px;background:#fff;
border:1px solid var(--line);display:flex;flex-direction:column}
.col--accent{background:var(--tint);border-color:color-mix(in srgb,var(--accent) 26%,transparent)}
.col__title{margin:0 0 calc(1.4*var(--u));font-size:calc(2.1*var(--u));font-weight:700;
line-height:1.2;color:var(--accent-deep)}
.col__title::after{content:"";display:block;margin-top:calc(.9*var(--u));width:calc(3.4*var(--u));
height:calc(.3*var(--u));border-radius:999px;background:var(--accent)}
.col ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;
flex:1 1 auto;justify-content:center;
gap:calc(1.3*var(--u));font-size:calc(1.8*var(--u));line-height:1.4}
.col li{padding-left:calc(1.7*var(--u));position:relative}
.col li::before{content:"";position:absolute;left:0;top:calc(.62*var(--u));
width:calc(.7*var(--u));height:calc(.7*var(--u));border-radius:3px;background:var(--accent)}

/* Цитата */
.slide--quote .body{justify-content:center}
.quote{position:relative;padding-left:calc(6.4*var(--u))}
.quote__mark{position:absolute;left:calc(-.6*var(--u));top:calc(-3.6*var(--u));
font-size:calc(14*var(--u));line-height:1;font-weight:700;color:var(--accent);opacity:.24;
user-select:none}
.quote__text{margin:0;font-size:calc(3*var(--u));line-height:1.32;font-style:italic;
font-weight:500;max-width:30ch}
.quote__author{margin-top:calc(2.4*var(--u));font-size:calc(1.8*var(--u));font-weight:600;
color:var(--accent-deep)}

/* Схема */
.slide--figure .body{justify-content:stretch}
.fig{flex:1 1 auto;min-height:0;display:grid;place-items:center;padding:calc(1.2*var(--u));
border-radius:12px;background:#fff;border:1px solid var(--line)}
.fig svg,.fig img{display:block;max-width:100%;max-height:100%;width:auto;height:auto}
.fig__cap{flex:0 0 auto;margin:calc(1.6*var(--u)) 0 0;font-size:calc(1.6*var(--u));
line-height:1.35;color:var(--muted);max-width:80ch}

/* Пункты */
.list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;
gap:calc(1.5*var(--u))}
.list li{position:relative;padding-left:calc(2.6*var(--u));font-size:calc(1.95*var(--u));
line-height:1.42}
.list li::before{content:"";position:absolute;left:0;top:calc(.66*var(--u));
width:calc(1.1*var(--u));height:calc(1.1*var(--u));border-radius:4px;
background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 45%,#fff))}
.list--airy{gap:calc(2.4*var(--u))}
.list--airy li{font-size:calc(2.7*var(--u));padding-left:calc(3.4*var(--u))}
.list--airy li::before{width:calc(1.5*var(--u));height:calc(1.5*var(--u));border-radius:5px;
top:calc(.9*var(--u))}
.list--dense{gap:calc(1.05*var(--u))}
.list--dense li{font-size:calc(1.62*var(--u));padding-left:calc(2.2*var(--u))}
.list--dense li::before{width:calc(.85*var(--u));height:calc(.85*var(--u));top:calc(.55*var(--u))}
.slide--deep .list li::before{background:var(--accent-bright)}

/* Пункты рядом с картинкой */
.split{display:grid;grid-template-columns:1.08fr .92fr;gap:calc(3*var(--u));
align-items:stretch;min-height:0;height:100%}
.split__text{min-width:0;display:flex;flex-direction:column;justify-content:center}
.split__media{display:flex;flex-direction:column;gap:calc(1.4*var(--u));min-height:0;height:100%}
.shot{position:relative;flex:1 1 auto;min-height:0;border-radius:12px;overflow:hidden;
background:var(--tint);box-shadow:0 10px 26px rgba(16,20,30,.18)}
.shot img{display:block;width:100%;height:100%;object-fit:cover}
.shot::after{content:"";position:absolute;inset:auto 0 0 0;height:38%;
background:linear-gradient(to top,rgba(10,12,18,.42),transparent)}
.split .fig{flex:1 1 auto}

/* Источники колоды — последним слайдом */
.srcs{margin:0;padding:0;list-style:none;display:grid;
grid-template-columns:repeat(2,minmax(0,1fr));gap:calc(1.3*var(--u)) calc(2.6*var(--u));
counter-reset:src}
.srcs--one{grid-template-columns:minmax(0,1fr)}
.srcs li{counter-increment:src;min-width:0;padding-left:calc(3.6*var(--u));position:relative;
font-size:calc(1.9*var(--u));line-height:1.3}
.srcs li::before{content:counter(src,decimal-leading-zero);position:absolute;left:0;top:calc(.2*var(--u));
font-size:calc(1.5*var(--u));font-weight:700;color:var(--accent)}
.srcs__title{display:block;font-weight:600}
.srcs__url{display:block;margin-top:calc(.3*var(--u));font-size:calc(1.45*var(--u));
color:var(--muted);overflow-wrap:anywhere;
font-family:ui-monospace,Consolas,"Courier New",monospace}
`;
