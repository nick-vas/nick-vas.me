# nick-vas.me

Personal site built with [Hugo](https://gohugo.io/) (extended, v0.146+) and the
[PaperMod](https://github.com/adityatelange/hugo-PaperMod) theme.

## Setup

```sh
git clone --recurse-submodules https://github.com/nick-vas/nick-vas.me.git
# or, in an existing clone:
git submodule update --init --recursive
```

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

```sh
DEPLOY_TARGET=user@your-droplet ./deploy/deploy.sh
```

[`deploy/deploy.sh`](deploy/deploy.sh) builds the site, makes pre-compressed `.gz` copies of
text files, and uploads to `/var/www/nick-vas.me` (override with `DEPLOY_PATH`) with
permissions Nginx can read. Use it rather than a plain `rsync`: the Nginx config serves those
`.gz` copies directly instead of compressing on every request.

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
its complement. The cursor makes the shape lean and glow in the complementary colour. It is full strength on the home page and dimmed
elsewhere, and the current shape carries over as you move between pages.

- The canvas has `pointer-events: none`, so it never blocks links, buttons or text
  selection. Clicks on links, buttons, code, post cards, the header and the footer are
  ignored, as are clicks that end a text selection.
- It plays by default even with "reduce motion" set (a deliberate choice; the pause button is the control), pauses when the tab is hidden,
  and is skipped entirely if WebGL is unavailable.
- A shatter carries over between pages: the shard state is saved to `sessionStorage`
  when you leave a page and restored (fast-forwarded by the time the navigation took)
  on the next one. Pages crossfade in browsers that support view transitions (the rule
  is inline in `layouts/_partials/extend_head.html`, because Hugo's CSS minifier drops
  it), and the canvas fades in on its first frame.
- Only the current shape is prepared before the first frame (about 2 ms); the next one
  is prepared when the browser is idle.
- Three.js r186 is vendored in `assets/js/vendor/` (MIT, see `three.LICENSE`) and
  bundled by Hugo, so the site makes no third-party requests.
- Tune it via the `CFG` block at the top of `bg-scene.js` (burst strength, hold and
  regather time, shard count, `hueSpan` and `hueDrift` for the rainbow), the `SHAPES`
  list and the `TONES` saturation/lightness per theme. To reform
  the same shape instead of the next one, change `to = (to + 1) % SHAPES.length` to
  `to = from` in `shatter()`. Page dimming is in `assets/css/extended/bg-scene.css`.

## Accessibility

The site targets **WCAG 2.2 Level AA**. Most of it comes from PaperMod; the additions below
cover what the theme doesn't, mainly around the animated background.

| WCAG | What | Where |
| --- | --- | --- |
| 2.2.2 Pause, Stop, Hide | Pause button for the background animation, remembered across pages; the paused pose is identical on every page. The animation plays by default, including when the OS "reduce motion" setting is on. Nothing animates in Windows High Contrast. | `layouts/_partials/scene_controls.html`, `assets/js/bg-scene.js` |
| 2.1.1 Keyboard | The shatter is also a button, so it isn't mouse-only. | same |
| 2.3.1 Three Flashes | Shard spin is capped at one turn per second, so a shard swaps its rainbow face for the complementary one at most twice a second, however fast someone clicks. | `bg-scene.js` (`MAX_SPIN`) |
| 1.4.3 Contrast | Shards passing behind text never reduce its contrast. Short text (header, home intro, titles, footer) gets a halo in the page's own background colour; long-form text (post bodies, archive lists) sits on blocks of the page colour instead, which costs nothing to paint (a halo on every glyph of a long post measured ~20x the scroll raster work). Theme containers that clip overflow are widened so the halo isn't cut off. Dark-mode post tags raised from 4.24:1 to 6.8:1. | `assets/css/extended/a11y.css` |
| 2.4.1 Bypass Blocks | "Skip to content" link, first in the tab order; moves focus into `<main>`. | `layouts/baseof.html` |
| 2.4.4 / 4.1.2 | Social icon links named "GitHub (opens in new tab)", "RSS feed (opens in new tab)". | `layouts/_partials/social_icons.html` |
| 2.4.7 / 2.4.11 / 2.5.8 | 44×44 px controls with a 3 px focus ring; `scroll-padding-bottom: 120px` keeps keyboard focus clear of the fixed buttons, including PaperMod's go-to-top button. | `a11y.css` |
| Forced colours | In Windows High Contrast the decorative scene is removed. | `a11y.css` |

`layouts/baseof.html` and `layouts/_partials/social_icons.html` override PaperMod's files;
when updating the theme, compare them with `themes/PaperMod/layouts/` (changes are marked).

## Updating the theme

```sh
git submodule update --remote --merge themes/PaperMod
```
