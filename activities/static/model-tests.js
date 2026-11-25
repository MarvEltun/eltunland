import { decodePolyline, routeGeometry, duration, pace, filterPage, formatDate, metric } from "./model.js";

export function runTests() {
  const tests = [];
  function assert(value, message) { if (!value) throw new Error(message); }
  function test(name, fn) { fn(); tests.push(name); }
  test("GPS polylines decode latitude and longitude without reversing", () => {
    const points = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    assert(JSON.stringify(points) === JSON.stringify([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]), "Incorrect coordinates");
    assert(routeGeometry(points).path.startsWith("M"), "No SVG route generated");
    assert(decodePolyline("").length === 0, "Empty polyline failed");
    let failed = false;
    try { decodePolyline("_"); } catch { failed = true; }
    assert(failed, "Truncated polyline accepted");
  });
  test("route fitting handles single coordinates and date-line crossings", () => {
    assert(routeGeometry([[0, 0]]).bounds.every(Number.isFinite), "Invalid stationary geometry");
    assert(routeGeometry([[179.9, 0], [-179.9, 0]]).bounds[2] < 2, "Date line inflated route bounds");
  });
  test("metric formatting distinguishes unreported values from zero", () => {
    assert(metric(null) === "Not provided" && metric(0, 0, "m") === "0 m", "Missing metrics treated as zero");
    assert(duration(0) === "0m 0s" && duration(3661) === "1h 1m", "Duration incorrect");
    assert(pace(0) === "Not provided" && pace(1000 / 359.9) === "6:00 /km", "Pace rounding incorrect");
    assert(formatDate("2026-03-02T00:30:00Z") === "2 Mar 2026", "Local activity date shifted");
  });
  test("search and sport filters apply together to the loaded page", () => {
    const data = [{ name: "Morning park", sport_type: "Run" }, { name: "Evening", sport_type: "Ride" }];
    assert(filterPage(data, " morning ", "Run").length === 1, "Combined filters failed");
    assert(filterPage(data, "morning", "Ride").length === 0, "Sport filter ignored");
  });
  return { passed: tests.length, tests };
}
