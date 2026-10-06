# Continuous deployment

Every push to `main` that passes CI is built and published to the droplet by
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). **All server details and
credentials live in GitHub Actions secrets** (an environment called `production`); nothing about
the server is in the repo.

```
push to main -> CI passes -> Deploy workflow -> build -> upload as a new release
             -> switch the `current` symlink (atomic) -> verify the live site
             -> (verification fails) roll back automatically
```

On the droplet, `/var/www/nick-vas.me` holds one directory per deploy and a symlink to the live one:

```
/var/www/nick-vas.me/
  releases/20261006120000-ab12cd3/   <- one full copy of the site per deploy (newest 5 kept)
  releases/20261006093000-9f8e7d6/
  current -> releases/20261006120000-ab12cd3   <- Nginx serves this (root .../current)
```

Visitors never see a half-uploaded site, a bad deploy is undone by repointing the symlink, and
unchanged files are hard-linked between releases so a deploy only stores what changed.

## One-time setup

Do the host hardening in [`HARDENING.md`](HARDENING.md) first. The droplet needs `rsync`
(installed by default on Ubuntu).

### 0. A separate, unprivileged user for CI

The pipeline logs in over SSH, and an SSH key can run any command as its user. So give CI its own
user with **no sudo**, instead of reusing your admin `deploy` account: then a leaked key can only
touch the web root.

```sh
sudo adduser --disabled-password --gecos '' cideploy
```

### 1. Switch the web root to the release layout

Doing it this order keeps the site up the whole time. Run on the droplet as your admin user:

```sh
cd /var/www/nick-vas.me
sudo mkdir -p releases/00000000000000-initial
sudo cp -a $(ls -A | grep -vx releases) releases/00000000000000-initial/   # copy what is live now
sudo ln -sfn releases/00000000000000-initial current
sudo chown -R cideploy:www-data /var/www/nick-vas.me   # CI writes, Nginx (www-data) only reads
```

Update the Nginx server block (the repo's copy already has this line) and reload:

```sh
sudo sed -i 's#root /var/www/nick-vas.me;#root /var/www/nick-vas.me/current;#' /etc/nginx/sites-available/nick-vas.me
sudo nginx -t && sudo systemctl reload nginx
```

Once the site loads, delete the old flat files (everything in `/var/www/nick-vas.me` except
`releases` and `current`). The `00000000000000-initial` name sorts oldest, so it is the first release
pruned and never counts as the newest.

### 2. A deploy-only SSH key

On your own machine:

```sh
ssh-keygen -t ed25519 -N '' -C github-actions-deploy -f deploy_key
```

On the droplet, add the **public** key to `/home/cideploy/.ssh/authorized_keys` (create the
directory with mode 700 and the file with mode 600, owned by `cideploy`) with restrictions, so
the key cannot forward ports or open an interactive shell:

```
no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... github-actions-deploy
```

Put the **private** key (`deploy_key`) in the `DEPLOY_SSH_KEY` secret, then delete both local files.

### 3. Pin the server's host key

The workflow never trusts a host key on first use. Get it from a machine you trust and compare its
fingerprint with the one on the droplet before saving it:

```sh
ssh-keyscan -t ed25519 <droplet-ip-or-host>          # the line to save as DEPLOY_KNOWN_HOSTS
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub     # run on the droplet; fingerprints must match
```

### 4. GitHub secrets

Repo > **Settings > Environments > New environment** called `production`, then add these
**environment secrets**:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | Droplet address (IP or hostname) |
| `DEPLOY_USER` | `cideploy` |
| `DEPLOY_SSH_KEY` | The private key from step 2 (the whole file, including the `BEGIN`/`END` lines) |
| `DEPLOY_KNOWN_HOSTS` | The `ssh-keyscan` line from step 3 |
| `DEPLOY_PATH` | Optional. Web root on the droplet; defaults to `/var/www/nick-vas.me` |
| `SITE_URL` | `https://nick-vas.me`, used to check the site after each deploy |

On the same environment page, restrict **Deployment branches** to `main` and optionally add
**Required reviewers** for a manual approval before each deploy. The workflow also refuses manual
runs started from any branch other than `main`, because a manual run skips the CI gate. It stops
with a clear error if a required secret is missing.

## Day to day

- **Deploy:** merge to `main`. CI runs, and when it passes the Deploy workflow publishes it. Watch
  it under the **Actions** tab; the run summary lists the release name.
- **Roll back:** Actions > **Deploy** > **Run workflow** > action `rollback`. It repoints `current`
  at the previous release in a second, with no rebuild. From a terminal:
  `DEPLOY_TARGET=cideploy@<host> ./deploy/rollback.sh`.
- **Manual deploy** (no GitHub): `DEPLOY_TARGET=cideploy@<host> ./deploy/deploy.sh`. It needs Hugo
  extended, `rsync` and your SSH key.
- **Automatic rollback:** after switching, the workflow checks that the site answers, sends a
  `Content-Security-Policy` header, and that every stylesheet and script the home page references
  loads. If any check fails, it rolls back to the previous release and the run is marked failed.

## What the pipeline does not do

Nginx and TLS config are not deployed by the pipeline: they change rarely, need `sudo`, and a bad
one can take the site down, so keep applying them by hand as described in the
[README](../README.md#deploying-to-the-droplet). The CI user has no sudo, so the pipeline cannot
change them either.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `secret DEPLOY_... is not set` | Secrets must be on the `production` **environment**, not just the repo. |
| `Host key verification failed` | `DEPLOY_KNOWN_HOSTS` is missing or is for a different key type or host. |
| `Permission denied (publickey)` | Public key not in `cideploy`'s `authorized_keys` (check the directory and file modes), or the private key was pasted without its `BEGIN`/`END` lines. |
| `rsync: mkdir ... Permission denied` | The web root is not owned by `cideploy`; repeat the `chown` from step 1. |
| Deploy succeeds, site unchanged | Nginx `root` still points at `/var/www/nick-vas.me` instead of `.../current`. |
| `current exists but is not a symlink` | The web root is still the old flat layout; do step 1. |
| Verification: no `Content-Security-Policy` | The security snippet is not included in the live `location` blocks; see the README. |
