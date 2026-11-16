// 界面文案。目前只有英文；以后加语言时在 STRINGS 里加一份同样键的字典，再提供切换入口即可。
const STRINGS = {
  en: {
    'title': 'MOVE Beyond Bus Configurator',
    'library': 'Boards',
    'interfacesOf': '{name} interfaces',
    'meta.slots.1': '1 slot',
    'meta.slots.n': '{n} slots',
    'meta.noPower': 'power n/a',
    'meta.interfaces': '{n} interfaces',
    'hint.loading': 'Loading models…',
    'hint.idle': 'Pick a board, then pick a slot. Drag to rotate.',
    'hint.place': 'Pick an empty slot for {name}.',
    'hint.place2': 'Pick an empty slot for {name}. It needs two adjacent slots.',
    'hint.noRoom': 'No room for {name}.',
    'hint.noRoom2': 'No room for {name}. It needs two adjacent slots.',
    'hint.selected': '{name} selected. Pick another empty slot to move it.',
    'hint.swap': 'Pick the board to swap with {name}.',
    'hint.swapNoRoom': 'Not enough room to swap {name} with {other}. Pick another board.',
    'hint.inspect': 'Inspecting {name}. Hover or click a number for details.',
    'banner.slot': 'Slot {n}',
    'btn.cancel': 'Cancel',
    'btn.remove': 'Remove',
    'btn.clear': 'Clear all',
    'btn.interfaces': 'Interfaces',
    'btn.flip': 'Flip',
    'btn.back': 'Back',
    'btn.swap': 'Swap',
    'btn.expansion': '{site}: {name}',
    'expansion.none': 'none',
    'expansion.unavailable': 'none available',
    'btn.bracket': 'Bracket: {mode}',
    'bracket.back': 'back side',
    'bracket.front': 'front side',
    'bracket.none': 'none',
    'face.front': 'front',
    'face.back': 'back',
    'face.both': 'both sides',
    'stats.slots': 'Slots used',
    'stats.typ': 'Typical power',
    'stats.peak': 'Peak power',
    'stats.capacity': 'Battery capacity',
    'stats.runtime': 'Runtime',
    'stats.missing': '{n} without power data, not counted',
    'aria.canvas': 'Isometric view of the slot card bus',
    'aria.slot': 'Slot {n}: {what}',
    'aria.empty': 'empty',
    'aria.rotL': 'Rotate left 90°',
    'aria.rotR': 'Rotate right 90°',
    'aria.reset': 'Reset view',
    'level.iter1': ' (Iter 1)',
    'level.proto': ' (Proto)'
  }
};
let lang = 'en';
export const languages = Object.keys(STRINGS);
export function setLanguage(code) { if (STRINGS[code]) lang = code; }
export function t(key, vars) {
  let s = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
// 填充 HTML 里带 data-i18n / data-i18n-aria 的静态元素
export function applyStatic(root) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.title = t('title');
}
