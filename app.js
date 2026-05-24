const state = {
  schools: [], attendance: [], demographics: [], testScores: [], selected: null
};

const fmtPct = v => v === null || v === undefined || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`;
const fmtNum = v => v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toLocaleString();
const byYear = (a, b) => String(a.school_year).localeCompare(String(b.school_year));
const latest = arr => [...arr].sort(byYear).at(-1);
const first = arr => [...arr].sort(byYear)[0];

const parseEndYear = schoolYear => {
  const m = String(schoolYear || '').match(/(\d{4})\s*-\s*(\d{4})/);
  return m ? Number(m[2]) : Number.NaN;
};
const formatSchoolYearFromEnd = endYear => `${endYear - 1}-${endYear}`;
const clampRate = v => Math.max(0, Math.min(1, v));
const tCritical95 = df => {
  if (df <= 1) return 12.706;
  if (df === 2) return 4.303;
  if (df === 3) return 3.182;
  if (df === 4) return 2.776;
  if (df === 5) return 2.571;
  if (df === 6) return 2.447;
  if (df === 7) return 2.365;
  if (df === 8) return 2.306;
  if (df === 9) return 2.262;
  if (df === 10) return 2.228;
  return 1.96;
};

function forecastSeries(rows, key, horizon = 3) {
  const points = rows
    .map(r => ({ x: parseEndYear(r.school_year), y: Number(r[key]) }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length < 3) return [];

  const n = points.length;
  const xBar = points.reduce((a, p) => a + p.x, 0) / n;
  const yBar = points.reduce((a, p) => a + p.y, 0) / n;
  const ssx = points.reduce((a, p) => a + (p.x - xBar) ** 2, 0);
  if (!ssx) return [];

  const slope = points.reduce((a, p) => a + (p.x - xBar) * (p.y - yBar), 0) / ssx;
  const intercept = yBar - slope * xBar;
  const residualSse = points.reduce((a, p) => a + (p.y - (intercept + slope * p.x)) ** 2, 0);
  const residualSe = Math.sqrt(residualSse / Math.max(n - 2, 1));
  const t = tCritical95(n - 2);
  const lastYear = Math.max(...points.map(p => p.x));

  return Array.from({ length: horizon }, (_, i) => {
    const x = lastYear + i + 1;
    const yhat = intercept + slope * x;
    const sePred = residualSe * Math.sqrt(1 + (1 / n) + ((x - xBar) ** 2 / ssx));
    return {
      school_year: formatSchoolYearFromEnd(x),
      value: clampRate(yhat),
      lower: clampRate(yhat - t * sePred),
      upper: clampRate(yhat + t * sePred),
      isForecast: true
    };
  });
}

function appendForecasts(rows, series, horizon = 3) {
  const forecastsByKey = Object.fromEntries(series.map(s => [s.key, forecastSeries(rows, s.key, horizon)]));
  const forecastYears = [...new Set(Object.values(forecastsByKey).flat().map(r => r.school_year))].sort();
  const forecastRows = forecastYears.map(year => {
    const row = { school_year: year, isForecast: true };
    series.forEach(s => {
      const f = forecastsByKey[s.key].find(r => r.school_year === year);
      row[s.key] = f?.value ?? null;
      row[`${s.key}_lower`] = f?.lower ?? null;
      row[`${s.key}_upper`] = f?.upper ?? null;
    });
    return row;
  });
  return [...rows.map(r => ({ ...r, isForecast: false })), ...forecastRows];
}

function forecastTable(rows, series) {
  const forecastRows = rows.filter(r => r.isForecast);
  if (!forecastRows.length) return '<p class="metric-note">Forecasts require at least three observed data points.</p>';
  const headers = ['School year', ...series.map(s => s.label)];
  return `<table class="forecast-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>
    ${forecastRows.map(r => `<tr><th>${r.school_year}</th>${series.map(s => {
      const v = r[s.key], lo = r[`${s.key}_lower`], hi = r[`${s.key}_upper`];
      return `<td>${fmtPct(v)}<br><span class="metric-note">95% CI: ${fmtPct(lo)}–${fmtPct(hi)}</span></td>`;
    }).join('')}</tr>`).join('')}
  </tbody></table>`;
}


function schoolLevel(s) {
  if (s.k_8_school === 'Yes') return 'K-8';
  if (s['9_12_school'] === 'Yes') return 'High';
  if (s['6_8_school'] === 'Yes') return 'Middle';
  if (s.k_5_school === 'Yes') return 'Elementary';
  return 'Other';
}

async function loadData() {
  const [schools, attendance, demographics, testScores] = await Promise.all([
    fetch('data/schools.json').then(r => r.json()),
    fetch('data/attendance_rates.json').then(r => r.json()),
    fetch('data/demographics.json').then(r => r.json()),
    fetch('data/test_scores.json').then(r => r.json())
  ]);
  Object.assign(state, { schools, attendance, demographics, testScores });
  state.selected = null;
  renderSchoolList();
  renderDashboard();
}

function rowsFor(file, id) { return file.filter(r => Number(r.locationid) === Number(id)).sort(byYear); }
function latestFor(file, id) { return latest(rowsFor(file, id)); }

function filterSchools() {
  const q = document.getElementById('search').value.toLowerCase();
  const level = document.getElementById('levelFilter').value;
  return state.schools
    .filter(s => s.school_name.toLowerCase().includes(q))
    .filter(s => level === 'all' || schoolLevel(s) === level)
    .sort((a,b) => a.school_name.localeCompare(b.school_name));
}

function renderSchoolList() {
  const list = document.getElementById('schoolList');
  const schools = filterSchools();
  list.innerHTML = schools.map(s => `
    <button class="school-item ${state.selected?.locationid === s.locationid ? 'active' : ''}" data-id="${s.locationid}">
      <strong>${s.school_name}</strong>
      <span>${schoolLevel(s)} · ${s.school_board_district || 'No district listed'}</span>
    </button>`).join('');
  list.querySelectorAll('.school-item').forEach(btn => btn.addEventListener('click', () => {
    state.selected = state.schools.find(s => Number(s.locationid) === Number(btn.dataset.id));
    renderSchoolList(); renderDashboard();
  }));
}

function renderOnboarding() {
  document.getElementById('selectedLevel').textContent = 'No school selected';
  document.getElementById('schoolName').textContent = 'School Insights';
  document.getElementById('schoolMeta').textContent = 'Search for a school or choose one from the list to begin.';
  document.getElementById('metricCards').innerHTML = `
    ${metric('Schools loaded', fmtNum(state.schools.length), 'Choose a school to view metrics')}
    ${metric('Attendance records', fmtNum(state.attendance.length), 'Local JSON data')}
    ${metric('Demographic records', fmtNum(state.demographics.length), 'Local JSON data')}
    ${metric('Test-score records', fmtNum(state.testScores.length), 'Local JSON data')}
  `;
  document.getElementById('attendanceChart').innerHTML = '<p class="metric-note">Select a school to display attendance trends.</p>';
  document.getElementById('testChart').innerHTML = '<p class="metric-note">Select a school to display proficiency trends.</p>';
  document.getElementById('demoTable').innerHTML = '<p class="metric-note">Select a school to display latest demographic data.</p>';
  document.getElementById('profileTable').innerHTML = '<p class="metric-note">Select a school to display program and profile details.</p>';
  document.getElementById('aiOutput').textContent = 'Select a school, then click “Generate AI Insight” to summarize it.';
  document.getElementById('aiButton').disabled = true;
  document.getElementById('copyButton').disabled = true;
}

function comparisonData(s) {
  const level = schoolLevel(s);
  const peers = state.schools.filter(x => schoolLevel(x) === level).map(x => Number(x.locationid));
  const latestAttendanceYear = latest(state.attendance)?.school_year;
  const latestTestYear = latest(state.testScores)?.school_year;
  const peerAttendance = state.attendance.filter(r => peers.includes(Number(r.locationid)) && r.school_year === latestAttendanceYear);
  const peerTests = state.testScores.filter(r => peers.includes(Number(r.locationid)) && r.school_year === latestTestYear);
  const avg = (arr, key) => {
    const vals = arr.map(r => r[key]).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  };
  return {
    level,
    latestAttendanceYear,
    latestTestYear,
    level_averages: {
      attendance_rate: avg(peerAttendance, 'attendance_rate'),
      chronic_absenteeism_rate: avg(peerAttendance, 'chronic_absenteeism_rate'),
      english_language_arts_proficiency: avg(peerTests, 'english_language_arts_proficiency'),
      mathematics_proficiency: avg(peerTests, 'mathematics_proficiency')
    }
  };
}

function renderDashboard() {
  const s = state.selected;
  if (!s) {
    renderOnboarding();
    return;
  }
  const att = rowsFor(state.attendance, s.locationid);
  const demo = rowsFor(state.demographics, s.locationid);
  const tests = rowsFor(state.testScores, s.locationid);
  const la = latest(att), fa = first(att), ld = latest(demo), lt = latest(tests);
  const comp = comparisonData(s);

  document.getElementById('aiButton').disabled = false;
  document.getElementById('copyButton').disabled = false;
  document.getElementById('selectedLevel').textContent = schoolLevel(s);
  document.getElementById('schoolName').textContent = s.school_name;
  document.getElementById('schoolMeta').textContent = `${s.school_address || 'No address listed'} · ${s.phone_number || 'No phone listed'} · Location ID ${s.locationid}`;

  const attChange = la && fa ? la.attendance_rate - fa.attendance_rate : null;
  const chronicChange = la && fa ? la.chronic_absenteeism_rate - fa.chronic_absenteeism_rate : null;
  document.getElementById('metricCards').innerHTML = `
    ${metric('Latest enrollment', fmtNum(ld?.enrollment), ld?.school_year || 'No demographic data')}
    ${metric('Attendance rate', fmtPct(la?.attendance_rate), `${la?.school_year || 'No data'} · ${signedPct(attChange)} from first year`)}
    ${metric('Chronic absenteeism', fmtPct(la?.chronic_absenteeism_rate), `${la?.school_year || 'No data'} · ${signedPct(chronicChange)} from first year`)}
    ${metric('Math proficiency', fmtPct(lt?.mathematics_proficiency), lt?.school_year || 'No test-score data')}
  `;

  drawLineChart('attendanceChart', att, [
    { key: 'attendance_rate', label: 'Attendance' },
    { key: 'chronic_absenteeism_rate', label: 'Chronic absenteeism', secondary: true }
  ], true);
  drawLineChart('testChart', tests, [
    { key: 'english_language_arts_proficiency', label: 'ELA' },
    { key: 'mathematics_proficiency', label: 'Math', secondary: true }
  ], true);
  renderDemoTable(ld, comp);
  renderProfileTable(s);
}

function metric(label, value, note) {
  return `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note || ''}</div></article>`;
}
function signedPct(v) { return v === null || v === undefined || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v*100).toFixed(1)} pts`; }

