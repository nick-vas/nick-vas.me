// Accessibility fixes for post content that markdown can't express (WCAG 2.2 AA):
//  - 2.1.1 Keyboard: a code block or table that scrolls sideways can only be scrolled from the
//    keyboard if it can take focus, so scrollable ones get tabindex="0" (re-checked on resize,
//    because whether something overflows depends on the window width).
//  - 1.3.1 / 4.1.2: Hugo renders markdown task lists as bare disabled checkboxes with no label,
//    so each is named from the text of its list item.
const SCROLLERS = '.post-content pre code, .post-content table';

function markScrollable() {
  for (const el of document.querySelectorAll(SCROLLERS)) {
    if (el.scrollWidth > el.clientWidth + 1) {
      el.tabIndex = 0;
      el.setAttribute('role', el.tagName === 'TABLE' ? 'region' : 'group');
      if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.tagName === 'TABLE' ? 'Table, scrollable' : 'Code, scrollable');
    } else if (el.getAttribute('tabindex') === '0') {
      el.removeAttribute('tabindex');
      el.removeAttribute('role');
      el.removeAttribute('aria-label');
    }
  }
}

function labelCheckboxes() {
  for (const box of document.querySelectorAll('.post-content li > input[type="checkbox"]')) {
    if (box.hasAttribute('aria-label') || box.labels?.length) continue;
    const text = box.parentElement.textContent.trim();
    if (text) box.setAttribute('aria-label', text);
  }
}

labelCheckboxes();
markScrollable();
// Layout can still shift after this script runs (late styles, fonts, images), so look again.
window.addEventListener('load', markScrollable);
document.fonts?.ready.then(markScrollable);
let timer = 0;
window.addEventListener('resize', () => {
  clearTimeout(timer);
  timer = setTimeout(markScrollable, 150);
}, { passive: true });
