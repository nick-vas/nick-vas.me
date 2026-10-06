import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The draft test posts (content/posts/test-*.md) are included: the CI build uses --buildDrafts, so
// the tests also cover long titles, wide code and tables, and previous/next post links, which
// only appear once there is more than one post.
const PAGES = [
  '/', '/posts/', '/posts/hello-world/', '/archives/', '/search/', '/about/',
  '/posts/test-long-form/', '/posts/test-code-heavy/', '/posts/test-very-long-title/', '/posts/test-lists-and-media/',
];

// Ready = loaded and the scene (if WebGL works here) has started. Not 'networkidle', which
// Playwright discourages and which timed out in Firefox when several browsers ran at once.
async function settle(page) {
  await page.waitForLoadState('load');
  await page.waitForFunction(() => {
    const c = document.getElementById('bg-scene');
    return !c || c.classList.contains('is-ready');
  });
}

async function open(page, path, theme) {
  if (theme) await page.addInitScript((t) => localStorage.setItem('pref-theme', t), theme);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(path);
  await settle(page);
  return errors;
}

for (const path of PAGES) {
  test.describe(path, () => {
    test('loads without JS errors or sideways scroll', async ({ page }) => {
      const errors = await open(page, path);
      expect(errors, 'uncaught JS errors').toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);
    });

    test('background scene starts, or falls back cleanly without WebGL', async ({ page }) => {
      await open(page, path);
      const hasCanvas = (await page.locator('#bg-scene').count()) > 0;
      if (!hasCanvas) return; // no WebGL here: the site is plain PaperMod, which is the design
      await expect(page.locator('#bg-scene')).toHaveClass(/is-ready/);
      await expect(page.locator('#scene-controls')).toBeVisible();
      expect(await page.locator('.scene-fx-row').count(), 'slider rows').toBeGreaterThanOrEqual(10);
    });

    test('no WCAG 2.2 AA violations (dark and light)', async ({ browser }, info) => {
      test.skip(info.project.name !== 'chromium', 'axe runs once, in desktop Chromium');
      for (const theme of ['dark', 'light']) {
        // A fresh context per theme, so one theme's saved preference can't leak into the other.
        // Reduced motion switches off the scroll-driven fade-ins, which would otherwise change an
        // element's opacity (and so its measured contrast) part-way through the scan.
        const context = await browser.newContext({ reducedMotion: 'reduce' });
        const page = await context.newPage();
        await open(page, path, theme);
        const { violations } = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .exclude('#bg-scene') // decorative canvas, aria-hidden
          .analyze();
        const summary = violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')}`);
        await context.close();
        expect(summary, `axe violations in ${theme} theme`).toEqual([]);
      }
    });
  });
}

test.describe('animation controls', () => {
  test('gear panel opens inside the viewport and Escape closes it', async ({ page }) => {
    await open(page, '/');
    test.skip((await page.locator('#bg-scene').count()) === 0, 'no WebGL in this browser');
    const toggle = page.locator('#scene-fx-toggle');
    const panel = page.locator('#scene-fx-panel');
    await expect(panel).toBeHidden();
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const box = await panel.boundingBox();
    const vw = page.viewportSize().width;
    expect(box.x, 'panel left edge').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'panel right edge').toBeLessThanOrEqual(vw);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test('controls meet the 44px touch target size', async ({ page }) => {
    await open(page, '/');
    test.skip((await page.locator('#bg-scene').count()) === 0, 'no WebGL in this browser');
    for (const id of ['#scene-pause', '#scene-shatter', '#scene-fx-toggle']) {
      const box = await page.locator(id).boundingBox();
      expect(box.width, id + ' width').toBeGreaterThanOrEqual(44);
      expect(box.height, id + ' height').toBeGreaterThanOrEqual(44);
    }
  });

  test('pause is remembered and the shape keeps the same opacity on every page', async ({ page }) => {
    await open(page, '/');
    test.skip((await page.locator('#bg-scene').count()) === 0, 'no WebGL in this browser');
    const opacity = () => page.evaluate(() => getComputedStyle(document.getElementById('bg-scene')).opacity);
    await expect.poll(opacity, { message: 'home opacity (after the first-visit fade-in)' }).toBe('1');
    await page.locator('#scene-pause').click();
    await expect(page.locator('#scene-pause')).toHaveAttribute('aria-pressed', 'true');
    await page.goto('/posts/');
    await settle(page);
    await expect(page.locator('#scene-pause')).toHaveAttribute('aria-pressed', 'true');
    // No fade and no dimming on later pages: full opacity straight away.
    expect(await opacity()).toBe('1');
  });

  test('stress: rapid clicks and slider changes cause no errors', async ({ page }) => {
    const errors = await open(page, '/');
    test.skip((await page.locator('#bg-scene').count()) === 0, 'no WebGL in this browser');
    await page.evaluate(async () => {
      for (let i = 0; i < 40; i++) {
        window.dispatchEvent(new MouseEvent('click', { clientX: 40 + i * 6, clientY: 80 + i * 8, button: 0, bubbles: true }));
        // Burst plus the two speed sliders that re-phase the animation (idle rotation, colour drift).
        for (const [id, value] of [['fx-burst', 0.5 + (i % 11) * 0.5], ['fx-idle', (i % 5) * 0.4], ['fx-hueDrift', (i % 6) * 0.02]]) {
          const r = document.getElementById(id);
          r.value = value;
          r.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await new Promise((res) => setTimeout(res, 20));
      }
    });
    expect(await page.locator('#bg-scene').count()).toBe(1);
    expect(errors).toEqual([]);
  });
});
