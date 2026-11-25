import { categories, colors, sum, uid, validateExpense, validateBackup, monthlyTotals, fuelStats, exportCSV, parseCSV, mergeExpenses } from './model.js';
import { carExplorerView, mountCarExplorer } from './car-explorer.js';

const STORAGE_KEY = 'myfuad.v1';
const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const toast = document.querySelector('#toast');
const money = (value, digits = 0) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const number = (value, digits = 0) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: digits }).format(value);
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const dateLabel = (value, short = false) => new Date(`${value.length === 7 ? `${value}-01` : value}T12:00:00`).toLocaleDateString('en-GB', { ...(value.length === 10 ? { day: 'numeric' } : {}), month: short ? 'short' : 'long', year: 'numeric' });
const monthLabel = (value) => new Date(`${value}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'short' });
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  wallet: '<path d="M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v11H5a3 3 0 0 1-3-3V6"/><path d="M20 12h-5v5h5"/><path d="M17 14.5h.01"/>',
  car: '<path d="m5 7 2-4h10l2 4 2 3v9h-3v-3H6v3H3v-9z"/><path d="M3 9h18M6 12h2m8 0h2"/>',
  fuel: '<path d="M4 21V4h10v17M2 21h14M4 10h10m3-7 4 4v10a2 2 0 0 1-4 0v-4h-3m4-8v4h3"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  wrench: '<path d="M14 6a5 5 0 0 0-6 6L2 18l4 4 6-6a5 5 0 0 0 6-6l-4 4-4-4z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  road: '<path d="m5 3-3 18M19 3l3 18M12 3v3m0 4v4m0 4v3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  edit: '<path d="m16 3 5 5L8 21H3v-5zM13 6l5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.wallet}</svg>`;
let state;
let view = 'overview';
let period = '2026';
let category = 'all';
let search = '';
let page = 1;
let toastTimer;
let disposeExplorer;

function notify(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 5000);
}

function save(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    state = next;
    return true;
  } catch (error) {
    notify(`Could not save your changes. Browser storage may be full or disabled. ${error.message}`);
    return false;
  }
}

function selectedRows() {
  return state.expenses.filter((row) => period === 'all' || row.date.startsWith(period));
}

function periodOptions() {
  const years = [...new Set([String(new Date().getFullYear()), ...state.expenses.map((row) => row.date.slice(0, 4))])].sort().reverse();
  return `<option value="all" ${period === 'all' ? 'selected' : ''}>All time</option>${years.map((year) => `<option ${period === year ? 'selected' : ''}>${year}</option>`).join('')}`;
}

function render() {
  disposeExplorer?.();
  disposeExplorer = undefined;
  const titles = { overview: ['Your car, understood.', 'A little clarity for every kilometre.'], expenses: ['Every expense. One place.', 'The big picture starts with the little things.'], garage: ['A little care goes a long way.', 'Your car’s details, mileage, and next check-in.'], explorer: ['Your Fiat, inside & out.', 'A closer look at the parts that keep your little car going.'] };
  const [title, subtitle] = titles[view];
  app.innerHTML = `
    <aside class="sidebar">
      <a href="#overview" class="brand" aria-label="MyFuad home"><span class="brand-symbol">f<span>.</span></span>MyFuad<span class="brand-dot">.</span></a>
      <div class="workspace-label">YOUR SPACE</div>
      <nav aria-label="Main navigation">
        ${[['overview', 'grid', 'Overview'], ['expenses', 'wallet', 'Expenses'], ['garage', 'car', 'My garage'], ['explorer', 'wrench', 'Car explorer']].map(([key, symbol, label]) => `<a href="#${key}" class="nav-link ${view === key ? 'active' : ''}" ${view === key ? 'aria-current="page"' : ''}>${icon(symbol)}${label}${view === key ? '<span class="nav-dot"></span>' : ''}</a>`).join('')}
      </nav>
      <div class="sidebar-bottom">
        <div class="private-card">${icon('shield')}<strong>Just you and your data.</strong><p>Saved on this browser.<br>No accounts. No tracking.</p><button class="text-button" data-action="backup">Back up your data ${icon('arrow')}</button></div>
        <div class="profile"><span class="avatar">F</span><div><strong>My personal garage</strong><small>Local workspace</small></div><span class="online-dot"></span></div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar"><div class="breadcrumb">My garage <span>/</span> <strong>${view === 'overview' ? 'Overview' : view === 'expenses' ? 'Expenses' : view === 'explorer' ? 'Car explorer' : 'Car & maintenance'}</strong></div><span class="local-status"><span class="online-dot"></span> Local-first, always</span></header>
      <main>
        <div class="page-heading"><div><div class="eyebrow">${view === 'explorer' ? 'GET TO KNOW YOUR CAR' : 'THE ROAD SO FAR'}</div><h1>${title}</h1><p>${subtitle}</p></div>${view === 'explorer' ? '' : `<button class="button primary" data-action="add">${icon('plus')} Add expense</button>`}</div>
        ${view === 'explorer' ? '' : `<div class="context-bar"><div class="car-label">${icon('car')}<strong>${esc(state.car.name)}</strong><span class="pill">Personal car</span></div><label class="period-control">${icon('calendar')}<span class="sr-only">Reporting period</span><select id="period">${periodOptions()}</select></label></div>`}
        ${view === 'overview' ? overview() : view === 'expenses' ? expenseView() : view === 'explorer' ? carExplorerView() : garageView()}
        <footer><span><strong>MyFuad.</strong> Less guesswork. More open road.</span><span>EUR · km · litres <span class="footer-dot">·</span> Stored on this device</span></footer>
      </main>
    </div>`;
  if (view === 'explorer') disposeExplorer = mountCarExplorer(document.querySelector('#car-explorer'), state.car.plate);
}

