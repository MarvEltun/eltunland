# MyFuad

A private, local-first car dashboard. No account, dependencies, build step, or external services.

## Run

MyFuad is part of the Hub project: start the one server from the project folder
(`.venv/bin/python main.py`, see the main README) and open
<http://127.0.0.1:5173/fuad/>. Your garage is stored in the browser for the address
`127.0.0.1:5173`, so keep using that same address (including the port) to see it.

## Your garage

- Optional starting data (your number plate and past expenses) is read on first launch from `data/users/<username>/fuad-seed.json` (format in `data.example/`). Without it the garage starts empty.
- Add, edit, delete, search, and filter expenses. Reporting is in EUR, kilometres, and litres.
- Month-only historical entries preserve their precision. ACV is kept as its own category.
- Overview shows monthly/category spending, monthly averages across **months with recorded expenses**, and data-derived insights. The latest month may be incomplete.
- Fuel economy uses full-to-full intervals, including intermediate partial fills. Record litres and odometer at each fuel purchase; mark full tanks. Incomplete intervals are excluded. Fuel cost/km is fuel-only, not total ownership cost/km.
- My garage shows odometer readings, maintenance history, and date-based reminders. Reminders are in-app only. Completing one removes it; add service expenses separately.
- **Car explorer** adds a procedural, rotatable 3D illustration of a 2015 Fiat
  500C, 1.2 petrol, German market, left-hand drive. It does not change your saved
  car name, expenses or reminders.

## Car explorer

Open **Car explorer** in the sidebar, or visit <http://127.0.0.1:5173/fuad/#explorer>.
Drag the model to rotate, use the camera presets/zoom buttons, or focus the
canvas and use arrow keys, `+`/`-` and `Home`. Choose an exterior part directly
on the model or use the keyboard-accessible parts list. Selecting an engine-bay
component switches to cutaway; the separation slider produces an illustrative
exploded view. The roof toggle changes the fabric-roof illustration.

Ten part cards cover the engine, oil filler, dipstick, coolant, brake fluid,
battery, washer-fluid filler, roof, wheels and body. Engine-bay letters A–F match
the handbook's 1.2 8V legend. Each card includes an original English summary,
a German section name, and a link to the relevant official handbook page.
The model uses projected 3D polygon geometry on a canvas; it requires neither
WebGL nor a downloaded car asset or third-party library. Part cards remain
available if the canvas cannot be created.

**Source:** Fiat's German November 2015 owner handbook, publication
**603.99.758**, from
[Fiat eLUM](https://aftersales.fiat.com/eLumData/DE/00/150_500/00_150_500_603.99.758_DE_03_11.15_L_LG/00_150_500_603.99.758_DE_03_11.15_L_LG.pdf).
Printed page numbers are two less than PDF page numbers. Verified sections:
the 500C roof (pp. 36–39), engine-bay diagram (p. 126), fluids (p. 128),
battery/tyres (p. 129), body care (p. 132), 1.2 engine specifications (p. 137),
and tyre-pressure tables (p. 142).

**Important:** this reference edition is not VIN-matched. A car registered in
2015 may be an earlier build or have different equipment. Confirm applicability
using your supplied handbook or [Fiat eLUM](https://aftersales.fiat.com/elum/).
The geometry, component positions, wheel style and separation are approximate,
not factory CAD or a parts catalogue. The owner handbook is not a workshop
manual; the app deliberately omits repair procedures and variant-dependent
oil grades, pressures and service intervals. Use a qualified technician for
safety-critical maintenance.

No handbook text, diagrams or 3D assets are redistributed. Handbook links open
Fiat's website and need an internet connection; the model and summaries run
locally without external requests.

## Import and backup

Use **Expenses → Import** for a comma-delimited UTF-8 CSV (including exports from Excel) with required headers `date,category,amount`. Optional columns are `litres,odometer,fullTank,notes`. Download the example from the import dialog. Amounts must be positive with at most two decimal places.

Dates use `YYYY-MM-DD` or `YYYY-MM` when the day is unknown. Fuel/odometer readings require an exact day. `fullTank` accepts `true`, `false`, or blank. Categories: Gas, Insurance, Installment, Maintenance, Registration, Tax, ACV, Parking ticket, Speed ticket, Parking, Other (case-insensitive).

CSV import validates the entire file before saving and merges entries, skipping matches already present. Identical repeated rows within the source are preserved up to their source count. Export CSV follows the current year, category, and search filters, across all pages.

**Download backup** exports the complete garage as JSON, including car details and reminders. Importing JSON replaces the entire garage after explicit confirmation. Maximum import size: 5 MB.

Data lives in browser localStorage. Clearing browser/site data, private browsing, a different port, or another device will not retain it. **Keep JSON backups.** There is no cloud sync or background server storage.

## Checks

With the server running, open <http://127.0.0.1:5173/fuad/tests.html> for dependency-free model checks. These do not modify garage storage.
