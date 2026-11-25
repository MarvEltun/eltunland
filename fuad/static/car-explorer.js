import { carParts, handbook, manualLink } from './car-manual.js';
import { createCarScene } from './car-scene.js';

const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

export function carExplorerView() {
  return `<section id="car-explorer">
    <div class="explorer-intro"><div><span class="eyebrow">A CLOSER LOOK AT YOUR CINQUECENTO</span><h2>Small car. A lot to discover.</h2><p>An interactive guide to the big little things under the bonnet.</p></div><div class="vehicle-spec"><strong>500<span>C</span></strong><div>2015 · 1.2 petrol<br><small>Germany · left-hand drive</small></div></div></div>
    <div class="car-explorer-grid">
      <section class="panel car-stage" aria-label="Interactive illustrative 3D car">
        <div class="car-stage-toolbar"><div class="car-modes" role="group" aria-label="Model display"><button id="car-exterior" aria-pressed="true">Exterior</button><button id="car-cutaway" aria-pressed="false">Cutaway</button></div><span class="model-badge"><i></i> ILLUSTRATIVE 3D MODEL</span></div>
        <div class="car-canvas-wrap"><canvas id="car-canvas" tabindex="0" role="img" aria-label="Rotatable illustrative Fiat 500C. Drag or use arrow keys to rotate, plus and minus to zoom. Select parts using the buttons below."></canvas><div class="car-stage-label"><span>FIAT 500C</span><strong>Made for a closer look.</strong></div><div class="car-view-controls" role="group" aria-label="Camera controls"><button id="car-zoom-in" aria-label="Zoom car in">+</button><button id="car-zoom-out" aria-label="Zoom car out">−</button><button id="car-reset" aria-label="Reset car view">⌂</button></div><div class="car-drag-hint">Drag to rotate · Select a visible part</div></div>
        <div class="car-scene-error" id="car-scene-error" role="alert" hidden></div>
        <div class="car-stage-options"><div class="car-perspectives" role="group" aria-label="View angle"><button data-camera="perspective" aria-pressed="true">Perspective</button><button data-camera="front" aria-pressed="false">Front</button><button data-camera="top" aria-pressed="false">Above</button></div><button id="car-roof" class="car-roof-button" aria-pressed="true">Roof open <span>↗</span></button></div>
        <div class="exploded-control"><label for="car-explode">Separate parts <span id="car-explode-value">0%</span></label><input id="car-explode" type="range" min="0" max="100" step="1" value="0" aria-describedby="car-explode-note"><p id="car-explode-note">Illustrative exploded view, not a disassembly sequence.</p></div>
      </section>
      <aside class="panel car-part-panel" aria-label="Selected part information"><div id="car-part-info" aria-live="polite"></div></aside>
    </div>
    <section class="panel car-parts-panel"><div class="panel-heading"><div><h2>Get to know the parts</h2><p>Choose a component. Under-bonnet parts automatically reveal the cutaway.</p></div><span class="car-parts-count">${carParts.length} POINTS OF INTEREST</span></div><div class="car-parts-list" aria-label="Select a car part">${carParts.map((part) => `<button class="car-part-button" data-part="${part.id}" aria-pressed="${part.id === 'roof'}"><span class="car-part-marker" style="--part-color:${part.color}">${part.marker}</span><span><strong>${part.name}</strong><small>${part.group}</small></span><span class="part-arrow">↗</span></button>`).join('')}</div></section>
    <section class="car-manual-source"><span class="manual-icon" aria-hidden="true">▤</span><div><h3>From the handbook, not guesswork.</h3><p>Concise, original English summaries of Fiat’s German owner’s handbook. Source: ${handbook.edition}. Engine-bay letters A–F follow the 1.2 8V diagram on printed page 126.</p><p><strong>Edition check:</strong> 2015 registrations can span different builds. This November 2015 handbook has not been matched to your VIN. Verify the supplied handbook or use Fiat eLUM before applying specifications. Shapes, positions and separation are approximate; this is not a workshop manual or parts catalogue.</p><div class="manual-links"><a href="${handbook.url}" target="_blank" rel="noopener noreferrer">Official handbook ↗</a><a href="https://aftersales.fiat.com/elum/" target="_blank" rel="noopener noreferrer">Find your VIN-specific manual ↗</a></div></div></section>
  </section>`;
}