function renderDemoTable(d, comp) {
  const rows = [
    ['School year', d?.school_year], ['Enrollment', fmtNum(d?.enrollment)], ['Economically disadvantaged', fmtPct(d?.pct_economically_disadvantaged)],
    ['Direct certification', fmtPct(d?.pct_direct_cert)], ['English learner', fmtPct(d?.pct_english_learner)], ['Special education', fmtPct(d?.pct_special_education)],
    ['Gifted', fmtPct(d?.pct_gifted)], ['Hispanic', fmtPct(d?.pct_hispanic)], ['Native American', fmtPct(d?.pct_native_american)], ['White', fmtPct(d?.pct_white)]
  ];
  document.getElementById('demoTable').innerHTML = `<table><tbody>${rows.map(r => `<tr><th>${r[0]}</th><td>${r[1] ?? '—'}</td></tr>`).join('')}</tbody></table>
  <div class="legend"><span><b>${comp.level}</b> peer averages shown in AI prompt for latest attendance/test years.</span></div>`;
}

function renderProfileTable(s) {
  const rows = [
    ['Community school', s.abc_community_school], ['Bilingual program', s.bilingual_education_program], ['Special ed hub', s.special_ed_hub],
    ['Calendar', s.extended_calendar === 'Yes' ? 'Extended' : 'Traditional'], ['Board district', s.school_board_district], ['Pre-K', s.pre_k_program_type || 'No/Not listed'],
    ['Academies of Albuquerque', s.academies_of_albuquerque || 'No/Not listed'], ['Home languages', s.home_language_other_than_english || 'Not listed'], ['Website', s.website || 'Not listed']
  ];
  document.getElementById('profileTable').innerHTML = `<table><tbody>${rows.map(r => `<tr><th>${r[0]}</th><td>${r[1] ?? '—'}</td></tr>`).join('')}</tbody></table>`;
}

