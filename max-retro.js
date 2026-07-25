'use strict';

/*
  ПОЗИТРОН КЕНО — модуль «Макс Ретро»
  Работает отдельно от основного прогноза «Аналоги+».
  Модуль только читает общую базу draws и функции analysis()/transitions().
*/
(() => {
  const MODULE_ID = 'maxRetroPanel';
  const BUTTON_ID = 'maxRetroToolBtn';
  const RESULT_ID = 'maxRetroResult';
  const RUN_ID = 'runMaxRetroBtn';
  const LIMIT_ID = 'maxRetroLimit';

  function getEl(id) {
    return document.getElementById(id);
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function percent(value) {
    return `${Math.round(clamp01(value) * 100)}%`;
  }

  function setSimilarity(a, b) {
    const A = new Set(a || []);
    const B = new Set(b || []);
    const union = new Set([...A, ...B]);
    if (!union.size) return 1;
    let same = 0;
    A.forEach(value => {
      if (B.has(value)) same += 1;
    });
    return same / union.size;
  }

  function closeness(a, b, range) {
    return clamp01(1 - Math.abs(a - b) / range);
  }

  function parityKind(item) {
    if (item.even === item.odd) return 'equal';
    return item.even > item.odd ? 'even' : 'odd';
  }

  function paritySimilarity(a, b) {
    const kindBonus = parityKind(a) === parityKind(b) ? 1 : 0.35;
    const countScore = closeness(a.even, b.even, 10);
    return countScore * 0.7 + kindBonus * 0.3;
  }

  function transitionColumns(index) {
    if (typeof transitions !== 'function') return [];
    return [...transitions(index)].map(number => (number % 10 === 0 ? 10 : number % 10));
  }

  function features(index) {
    const draw = draws[index];
    const info = analysis(draw);
    return {
      index,
      draw,
      info,
      winner: info.winner,
      empty: info.empty || [],
      single: info.single || [],
      transitionNumbers: typeof transitions === 'function' ? [...transitions(index)] : [],
      transitionColumns: transitionColumns(index),
      even: info.even,
      odd: info.odd,
      sum: info.sum
    };
  }

  function compare(target, candidate) {
    const winner = target.winner === candidate.winner ? 1 : 0;
    const empty = setSimilarity(target.empty, candidate.empty);
    const single = setSimilarity(target.single, candidate.single);
    const transitionNumbers = setSimilarity(target.transitionNumbers, candidate.transitionNumbers);
    const transitionColumnsScore = setSimilarity(target.transitionColumns, candidate.transitionColumns);
    const transition = transitionNumbers * 0.6 + transitionColumnsScore * 0.4;
    const parity = paritySimilarity(target, candidate);
    const sum = closeness(target.sum, candidate.sum, 420);

    // Победный столб — важный якорь, но итог не зависит только от него.
    const score =
      winner * 0.27 +
      empty * 0.16 +
      single * 0.15 +
      transition * 0.20 +
      parity * 0.11 +
      sum * 0.11;

    return { score, winner, empty, single, transition, parity, sum };
  }

  function safeDate(draw) {
    try {
      return typeof showDate === 'function' ? showDate(draw.date) : draw.date;
    } catch (_) {
      return draw.date || '';
    }
  }

  function safeTime(draw) {
    try {
      return typeof normTime === 'function' ? normTime(draw.time) : draw.time;
    } catch (_) {
      return draw.time || '';
    }
  }

  function listColumns(items, emptyText) {
    return items.length ? items.map(value => `ст${value}`).join(', ') : emptyText;
  }

  function buildForecast(rows) {
    const scores = Array(11).fill(0);
    const counts = Array(11).fill(0);

    rows.forEach((row, rank) => {
      const nextWinner = analysis(draws[row.nextIndex]).winner;
      const rankWeight = Math.max(0.35, 1 - rank / Math.max(rows.length, 10));
      const weight = (0.45 + row.score * 0.55) * rankWeight;
      scores[nextWinner] += weight;
      counts[nextWinner] += 1;
    });

    const columns = Array.from({ length: 10 }, (_, i) => i + 1)
      .sort((a, b) => scores[b] - scores[a] || counts[b] - counts[a] || a - b)
      .slice(0, 4);

    const total = scores.reduce((sum, value) => sum + value, 0) || 1;
    return { columns, scores, counts, total };
  }

  function render() {
    const box = getEl(RESULT_ID);
    if (!box) return;

    if (typeof draws === 'undefined' || !Array.isArray(draws) || draws.length < 30) {
      box.innerHTML = '<div class="row small">Для Макс Ретро нужно хотя бы 30 сохранённых тиражей.</div>';
      return;
    }
    if (typeof analysis !== 'function') {
      box.innerHTML = '<div class="row small">Не найдена общая функция анализа тиражей.</div>';
      return;
    }

    const requestedLimit = Number(getEl(LIMIT_ID)?.value || 12);
    const limit = Math.max(5, Math.min(30, requestedLimit));
    const targetIndex = draws.length - 1;
    const target = features(targetIndex);
    const rows = [];

    // Последний архивный кандидат должен иметь следующий фактический тираж.
    for (let index = 1; index < targetIndex; index += 1) {
      if (Math.abs(index - targetIndex) < 3) continue;
      const candidate = features(index);
      const result = compare(target, candidate);
      rows.push({ index, nextIndex: index + 1, ...result });
    }

    rows.sort((a, b) => b.score - a.score || draws[b.index].draw - draws[a.index].draw);
    const top = rows.slice(0, limit);

    if (!top.length) {
      box.innerHTML = '<div class="row small">В архиве пока нет подходящих завершённых ситуаций.</div>';
      return;
    }

    const forecast = buildForecast(top);
    const latest = target.draw;
    const forecastCards = forecast.columns.map((column, place) => {
      const share = Math.round((forecast.scores[column] / forecast.total) * 100);
      return `<div class="max-retro-forecast-card">
        <div class="small">${place + 1} место</div>
        <div class="max-retro-column">ст${column}</div>
        <div>${forecast.counts[column]}× · ${share}% веса</div>
      </div>`;
    }).join('');

    const analogs = top.map((row, rank) => {
      const oldDraw = draws[row.index];
      const nextDraw = draws[row.nextIndex];
      const oldInfo = analysis(oldDraw);
      const nextInfo = analysis(nextDraw);
      const parityText = oldInfo.even === oldInfo.odd ? 'поровну' : oldInfo.even > oldInfo.odd ? 'чёт' : 'нечёт';

      return `<div class="max-retro-item">
        <div class="max-retro-item-head">
          <div><b>${rank + 1}. №${oldDraw.draw}</b><div class="small">${safeDate(oldDraw)} ${safeTime(oldDraw)}</div></div>
          <div class="max-retro-score">${percent(row.score)}</div>
        </div>
        <div class="max-retro-state">
          🔴 ст${oldInfo.winner} · ${parityText} ${oldInfo.even}/${oldInfo.odd} · Σ ${oldInfo.sum}<br>
          ☝️ ${listColumns(oldInfo.single || [], 'нет одиночных')}<br>
          ☐ ${listColumns(oldInfo.empty || [], 'нет пустых')}
        </div>
        <div class="max-retro-next">➡️ Следом №${nextDraw.draw}: 🔴 ст${nextInfo.winner}</div>
        <div class="breakdown">
          <span>победный ${percent(row.winner)}</span>
          <span>пустые ${percent(row.empty)}</span>
          <span>одиночные ${percent(row.single)}</span>
          <span>переходы ${percent(row.transition)}</span>
          <span>чётность ${percent(row.parity)}</span>
          <span>сумма ${percent(row.sum)}</span>
        </div>
      </div>`;
    }).join('');

    box.innerHTML = `
      <div class="row max-retro-summary">
        <b>Текущая ситуация: №${latest.draw}</b><br>
        <span class="small">Макс Ретро сравнил её с ${rows.length} завершёнными ситуациями архива. Прогноз ниже независим от «Аналоги+» и не изменяет основной прогноз.</span>
      </div>
      <div class="section"><span>🕰️ Отдельный прогноз Макс Ретро на №${Number(latest.draw) + 1}</span></div>
      <div class="max-retro-forecast-grid">${forecastCards}</div>
      <div class="row small"><b>Основа:</b> что вышло следующим после ${top.length} наиболее похожих архивных ситуаций.</div>
      <div class="section"><span>Лучшие совпадения архива</span></div>
      ${analogs}`;
  }

  function injectStyles() {
    if (getEl('maxRetroStyles')) return;
    const style = document.createElement('style');
    style.id = 'maxRetroStyles';
    style.textContent = `
      .max-retro-title{font-size:17px;font-weight:950}
      .max-retro-controls{display:grid;grid-template-columns:1fr auto;gap:7px;margin-top:10px}
      .max-retro-forecast-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
      .max-retro-forecast-card{border:1px solid #355273;background:#14253b;border-radius:11px;padding:10px;text-align:center}
      .max-retro-column{font-size:26px;font-weight:950;color:#ffd35c;margin:2px 0}
      .max-retro-item{background:#101f33;border:1px solid #2a4464;border-radius:11px;padding:10px;margin-top:8px}
      .max-retro-item-head{display:flex;justify-content:space-between;gap:8px}
      .max-retro-score{font-size:21px;font-weight:950;color:#8eedaa}
      .max-retro-state{margin-top:7px;font-size:12px;line-height:1.55;color:#d2deeb}
      .max-retro-next{margin-top:7px;font-size:17px;font-weight:950;color:#ffd35c}
      .max-retro-summary{border-color:#516c8c}
      @media(min-width:620px){.max-retro-forecast-grid{grid-template-columns:repeat(4,1fr)}}
    `;
    document.head.appendChild(style);
  }

  function injectInterface() {
    if (getEl(BUTTON_ID) || getEl(MODULE_ID)) return;

    const tools = document.querySelector('.tools');
    if (!tools) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.className = 'tool';
    button.type = 'button';
    button.textContent = '🕰️ Макс Ретро ▶';
    tools.appendChild(button);

    const section = document.createElement('section');
    section.id = MODULE_ID;
    section.className = 'card panel';
    section.innerHTML = `
      <div class="max-retro-title">🕰️ Макс Ретро</div>
      <div class="small" style="margin-top:5px">Поиск максимально похожей ситуации во всём сохранённом архиве и проверка, какой победный столб вышел следом.</div>
      <div class="max-retro-controls">
        <select id="${LIMIT_ID}" aria-label="Количество аналогов">
          <option value="8">8 лучших аналогов</option>
          <option value="12" selected>12 лучших аналогов</option>
          <option value="20">20 лучших аналогов</option>
          <option value="30">30 лучших аналогов</option>
        </select>
        <button id="${RUN_ID}" class="tool" type="button">🔎 Найти</button>
      </div>
      <div id="${RESULT_ID}"></div>`;

    const searchPanel = getEl('searchPanel');
    if (searchPanel?.parentNode) {
      searchPanel.parentNode.insertBefore(section, searchPanel);
    } else {
      document.querySelector('.app')?.appendChild(section);
    }

    button.addEventListener('click', () => {
      const willOpen = !section.classList.contains('show');
      section.classList.toggle('show', willOpen);
      button.textContent = willOpen ? '🕰️ Макс Ретро ▼' : '🕰️ Макс Ретро ▶';
      if (willOpen && !getEl(RESULT_ID).innerHTML.trim()) render();
      if (willOpen) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    getEl(RUN_ID)?.addEventListener('click', render);
    getEl(LIMIT_ID)?.addEventListener('change', render);
  }

  function start() {
    injectStyles();
    injectInterface();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
