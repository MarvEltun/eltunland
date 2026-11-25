import { sum, validateExpense, validateBackup, monthlyTotals, fuelStats, parseCSV, exportCSV, mergeExpenses } from './model.js';
import { buildCar, rotatePoint } from './car-scene.js';

const output = document.querySelector('#results');
let failed = 0;
const assert = (condition, message = 'Assertion failed') => { if (!condition) throw new Error(message); };
const equal = (actual, expected) => assert(JSON.stringify(actual) === JSON.stringify(expected), `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const rejects = (fn) => { let threw = false; try { fn(); } catch { threw = true; } assert(threw, 'Expected validation to reject input'); };
const expense = (overrides = {}) => validateExpense({ date: '2027-01-01', category: 'Gas', amount: 60, ...overrides });
function test(name, fn) {
  try { fn(); output.textContent += `PASS  ${name}\n`; }
  catch (error) { failed++; output.textContent += `FAIL  ${name}: ${error.message}\n`; }
}

// Invented sample garage: month-precision and exact-day entries, no fuel readings.
const sampleExpenses = [
  { id: 's1', date: '2026-03', category: 'Registration', amount: 100, litres: null, odometer: null, fullTank: false, notes: '' },
  { id: 's2', date: '2026-03-19', category: 'Gas', amount: 60, litres: null, odometer: null, fullTank: false, notes: '' },
  { id: 's3', date: '2026-04-02', category: 'Gas', amount: 40, litres: null, odometer: null, fullTank: false, notes: '' },
  { id: 's4', date: '2026-04-10', category: 'Maintenance', amount: 200, litres: null, odometer: null, fullTank: false, notes: '' },
  { id: 's5', date: '2026-04-15', category: 'Insurance', amount: 50, litres: null, odometer: null, fullTank: false, notes: '' },
];

test('Sample history: entry count, exact month and category totals', () => {
  equal(sampleExpenses.length, 5);
  equal(sum(sampleExpenses), 450);
  equal(monthlyTotals(sampleExpenses).map((month) => month.amount), [160, 290]);
  equal(sum(sampleExpenses.filter((row) => row.category === 'Gas')), 100);
  equal(sum(sampleExpenses.filter((row) => row.category === 'Maintenance')), 200);
  equal(sampleExpenses.find((row) => row.category === 'Registration').date, '2026-03');
  equal(fuelStats(sampleExpenses), null);
});
test('Month precision, calendar validation, decimal amounts and fuel requirements', () => {
  equal(expense({ date: '2026-03', category: ' insurance ', amount: '98' }).category, 'Insurance');
  equal(expense({ date: '2028-02-29', amount: 0.29 }).amount, 0.29);
  for (const date of ['2026-02-29', '2026-13', '2026-04-31', '01/02/2026']) rejects(() => expense({ date }));
  for (const amount of [0, -1, Infinity, 'abc', true, [5], 1.001, 1.00001]) rejects(() => expense({ amount }));
  rejects(() => expense({ date: '2026-03', odometer: 1000 }));
  rejects(() => expense({ fullTank: true }));
  rejects(() => expense({ category: 'Insurance', litres: 20 }));
  rejects(() => expense({ fullTank: 'yes' }));
});
test('Full-to-full economy includes intermediate partial fills, not opening fill', () => {
  const rows = [
    expense({ odometer: 1000, litres: 40, fullTank: true, amount: 70 }),
    expense({ date: '2027-01-05', litres: 10, amount: 15 }),
    expense({ date: '2027-01-10', odometer: 1500, litres: 25, fullTank: true, amount: 45 }),
  ];
  const stats = fuelStats(rows);
  assert(Math.abs(stats.economy - 7) < 1e-10);
  equal({ ...stats, economy: 7 }, { economy: 7, costPerKm: 0.12, distance: 500, intervals: 1 });
  equal(fuelStats([...rows, expense({ date: '2027-01-06' })]), null);
  equal(fuelStats([...rows, expense({ date: '2027-01' })]), null);
  equal(fuelStats([rows[0], { ...rows[2], odometer: 900 }]), null);
});
test('CSV round-trip: Unicode, commas, quotes, line breaks, month-only and blank fields', () => {
  const rows = [expense({ notes: '  Café, "hello"\nNew line  ' }), expense({ date: '2027-02', category: 'Insurance', amount: 98 })];
  const reimported = parseCSV(`\uFEFF${exportCSV(rows)}`);
  const withoutId = (entries) => entries.map(({ id, ...row }) => row);
  equal(withoutId(reimported), withoutId(rows));
  equal(parseCSV('date,category,amount\n2027-01,Insurance,98\n\n')[0].date, '2027-01');
});
test('CSV rejects malformed files and invalid rows before returning data', () => {
  for (const csv of [
    'date,category\n2027-01,Gas', 'date,category,amount\n2027-01,Gas,10,extra',
    'date,category,amount\n2027-01,Gas,"10', 'date,category,amount\n2027-01,Gas,-1',
    'date,category,amount\n2027-01,Wrong,10', 'date,category,amount\n2027-01,Gas,10\nbad,Gas,20',
    'date,category,amount,amount\n2027-01,Gas,10,10',
  ]) rejects(() => parseCSV(csv));
});
test('CSV merge preserves repeated legitimate entries and is idempotent', () => {
  const repeated = [expense({ date: '2027-01', category: 'Speed ticket', amount: 20 }), expense({ date: '2027-01', category: 'Speed ticket', amount: 20 })];
  const first = mergeExpenses([], repeated);
  equal(first.added, 2);
  equal(mergeExpenses(first.expenses, repeated).added, 0);
  equal(mergeExpenses([repeated[0]], repeated).added, 1);
});
test('Backup validates all nested records, car and version', () => {
  const backup = { version: 1, expenses: sampleExpenses, car: { name: 'My car' }, reminders: [{ title: 'Oil change', due: '2027-02-01' }] };
  equal(validateBackup(backup).expenses.length, 5);
  equal(validateBackup({ ...backup, car: { name: 'My car', plate: ' ab 123 ' } }).car, { name: 'My car', plate: 'AB 123' });
  rejects(() => validateBackup({ ...backup, version: 2 }));
  rejects(() => validateBackup({ ...backup, car: { name: '' } }));
  rejects(() => validateBackup({ ...backup, reminders: [{ title: 'Test', due: '2027-02-30' }] }));
});
test('Empty reports have no invented economy or months', () => {
  equal(sum([]), 0);
  equal(monthlyTotals([]), []);
  equal(fuelStats([]), null);
});
test('Car cutaway removes the shell while preserving selectable internal parts', () => {
  const exterior = buildCar({ cutaway: false });
  const cutaway = buildCar({ cutaway: true });
  assert(exterior.some((face) => face.layer === 'shell'));
  assert(!exterior.some((face) => face.part === 'battery'), 'Exterior exposes a component through the closed bonnet');
  assert(!cutaway.some((face) => ['shell', 'glass'].includes(face.layer)));
  for (const id of ['engine', 'oil-cap', 'dipstick', 'coolant', 'brake-fluid', 'battery', 'washer', 'wheels', 'roof']) {
    assert(cutaway.some((face) => face.part === id), `Missing selectable component: ${id}`);
  }
  assert(cutaway.every((face) => face.points.every((point) => point.every(Number.isFinite))));
});
test('Exploded view moves parts in 3D without changing their identities', () => {
  const assembled = buildCar({ cutaway: true, exploded: 0 });
  const exploded = buildCar({ cutaway: true, exploded: 1 });
  const firstPoint = (faces, id) => faces.find((face) => face.part === id).points[0];
  assert(firstPoint(exploded, 'engine')[1] > firstPoint(assembled, 'engine')[1]);
  assert(Math.abs(firstPoint(exploded, 'wheels')[0]) > Math.abs(firstPoint(assembled, 'wheels')[0]));
  equal([...new Set(exploded.map((f) => f.part))], [...new Set(assembled.map((f) => f.part))]);
  const rotated = rotatePoint([1, 0, 0], Math.PI / 2, 0);
  assert(Math.abs(rotated[0]) < 1e-10 && Math.abs(rotated[2] + 1) < 1e-10);
  const open = buildCar({ roofOpen: true }).filter((face) => face.part === 'roof');
  const closed = buildCar({ roofOpen: false }).filter((face) => face.part === 'roof');
  assert(JSON.stringify(open) !== JSON.stringify(closed), 'Roof toggle did not change geometry');
});
test('Personalised exterior has white body, red roof and plates only when a plate is set', () => {
  for (const roofOpen of [true, false]) {
    const exterior = buildCar({ cutaway: false, roofOpen, plate: 'AB 123' });
    const roof = exterior.filter((face) => face.part === 'roof' && face.color !== '#789b97');
    assert(roof.length > 0 && roof.every((face) => ['#a52e32', '#c34448'].includes(face.color)));
    assert(exterior.some((face) => face.part === 'body' && face.color === '#f6f7f4'));
    const plates = exterior.filter((face) => face.label === 'AB 123');
    equal(plates.length, 2);
    assert(plates.some((face) => face.points[0][2] < 0));
    assert(plates.some((face) => face.points[0][2] > 0));
    assert(!buildCar({ cutaway: false, roofOpen }).some((face) => face.label), 'Plates drawn without a plate');
    assert(!buildCar({ cutaway: true, roofOpen, plate: 'AB 123' }).some((face) => face.label));
  }
});
output.textContent += `\n${failed ? `${failed} CHECK(S) FAILED` : 'ALL 11 CHECKS PASSED'}`;
document.title = failed ? 'FAIL · MyFuad checks' : 'PASS · MyFuad checks';
