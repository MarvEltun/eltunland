export const handbook = {
  title: 'Fiat 500 / 500C · Betriebsanleitung',
  edition: '603.99.758 · German · November 2015',
  url: 'https://aftersales.fiat.com/eLumData/DE/00/150_500/00_150_500_603.99.758_DE_03_11.15_L_LG/00_150_500_603.99.758_DE_03_11.15_L_LG.pdf',
};

// Printed page numbers exclude the two front-matter PDF pages.
export function manualLink(printedPage) {
  return `${handbook.url}#page=${printedPage + 2}`;
}

export const carParts = [
  {
    id: 'engine', name: '1.2 petrol engine', german: 'Motor · 1.2 8V 69 PS', group: 'Powertrain',
    marker: '01', color: '#899da4', anchor: [0, .95, -1.03], page: 137, section: 'Technische Daten · Motor',
    summary: 'The handbook lists the 1.2 8V petrol engine as a 1,242 cm³ inline four-cylinder, with 51 kW (69 PS) and engine code 169A4000.',
    facts: [['Displacement', '1,242 cm³'], ['Power', '51 kW / 69 PS'], ['Fuel', '95 RON petrol · EN228']],
    care: 'These are reference specifications for the handbook’s 1.2 8V entry. Confirm the engine code and build version against your vehicle documents.',
  },
  {
    id: 'oil-cap', name: 'Engine oil filler', german: 'Motoröl-Einfülldeckel', group: 'Under the bonnet',
    marker: 'B', color: '#e5c15b', anchor: [.03, 1.04, -1.12], page: 128, diagramPage: 126, section: 'Kontrolle der Füllstände · Motoröl',
    summary: 'The 1.2 engine-bay diagram identifies the oil filler as B. The oil level belongs between the dipstick’s MIN and MAX marks; the handbook says not to exceed MAX.',
    facts: [['Diagram reference', 'B · printed page 126'], ['Level reference', 'Dipstick MIN–MAX']],
    care: 'Use only the oil specification appropriate to your exact engine and build. This explorer intentionally does not prescribe an oil grade or a refill procedure.',
  },
  {
    id: 'dipstick', name: 'Oil dipstick', german: 'Ölpeilstab', group: 'Under the bonnet',
    marker: 'E', color: '#e7a24f', anchor: [.32, .94, -1.34], page: 128, diagramPage: 126, section: 'Kontrolle der Füllstände · Motoröl',
    summary: 'The 1.2 8V diagram has a separate dipstick, marked E. The manual uses its MIN and MAX marks to assess engine-oil level.',
    facts: [['Diagram reference', 'E · printed page 126'], ['Engine variant', '1.2 8V · separate dipstick']],
    care: 'The handbook covers several engines: the TwinAir dipstick arrangement differs. Use the 1.2 8V diagram, not a diagram for a different engine.',
  },
  {
    id: 'coolant', name: 'Coolant reservoir', german: 'Motorkühlmittel', group: 'Under the bonnet',
    marker: 'A', color: '#dca6a2', anchor: [.54, .93, -.82], page: 128, diagramPage: 126, section: 'Flüssigkeit der Motorkühlanlage',
    summary: 'The engine-bay diagram marks the coolant reservoir A. The handbook specifies a cold-engine level check, with the level between MIN and MAX on the reservoir.',
    facts: [['Diagram reference', 'A · printed page 126'], ['Level reference', 'MIN–MAX · engine cold']],
    care: 'Never open the cooling system when hot. It may be pressurised. Ask a qualified technician about coolant loss or overheating.',
  },
  {
    id: 'brake-fluid', name: 'Brake-fluid reservoir', german: 'Bremsflüssigkeit', group: 'Under the bonnet',
    marker: 'C', color: '#d5c2a0', anchor: [-.45, .96, -.55], page: 128, diagramPage: 126, section: 'Kontrolle der Füllstände · Bremsflüssigkeit',
    summary: 'Brake fluid is marked C in the engine-bay diagram. The handbook notes that it absorbs moisture and that its level must not exceed the reservoir’s MAX mark.',
    facts: [['Diagram reference', 'C · printed page 126'], ['System', 'Hydraulic braking']],
    care: 'Brakes are safety-critical. This is identification only—not bleeding, topping-up or repair guidance. Have a qualified technician investigate low fluid or brake warnings.',
  },
  {
    id: 'battery', name: '12 V battery', german: 'Batterie', group: 'Under the bonnet',
    marker: 'D', color: '#638f85', anchor: [-.5, .82, -1.02], page: 129, diagramPage: 126, section: 'Batterie · Austausch der Batterie',
    summary: 'The handbook marks the battery D and describes a low-maintenance unit. A replacement must have appropriate matching characteristics; Start&Stop versions have additional battery-sensor considerations.',
    facts: [['Diagram reference', 'D · printed page 126'], ['Version dependent', 'Start&Stop equipment']],
    care: 'Battery replacement and charging should follow the full manual and be handled by qualified personnel. This view does not show wiring or jump-start connections.',
  },
  {
    id: 'washer', name: 'Washer-fluid filler', german: 'Scheibenwaschflüssigkeit', group: 'Under the bonnet',
    marker: 'F', color: '#729fbc', anchor: [.55, .8, -1.37], page: 128, diagramPage: 126, section: 'Windschutz-/Heckscheibenwaschflüssigkeit',
    summary: 'The washer-fluid filler is F in the 1.2 engine-bay diagram. The handbook distinguishes warm- and cold-weather washer-fluid mixtures.',
    facts: [['Diagram reference', 'F · printed page 126'], ['System', 'Windscreen / rear-window washing']],
    care: 'Do not confuse washer fluid with coolant or brake fluid. Follow the product’s instructions and the handbook for local winter conditions.',
  },
  {
    id: 'roof', name: '500C fabric roof', german: 'Verdeck', group: 'Body & cabin',
    marker: '02', color: '#766957', anchor: [0, 1.49, .85], page: 38, section: 'Kenntnis des Fahrzeugs · Verdeck',
    summary: 'The 500C uses an electrically operated fabric roof. The handbook describes its opening positions and notes that operation may need reinitialisation after battery or fuse disconnection.',
    facts: [['Body style', '500C · fabric roof'], ['Manual topic', 'Verdeck · pp. 36–39']],
    care: 'Keep people and objects clear of moving roof parts. Never put luggage on the fabric. The roof button here changes the illustration only; it is not an operating procedure.',
  },
  {
    id: 'wheels', name: 'Wheels & tyres', german: 'Räder und Reifen', group: 'Running gear',
    marker: '03', color: '#8a9094', anchor: [-.86, .38, -1.09], page: 129, section: 'Wartung und Pflege · Räder und Reifen',
    summary: 'The handbook calls for checking tyre pressures when cold, every two weeks and before long journeys. The correct pressure depends on tyre size and vehicle load.',
    facts: [['Check condition', 'Tyres cold'], ['Pressure tables', 'Printed page 142']],
    care: 'Use the pressure table for your fitted tyre size and load, not a generic value. Wheel style and tyre dimensions in this model are illustrative.',
  },
  {
    id: 'body', name: 'Body & cabin', german: 'Karosserie', group: 'Body & cabin',
    marker: '04', color: '#d7dfcd', anchor: [0, .94, .35], page: 132, section: 'Wartung und Pflege · Karosserie',
    summary: 'The handbook’s body-care section covers preserving the finish and protecting the bodywork. The paint is a protective layer as well as a cosmetic finish.',
    facts: [['Reference vehicle', '2015 · Germany · LHD'], ['Visual style', 'Illustrative cutaway']],
    care: 'The model is not a parts catalogue, repair drawing or exact component locator. Use the official diagrams and a qualified workshop for actual maintenance.',
  },
];
