import { parseFlights, filterFlights, summarize, greatCircleDistance, greatCirclePoints, routeKey, exportCSV } from "./flight-model.js";

// Runs against an invented sample (fixtures/sample-flights.tsv), never your own flights file.
export async function runTests() {
  const response = await fetch(new URL("fixtures/sample-flights.tsv", import.meta.url));
  if (!response.ok) throw new Error(`Fixture failed to load (${response.status}).`);
  const source = await response.text();
  const flights = parseFlights(source);
  const passed = [];
  function test(name, fn) { fn(); passed.push(name); }
  function assert(value, message) { if (!value) throw new Error(message); }
  function rejects(text, message) {
    let failed = false;
    try { parseFlights(text); } catch (error) { failed = error.message.includes(message); }
    assert(failed, `Expected validation error containing ${message}`);
  }
  test("all sample flight legs are preserved in file order", () => {
    assert(flights.length === 6, `Got ${flights.length} flights`);
    assert(flights[0].date === "2025-02-15" && flights.at(-1).date === "2024-03-03", "Dates changed");
  });
  test("blank distances reuse airport coordinates, not zero coordinates", () => {
    const missing = flights.filter((f) => f.estimated);
    assert(missing.length === 2, "Expected exactly two calculated distances");
    assert(missing.every((f) => f.distance > 300 && f.distance < 400), "Unexpected calculated distance");
    assert(flights[0].origin.code === "LHR" && flights[0].destination.code === "CDG", "Flight direction reversed");
    assert(flights[2].distance === 370.5, "Supplied distance changed");
  });
  test("coordinated filters combine year, airline, text and undirected route", () => {
    const result = filterFlights(flights, { year: "2025", airline: "Alpha Air", query: " lhr ", route: routeKey("CDG", "LHR") });
    assert(result.length === 2, "Combined filters did not match both directions");
    assert(filterFlights(flights, { query: "no-such-airport" }).length === 0, "Empty search matched");
    assert(filterFlights(flights, { year: "2024", query: "Amsterdam" }).length === 2, "Airport name enrichment missing");
  });
  test("bidirectional routes aggregate without collapsing flight legs", () => {
    const summary = summarize(filterFlights(flights, { year: "2025" }));
    assert(summary.routes.length === 1 && summary.airports.size === 2, "Wrong route or airport count");
    assert(summary.routes[0].count === 2, "Return flights not combined");
    assert(summary.estimated === 2 && summary.distance > 600 && summary.distance < 800, "Wrong estimated distance total");
    assert(summarize([]).distance === 0 && summarize([]).routes.length === 0, "Empty summary failed");
  });
  test("invalid dates, codes, distances, units and missing coordinates are rejected", () => {
    rejects(source.replace("2/15/2025", "2/30/2025"), "Invalid date");
    rejects(source.replace("2/15/2025", "15/2/2025"), "Invalid date");
    rejects(source.replace("\tCDG\t", "\tXXX\t"), "Missing airport coordinates");
    rejects(source.replace("370.5", "-1"), "Invalid distance");
    rejects(source.replace("370.5\tkm", "370.5\tmi"), "Expected kilometer");
    rejects(source.replace("49.0097", "99"), "Invalid coordinates");
    rejects("date\tairline\n", "required columns");
  });
  test("great-circle distance and geometry are spherical", () => {
    const a = { lat: 0, lon: 0 }, b = { lat: 0, lon: 90 };
    assert(Math.abs(greatCircleDistance(a, b) - 10007.557) < .01, "Quarter circumference incorrect");
    const points = greatCirclePoints(flights[0].origin, flights[0].destination);
    assert(points.length === 49 && points.every((p) => p.every(Number.isFinite)), "Invalid arc");
    assert(Math.abs(points[0][0] - flights[0].origin.lon) < 1e-8, "Arc origin incorrect");
    assert(Math.abs(points.at(-1)[1] - flights[0].destination.lat) < 1e-8, "Arc destination incorrect");
    assert(greatCircleDistance(a, a) === 0, "Coincident airport distance incorrect");
  });
  test("CSV exports only selection, provenance and correctly escaped cells", () => {
    const csv = exportCSV([{ ...flights[0], airline: '=test,"quote"' }]);
    assert(csv.split("\r\n").length === 2, "Wrong CSV row count");
    assert(csv.includes("\"'=test,\"\"quote\"\"\""), "Spreadsheet formula / quoting not handled");
    assert(csv.includes("calculated great-circle"), "Estimated distance provenance missing");
    assert(exportCSV([flights[2]]).includes("supplied"), "Supplied provenance missing");
  });
  return { passed: passed.length, tests: passed };
}
