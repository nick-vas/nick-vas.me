# Host, DNS & account hardening runbook

The Nginx-level defences live in [`deploy/nginx/`](nginx/) and are covered in the
[README](../README.md#deploying-to-the-droplet). This file covers what you do **on the
droplet** and **at your DNS host / registrar** — things that can't be committed to the repo.

Work top to bottom. The SSH section can lock you out if done carelessly: **keep your current
SSH session open and test a new login in a second terminal before closing anything.**

Placeholders: `<droplet-ip>`, `<you@example.com>`, `nick-vas.me`. Assumes Ubuntu 22.04/24.04.

---

## 1. A non-root deploy user

Serving and deploying as `root` is unnecessary risk. Make a normal sudo user and deploy as
that instead.

```sh
# as root on the droplet
adduser deploy                 # set a strong password (used only for sudo)
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # copy your authorized key over
```

Test `ssh deploy@<droplet-ip>` in a **new terminal**, then `sudo whoami` → `root`. Once that
works, point deploys at this user: run the site deploy with `DEPLOY_TARGET=deploy@<droplet-ip>`.

---

## 2. SSH: keys only, no root login

DigitalOcean droplets created with an SSH key usually already disable password auth via
`/etc/ssh/sshd_config.d/50-cloud-init.conf`. Check and lock it down:

```sh
sudo tee /etc/ssh/sshd_config.d/99-hardening.conf >/dev/null <<'CONF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
CONF
sudo sshd -t          # MUST print nothing (syntax OK) before you reload
sudo systemctl reload ssh
```

> **Lockout check:** before closing this session, open a **new** terminal and confirm
> `ssh deploy@<droplet-ip>` still works. A later file in `sshd_config.d/` can override these
> (files load in order); if password login still works, grep for the stray setting:
> `sudo grep -ri passwordauth /etc/ssh/sshd_config*`.

---

## 3. Firewall (ufw): only SSH + web

```sh
sudo ufw allow OpenSSH        # do this FIRST, or enabling ufw drops your SSH session
sudo ufw allow 'Nginx Full'   # opens 80 and 443
sudo ufw --force enable
sudo ufw status verbose
```

Optionally also add a **DigitalOcean Cloud Firewall** (Networking → Firewalls) with the same
three ports — it blocks traffic before it reaches the droplet at all.

---

## 4. Automatic security updates

```sh
sudo apt update && sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # answer "Yes"
# confirm the security origin is enabled:
grep -A3 'Allowed-Origins' /etc/apt/apt.conf.d/50unattended-upgrades
```

To also auto-reboot for kernel updates (at a quiet hour), in
`/etc/apt/apt.conf.d/50unattended-upgrades`:

```
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
```

---

## 5. fail2ban: ban repeat offenders

```sh
sudo apt install -y fail2ban
sudo tee /etc/fail2ban/jail.local >/dev/null <<'CONF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true

# Ban IPs that keep tripping Nginx's rate limiter (the 429s from rate-limit.conf).
[nginx-limit-req]
enabled  = true
filter   = nginx-limit-req
logpath  = /var/log/nginx/error.log
maxretry = 10
findtime = 1m
bantime  = 1h
CONF
sudo systemctl enable --now fail2ban
sudo fail2ban-client status            # lists active jails
sudo fail2ban-client status sshd       # banned IPs for a jail
```

---

## 6. Web-root permissions

Nginx (`www-data`) only needs to **read** the site. Own the files as `deploy`, let the
`www-data` group read, and keep them non-writable by the web server.

```sh
sudo chown -R deploy:www-data /var/www/nick-vas.me
sudo find /var/www/nick-vas.me -type d -exec chmod 755 {} \;
sudo find /var/www/nick-vas.me -type f -exec chmod 644 {} \;
```

`deploy/deploy.sh` already rsyncs with `--chmod=D755,F644`, so this stays correct on every
deploy. If you use the GitHub Actions pipeline, the site is served from
`/var/www/nick-vas.me/current` (a symlink into `releases/`) and the files are owned by a
separate `cideploy` user instead; follow [`CD.md`](CD.md) for the ownership commands.

---

## 7. Certificate auto-renewal (verify + monitor)

certbot installs a systemd timer. Confirm it renews and won't silently expire:

```sh
systemctl list-timers | grep certbot      # a scheduled timer should be listed
sudo certbot renew --dry-run               # must end with "Congratulations" / success
```

Add an external **uptime + cert-expiry monitor** (e.g. UptimeRobot, free) on
`https://nick-vas.me` — a silent renewal failure is the most common way a static site goes
down, and only an outside check catches it.

---

## 8. DNS & domain records

Set these at whoever hosts your DNS (DigitalOcean DNS, or your registrar). Verify each with
`dig`.

### CAA — restrict who can issue certs for the domain
```
nick-vas.me.   CAA   0 issue "letsencrypt.org"
```
```sh
dig CAA nick-vas.me +short        # expect: 0 issue "letsencrypt.org"
```

### Anti-spoofing for a domain that sends/receives no mail
Your mail is on Gmail (`…@gmail.com`), not this domain, so declare that `nick-vas.me` sends no
mail. This stops anyone forging `anything@nick-vas.me`.

```
nick-vas.me.          TXT   "v=spf1 -all"
_dmarc.nick-vas.me.   TXT   "v=DMARC1; p=reject; rua=mailto:<you@example.com>"
nick-vas.me.          MX    0 .
```
```sh
dig TXT nick-vas.me +short
dig TXT _dmarc.nick-vas.me +short
dig MX  nick-vas.me +short         # expect: 0 .
```

> **Only if you never want email at `@nick-vas.me`.** The null MX (`MX 0 .`, RFC 7505) says
> "this domain receives no mail." If you later add a mailbox on the domain, remove the null MX
> and widen the SPF record first.

### DNSSEC — sign the zone against tampering
Enable DNSSEC wherever your zone is hosted.
- **Cloudflare DNS / most registrars:** a one-click toggle, then paste the generated DS record
  to your registrar if it's hosted elsewhere.
- **DigitalOcean DNS does not support DNSSEC.** If you use DO's nameservers and want DNSSEC,
  move DNS to a provider that supports it (Cloudflare's free tier does) and then enable it.
```sh
dig DNSKEY nick-vas.me +short     # non-empty once DNSSEC is live
```

---

## 9. Accounts

- **2FA** on GitHub and DigitalOcean (both support TOTP/passkeys).
- Keep **branch protection** on `master` (you already merge via PR).
- Use an **SSH key or fine-grained PAT** for GitHub, not a password.

---

## Quick verification pass

```sh
ssh deploy@<droplet-ip> 'sudo whoami'                      # root (sudo works, root login off)
ssh -o PreferredAuthentications=password root@<droplet-ip> # must be refused
sudo ufw status | grep -E '22|80|443'                      # only these allowed
sudo fail2ban-client status                                # jails active
sudo certbot renew --dry-run                               # renewal works
curl -sI https://nick-vas.me | grep -i strict-transport    # HSTS present (Nginx side)
dig CAA nick-vas.me +short ; dig MX nick-vas.me +short      # CAA set; null MX
```
