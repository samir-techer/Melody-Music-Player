/**
 * equalizer-screen.js
 * A dedicated Equalizer screen, split out of Settings' "Audio Processing"
 * section for quicker access from Now Playing. Two ways to shape sound,
 * both driving the exact same three BiquadFilter nodes already live in
 * player-service.js (eqBass/eqMid/eqTreble) — never a second, competing
 * filter chain:
 *
 *   1. Presets — the existing EQ_PRESETS (Normal/Bass Boost/Vocal/Rock/
 *      Pop/Classical), reused as-is from player-service.js.
 *   2. Custom — three vertical sliders (Bass / Vocal / Treble) the person
 *      can dial in by hand, each with its own on/off switch. Picking a
 *      preset updates these sliders to reflect it; dragging a slider
 *      switches the audio path into "custom" mode.
 *
 * Both are gated behind the same Basic+ requirement the preset system
 * already enforced — this screen doesn't loosen or duplicate that gate,
 * it just gives it a second, more direct entry point.
 */

import { navigate } from '../utils/router.js';
import {
  EQ_PRESETS, getEqualizerPreset, useEqPreset,
  getManualEqState, setManualEqBand, setManualEqBandEnabled, resetManualEq,
} from '../services/player-service.js';
import { hasPremiumAccess } from '../services/premium-service.js';
import { showUpgradeDialog } from '../utils/upgrade-dialog.js';

const BAND_LABELS = { bass: 'Bass', mid: 'Vocal', treble: 'Treble' };
const BAND_ICONS = { bass: '🔊', mid: '🎤', treble: '🎵' };

export async function renderEqualizerScreen() {
  const el = document.createElement('div');
  el.className = 'screen eq-screen';

  const activePreset = getEqualizerPreset();
  const manual = getManualEqState();

  el.innerHTML = `
    <div class="player-topbar">
      <button id="eq-back" aria-label="Back">‹</button>
      <span class="player-topbar-label">Equalizer</span>
      <button id="eq-reset" aria-label="Reset">Reset</button>
    </div>

    ${!manual.unlocked ? `
      <div class="eq-locked-banner">
        <p>🔒 The Equalizer is a <strong>Basic+</strong> feature.</p>
        <button class="btn-primary" id="eq-upgrade-btn" style="margin-top: var(--space-2);">Upgrade</button>
      </div>
    ` : ''}

    <section class="section">
      <div class="section-heading"><h2>Presets</h2></div>
      <div class="eq-preset-grid" id="eq-preset-grid">
        ${Object.entries(EQ_PRESETS).map(([key, preset]) => {
          const unlocked = hasPremiumAccess(preset.requiredPlan);
          const isActive = manual.mode === 'preset' && activePreset === key;
          return `<button type="button" class="eq-preset-chip ${isActive ? 'active' : ''} ${unlocked ? '' : 'locked'}" data-eq-key="${key}" data-required-plan="${preset.requiredPlan}">${unlocked ? '' : '🔒 '}${preset.label}</button>`;
        }).join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-heading"><h2>Custom</h2></div>
      <div class="eq-band-row" id="eq-band-row">
        ${Object.keys(BAND_LABELS).map((band) => `
          <div class="eq-band" data-band="${band}">
            <span class="eq-band-value" id="eq-value-${band}">${formatDb(manual.bands[band])}</span>
            <input type="range" class="eq-band-slider" id="eq-slider-${band}"
                   min="-${manual.range}" max="${manual.range}" step="1"
                   value="${manual.bands[band]}"
                   ${manual.unlocked ? '' : 'disabled'} />
            <span class="eq-band-icon" aria-hidden="true">${BAND_ICONS[band]}</span>
            <span class="eq-band-label">${BAND_LABELS[band]}</span>
            <label class="eq-band-switch">
              <input type="checkbox" id="eq-toggle-${band}" ${manual.enabled[band] ? 'checked' : ''} ${manual.unlocked ? '' : 'disabled'} />
              <span class="eq-band-switch-track"></span>
            </label>
          </div>
        `).join('')}
      </div>
      <p class="settings-hint" style="text-align:center;">Drag a slider to switch to Custom mode.</p>
    </section>
  `;

  el.querySelector('#eq-back').addEventListener('click', () => navigate('player'));

  if (!manual.unlocked) {
    el.querySelector('#eq-upgrade-btn')?.addEventListener('click', () => {
      showUpgradeDialog('Upgrade to Basic to unlock the Equalizer.', 'Basic');
    });
  }

  // ---------- Presets ----------
  el.querySelector('#eq-preset-grid').addEventListener('click', (e) => {
    const chip = e.target.closest('.eq-preset-chip');
    if (!chip) return;
    const key = chip.dataset.eqKey;
    const requiredPlan = chip.dataset.requiredPlan;
    if (!hasPremiumAccess(requiredPlan)) {
      showUpgradeDialog(`Upgrade to ${requiredPlan} to unlock ${chip.textContent.trim()}.`, requiredPlan);
      return;
    }
    useEqPreset(key);
    const preset = EQ_PRESETS[key];
    el.querySelectorAll('.eq-preset-chip').forEach((c) => c.classList.toggle('active', c === chip));
    Object.keys(BAND_LABELS).forEach((band) => {
      const value = band === 'mid' ? preset.mid : preset[band];
      el.querySelector(`#eq-slider-${band}`).value = value;
      el.querySelector(`#eq-value-${band}`).textContent = formatDb(value);
      el.querySelector(`#eq-toggle-${band}`).checked = true;
    });
  });

  // ---------- Custom sliders ----------
  Object.keys(BAND_LABELS).forEach((band) => {
    const slider = el.querySelector(`#eq-slider-${band}`);
    const valueEl = el.querySelector(`#eq-value-${band}`);
    const toggle = el.querySelector(`#eq-toggle-${band}`);

    slider.addEventListener('input', () => {
      valueEl.textContent = formatDb(Number(slider.value));
    });
    slider.addEventListener('change', () => {
      setManualEqBand(band, Number(slider.value));
      el.querySelectorAll('.eq-preset-chip').forEach((c) => c.classList.remove('active'));
    });
    toggle.addEventListener('change', () => {
      setManualEqBandEnabled(band, toggle.checked);
      el.querySelectorAll('.eq-preset-chip').forEach((c) => c.classList.remove('active'));
    });
  });

  // ---------- Reset ----------
  el.querySelector('#eq-reset').addEventListener('click', () => {
    useEqPreset('normal');
    resetManualEq();
    el.querySelectorAll('.eq-preset-chip').forEach((c) => c.classList.toggle('active', c.dataset.eqKey === 'normal'));
    Object.keys(BAND_LABELS).forEach((band) => {
      el.querySelector(`#eq-slider-${band}`).value = 0;
      el.querySelector(`#eq-value-${band}`).textContent = formatDb(0);
      el.querySelector(`#eq-toggle-${band}`).checked = true;
    });
  });

  return el;
}

function formatDb(value) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}