function statCard(label, value, detail, symbol, cls = '') {
  return `<article class="stat-card ${cls}"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon(symbol)}</span></div><div class="stat-value">${value}</div><div class="stat-detail">${detail}</div></article>`;
}

function overview() {
  const rows = selectedRows();
  const total = sum(rows);
  const months = monthlyTotals(rows);
  const gas = rows.filter((row) => row.category === 'Gas');
  const fuel = fuelStats(rows);
  const average = months.length ? total / months.length : 0;
  const last = months.at(-1);
  const previous = months.at(-2);
  const change = previous && previous.amount ? (last.amount - previous.amount) / previous.amount * 100 : null;
  const highest = months.reduce((best, month) => !best || month.amount > best.amount ? month : best, null);
  const maintenance = sum(rows.filter((row) => row.category === 'Maintenance'));
  return `
    <section class="stats-grid" aria-label="Spending at a glance">
      ${statCard('Total car expenses', money(total), `<span class="tiny-dot"></span> ${rows.length} expenses · ${period === 'all' ? 'all time' : esc(period)}`, 'wallet', 'featured')}
      ${statCard('Monthly average', money(average), `Across ${months.length} months with expenses`, 'calendar')}
      ${statCard('Fuel spending', money(sum(gas)), `${gas.length} fill-ups logged`, 'fuel')}
      ${statCard('Fuel economy', fuel ? `${number(fuel.economy, 1)} <small>L/100km</small>` : '— <small>L/100km</small>', fuel ? `${number(fuel.distance)} km · full-to-full` : 'Add full-tank readings to unlock', 'road')}
    </section>
    <div class="dashboard-grid">
      <section class="panel spending-panel"><div class="panel-heading"><div><h2>The cost of the journey</h2><p>Your monthly spending, broken down.</p></div><span class="chart-key"><i></i> Expenses</span></div>${spendingChart(months)}</section>
      <section class="panel breakdown-panel"><div class="panel-heading"><div><h2>Where it all goes</h2><p>Every euro has a story.</p></div></div>${breakdown(rows, total)}</section>
    </div>
    <section class="insights-section"><div class="section-title"><h2>A few things worth knowing</h2><span class="subtle">YOUR DATA, CONNECTED</span></div><div class="insights-grid">
      <article class="insight-card"><span class="insight-icon sage">${icon('calendar')}</span><div><h3>${highest ? `${dateLabel(highest.month)} led the way` : 'Your story starts here'}</h3><p>${highest ? `At ${money(highest.amount)}, it was your highest-spend month in this view.` : 'Add your first expense to start discovering patterns.'}</p></div></article>
      <article class="insight-card"><span class="insight-icon sand">${icon('wrench')}</span><div><h3>${money(maintenance)} in care & upkeep</h3><p>${maintenance ? 'Maintenance expenses, separate from fuel and everyday running costs.' : 'Log services and repairs to build your maintenance history.'}</p></div></article>
      <article class="insight-card"><span class="insight-icon lavender">${icon(fuel ? 'fuel' : 'road')}</span><div><h3>${fuel ? `${money(fuel.costPerKm, 2)} per kilometre in fuel` : 'Unlock your fuel insights'}</h3><p>${fuel ? `Based on ${fuel.intervals} complete full-to-full interval${fuel.intervals === 1 ? '' : 's'}, not an estimate.` : 'Log litres and odometer at two full tanks. We’ll take care of the maths.'}</p></div></article>
    </div></section>
    <div class="bottom-grid"><section class="panel recent-panel"><div class="panel-heading"><div><h2>Recent pit stops</h2><p>The latest entries in your car’s story.</p></div><a href="#expenses" class="text-button">All expenses ${icon('chevron')}</a></div>${expenseTable(rows, true)}</section>
      <section class="journey-card"><span class="eyebrow">A LITTLE PERSPECTIVE</span><h2>${change === null ? 'Every journey starts with a little insight.' : `${number(Math.abs(change), 0)}% ${change <= 0 ? 'less' : 'more'} than the previous logged month.`}</h2><p>${change === null ? 'Keep logging. The more you add, the clearer the picture becomes.' : `${last ? monthLabel(last.month) : ''} vs ${previous ? monthLabel(previous.month) : ''}. Latest month may still be in progress; missing months aren’t treated as zero.`}</p><div class="road-art" aria-hidden="true"><div class="road-line"></div>${icon('car')}</div><span class="journey-note">Small details. A better big picture.</span></section></div>`;
}

