export const categories = ['Gas', 'Insurance', 'Installment', 'Maintenance', 'Registration', 'Tax', 'ACV', 'Parking ticket', 'Speed ticket', 'Parking', 'Other'];
export const colors = {
  Gas: '#a8cf68', Insurance: '#89a7cb', Installment: '#213d35',
  Maintenance: '#ddaa72', Registration: '#b59bc5', Tax: '#e1c66d',
  ACV: '#7eb7ad', 'Parking ticket': '#d17b79', 'Speed ticket': '#ba6b78',
  Parking: '#839c88', Other: '#a4aaa8',
};
export const sum = (rows) => Math.round(rows.reduce((total, row) => total + row.amount, 0) * 100) / 100;
export const uid = () => crypto.randomUUID();

export function validDate(value, monthAllowed = true) {
  if (typeof value !== 'string' || !(monthAllowed ? /^\d{4}-\d{2}(-\d{2})?$/ : /^\d{4}-\d{2}-\d{2}$/).test(value)) return false;
  const full = value.length === 7 ? `${value}-01` : value;
  const parsed = new Date(`${full}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === full && Number(value.slice(0, 4)) >= 1900;
}

function optionalNumber(value, name) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${name} must be a number.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1e9) throw new Error(`${name} must be a positive number.`);
  return number;
}

export function validateExpense(row) {
  if (!row || typeof row !== 'object') throw new Error('Invalid expense.');
  if (!validDate(row.date)) throw new Error('Use a valid date: YYYY-MM or YYYY-MM-DD.');
  const category = categories.find((item) => item.toLowerCase() === String(row.category).trim().toLowerCase());
  if (!category) throw new Error(`Unknown category "${row.category}". Use one of: ${categories.join(', ')}.`);
  const amount = optionalNumber(row.amount, 'Amount');
  if (amount === null || amount !== Math.round(amount * 100) / 100) throw new Error('Amount must be positive with at most two decimal places.');
  const litres = optionalNumber(row.litres, 'Litres');
  const odometer = optionalNumber(row.odometer, 'Odometer');
  const fullTank = row.fullTank === true || row.fullTank === 'true';
  if (row.fullTank !== undefined && ![true, false, 'true', 'false', ''].includes(row.fullTank)) throw new Error('fullTank must be true or false.');
  if (category !== 'Gas' && (litres !== null || fullTank)) throw new Error('Litres and full-tank status are only available for Gas expenses.');
  if ((litres !== null || odometer !== null || fullTank) && row.date.length !== 10) throw new Error('An exact day is required for fuel and odometer readings.');
  if (fullTank && (litres === null || odometer === null)) throw new Error('A full-tank entry needs litres and an odometer reading.');
  if (row.notes !== undefined && typeof row.notes !== 'string') throw new Error('Notes must be text.');
  if ((row.notes || '').length > 2000) throw new Error('Notes must be 2,000 characters or fewer.');
  return { id: uid(), date: row.date, category, amount, litres, odometer, fullTank, notes: row.notes || '' };
}

export function validateBackup(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.expenses) || !Array.isArray(input.reminders)) throw new Error('This is not a MyFuad v1 backup.');
  const expenses = input.expenses.map(validateExpense);
  const reminders = input.reminders.map((item) => {
    if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120 || !validDate(item.due, false)) throw new Error('Invalid maintenance reminder in backup.');
    return { id: uid(), title: item.title.trim(), due: item.due };
  });
  if (!input.car || typeof input.car.name !== 'string' || !input.car.name.trim() || input.car.name.length > 80) throw new Error('Invalid car name in backup.');
  const plate = typeof input.car.plate === 'string' ? input.car.plate.trim().toUpperCase().slice(0, 12) : '';
  return { version: 1, expenses, reminders, car: { name: input.car.name.trim(), ...(input.car.plate === undefined ? {} : { plate }) } };
}

export function monthlyTotals(rows) {
  const months = new Map();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(row);
  }
  return [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, entries]) => ({ month, amount: sum(entries), entries }));
}

export function fuelStats(rows) {
  const fuel = rows.filter((row) => row.category === 'Gas').slice()
    .sort((a, b) => a.date.localeCompare(b.date) || (a.odometer ?? Infinity) - (b.odometer ?? Infinity));
  let start = -1;
  let distance = 0;
  let litres = 0;
  let cost = 0;
  let intervals = 0;
  fuel.forEach((row, i) => {
    if (!row.fullTank || row.odometer === null || row.litres === null) return;
    if (start >= 0) {
      const segment = fuel.slice(start + 1, i + 1);
      const km = row.odometer - fuel[start].odometer;
      const unknownDay = fuel.some((fill) => fill.date.length === 7 &&
        fill.date >= fuel[start].date.slice(0, 7) && fill.date <= row.date.slice(0, 7));
      // Month-only or incomplete fills cannot establish a full-to-full interval.
      if (km > 0 && !unknownDay && segment.every((fill) => fill.litres !== null && fill.date.length === 10)) {
        distance += km;
        litres += segment.reduce((total, fill) => total + fill.litres, 0);
        cost += sum(segment);
        intervals++;
      }
    }
    start = i;
  });
  return intervals ? { economy: litres / distance * 100, costPerKm: cost / distance, distance, intervals } : null;
}

export const csvHeaders = ['date', 'category', 'amount', 'litres', 'odometer', 'fullTank', 'notes'];
export function exportCSV(rows) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [csvHeaders.join(','), ...rows.map((row) => csvHeaders.map((key) => quote(row[key])).join(','))].join('\r\n');
}

export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"' && cell === '' && !closed) {
      quoted = true;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (char !== ',') {
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
      }
    } else {
      if (closed || char === '"') throw new Error('Malformed CSV quoting.');
      cell += char;
    }
  }
  if (quoted) throw new Error('Unclosed quote in CSV.');
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV needs a header and at least one expense.');
  const headers = rows.shift().map((header) => header.trim());
  if (new Set(headers).size !== headers.length || headers.some((header) => !csvHeaders.includes(header))) throw new Error(`CSV headers must be unique and use: ${csvHeaders.join(', ')}.`);
  if (!['date', 'category', 'amount'].every((key) => headers.includes(key))) throw new Error('CSV requires date, category, and amount columns.');
  return rows.map((values, i) => {
    try {
      if (values.length !== headers.length) throw new Error('Column count does not match the header.');
      return validateExpense(Object.fromEntries(headers.map((key, j) => [key, key === 'notes' ? values[j] : values[j].trim()])));
    } catch (error) {
      throw new Error(`CSV row ${i + 2}: ${error.message}`);
    }
  });
}

export function mergeExpenses(existing, incoming) {
  const key = (row) => JSON.stringify(csvHeaders.map((header) => row[header]));
  const counts = new Map();
  existing.forEach((row) => counts.set(key(row), (counts.get(key(row)) || 0) + 1));
  const added = incoming.filter((row) => {
    const count = counts.get(key(row)) || 0;
    if (count) { counts.set(key(row), count - 1); return false; }
    return true;
  });
  return { expenses: [...existing, ...added], added: added.length };
}