function drawLineChart(id, rows, series, includeForecast = false) {
  const el = document.getElementById(id);
  if (!rows.length) { el.innerHTML = '<p class="metric-note">No data available.</p>'; return; }
  const chartRows = includeForecast ? appendForecasts(rows, series, 3) : rows.map(r => ({ ...r, isForecast: false }));
  const w = 640, h = 250, pad = 34;
  const years = chartRows.map(r => r.school_year);
  const vals = chartRows.flatMap(r => series.flatMap(s => [r[s.key], r[`${s.key}_lower`], r[`${s.key}_upper`]])).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  if (!vals.length) { el.innerHTML = '<p class="metric-note">No numeric values available.</p>'; return; }
  const min = Math.max(0, Math.min(...vals) - .05), max = Math.min(1, Math.max(...vals) + .05);
  const x = i => pad + (years.length === 1 ? 0 : i * (w - pad*2) / (years.length - 1));
  const y = v => h - pad - ((v - min) / (max - min || 1)) * (h - pad*2);
  const path = (key, forecastOnly = false) => chartRows
    .map((r,i) => [r[key], i, r.isForecast])
    .filter(([v,,isForecast]) => v !== null && v !== undefined && !Number.isNaN(v) && (!forecastOnly || isForecast))
    .map(([v,i],j) => `${j?'L':'M'}${x(i)},${y(v)}`).join(' ');
  const forecastConnector = key => {
    const firstForecastIndex = chartRows.findIndex(r => r.isForecast && r[key] !== null && r[key] !== undefined && !Number.isNaN(r[key]));
    if (firstForecastIndex < 1) return '';
    const prev = chartRows.slice(0, firstForecastIndex).reverse().find(r => r[key] !== null && r[key] !== undefined && !Number.isNaN(r[key]));
    const prevIndex = chartRows.indexOf(prev);
    return prev ? `M${x(prevIndex)},${y(prev[key])}L${x(firstForecastIndex)},${y(chartRows[firstForecastIndex][key])}` : '';
  };
  const dots = (key, secondary) => chartRows.map((r,i) => {
    const v = r[key];
    if (v === null || v === undefined || Number.isNaN(v)) return '';
    const ci = r.isForecast ? `; 95% CI: ${fmtPct(r[`${key}_lower`])}–${fmtPct(r[`${key}_upper`])}` : '';
    return `<circle class="dot ${secondary?'secondary-dot':''}" cx="${x(i)}" cy="${y(v)}" r="${r.isForecast ? 5 : 4}" opacity="${r.isForecast ? '.72' : '1'}"><title>${r.school_year}: ${fmtPct(v)}${ci}${r.isForecast ? ' forecast' : ''}</title></circle>`;
  }).join('');
  const intervals = (key, secondary) => chartRows.map((r,i) => {
    if (!r.isForecast || r[`${key}_lower`] === null || r[`${key}_upper`] === null) return '';
    return `<line class="forecast-ci ${secondary?'secondary-ci':''}" x1="${x(i)}" x2="${x(i)}" y1="${y(r[`${key}_lower`])}" y2="${y(r[`${key}_upper`])}" />
      <line class="forecast-ci ${secondary?'secondary-ci':''}" x1="${x(i)-5}" x2="${x(i)+5}" y1="${y(r[`${key}_lower`])}" y2="${y(r[`${key}_lower`])}" />
      <line class="forecast-ci ${secondary?'secondary-ci':''}" x1="${x(i)-5}" x2="${x(i)+5}" y1="${y(r[`${key}_upper`])}" y2="${y(r[`${key}_upper`])}" />`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Trend chart with three-year forecast and 95 percent confidence intervals">
    <line class="axis" x1="${pad}" x2="${w-pad}" y1="${h-pad}" y2="${h-pad}" />
    <line class="axis" x1="${pad}" x2="${pad}" y1="${pad}" y2="${h-pad}" />
    ${[0,.25,.5,.75,1].map(t => `<line class="gridline" x1="${pad}" x2="${w-pad}" y1="${pad+t*(h-pad*2)}" y2="${pad+t*(h-pad*2)}" />`).join('')}
    ${years.map((yr,i) => `<text x="${x(i)}" y="${h-10}" text-anchor="middle" font-size="10" fill="#687386">${yr.slice(2)}</text>`).join('')}
    ${series.map(s => `${intervals(s.key, s.secondary)}<path class="line ${s.secondary?'secondary-line':''}" d="${path(s.key)}" />
      <path class="line ${s.secondary?'secondary-line':''}" d="${forecastConnector(s.key)}${path(s.key, true).replace(/^M/, 'L')}" stroke-dasharray="6 5" opacity=".65" />${dots(s.key, s.secondary)}`).join('')}
  </svg><div class="legend">${series.map(s => `<span><b>${s.label}</b></span>`).join('')}<span>Dashed points are three-year linear forecasts with 95% prediction intervals.</span></div>${includeForecast ? forecastTable(chartRows, series) : ''}`;
}

async function generateAI() {
  const s = state.selected;
  if (!s) return;
  const btn = document.getElementById('aiButton');
  const out = document.getElementById('aiOutput');
  btn.disabled = true; out.textContent = 'Generating insight...';
  const payload = {
    school: s,
    attendance: rowsFor(state.attendance, s.locationid),
    demographics: rowsFor(state.demographics, s.locationid).slice(-8),
    testScores: rowsFor(state.testScores, s.locationid),
    comparison: comparisonData(s),
    question: document.getElementById('question').value.trim()
  };
  try {
    const res = await fetch('/.netlify/functions/gemini-insights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI request failed.');
    out.textContent = data.text;
  } catch (err) {
    out.textContent = `AI summary unavailable: ${err.message}\n\nThe dashboard still works without Gemini. To enable AI, deploy on Netlify and set GEMINI_API_KEY as an environment variable.`;
  } finally { btn.disabled = false; }
}

document.getElementById('search').addEventListener('input', renderSchoolList);
document.getElementById('levelFilter').addEventListener('change', renderSchoolList);
document.getElementById('aiButton').addEventListener('click', generateAI);
document.getElementById('copyButton').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.getElementById('aiOutput').textContent || '');
  document.getElementById('copyButton').textContent = 'Copied';
  setTimeout(() => document.getElementById('copyButton').textContent = 'Copy Summary', 1200);
});

loadData().catch(err => {
  document.getElementById('schoolName').textContent = 'Data failed to load';
  document.getElementById('schoolMeta').textContent = err.message;
});