export function mountCarExplorer(root, plate = '') {
  const query = (selector) => root.querySelector(selector);
  const abort = new AbortController();
  const events = { signal: abort.signal };
  const options = { cutaway: false, exploded: 0, roofOpen: true, selected: 'roof', plate };
  let scene;
  const showError = (text) => {
    query('#car-scene-error').hidden = false;
    query('#car-scene-error').textContent = text;
  };
  function showPart(id) {
    const part = carParts.find((p) => p.id === id);
    if (!part) throw new Error('Unknown car part.');
    options.selected = id;
    if (part.group === 'Under the bonnet' || id === 'engine') options.cutaway = true;
    if (id === 'body') options.cutaway = false;
    query('#car-part-info').innerHTML = `
      <div class="part-info-top"><span class="eyebrow">${escapeHTML(part.group.toUpperCase())}</span><span class="car-part-marker large" style="--part-color:${part.color}">${part.marker}</span></div>
      <h2>${part.name}</h2><p class="part-german">${part.german}</p><p class="part-summary">${part.summary}</p>
      <dl class="part-facts">${part.facts.map(([key,value]) => `<div><dt>${escapeHTML(key)}</dt><dd>${escapeHTML(value)}</dd></div>`).join('')}</dl>
      <div class="part-care"><span class="eyebrow">WORTH KNOWING</span><p>${part.care}</p></div>
      <div class="part-reference"><span>OFFICIAL OWNER’S HANDBOOK</span><strong>${part.section}</strong><a href="${manualLink(part.page)}" target="_blank" rel="noopener noreferrer">Read printed page ${part.page} <span>↗</span></a>${part.diagramPage ? `<a href="${manualLink(part.diagramPage)}" target="_blank" rel="noopener noreferrer">Engine-bay diagram · p. ${part.diagramPage} ↗</a>` : ''}<small>PDF page ${part.page + 2} · German original</small></div>`;
    for (const button of root.querySelectorAll('[data-part]')) button.setAttribute('aria-pressed', String(button.dataset.part === id));
    update();
  }
  function update() {
    query('#car-exterior').setAttribute('aria-pressed', String(!options.cutaway));
    query('#car-cutaway').setAttribute('aria-pressed', String(options.cutaway));
    query('#car-roof').setAttribute('aria-pressed', String(options.roofOpen));
    query('#car-roof').innerHTML = `${options.roofOpen ? 'Roof open' : 'Roof closed'} <span>↗</span>`;
    scene?.update(options);
  }
  root.addEventListener('click', (event) => {
    const part = event.target.closest('[data-part]');
    if (part) showPart(part.dataset.part);
    const camera = event.target.closest('[data-camera]');
    if (camera) {
      scene?.camera(camera.dataset.camera);
      for (const button of root.querySelectorAll('[data-camera]')) button.setAttribute('aria-pressed', String(button === camera));
    }
  }, events);
  query('#car-exterior').addEventListener('click', () => { options.cutaway = false; update(); }, events);
  query('#car-cutaway').addEventListener('click', () => { options.cutaway = true; update(); }, events);
  query('#car-roof').addEventListener('click', () => { options.roofOpen = !options.roofOpen; update(); }, events);
  query('#car-explode').addEventListener('input', (event) => {
    options.exploded = Number(event.target.value) / 100;
    query('#car-explode-value').textContent = `${event.target.value}%`;
    if (options.exploded > 0) options.cutaway = true;
    update();
  }, events);
  query('#car-zoom-in').addEventListener('click', () => scene?.zoom(1.15), events);
  query('#car-zoom-out').addEventListener('click', () => scene?.zoom(1/1.15), events);
  query('#car-reset').addEventListener('click', () => {
    scene?.camera('perspective');
    for (const button of root.querySelectorAll('[data-camera]')) button.setAttribute('aria-pressed', String(button.dataset.camera === 'perspective'));
  }, events);
  try { scene = createCarScene(query('#car-canvas'), showPart, showError); }
  catch (error) { showError(error.message); }
  showPart('roof');
  return () => { abort.abort(); scene?.dispose(); };
}
