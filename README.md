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
hugo --minify
rsync -avz --delete public/ user@droplet:/var/www/nick-vas.me/
```

Minimal Nginx server block:

```nginx
server {
    listen 80;
    server_name nick-vas.me www.nick-vas.me;
    root /var/www/nick-vas.me;
    index index.html;
    error_page 404 /404.html;
    location / { try_files $uri $uri/ =404; }
}
```

Add HTTPS with `sudo certbot --nginx -d nick-vas.me -d www.nick-vas.me`.

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
- It honours "reduce motion" (shows a still frame), pauses when the tab is hidden,
  and is skipped entirely if WebGL is unavailable.
- Three.js r186 is vendored in `assets/js/vendor/` (MIT, see `three.LICENSE`) and
  bundled by Hugo, so the site makes no third-party requests.
- Tune it via the `CFG` block at the top of `bg-scene.js` (burst strength, hold and
  regather time, shard count, `hueSpan` and `hueDrift` for the rainbow), the `SHAPES`
  list and the `TONES` saturation/lightness per theme. To reform
  the same shape instead of the next one, change `to = (to + 1) % SHAPES.length` to
  `to = from` in `shatter()`. Page dimming is in `assets/css/extended/bg-scene.css`.

## Updating the theme

```sh
git submodule update --remote --merge themes/PaperMod
```