function spendingChart(months) {
  if (!months.length) return '<div class="empty-chart">Your first expense starts the chart.</div>';
  const max = Math.max(...months.map((month) => month.amount), 1);
  const scale = Math.ceil(max / 4 / 100) * 100 || 100;
  const ceiling = scale * 4;
  return `<div class="chart" role="img" aria-label="Monthly expenses. ${months.map((month) => `${dateLabel(month.month)}: ${money(month.amount)}`).join('; ')}">
    <div class="chart-axis">${[4, 3, 2, 1, 0].map((step) => `<span>${step ? number(step * scale) : '0'}</span>`).join('')}</div>
    <div class="plot"><div class="grid-lines">${Array.from({ length: 5 }, () => '<i></i>').join('')}</div><div class="bars">${months.map((month, i) => `<div class="bar-column"><div tabindex="0" class="bar ${i === months.length - 1 ? 'latest' : ''}" style="height:${Math.max(month.amount / ceiling * 100, 1)}%" aria-label="${dateLabel(month.month)}: ${money(month.amount)}"><span class="bar-tooltip">${money(month.amount)}</span></div><span class="bar-label">${monthLabel(month.month)}${period === 'all' ? `<small>${month.month.slice(0, 4)}</small>` : ''}</span></div>`).join('')}</div></div>
    </div><div class="chart-footnote">EUR <span>Months with recorded expenses · hover or focus a bar for details</span></div>`;
}

function breakdown(rows, total) {
  const amounts = categories.map((name) => ({ name, amount: sum(rows.filter((row) => row.category === name)) })).filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount);
  let stop = 0;
  const gradient = amounts.map((item) => {
    const start = stop;
    stop += item.amount / total * 100;
    return `${colors[item.name]} ${start}% ${stop}%`;
  }).join(',');
  return `<div class="donut-wrap"><div class="donut" style="background:${total ? `conic-gradient(${gradient})` : '#e8ede7'}" role="img" aria-label="Expense categories"><div class="donut-center"><span>TOTAL SPENT</span><strong>${money(total)}</strong><small>${amounts.length} categories</small></div></div></div>
    <div class="legend">${amounts.slice(0, 4).map((item) => `<div><span class="legend-name"><i style="background:${colors[item.name]}"></i>${esc(item.name)}</span><strong>${money(item.amount)}</strong><span>${number(item.amount / total * 100, 1)}%</span></div>`).join('')}${amounts.length > 4 ? `<details><summary>+ ${amounts.length - 4} more categories</summary>${amounts.slice(4).map((item) => `<div><span class="legend-name"><i style="background:${colors[item.name]}"></i>${esc(item.name)}</span><strong>${money(item.amount)}</strong><span>${number(item.amount / total * 100, 1)}%</span></div>`).join('')}</details>` : ''}${!amounts.length ? '<p class="subtle">No expenses in this period.</p>' : ''}</div>`;
}

