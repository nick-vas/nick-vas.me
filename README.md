# nick-vas.me

Personal site built with [Hugo](https://gohugo.io/) (extended, v0.146+) and the
[PaperMod](https://github.com/adityatelange/hugo-PaperMod) theme.

## Setup

```sh
git clone --recurse-submodules https://github.com/nick-vas/nick-vas.me.git
# or, in an existing clone:
git submodule update --init --recursive
```

## Running it locally

| I want to... | Run (from the repo root) |
| --- | --- |
| Edit with live reload and drafts | `hugo server -D`, then http://localhost:1313 |
| See exactly what visitors get: the production build behind the real Nginx config (security headers, gzip, caching, rate limits) | `bash deploy/local.sh`, then http://localhost:8080 (includes the draft test posts; add `--no-drafts` to see only what is published; stop with `bash deploy/local.sh down`). Needs Docker. |
| Run the browser tests against that Nginx | `cd tests && BASE_URL=http://localhost:8080 npx playwright test` |
| Run the browser tests against a plain static copy of the build | `hugo --minify --buildDrafts --baseURL http://localhost:4173/ && cd tests && npx playwright test` |
| Run the deploy-script tests | `bash tests/deploy/remote-switch.test.sh` and `bash tests/deploy/deploy.test.sh` (Linux or WSL) |
| Health-check any running copy of the site | `bash deploy/verify.sh http://localhost:8080` |

Run `hugo` from the repo root: it does not look in parent folders, so running it from `tests/`
(or anywhere else) finds no theme and prints "found no layout file" warnings, and
`hugo server` then answers 404 on every page.

## Writing

```sh
hugo new content posts/my-post.md   # creates a draft
hugo server -D                      # preview at http://localhost:1313, drafts included
```

Set `draft: false` (or delete the line) to publish a post.

| Path | What it is |
| --- | --- |
| `hugo.toml` | Site config: title, home intro, menu, social links |
| `content/about.md` | About page |
| `content/posts/` | Blog posts (these make up the RSS feed at `/index.xml`) |
| `content/archives.md`, `content/search.md` | Archive and search pages |

## Deploying to the droplet

Pushes to `main` that pass CI deploy automatically through GitHub Actions
(`.github/workflows/deploy.yml`), using secrets from a `production` environment; setup,
rollback and troubleshooting are in [`deploy/CD.md`](deploy/CD.md). By hand:

```sh
DEPLOY_TARGET=user@your-droplet ./deploy/deploy.sh      # build, upload as a new release, go live
DEPLOY_TARGET=user@your-droplet ./deploy/rollback.sh    # back to the previous release
```

[`deploy/deploy.sh`](deploy/deploy.sh) builds the site, makes pre-compressed `.gz` copies of
text files, and uploads them as a new release under `/var/www/nick-vas.me/releases/` (override
the base with `DEPLOY_PATH`) with permissions Nginx can read. It then repoints the `current`
symlink, which Nginx serves, in one atomic step, so visitors never see a half-uploaded site, and
keeps the last 5 releases for rollback. Use it rather than a plain `rsync`: the Nginx config
serves the `.gz` copies directly instead of compressing on every request.

The Nginx server block is in [`deploy/nginx/nick-vas.me.conf`](deploy/nginx/nick-vas.me.conf).
It gzips text files and sets caching: files Hugo fingerprints (the script and stylesheet,
which have a content hash in their names) are cached by browsers for a year, while pages,
the RSS feed and the search index are re-checked on every visit so new posts appear at once.

```sh
sudo cp deploy/nginx/security-headers.conf /etc/nginx/snippets/nick-vas-security.conf
sudo cp deploy/nginx/rate-limit.conf      /etc/nginx/conf.d/nick-vas-rate-limit.conf
sudo cp deploy/nginx/nick-vas.me.conf     /etc/nginx/sites-available/nick-vas.me
sudo ln -s /etc/nginx/sites-available/nick-vas.me /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Copy all three files before `nginx -t`: the server block `include`s the security snippet
and uses the rate-limit zones, so a missing one fails the config test.

The server block sends security headers (CSP, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`, HSTS) from
[`deploy/nginx/security-headers.conf`](deploy/nginx/security-headers.conf). That snippet is
`include`-d inside **each** `location`, not at the server level: nginx only inherits
`add_header` into a location that sets none of its own, and both locations set
`Cache-Control`, so headers placed at the server level would be silently dropped on every
response. Copy the snippet to `/etc/nginx/snippets/nick-vas-security.conf` (first line above)
before `nginx -t`, or the include fails. Verify the headers reach the wire with
`curl -sI https://nick-vas.me/ | grep -i -E 'content-security|x-frame|x-content'`.

Add HTTPS with `sudo certbot --nginx -d nick-vas.me -d www.nick-vas.me`. Then harden TLS:
copy the modern-TLS snippet, include it in the `:443` block certbot created, and drop
`TLSv1`/`TLSv1.1` from the `ssl_protocols` line in `/etc/nginx/nginx.conf`:

```sh
sudo cp deploy/nginx/tls.conf /etc/nginx/snippets/nick-vas-tls.conf
# add  include snippets/nick-vas-tls.conf;  inside the listen 443 server block, then:
sudo nginx -t && sudo systemctl reload nginx
```

Ubuntu's `/etc/nginx/nginx.conf` allows 768 connections per worker, and a 1-vCPU droplet
has one worker; past that, visitors silently queue and time out. Raise it to
`worker_connections 4096;` in the `events` block, then `sudo systemctl reload nginx`.

### Hardening summary

The server block and its snippets defend against the attacks that actually apply to a
static site:

| Attack | Defence | Where |
| --- | --- | --- |
| Clickjacking, MIME-sniffing, off-origin injection, referrer leak | CSP + `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` | `security-headers.conf` |
| Protocol downgrade | HSTS | `security-headers.conf` |
| Obsolete TLS 1.0/1.1, weak ciphers | TLS 1.2/1.3 only, modern ciphers, OCSP stapling | `tls.conf` |
| Request floods / brute force | `limit_req` 30 r/s/IP (burst 60), `limit_conn` 30/IP → 429 | `rate-limit.conf` + server block |
| Slowloris (slow requests) | `client_header_timeout`/`client_body_timeout`/`send_timeout` 10s | server block |
| Oversized request bodies | `client_max_body_size 1k` → 413 | server block |
| Source/metadata disclosure (`.git`, `.env`) | dotfile deny (exempts `.well-known`) | server block |
| Version disclosure | `server_tokens off` | server block |

Host, DNS and account hardening (SSH keys, `ufw`, `fail2ban`, unattended-upgrades, CAA,
DNSSEC, SPF/DMARC, 2FA) are done on the droplet and at the registrar, not in this repo — see
the step-by-step runbook in [`deploy/HARDENING.md`](deploy/HARDENING.md).

## Background scene

Every page has a Three.js background (`assets/js/bg-scene.js`): one primitive at a time
hovers and slowly turns. Clicking empty space shatters it into its own triangle shards,
which drift apart and slowly regather as the next primitive (icosahedron, cube, torus
knot, octahedron, torus, dodecahedron, tetrahedron, cone, then round again). The shape
is coloured with a rainbow gradient that slowly turns through the spectrum; each shard's
inner face shows the complementary hue, so tumbling shards flash between a colour and
its complement. The shape leans toward the cursor (it never glows or swells on hover), is the
same opacity on every page, and carries over as you move between pages.

- The canvas has `pointer-events: none`, so it never blocks links, buttons or text
  selection. Clicks on links, buttons, code, post cards, the header and the footer are
  ignored, as are clicks that end a text selection.
- It plays by default even with "reduce motion" set (a deliberate choice; the pause button is the control), pauses when the tab is hidden,
  and is skipped entirely if WebGL is unavailable.
- A shatter carries over between pages: the shard state is saved to `sessionStorage`
  when you leave a page and restored (fast-forwarded by the time the navigation took)
  on the next one. Pages crossfade in browsers that support view transitions (the rule
  is inline in `layouts/_partials/extend_head.html`, because Hugo's CSS minifier drops
  it), and the canvas fades in on the first page of a visit only.
- Only the current shape is prepared before the first frame (about 2 ms); the next one
  is prepared when the browser is idle.
- Three.js r186 is vendored in `assets/js/vendor/` (MIT, see `three.LICENSE`) and
  bundled by Hugo, so the site makes no third-party requests.
- Shards may travel a little past the screen edge and are eased back (`edgeMargin`,
  `wallStiffness`).
- The gear button opens sliders for the main effect settings (shatter speed, regather time,
  hover tilt and follow speed, size, opacity, brightness, colours, ...). They apply live, are
  remembered in `localStorage`, and have a reset button. The list is `FX` in
  `assets/js/bg-scene/fx-panel.js`; defaults are in `assets/js/bg-scene/config.js`.
- The code is split into modules under `assets/js/bg-scene/`: `config` (settings),
  `shards` (the shapes and their cutting), `storage` (everything remembered between
  pages), `fx-panel` (the sliders) and `math`. `assets/js/bg-scene.js` holds the scene and
  simulation. To reform the same shape instead of the next one, change
  `to = (to + 1) % SHAPE_COUNT` to `to = from` in `shatter()`.

## Testing and CI

`.github/workflows/ci.yml` runs on every pull request and push to `main`:

| Job | What it checks |
|---|---|
| Build | `hugo --minify` with the same flags as `deploy/deploy.sh`, so minifier surprises show up before production. |
| Links and assets | `lychee` (offline) confirms every internal link, image, script, stylesheet and icon resolves to a file in the build. |
| Browsers | Playwright on Chromium, Firefox, WebKit, Pixel 7 and iPhone 14 profiles: no JS errors, no sideways scroll, the scene starts (or falls back cleanly without WebGL), the gear panel fits and closes with Escape, 44px targets, and a click/slider stress burst. Chromium also runs axe (WCAG 2.2 AA) in dark and light. |
| Lighthouse | Accessibility must stay at 95+; performance, best-practices, SEO and bundle size are warnings. |

Run the browser tests locally (see also [Running it locally](#running-it-locally)):

```sh
hugo --minify --buildDrafts --baseURL http://localhost:4173/    # build into public/ (with the draft test posts the tests use)
cd tests && npm ci && npx playwright install      # first time only
npx playwright test                               # add --project=webkit to run one browser
```

Draft posts (`content/posts/test-*.md`) exist for manual testing and are only built with
`hugo server -D`. In `hugo server`, an "A11y test" button (bottom-right) simulates reduced
motion, 200% zoom, greyscale and outlines; it is never in a production build.

## Accessibility

The site targets **WCAG 2.2 Level AA**. Most of it comes from PaperMod; the additions below
cover what the theme doesn't, mainly around the animated background.

| WCAG | What | Where |
| --- | --- | --- |
| 2.2.2 Pause, Stop, Hide | Pause button for the background animation, remembered across pages; the paused pose is identical on every page. The animation plays by default, including when the OS "reduce motion" setting is on. Nothing animates in Windows High Contrast. | `layouts/_partials/scene_controls.html`, `assets/js/bg-scene.js` |
| 2.1.1 Keyboard | The shatter is also a button, so it isn't mouse-only. Code blocks and tables that scroll sideways take keyboard focus (and task-list checkboxes get names) via `assets/js/a11y-content.js`. | same |
| 2.3.1 Three Flashes | Shard spin is capped at one turn per second, so a shard swaps its rainbow face for the complementary one at most twice a second, however fast someone clicks. | `bg-scene.js` (`MAX_SPIN`) |
| 1.4.3 Contrast | Shards passing behind text never reduce its contrast. Short text (header, home intro, titles, footer) gets a halo in the page's own background colour; long-form text (post bodies) sits on blocks of the page colour instead, which costs nothing to paint (a halo on every glyph of a long post measured ~20x the scroll raster work). Theme containers that clip overflow are widened so the halo isn't cut off. Dark-mode post tags raised from 4.24:1 to 6.8:1, dark-mode previous/next post links from 4.24:1 to 7+:1, and code-comment colour from 2.9:1 to 5+:1. The posts page and archive entries are transparent with a 1px outline, so their text keeps the halo. | `assets/css/extended/site.css` |
| 2.4.1 Bypass Blocks | "Skip to content" link, first in the tab order; moves focus into `<main>`. | `layouts/baseof.html` |
| 2.4.4 / 4.1.2 | Social icon links named "GitHub (opens in new tab)", "RSS feed (opens in new tab)". | `layouts/_partials/social_icons.html` |
| 2.4.7 / 2.4.11 / 2.5.8 | 44×44 px controls with a 3 px focus ring; `scroll-padding-bottom: 120px` keeps keyboard focus clear of the fixed buttons, including PaperMod's go-to-top button. | `site.css` |
| Forced colours | In Windows High Contrast the decorative scene is removed. | `site.css` |

`layouts/baseof.html` and `layouts/_partials/social_icons.html` override PaperMod's files;
when updating the theme, compare them with `themes/PaperMod/layouts/` (changes are marked).

## Updating the theme

```sh
git submodule update --remote --merge themes/PaperMod
```
