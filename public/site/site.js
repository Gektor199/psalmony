// Local, silent illustrations only. No microphone, account, or analytics access.
const tabs = [...document.querySelectorAll('[data-demo-tab]')];
function selectTab(tab, moveFocus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  }
  if (moveFocus) tab.focus();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(tab);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      selectTab(tabs[next], true);
    }
  });
}

const faders = [...document.querySelectorAll('.demo-fader')];
const defaultValues = new Map(faders.map((fader) => [fader.id, fader.value]));

function renderFader(fader) {
  const strip = fader.closest('[data-channel]');
  const value = Number(fader.value);
  const minimum = Number(fader.min);
  const maximum = Number(fader.max);
  const label = value === minimum ? 'Выключено' : `${value} дБ`;
  const display = value === minimum ? '−∞' : value.toFixed(1).replace('-', '−');
  const muted = strip.querySelector('.channel-mute').getAttribute('aria-pressed') === 'true';
  fader.setAttribute('aria-valuetext', label);
  strip.querySelector('output').value = display;
  // Deliberately synthetic levels; the page never initializes an audio engine.
  const level = muted || value === minimum ? 0 : 16 + ((value - minimum) / (maximum - minimum)) * 64;
  strip.querySelector('.meter-track i').style.setProperty('--level', `${level}%`);
}

for (const fader of faders) {
  fader.addEventListener('input', () => renderFader(fader));
  renderFader(fader);
}

for (const button of document.querySelectorAll('.channel-mute')) {
  button.addEventListener('click', () => {
    const muted = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(muted));
    renderFader(button.closest('[data-channel]').querySelector('.demo-fader'));
  });
}

document.getElementById('reset-demo').addEventListener('click', () => {
  for (const fader of faders) {
    fader.value = defaultValues.get(fader.id);
    fader.closest('[data-channel]').querySelector('.channel-mute').setAttribute('aria-pressed', 'false');
    renderFader(fader);
  }
});
