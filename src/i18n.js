// 界面文案。目前只有英文；以后加语言时在 STRINGS 里加一份同样键的字典，再提供切换入口即可。
const STRINGS = {
  en: {
    'title': 'MOVE Beyond Bus Configurator',
    'library': 'Boards',
    'layouts': 'Layout',
    'aria.filters': 'Filter boards',
    'filter.empty': 'No boards match these filters.',
    'filter.clear': 'Clear',
    'aria.layouts': 'Layout',
    'interfacesOf': '{name} interfaces',
    'meta.slots.1': '1 slot',
    'meta.slots.n': '{n} slots',
    'meta.noPower': 'power n/a',
    'meta.interfaces': '{n} interfaces',
    'hint.loading': 'Loading models…',
    'hint.idle': 'Pick a board, then pick a slot. Drag to rotate, right-drag to pan.',
    'hint.place': 'Pick an empty slot for {name}.',
    'hint.place2': 'Pick an empty slot for {name}. It needs two adjacent slots.',
    'hint.noRoom': 'No room for {name}.',
    'hint.noRoom2': 'No room for {name}. It needs two adjacent slots.',
    'hint.selected': '{name} selected. Pick an empty slot to move it.',
    'hint.selectedFull': '{name} selected. No free slot: use Swap.',
    'hint.selectedOnly': '{name} selected.',
    'hint.loadingBoard': 'Loading model…',
    'hint.loadFailed': 'Could not load {name}. Retry?',
    'hint.failed': 'Could not load: {names}.',
    'btn.retry': 'Retry',
    'hint.swap': 'Pick the board to swap with {name}.',
    'hint.swapNoRoom': 'Not enough room to swap {name} with {other}. Pick another board.',
    'hint.inspect': 'Inspecting {name}. Drag to look around, click a number for details.',
    'banner.slot': 'Slot {n}',
    'hover.interfaces': 'Interfaces',
    'hover.capacity': 'Capacity',
    'hover.power': 'Power',
    'btn.cancel': 'Cancel',
    'btn.remove': 'Remove',
    'btn.clear': 'Clear all',
    'btn.interfaces': 'Interfaces',
    'btn.flip': 'Flip',
    'btn.back': 'Back',
    'btn.swap': 'Swap',
    'btn.backplane': 'Backplane interfaces',
    'backplane': 'Backplane',
    'btn.expansion': '{site}: {name}',
    'expansion.none': 'None',
    'expansion.unavailable': 'none available',
    'bracket': 'Bracket',
    'bracket.back': 'Back',
    'bracket.front': 'Front',
    'bracket.none': 'None',
    'face.front': 'front',
    'face.back': 'back',
    'face.top': 'top',
    'face.bottom': 'bottom',
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
    'aria.undo': 'Undo (Ctrl+Z)',
    'aria.redo': 'Redo (Ctrl+Shift+Z)',
    'aria.share': 'Copy a link to this configuration',
    'share.copied': 'Link copied',
    'share.failed': 'Could not copy. Copy the address bar instead.',
    'aria.slotLoading': 'Slot {n}: loading {what}',
    'aria.toLight': 'Switch to light theme',
    'aria.toDark': 'Switch to dark theme',
    'level.rev1': ' (Rev 1)',
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
  root.querySelectorAll('[data-i18n-aria]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
    if (el.tagName === 'BUTTON') el.title = t(el.dataset.i18nAria);   // 只有图标的按钮，鼠标停上去也能看到说明
  });
  document.title = t('title');
}
