'use strict';

const fs = require('fs');

const SOURCE_URL = 'https://lucky-numbers.ru/lottery/ru/keno2';
const HISTORY_FILE = 'keno-history-v71.json';
const STATUS_FILE = 'keno-status-v71.json';

function stripTags(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePage(html) {
  const rows = [];
  const tableRows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  for (const row of tableRows) {
    const balls = [];
    const buttonPattern = /<button\b[^>]*>\s*(\d{1,2})\s*<\/button>/gi;
    let match;

    while ((match = buttonPattern.exec(row)) && balls.length < 20) {
      const number = Number(match[1]);
      if (number >= 1 && number <= 80) balls.push(number);
    }

    if (balls.length !== 20 || new Set(balls).size !== 20) continue;

    const text = stripTags(row);
    const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{2,4})\s*,\s*(\d{2}:\d{2})/);
    if (!dateMatch) continue;

    const beforeDate = text.slice(0, text.indexOf(dateMatch[0]));
    const possibleDraws = [...beforeDate.matchAll(/(?:^|\s)(\d[\d\s\u00a0]{4,8})(?=\s|$)/g)]
      .map(item => Number(item[1].replace(/\s|\u00a0/g, '')))
      .filter(number => number >= 100000 && number <= 999999);

    const draw = possibleDraws.at(-1);
    if (!draw) continue;

    rows.push({ draw, date: dateMatch[1], time: dateMatch[2], balls });
  }

  return [...new Map(rows.map(row => [row.draw, row])).values()]
    .sort((a, b) => a.draw - b.draw);
}

function validDraw(draw) {
  return Number.isInteger(Number(draw?.draw)) &&
    Array.isArray(draw?.balls) &&
    draw.balls.length === 20 &&
    new Set(draw.balls.map(Number)).size === 20 &&
    draw.balls.every(number => Number(number) >= 1 && Number(number) <= 80);
}

async function fetchSource(attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(SOURCE_URL, {
        headers: {
          'user-agent': 'Mozilla/5.0 GitHub-Actions Positron-Keno-v7.1/1.0',
          accept: 'text/html,application/xhtml+xml',
          'cache-control': 'no-cache'
        },
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) throw new Error(`Lucky Numbers HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 3000));
    }
  }

  throw lastError;
}

async function main() {
  const fresh = parsePage(await fetchSource());
  if (!fresh.length) throw new Error('Новые тиражи на странице Lucky Numbers не распознаны');

  const storedPayload = fs.existsSync(HISTORY_FILE)
    ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    : [];
  const stored = Array.isArray(storedPayload) ? storedPayload : (storedPayload.draws || []);
  const map = new Map();

  for (const item of [...stored, ...fresh]) {
    if (!validDraw(item)) continue;
    map.set(Number(item.draw), {
      draw: Number(item.draw),
      date: String(item.date || ''),
      time: String(item.time || ''),
      balls: item.balls.map(Number)
    });
  }

  const draws = [...map.values()].sort((a, b) => a.draw - b.draw);
  const latest = draws.at(-1);
  const previousLatest = stored.filter(validDraw).sort((a, b) => Number(a.draw) - Number(b.draw)).at(-1);

  if (!latest) throw new Error('Итоговая база пуста');

  const historyChanged = draws.length !== stored.filter(validDraw).length ||
    Number(latest.draw) !== Number(previousLatest?.draw || 0);

  if (!historyChanged) {
    console.log(`ПОЗИТРОН v7.1: новых тиражей нет, последний №${latest.draw}`);
    return;
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(draws));
  fs.writeFileSync(STATUS_FILE, JSON.stringify({
    version: '7.1.3',
    source: SOURCE_URL,
    updatedAt: new Date().toISOString(),
    drawsStored: draws.length,
    latestDraw: latest.draw,
    latestDate: latest.date,
    latestTime: latest.time
  }, null, 2) + '\n');

  console.log(`ПОЗИТРОН v7.1: база ${draws.length}, последний №${latest.draw}`);
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