function expenseView() {
  const rows = filteredExpenses();
  return `<section class="panel expenses-panel"><div class="panel-heading"><div><h2>Your expense log <span class="count-badge">${rows.length}</span></h2><p>${money(sum(rows), 2)} across the filtered entries.</p></div><div class="actions"><button class="button secondary" data-action="import">${icon('upload')} Import</button><button class="button secondary" data-action="csv">${icon('download')} Export CSV</button></div></div>
    <div class="filters"><label><span class="sr-only">Search expenses</span><input id="search" type="search" placeholder="Search category, date, notes…" value="${esc(search)}"></label><label><span class="sr-only">Filter category</span><select id="category"><option value="all">All categories</option>${categories.map((name) => `<option ${category === name ? 'selected' : ''}>${name}</option>`).join('')}</select></label></div><div id="expense-results">${expenseResults(rows)}</div></section>
    <div class="info-banner">${icon('shield')}<p>Some history only includes a month. Those entries keep their original precision — no made-up dates. Export a JSON backup to keep expenses, car details, and reminders safe.</p><button class="text-button" data-action="backup">Download backup ${icon('download')}</button></div>`;
}

function filteredExpenses() {
  return selectedRows().filter((row) => (category === 'all' || row.category === category) && `${row.category} ${row.notes} ${row.date}`.toLowerCase().includes(search.toLowerCase()));
}

function expenseResults(rows) {
  const pages = Math.max(1, Math.ceil(rows.length / 15));
  page = Math.min(page, pages);
  return `${expenseTable(rows, false)}<div class="pagination"><span>Page ${page} of ${pages} · ${rows.length} entries</span><div><button class="button secondary small" data-action="previous" ${page === 1 ? 'disabled' : ''}>Previous</button><button class="button secondary small" data-action="next" ${page >= pages ? 'disabled' : ''}>Next</button></div></div>`;
}

function expenseTable(rows, recent = false) {
  const sorted = rows.slice().reverse().sort((a, b) => b.date.localeCompare(a.date));
  const entries = recent ? sorted.slice(0, 4) : sorted.slice((page - 1) * 15, page * 15);
  return `<div class="table-scroll"><table><thead><tr><th>Expense</th><th>Date</th>${recent ? '' : '<th>Details</th>'}<th class="amount-cell">Amount</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${entries.length ? entries.map((row) => `<tr><td><span class="expense-name"><span class="category-icon" style="--category-color:${colors[row.category]}">${icon(row.category === 'Gas' ? 'fuel' : row.category === 'Maintenance' ? 'wrench' : row.category === 'Insurance' ? 'shield' : 'wallet')}</span><span><strong>${esc(row.category)}</strong>${row.notes ? `<small>${esc(row.notes)}</small>` : '<small>Car expense</small>'}</span></span></td><td class="date-cell">${dateLabel(row.date, true)}${row.date.length === 7 ? '<small>Day not recorded</small>' : ''}</td>${recent ? '' : `<td class="details-cell">${row.odometer !== null ? `${number(row.odometer)} km` : '—'}${row.litres !== null ? `<small>${number(row.litres, 2)} L${row.fullTank ? ' · Full tank' : ''}</small>` : ''}</td>`}<td class="amount-cell"><strong>${money(row.amount, 2)}</strong></td><td><div class="row-actions"><button class="icon-button" data-action="edit" data-id="${esc(row.id)}" aria-label="Edit ${esc(row.category)} ${esc(row.date)}">${icon('edit')}</button>${recent ? '' : `<button class="icon-button danger" data-action="delete" data-id="${esc(row.id)}" aria-label="Delete ${esc(row.category)} ${esc(row.date)}">${icon('trash')}</button>`}</div></td></tr>`).join('') : `<tr><td colspan="${recent ? 4 : 5}" class="empty-state">No expenses here yet. Add one or import your history.</td></tr>`}</tbody></table></div>`;
}

