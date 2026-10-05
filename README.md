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

## Updating the theme

```sh
git submodule update --remote --merge themes/PaperMod
```
