'use strict';

/*
  ПОЗИТРОН КЕНО v7.1 — модуль «Чётная волна»
  4 тройки / 12 уникальных чётных чисел.
  Модуль использует только завершённые тиражи, фиксирует живой прогноз
  и выполняет хронологическую проверку 70/30 без заглядывания в будущее.
*/
(() => {
  const MODULE_ID = 'evenWavePanel';
  const BUTTON_ID = 'evenWaveToolBtn';
  const RESULT_ID = 'evenWaveResult';
  const AUDIT_ID = 'evenWaveAudit';
  const CHECK_ID = 'evenWaveCheck';
  const RUN_ID = 'runEvenWaveBtn';
  const AUDIT_BTN_ID = 'auditEvenWaveBtn';
  const BASE_STATUS_ID = 'evenWaveBaseStatus';
  const BASE_URL = 'keno-history-v71.json';
  const PREDICTIONS_KEY = 'pozitron_v71_even_wave_predictions_v1';
  const AUDIT_CACHE_KEY = 'pozitron_v71_even_wave_audit_v1';

  const FEATURE_SIZES = [9, 32, 6, 11, 3, 10, 2, 5, 5, 3, 5, 5];
  const FEATURE_WEIGHTS = [0.25, 0.55, 0.15, 0.12, 0.18, 0.10, 0.18, 0.55, 0.08, 0.05, 0.25, 0.05];
  const GROUPS = [
    { key: 'joint', label: 'Совместная', icon: '🔗' },
    { key: 'dense', label: 'Плотная', icon: '🧲' },
    { key: 'angle', label: 'Угловая', icon: '📐' },
    { key: 'scatter', label: 'Разрозненная', icon: '✨' }
  ];

  let matrixCache = null;
  let liveTablesCache = null;
  let openingStarted = false;

  function el(id) {
    return document.getElementById(id);
  }

  function sleepFrame() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function evenNumber(position) {
    return (position + 1) * 2;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function currentSignature() {
    if (typeof draws === 'undefined' || !Array.isArray(draws) || !draws.length) return '0';
    return `${draws.length}:${draws[0].draw}:${draws.at(-1).draw}`;
  }

  function buildMatrix() {
    const signature = currentSignature();
    if (matrixCache?.signature === signature) return matrixCache;

    const n = Array.isArray(draws) ? draws.length : 0;
    const data = new Uint8Array(n * 40);
    for (let i = 0; i < n; i += 1) {
      const balls = new Set(draws[i].balls || []);
      const offset = i * 40;
      for (let j = 0; j < 40; j += 1) {
        data[offset + j] = balls.has(evenNumber(j)) ? 1 : 0;
      }
    }
    matrixCache = { signature, n, data };
    liveTablesCache = null;
    return matrixCache;
  }

  function cell(matrix, row, position) {
    if (row < 0 || row >= matrix.n || position < 0 || position >= 40) return 0;
    return matrix.data[row * 40 + position];
  }

  // out[0..11] — калибруемые признаки; out[12..13] — подписанные углы.
  function featureValues(matrix, t, j, out) {
    let gap = 0;
    if (!cell(matrix, t, j)) {
      let row = t;
      while (row >= 0 && !cell(matrix, row, j) && gap < 8) {
        gap += 1;
        row -= 1;
      }
    }

    let pattern = 0;
    let count5 = 0;
    for (let back = 4; back >= 0; back -= 1) {
      const value = cell(matrix, t - back, j);
      pattern = (pattern << 1) | value;
      count5 += value;
    }

    let count10 = 0;
    for (let back = 0; back < 10; back += 1) count10 += cell(matrix, t - back, j);

    const neighbors = cell(matrix, t, j - 1) + cell(matrix, t, j + 1);
    let local3 = 0;
    for (let back = 0; back < 3; back += 1) {
      local3 += cell(matrix, t - back, j - 1);
      local3 += cell(matrix, t - back, j);
      local3 += cell(matrix, t - back, j + 1);
    }
    const insert = !cell(matrix, t, j) && cell(matrix, t, j - 1) && cell(matrix, t, j + 1) ? 1 : 0;

    let bestContinuation = 0;
    let bestContinuationShift = 0;
    for (let shift = -4; shift <= 4; shift += 1) {
      if (!shift) continue;
      let length = 0;
      for (let back = 0; back < 4; back += 1) {
        const position = j - (back + 1) * shift;
        if (cell(matrix, t - back, position)) length += 1;
        else break;
      }
      if (length > bestContinuation) {
        bestContinuation = length;
        bestContinuationShift = shift;
      }
    }

    let bestReflection = 0;
    let bestReflectionShift = 0;
    for (let shift = -4; shift <= 4; shift += 1) {
      if (!shift) continue;
      const points = [
        [t, j + shift],
        [t - 1, j],
        [t - 2, j - shift],
        [t - 3, j - 2 * shift]
      ];
      let length = 0;
      for (const [row, position] of points) {
        if (cell(matrix, row, position)) length += 1;
        else break;
      }
      if (length > bestReflection) {
        bestReflection = length;
        bestReflectionShift = shift;
      }
    }

    out[0] = gap;
    out[1] = pattern;
    out[2] = count5;
    out[3] = count10;
    out[4] = neighbors;
    out[5] = local3;
    out[6] = insert;
    out[7] = bestContinuation;
    out[8] = Math.abs(bestContinuationShift);
    out[9] = bestContinuationShift < 0 ? 0 : bestContinuationShift > 0 ? 2 : 1;
    out[10] = bestReflection;
    out[11] = Math.abs(bestReflectionShift);
    out[12] = bestContinuationShift;
    out[13] = bestReflectionShift;
    return out;
  }

  function createTables() {
    return FEATURE_SIZES.map(size => ({ hits: new Uint32Array(size), counts: new Uint32Array(size) }));
  }

  async function trainTables(matrix, start, endExclusive, progress) {
    const tables = createTables();
    const f = new Int16Array(14);
    const from = Math.max(10, start);
    const to = Math.min(endExclusive, matrix.n - 1);

    for (let t = from; t < to; t += 1) {
      for (let j = 0; j < 40; j += 1) {
        featureValues(matrix, t, j, f);
        const outcome = cell(matrix, t + 1, j);
        for (let k = 0; k < FEATURE_SIZES.length; k += 1) {
          const bucket = clamp(f[k], 0, FEATURE_SIZES[k] - 1);
          tables[k].counts[bucket] += 1;
          tables[k].hits[bucket] += outcome;
        }
      }
      if ((t - from) % 300 === 0) {
        progress?.(t - from, Math.max(1, to - from));
        await sleepFrame();
      }
    }
    progress?.(to - from, Math.max(1, to - from));
    return tables;
  }

  function scoreCandidate(matrix, t, j, tables, f) {
    featureValues(matrix, t, j, f);
    let score = 0.25;
    for (let k = 0; k < FEATURE_SIZES.length; k += 1) {
      const bucket = clamp(f[k], 0, FEATURE_SIZES[k] - 1);
      const hits = tables[k].hits[bucket];
      const count = tables[k].counts[bucket];
      const rate = (hits + 25) / (count + 100); // сглаживание к базовым 25%
      score += FEATURE_WEIGHTS[k] * (rate - 0.25);
    }
    return clamp(score, 0.05, 0.55);
  }

  function makeCandidates(matrix, t, tables) {
    const f = new Int16Array(14);
    const candidates = [];
    for (let j = 0; j < 40; j += 1) {
      const score = scoreCandidate(matrix, t, j, tables, f);
      candidates.push({
        j,
        score,
        present: cell(matrix, t, j),
        contLength: f[7],
        contShift: f[12],
        reflectionLength: f[10],
        reflectionShift: f[13]
      });
    }
    return candidates;
  }

  const DENSE_SHAPES = (() => {
    const shapes = [];
    for (let a = 0; a <= 5; a += 1) {
      for (let b = a + 1; b <= 6; b += 1) {
        for (let c = b + 1; c <= 7; c += 1) {
          const span = c - a;
          if (span < 3 || span > 7) continue;
          if (b === a + 1 && c === b + 1) continue;
          shapes.push([a, b, c]);
        }
      }
    }
    return shapes;
  })();

  function chooseGroups(matrix, t, tables) {
    const candidates = makeCandidates(matrix, t, tables);
    const byPosition = candidates;
    const used = new Set();
    const result = [];

    let bestJoint = null;
    for (let start = 0; start <= 37; start += 1) {
      const positions = [start, start + 1, start + 2];
      const score = positions.reduce((sum, p) => sum + byPosition[p].score + byPosition[p].present * 0.015, 0);
      if (!bestJoint || score > bestJoint.score) bestJoint = { score, positions };
    }
    result.push({ key: 'joint', positions: bestJoint.positions });
    bestJoint.positions.forEach(position => used.add(position));

    let bestDense = null;
    for (const shape of DENSE_SHAPES) {
      for (let start = 0; start + shape[2] < 40; start += 1) {
        const positions = shape.map(offset => start + offset);
        if (positions.some(position => used.has(position))) continue;
        const span = positions[2] - positions[0];
        const score = positions.reduce((sum, p) => sum + byPosition[p].score, 0) - span * 0.003;
        if (!bestDense || score > bestDense.score) bestDense = { score, positions };
      }
    }
    if (!bestDense) {
      const positions = [...candidates].sort((a, b) => b.score - a.score).filter(x => !used.has(x.j)).slice(0, 3).map(x => x.j);
      bestDense = { score: 0, positions };
    }
    result.push({ key: 'dense', positions: bestDense.positions.slice().sort((a, b) => a - b) });
    bestDense.positions.forEach(position => used.add(position));

    const angleRank = candidates
      .filter(candidate => !used.has(candidate.j))
      .map(candidate => ({
        ...candidate,
        angleScore: candidate.score + candidate.contLength * 0.035 + candidate.reflectionLength * 0.018 - Math.abs(candidate.contShift) * 0.002
      }))
      .sort((a, b) => b.angleScore - a.angleScore || b.score - a.score || a.j - b.j);
    const anglePositions = angleRank.slice(0, 3).map(x => x.j).sort((a, b) => a - b);
    result.push({ key: 'angle', positions: anglePositions });
    anglePositions.forEach(position => used.add(position));

    const remaining = [...candidates].sort((a, b) => b.score - a.score || a.j - b.j).filter(x => !used.has(x.j));
    const scatterPositions = [];
    for (const candidate of remaining) {
      if (scatterPositions.every(position => Math.abs(position - candidate.j) >= 5)) scatterPositions.push(candidate.j);
      if (scatterPositions.length === 3) break;
    }
    for (const candidate of remaining) {
      if (scatterPositions.length === 3) break;
      if (!scatterPositions.includes(candidate.j)) scatterPositions.push(candidate.j);
    }
    scatterPositions.sort((a, b) => a - b);
    result.push({ key: 'scatter', positions: scatterPositions });

    // Защита: ровно 12 уникальных позиций.
    const all = new Set(result.flatMap(group => group.positions));
    if (all.size < 12) {
      const fallback = remaining.filter(x => !all.has(x.j));
      for (const group of result) {
        while (group.positions.length < 3 && fallback.length) {
          const next = fallback.shift().j;
          group.positions.push(next);
          all.add(next);
        }
      }
    }

    result.forEach(group => {
      group.positions.sort((a, b) => a - b);
      group.numbers = group.positions.map(evenNumber);
      group.meanScore = group.positions.reduce((sum, position) => sum + byPosition[position].score, 0) / 3;
      group.details = group.positions.map(position => {
        const candidate = byPosition[position];
        return {
          number: evenNumber(position),
          score: candidate.score,
          contLength: candidate.contLength,
          contShift: candidate.contShift,
          reflectionLength: candidate.reflectionLength,
          reflectionShift: candidate.reflectionShift
        };
      });
    });

    return { groups: result, candidates };
  }

  function choose(n, k) {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    let value = 1;
    for (let i = 1; i <= k; i += 1) value = value * (n - k + i) / i;
    return value;
  }

  function hypergeomAtLeast3(successes, sample = 12, population = 40) {
    const denominator = choose(population, sample);
    let probability = 0;
    for (let hits = 3; hits <= Math.min(sample, successes); hits += 1) {
      probability += choose(successes, hits) * choose(population - successes, sample - hits) / denominator;
    }
    return probability;
  }

  function loadPredictions() {
    try {
      const value = JSON.parse(localStorage.getItem(PREDICTIONS_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function savePredictions(items) {
    localStorage.setItem(PREDICTIONS_KEY, JSON.stringify(items.slice(-300)));
  }

  function savePrediction(record) {
    const items = loadPredictions();
    const existing = items.find(item => Number(item.targetDraw) === Number(record.targetDraw));
    if (existing) return { record: existing, created: false };
    items.push(record);
    items.sort((a, b) => Number(a.targetDraw) - Number(b.targetDraw));
    savePredictions(items);
    return { record, created: true };
  }

  function groupMeta(key) {
    return GROUPS.find(item => item.key === key) || { key, label: key, icon: '•' };
  }

  function scoreText(score) {
    return `${(score * 100).toFixed(1)}%`;
  }

  function angleText(detail) {
    if (detail.contLength >= 2 && detail.contShift) {
      const sign = detail.contShift > 0 ? '+' : '';
      return `продолжение ${detail.contLength} · угол ${sign}${detail.contShift}`;
    }
    if (detail.reflectionLength >= 2 && detail.reflectionShift) {
      const sign = detail.reflectionShift > 0 ? '+' : '';
      return `отражение ${detail.reflectionLength} · угол ${sign}${detail.reflectionShift}`;
    }
    return 'локальная волна';
  }

  function renderForecastRecord(saved, calculation) {
    const box = el(RESULT_ID);
    if (!box) return;
    const record = saved.record;
    const groups = record.groups || [];

    box.innerHTML = `
      <div class="wave-summary">
        <b>Прогноз строго на №${record.targetDraw}</b><br>
        <span class="small">${saved.created ? 'Создан и зафиксирован сейчас' : 'Уже был сохранён раньше и не изменён'} · источник №${record.sourceDraw} · 4 тройки, 12 уникальных чётных.</span>
      </div>
      <div class="wave-group-grid">
        ${groups.map(group => {
          const meta = groupMeta(group.key);
          return `<div class="wave-group wave-${group.key}">
            <div class="wave-group-title">${meta.icon} ${meta.label}</div>
            <div class="wave-numbers">${group.numbers.map(number => `<span>${pad2(number)}</span>`).join('')}</div>
            <div class="small">${group.key === 'angle' && group.details ? group.details.map(angleText).join(' · ') : `средняя оценка ${scoreText(group.meanScore || 0.25)}`}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="row small"><b>Цель проверки:</b> не менее 3 совпадений в следующем тираже либо через один. Целая тройка отмечается отдельно. Оценки — архивные частоты после сглаживания к базовым 25%, а не обещание выигрыша.</div>`;

    renderChecks();
  }

  async function getLiveTables(matrix, progress) {
    if (liveTablesCache?.signature === matrix.signature) return liveTablesCache.tables;
    const tables = await trainTables(matrix, 0, matrix.n - 1, progress);
    liveTablesCache = { signature: matrix.signature, tables };
    return tables;
  }

  async function runForecast() {
    const box = el(RESULT_ID);
    if (!box) return;
    if (!Array.isArray(draws) || draws.length < 120) {
      box.innerHTML = `<div class="row small">Для «Чётной волны» нужно хотя бы 120 тиражей. Сейчас: ${draws?.length || 0}.</div>`;
      return;
    }

    const latest = draws.at(-1);
    const targetDraw = Number(latest.draw) + 1;
    const existing = loadPredictions().find(item => Number(item.targetDraw) === targetDraw);
    if (existing) {
      renderForecastRecord({ record: existing, created: false });
      return;
    }

    box.innerHTML = '<div class="row small">⏳ Калибрую движение чётных по завершённому архиву…</div>';
    const matrix = buildMatrix();
    const tables = await getLiveTables(matrix, (done, total) => {
      const percent = Math.round(done / total * 100);
      box.innerHTML = `<div class="row small">⏳ Калибрую движение чётных: ${percent}%</div>`;
    });
    const calculation = chooseGroups(matrix, matrix.n - 1, tables);
    const record = {
      version: 1,
      createdAt: new Date().toISOString(),
      sourceDraw: Number(latest.draw),
      targetDraw,
      secondDraw: targetDraw + 1,
      groups: calculation.groups.map(group => ({
        key: group.key,
        numbers: group.numbers.slice(),
        meanScore: group.meanScore,
        details: group.details
      })),
      numbers: calculation.groups.flatMap(group => group.numbers)
    };
    const saved = savePrediction(record);
    renderForecastRecord(saved, calculation);
  }

  function hitsFor(numbers, actual) {
    if (!actual) return [];
    const set = new Set(actual.balls || []);
    return numbers.filter(number => set.has(number));
  }

  function renderDrawCheck(record, actual, title, cssClass) {
    if (!actual) {
      return `<div class="wave-check-block"><div class="wave-check-title">⏳ ${title}</div><div class="small">Ожидается тираж №${title.toLowerCase().includes('через') ? record.secondDraw : record.targetDraw}.</div></div>`;
    }
    const numbers = record.numbers || record.groups.flatMap(group => group.numbers);
    const hits = hitsFor(numbers, actual);
    const actualSet = new Set(actual.balls || []);
    const fullGroups = record.groups.filter(group => group.numbers.every(number => actualSet.has(number)));
    return `<div class="wave-check-block ${cssClass}">
      <div class="wave-check-title">${hits.length >= 3 ? '✅' : '•'} ${title}: ${hits.length} из 12</div>
      <div class="small">№${actual.draw} · ${typeof showDate === 'function' ? showDate(actual.date) : actual.date} ${actual.time || ''}${fullGroups.length ? ` · целая тройка: ${fullGroups.map(group => groupMeta(group.key).label).join(', ')}` : ''}</div>
      <div class="wave-check-numbers">${numbers.map(number => `<span class="${actualSet.has(number) ? 'hit' : ''}">${pad2(number)}${actualSet.has(number) ? '✓' : ''}</span>`).join('')}</div>
    </div>`;
  }

  function renderChecks() {
    const box = el(CHECK_ID);
    if (!box) return;
    const records = loadPredictions().sort((a, b) => Number(b.targetDraw) - Number(a.targetDraw));
    if (!records.length) {
      box.innerHTML = '';
      return;
    }
    const record = records[0];
    const actualNext = draws.find(draw => Number(draw.draw) === Number(record.targetDraw));
    const actualSecond = draws.find(draw => Number(draw.draw) === Number(record.secondDraw));
    const nextHits = hitsFor(record.numbers || [], actualNext).length;
    const secondHits = hitsFor(record.numbers || [], actualSecond).length;
    const totalResult = actualNext || actualSecond
      ? `<div class="wave-total ${Math.max(nextHits, secondHits) >= 3 ? 'good' : ''}"><b>${Math.max(nextHits, secondHits) >= 3 ? 'Цель выполнена' : 'Проверка идёт'}:</b> лучший результат ${Math.max(nextHits, secondHits)} из 12.</div>`
      : '';
    box.innerHTML = `<div class="section"><span>✅ Проверка живого прогноза</span></div>${renderDrawCheck(record, actualNext, 'Следующий тираж', 'next')}${renderDrawCheck(record, actualSecond, 'Через один тираж', 'second')}${totalResult}`;
  }

  function loadAuditCache(signature) {
    try {
      const value = JSON.parse(localStorage.getItem(AUDIT_CACHE_KEY) || 'null');
      return value?.signature === signature ? value : null;
    } catch (_) {
      return null;
    }
  }

  function saveAuditCache(value) {
    try {
      localStorage.setItem(AUDIT_CACHE_KEY, JSON.stringify(value));
    } catch (_) {
      // Проверка останется на экране, даже если хранилище телефона заполнено.
    }
  }

  function renderAuditResult(result) {
    const box = el(AUDIT_ID);
    if (!box) return;
    const liftHits = result.avgHits - result.baselineAvg;
    const liftRate = result.rate3 - result.baselineRate3;
    box.innerHTML = `
      <div class="section"><span>🧪 Проверка по всему архиву</span></div>
      <div class="row"><b>${result.totalDraws.toLocaleString('ru-RU')} тиражей</b><br><span class="small">Первые ${result.trainDraws.toLocaleString('ru-RU')} — калибровка. Последние ${result.tests.toLocaleString('ru-RU')} прогнозов — честная проверка 70/30 без будущих данных.</span></div>
      <div class="wave-audit-grid">
        <div><span>Среднее, следующий</span><b>${result.avgHits.toFixed(3)} / 12</b><small>база ${result.baselineAvg.toFixed(3)} · Δ ${liftHits >= 0 ? '+' : ''}${liftHits.toFixed(3)}</small></div>
        <div><span>Не менее 3, следующий</span><b>${(result.rate3 * 100).toFixed(1)}%</b><small>база ${(result.baselineRate3 * 100).toFixed(1)}% · Δ ${liftRate >= 0 ? '+' : ''}${(liftRate * 100).toFixed(1)} п.п.</small></div>
        <div><span>Не менее 3 через один</span><b>${(result.secondRate3 * 100).toFixed(1)}%</b><small>среднее ${result.secondAvg.toFixed(3)} / 12</small></div>
        <div><span>≥3 хотя бы в одном</span><b>${(result.eitherRate3 * 100).toFixed(1)}%</b><small>из двух ближайших тиражей</small></div>
        <div><span>Целая тройка</span><b>${(result.fullTripleRate * 100).toFixed(1)}%</b><small>хотя бы одна из четырёх</small></div>
        <div><span>Проверено переходов</span><b>${result.tests.toLocaleString('ru-RU')}</b><small>фиксированная модель</small></div>
      </div>
      <div class="row small"><b>По типам троек, среднее попаданий:</b><br>${GROUPS.map(group => `${group.icon} ${group.label}: ${result.groupAverages[group.key].toFixed(3)} из 3`).join(' · ')}</div>
      <div class="row small"><b>Честный смысл:</b> модуль проверяет, даёт ли геометрия троек прибавку к обычному выбору 12 из 40 чётных. Небольшой плюс считается наработкой, но не гарантией.</div>`;
  }

  async function runAudit(force = false) {
    const box = el(AUDIT_ID);
    if (!box) return;
    if (!Array.isArray(draws) || draws.length < 500) {
      box.innerHTML = `<div class="row small">Для полной проверки нужно хотя бы 500 тиражей. Сейчас: ${draws?.length || 0}.</div>`;
      return;
    }

    const matrix = buildMatrix();
    const cached = !force && loadAuditCache(matrix.signature);
    if (cached) {
      renderAuditResult(cached);
      return;
    }

    const split = Math.floor(matrix.n * 0.70);
    box.innerHTML = '<div class="row small">⏳ Этап 1/2: калибрую признаки на первых 70% архива…</div>';
    const tables = await trainTables(matrix, 0, split - 1, (done, total) => {
      box.innerHTML = `<div class="row small">⏳ Этап 1/2: калибровка ${Math.round(done / total * 100)}%</div>`;
    });

    let tests = 0;
    let totalHits = 0;
    let totalSecondHits = 0;
    let atLeast3 = 0;
    let secondAtLeast3 = 0;
    let eitherAtLeast3 = 0;
    let fullTriple = 0;
    let baselineAvg = 0;
    let baselineRate3 = 0;
    const groupHits = { joint: 0, dense: 0, angle: 0, scatter: 0 };

    const start = Math.max(10, split - 1);
    const end = matrix.n - 2;
    box.innerHTML = '<div class="row small">⏳ Этап 2/2: прогоняю четыре тройки по будущей части…</div>';

    for (let t = start; t < end; t += 1) {
      const calculation = chooseGroups(matrix, t, tables);
      const positions = calculation.groups.flatMap(group => group.positions);
      let hits = 0;
      let secondHits = 0;
      for (const position of positions) {
        hits += cell(matrix, t + 1, position);
        secondHits += cell(matrix, t + 2, position);
      }

      let gotFullTriple = false;
      for (const group of calculation.groups) {
        let groupHit = 0;
        for (const position of group.positions) groupHit += cell(matrix, t + 1, position);
        groupHits[group.key] += groupHit;
        if (groupHit === 3) gotFullTriple = true;
      }

      let evenCount = 0;
      for (let j = 0; j < 40; j += 1) evenCount += cell(matrix, t + 1, j);

      tests += 1;
      totalHits += hits;
      totalSecondHits += secondHits;
      if (hits >= 3) atLeast3 += 1;
      if (secondHits >= 3) secondAtLeast3 += 1;
      if (Math.max(hits, secondHits) >= 3) eitherAtLeast3 += 1;
      if (gotFullTriple) fullTriple += 1;
      baselineAvg += 12 * evenCount / 40;
      baselineRate3 += hypergeomAtLeast3(evenCount);

      if ((t - start) % 120 === 0) {
        box.innerHTML = `<div class="row small">⏳ Этап 2/2: проверено ${tests.toLocaleString('ru-RU')} из ${(end - start).toLocaleString('ru-RU')}</div>`;
        await sleepFrame();
      }
    }

    const result = {
      signature: matrix.signature,
      calculatedAt: new Date().toISOString(),
      totalDraws: matrix.n,
      trainDraws: split,
      tests,
      avgHits: totalHits / tests,
      secondAvg: totalSecondHits / tests,
      rate3: atLeast3 / tests,
      secondRate3: secondAtLeast3 / tests,
      eitherRate3: eitherAtLeast3 / tests,
      fullTripleRate: fullTriple / tests,
      baselineAvg: baselineAvg / tests,
      baselineRate3: baselineRate3 / tests,
      groupAverages: Object.fromEntries(Object.entries(groupHits).map(([key, value]) => [key, value / tests]))
    };
    saveAuditCache(result);
    renderAuditResult(result);
  }

  async function ensureBundledBase() {
    const status = el(BASE_STATUS_ID);
    if (!status) return;
    const current = Array.isArray(draws) ? draws.length : 0;
    if (current >= 1000) {
      status.innerHTML = `✅ Общая база приложения: <b>${current.toLocaleString('ru-RU')}</b> тиражей.`;
      return;
    }

    status.textContent = '⏳ Подключаю архив, вложенный в сборку…';
    try {
      const response = await fetch(BASE_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const imported = typeof parse === 'function' ? parse(text) : [];
      if (!imported.length) throw new Error('архив не распознан');
      let added = 0;
      try {
        added = typeof merge === 'function' ? merge(imported) : 0;
      } catch (error) {
        // Даже при заполненном localStorage база остаётся доступна в текущем сеансе.
        if (typeof dedupe === 'function') draws = dedupe([...(draws || []), ...imported]);
        else draws = imported;
        added = imported.length;
      }
      matrixCache = null;
      liveTablesCache = null;
      if (typeof render === 'function') render();
      status.innerHTML = `✅ Встроенный архив подключён: <b>${draws.length.toLocaleString('ru-RU')}</b> тиражей · добавлено ${added.toLocaleString('ru-RU')}.`;
    } catch (error) {
      status.innerHTML = `⚠️ Встроенный архив не загрузился: ${error.message}. Можно импортировать JSON через раздел «База».`;
    }
  }

  function injectStyles() {
    if (el('evenWaveStyles')) return;
    const style = document.createElement('style');
    style.id = 'evenWaveStyles';
    style.textContent = `
      .wave-title{font-size:19px;font-weight:950;color:#b8ff62}
      .wave-summary{border:1px solid #60c93b;background:linear-gradient(135deg,#102b1b,#14263b);border-radius:12px;padding:11px;margin-top:10px}
      .wave-controls{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px}
      .wave-controls .tool{font-size:14px}
      .wave-group-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}
      .wave-group{border:1px solid #355273;background:#101f33;border-radius:12px;padding:10px}
      .wave-group-title{font-weight:950;margin-bottom:7px}
      .wave-joint{border-color:#69d487}.wave-dense{border-color:#6ab2ff}.wave-angle{border-color:#ffd35c}.wave-scatter{border-color:#c58cff}
      .wave-numbers{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px}
      .wave-numbers span{min-width:39px;text-align:center;padding:7px 5px;border-radius:9px;background:#183650;border:1px solid #4e789b;font-size:18px;font-weight:950;font-family:ui-monospace,Consolas,monospace}
      .wave-check-block{border:1px solid #355273;background:#101f33;border-radius:11px;padding:10px;margin-top:8px}
      .wave-check-title{font-size:17px;font-weight:950}
      .wave-check-numbers{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
      .wave-check-numbers span{padding:5px 7px;border:1px solid #355273;border-radius:8px;background:#172a43;font-weight:900;font-family:ui-monospace,Consolas,monospace}
      .wave-check-numbers span.hit{border-color:#53df82;background:#123a28;color:#d0ffdd}
      .wave-total{margin-top:8px;padding:9px;border-radius:10px;border:1px solid #63502b;background:#302812}.wave-total.good{border-color:#53df82;background:#123a28;color:#d0ffdd}
      .wave-audit-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}
      .wave-audit-grid>div{border:1px solid #355273;background:#101f33;border-radius:11px;padding:9px;text-align:center}
      .wave-audit-grid span,.wave-audit-grid small{display:block;color:#aebed0;font-size:11px}.wave-audit-grid b{display:block;font-size:21px;color:#b8ff62;margin:3px 0}
      #${BASE_STATUS_ID}{margin-top:7px;padding:8px;border:1px dashed #4c6c88;border-radius:10px;color:#c9d8e8}
      @media(max-width:430px){.wave-group-grid,.wave-audit-grid,.wave-controls{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function injectInterface() {
    if (el(BUTTON_ID) || el(MODULE_ID)) return;
    const tools = document.querySelector('.tools');
    if (!tools) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.className = 'tool';
    button.textContent = '🌊 Чётная волна ▶';
    tools.appendChild(button);

    const panel = document.createElement('section');
    panel.id = MODULE_ID;
    panel.className = 'card panel';
    panel.innerHTML = `
      <div class="wave-title">🌊 Чётная волна · 4 тройки / 12 чисел</div>
      <div class="small" style="margin-top:5px">Совместная, плотная, угловая и разрозненная тройки. Проверка идёт на следующий тираж и через один.</div>
      <div id="${BASE_STATUS_ID}" class="small">Проверяю встроенный архив…</div>
      <div class="wave-controls">
        <button id="${RUN_ID}" class="tool" type="button">🎯 Сформировать 4 тройки</button>
        <button id="${AUDIT_BTN_ID}" class="tool" type="button">🧪 Проверить всю базу</button>
      </div>
      <div id="${RESULT_ID}"></div>
      <div id="${CHECK_ID}"></div>
      <div id="${AUDIT_ID}"></div>`;

    const searchPanel = el('searchPanel');
    if (searchPanel?.parentNode) searchPanel.parentNode.insertBefore(panel, searchPanel);
    else document.querySelector('.app')?.appendChild(panel);

    button.addEventListener('click', async () => {
      const opening = !panel.classList.contains('show');
      panel.classList.toggle('show', opening);
      button.textContent = opening ? '🌊 Чётная волна ▼' : '🌊 Чётная волна ▶';
      if (opening) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        await ensureBundledBase();
        if (!openingStarted) {
          openingStarted = true;
          await runForecast();
          await runAudit(false);
        } else {
          renderChecks();
        }
      }
    });

    el(RUN_ID)?.addEventListener('click', async () => {
      await ensureBundledBase();
      await runForecast();
    });
    el(AUDIT_BTN_ID)?.addEventListener('click', async () => {
      await ensureBundledBase();
      await runAudit(true);
    });
  }

  function start() {
    injectStyles();
    injectInterface();
    renderChecks();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