function garageView() {
  const readings = selectedRows().filter((row) => row.odometer !== null).sort((a, b) => a.date.localeCompare(b.date) || a.odometer - b.odometer);
  const latest = readings.at(-1);
  const first = readings[0];
  const fuel = fuelStats(selectedRows());
  const maintenance = selectedRows().filter((row) => row.category === 'Maintenance');
  return `<section class="stats-grid garage-stats">
    ${statCard('Latest logged odometer', latest ? `${number(latest.odometer)} <small>km</small>` : '— <small>km</small>', latest ? dateLabel(latest.date) : 'Add an odometer reading with an expense', 'road')}
    ${statCard('Logged distance', readings.length > 1 && latest.odometer >= first.odometer ? `${number(latest.odometer - first.odometer)} <small>km</small>` : '— <small>km</small>', 'First to latest reading in this period', 'car')}
    ${statCard('Fuel economy', fuel ? `${number(fuel.economy, 1)} <small>L/100km</small>` : '—', fuel ? `${fuel.intervals} complete full-to-full intervals` : 'Two full-tank readings needed', 'fuel')}
    ${statCard('Maintenance spending', money(sum(maintenance)), `${maintenance.length} service & repair entries`, 'wrench')}
    </section><section class="panel mileage-panel"><div class="panel-heading"><div><h2>Kilometres, over time</h2><p>Actual odometer readings, not estimated mileage.</p></div><span class="chart-key">km</span></div>${mileageChart(readings)}</section>
    <div class="dashboard-grid garage-grid"><section class="panel"><div class="panel-heading"><div><h2>Coming up next</h2><p>Date-based reminders to keep you on the road.</p></div><button class="button secondary" data-action="reminder">${icon('plus')} Reminder</button></div>
    <div class="reminders">${state.reminders.length ? state.reminders.slice().sort((a, b) => a.due.localeCompare(b.due)).map((item) => `<article class="reminder"><span class="category-icon">${icon('wrench')}</span><div><strong>${esc(item.title)}</strong><small>${dateLabel(item.due)} <span class="${item.due < today() ? 'overdue' : ''}">${item.due < today() ? '· Overdue' : item.due === today() ? '· Due today' : ''}</span></small></div><button class="button secondary small" data-action="complete" data-id="${esc(item.id)}">Done</button></article>`).join('') : '<div class="empty-state">Nothing on the to-do list.<br><span class="subtle">Add a reminder for your next service, inspection, or insurance renewal.</span></div>'}</div><p class="panel-note">Reminders are shown here when you open MyFuad; no background notifications. “Done” removes the reminder, not adds an expense.</p></section>
    <section class="panel car-settings"><div class="panel-heading"><div><h2>Meet your daily companion</h2><p>Make this garage your own.</p></div>${icon('car')}</div><form id="car-form"><label>Car name<input name="name" value="${esc(state.car.name)}" maxlength="80" required placeholder="e.g. Volkswagen Golf · 2019"></label><label>Number plate (shown on the 3D car, optional)<input name="plate" value="${esc(state.car.plate || '')}" maxlength="12" placeholder="e.g. AB CD 123"></label><p class="subtle">Currency: EUR · Distance: kilometres · Fuel: litres</p><button class="button primary" type="submit">Save car details</button></form></section></div>
    <section class="panel"><div class="panel-heading"><div><h2>Maintenance history</h2><p>Your recorded services and repairs.</p></div></div>${expenseTable(maintenance, true)}</section>
    <div class="info-banner">${icon('download')}<p>Your data is saved in this browser, not in the cloud. Clearing site data or changing browsers won’t carry your garage over. Keep a backup.</p><button class="text-button" data-action="backup">Download backup ${icon('arrow')}</button></div>`;
}

function mileageChart(readings) {
  if (readings.length < 2) return '<div class="empty-chart">Add odometer readings on at least two expenses to see your mileage trend.</div>';
  const min = Math.min(...readings.map((row) => row.odometer));
  const max = Math.max(...readings.map((row) => row.odometer));
  const timestamp = (row) => new Date(`${row.date}T12:00:00Z`).getTime();
  const start = timestamp(readings[0]);
  const span = timestamp(readings.at(-1)) - start || 1;
  const points = readings.map((row) => ({
    x: 65 + (timestamp(row) - start) / span * 675,
    y: 145 - (row.odometer - min) / (max - min || 1) * 110,
    row,
  }));
  return `<div class="mileage-chart"><svg viewBox="0 0 800 195" role="img" aria-label="Odometer trend from ${number(readings[0].odometer)} to ${number(readings.at(-1).odometer)} kilometres">
    ${[0, 1, 2].map((step) => `<line x1="65" y1="${35 + step * 55}" x2="740" y2="${35 + step * 55}" stroke="#e9eee2" stroke-dasharray="4 4"/><text x="50" y="${39 + step * 55}" text-anchor="end">${number(max - step / 2 * (max - min))}</text>`).join('')}
    <polyline points="${points.map((point) => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="#7ea44e" stroke-width="2.5"/>
    ${points.map(({ x, y, row }) => `<circle cx="${x}" cy="${y}" r="4" fill="#35543a" tabindex="0"><title>${dateLabel(row.date)}: ${number(row.odometer)} km</title></circle>`).join('')}
    <text x="65" y="180">${esc(dateLabel(readings[0].date, true))}</text><text x="740" y="180" text-anchor="end">${esc(dateLabel(readings.at(-1).date, true))}</text>
    </svg></div>`;
}

function openModal(content) {
  modal.innerHTML = `<button class="icon-button modal-close" data-action="close" aria-label="Close dialog">${icon('close')}</button>${content}`;
  modal.querySelector('h2').id = 'modal-title';
  modal.setAttribute('aria-labelledby', 'modal-title');
  modal.showModal();
}

function expenseModal(id) {
  const entry = state.expenses.find((row) => row.id === id);
  openModal(`<div class="eyebrow">YOUR EXPENSE LOG</div><h2>${entry ? 'Edit expense' : 'A new pit stop.'}</h2><p class="modal-intro">The little details make the big picture.</p>
    <form id="expense-form" data-id="${esc(entry?.id || '')}"><div class="form-grid">
    <label>Category<select name="category">${categories.map((name) => `<option ${entry?.category === name ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
    <label>Amount (€)<input type="number" name="amount" min="0.01" max="1000000000" step="0.01" required value="${entry?.amount ?? ''}" placeholder="0.00"></label>
    <label class="full"><span class="checkbox-label"><input type="checkbox" name="monthOnly" ${entry?.date.length === 7 ? 'checked' : ''}> I only know the month</span></label>
    <label class="full">Date<input name="date" type="${entry?.date.length === 7 ? 'month' : 'date'}" required value="${entry?.date || today()}"></label>
    <label>Odometer (km) <span class="optional">optional</span><input type="number" name="odometer" min="0.1" max="1000000000" step="0.1" value="${entry?.odometer ?? ''}" placeholder="e.g. 85000"></label>
    <label class="fuel-field">Fuel (litres) <span class="optional">optional</span><input type="number" name="litres" min="0.01" max="1000000000" step="0.01" value="${entry?.litres ?? ''}" placeholder="e.g. 42.5"></label>
    <label class="full fuel-field"><span class="checkbox-label"><input type="checkbox" name="fullTank" ${entry?.fullTank ? 'checked' : ''}> Filled up to a full tank</span><small>For fuel economy, add litres and odometer readings at two full tanks.</small></label>
    <label class="full">Notes <span class="optional">optional</span><textarea name="notes" rows="2" maxlength="2000" placeholder="A little context for later…">${esc(entry?.notes || '')}</textarea></label>
    </div><p class="form-error" role="alert"></p><div class="modal-actions"><button class="button secondary" type="button" data-action="close">Cancel</button><button class="button primary" type="submit">${entry ? 'Save changes' : 'Add expense'} ${icon('plus')}</button></div></form>`);
  updateFuelFields();
}

function updateFuelFields() {
  const form = document.querySelector('#expense-form');
  const gas = form.elements.category.value === 'Gas';
  form.querySelectorAll('.fuel-field').forEach((el) => { el.hidden = !gas; });
  form.elements.litres.disabled = !gas;
  form.elements.fullTank.disabled = !gas;
}

function importModal() {
  openModal(`<div class="eyebrow">BRING YOUR HISTORY</div><h2>A fresh perspective on old data.</h2><p class="modal-intro">Import a CSV or restore a MyFuad JSON backup. Files are read on your device — never uploaded.</p>
    <div class="import-guide"><strong>CSV format</strong><code>date,category,amount,litres,odometer,fullTank,notes</code><p>Required: date, category, amount. Dates: YYYY-MM-DD or YYYY-MM for month-only entries. Amounts use a decimal point. Excel: save as CSV UTF-8 (comma-delimited).</p><p>Categories: ${categories.join(', ')}.</p><button class="text-button" data-action="template">Download example CSV ${icon('download')}</button></div>
    <form id="import-form"><label>Choose a CSV or JSON file<input type="file" name="file" accept=".csv,.json,text/csv,application/json" required></label><p class="subtle">CSV merges with your log, skipping existing matching entries. A JSON backup replaces your entire garage after confirmation. Maximum 5 MB.</p><p class="form-error" role="alert"></p><div class="modal-actions"><button class="button secondary" type="button" data-action="close">Cancel</button><button class="button primary" type="submit">Read file ${icon('upload')}</button></div></form>`);
}

function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function confirmModal(title, description, label, onConfirm) {
  openModal(`<h2>${esc(title)}</h2><p class="modal-intro">${esc(description)}</p><div class="modal-actions"><button class="button secondary" data-action="close">Cancel</button><button class="button primary" id="confirm-action">${esc(label)}</button></div>`);
  document.querySelector('#confirm-action').addEventListener('click', onConfirm, { once: true });
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const { action, id } = button.dataset;
  if (action === 'close') modal.close();
  if (action === 'add' || action === 'edit') expenseModal(id);
  if (action === 'delete') {
    const entry = state.expenses.find((row) => row.id === id);
    confirmModal('Delete this expense?', `${entry.category} · ${money(entry.amount, 2)} · ${dateLabel(entry.date)}. This cannot be undone.`, 'Delete expense', () => {
      if (save({ ...state, expenses: state.expenses.filter((row) => row.id !== id) })) { modal.close(); render(); notify('Expense deleted.'); }
    });
  }
  if (action === 'backup') download(JSON.stringify(state, null, 2), `myfuad-backup-${today()}.json`, 'application/json');
  if (action === 'csv') download(exportCSV(filteredExpenses()), `myfuad-expenses-${period}.csv`, 'text/csv;charset=utf-8');
  if (action === 'template') download('date,category,amount,litres,odometer,fullTank,notes\r\n2026-03,Insurance,98,,,,Monthly premium\r\n2026-03-19,Gas,60,35,85000,true,Full tank\r\n2026-03-30,Gas,66,38,85500,true,Full tank\r\n', 'myfuad-example.csv', 'text/csv;charset=utf-8');
  if (action === 'import') importModal();
  if (action === 'previous' || action === 'next') { page += action === 'next' ? 1 : -1; render(); }
  if (action === 'reminder') openModal(`<div class="eyebrow">A LITTLE FORWARD THINKING</div><h2>Your next check-in.</h2><form id="reminder-form"><label>What needs doing?<input name="title" maxlength="120" required placeholder="e.g. Oil change"></label><label>Due date<input name="due" type="date" value="${today()}" required></label><p class="form-error" role="alert"></p><div class="modal-actions"><button class="button secondary" type="button" data-action="close">Cancel</button><button class="button primary" type="submit">Add reminder</button></div></form>`);
  if (action === 'complete') {
    confirmModal('Mark reminder as done?', 'This removes the reminder. Add a separate expense if you paid for a service.', 'Mark as done', () => {
      if (save({ ...state, reminders: state.reminders.filter((row) => row.id !== id) })) { modal.close(); render(); notify('Reminder completed.'); }
    });
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'period') { period = event.target.value; page = 1; render(); }
  if (event.target.id === 'category') { category = event.target.value; page = 1; render(); }
  if (event.target.name === 'category' && event.target.closest('#expense-form')) updateFuelFields();
  if (event.target.name === 'monthOnly') {
    const date = event.target.form.elements.date;
    const value = date.value;
    date.type = event.target.checked ? 'month' : 'date';
    date.value = event.target.checked ? value.slice(0, 7) : '';
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'search') {
    search = event.target.value; page = 1;
    const rows = filteredExpenses();
    document.querySelector('#expense-results').innerHTML = expenseResults(rows);
    document.querySelector('.expenses-panel h2 .count-badge').textContent = rows.length;
    document.querySelector('.expenses-panel .panel-heading p').textContent = `${money(sum(rows), 2)} across the filtered entries.`;
  }
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const errorElement = form.querySelector('.form-error');
  try {
    if (form.id === 'expense-form') {
      const expense = validateExpense({ ...data, fullTank: form.elements.fullTank.disabled ? false : form.elements.fullTank.checked });
      const id = form.dataset.id;
      if (id) expense.id = id;
      const expenses = id ? state.expenses.map((row) => row.id === id ? expense : row) : [...state.expenses, expense];
      if (save({ ...state, expenses })) { modal.close(); render(); notify(id ? 'Expense updated.' : 'Expense added. Your garage is up to date.'); }
    }
    if (form.id === 'car-form') {
      const name = data.name.trim();
      if (!name) throw new Error('Enter a car name.');
      if (save({ ...state, car: { name, plate: (data.plate || '').trim().toUpperCase() } })) { render(); notify('Car details saved.'); }
    }
    if (form.id === 'reminder-form') {
      const next = validateBackup({ ...state, reminders: [...state.reminders, { title: data.title, due: data.due }] });
      if (save({ ...state, reminders: next.reminders })) { modal.close(); render(); notify('Reminder added.'); }
    }
    if (form.id === 'import-form') {
      const file = form.elements.file.files[0];
      if (!file || file.size > 5 * 1024 * 1024) throw new Error('Choose a file smaller than 5 MB.');
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.json')) {
        const restored = validateBackup(JSON.parse(text));
        modal.close();
        confirmModal('Replace your garage?', `This backup contains ${restored.expenses.length} expenses and ${restored.reminders.length} reminders. It replaces all current data. Download a backup of your current garage first if you need it.`, 'Replace with backup', () => {
          if (save(restored)) { modal.close(); period = 'all'; page = 1; render(); notify('Your backup has been restored.'); }
        });
      } else {
        const result = mergeExpenses(state.expenses, parseCSV(text));
        if (save({ ...state, expenses: result.expenses })) { modal.close(); period = 'all'; page = 1; render(); notify(`${result.added} expenses imported. Existing matching entries were skipped.`); }
      }
    }
  } catch (error) {
    if (errorElement) errorElement.textContent = error.message;
    else notify(error.message);
  }
});

window.addEventListener('hashchange', () => {
  view = ['overview', 'expenses', 'garage', 'explorer'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  page = 1; render();
});

// Optional first-run data (plate, past expenses) from the signed-in person's data folder.
async function loadSeed() {
  try {
    const response = await fetch('api/seed', { cache: 'no-store' });
    return response.ok ? await response.json() : {};
  } catch {
    return {};
  }
}

async function start() {
  try {
    const seed = await loadSeed();
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      state = validateBackup(JSON.parse(stored));
      // A garage saved before plates existed picks its plate up from the seed once.
      if (state.car.plate === undefined && seed.car?.plate) {
        state = validateBackup({ ...state, car: { ...state.car, plate: seed.car.plate } });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
    } else {
      state = validateBackup({ version: 1, car: { name: 'My car', plate: seed.car?.plate }, expenses: seed.expenses || [], reminders: [] });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    view = ['overview', 'expenses', 'garage', 'explorer'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
    render();
  } catch (error) {
    app.innerHTML = `<main class="recovery panel"><h1>Your garage couldn’t be opened.</h1><p>${esc(error.message)}</p><p>Browser storage may be unavailable, or saved data may be invalid. Nothing has been overwritten. Enable site storage and reload, or download the saved data before explicitly resetting this garage.</p><div class="actions"><button class="button secondary" id="recover-data">Download stored data</button><button class="button primary" id="reset-data">Reset garage</button></div><p class="form-error" role="alert"></p></main>`;
    document.querySelector('#recover-data').onclick = () => {
      try { download(localStorage.getItem(STORAGE_KEY) || '', 'myfuad-recovery.json', 'application/json'); }
      catch (failure) { document.querySelector('.form-error').textContent = failure.message; }
    };
    document.querySelector('#reset-data').onclick = () => confirmModal('Reset your garage?', 'This removes the stored garage and reloads your original supplied history. Download the stored data first if you need to recover it.', 'Reset garage', () => {
      try { localStorage.removeItem(STORAGE_KEY); modal.close(); start(); }
      catch (failure) { notify(`Reset failed: ${failure.message}`); }
    });
  }
}
start();
