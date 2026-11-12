# Deploying the backend (free options)

The frontend (Vercel) calls a Node backend that holds a funder wallet and signs
Monad testnet transactions, so it needs a real server (GitHub Pages is static
only). After deploying, set `REMOTE_BACKEND` in `frontend/shared.js` to the new
HTTPS URL. The page is HTTPS, so the backend must be HTTPS/WSS too.

## RPC

Use `https://testnet-rpc.monad.xyz` (fallback `https://rpc-testnet.monadinfra.com`).
Both reject JSON-RPC batching, which the backend now disables. Do not use a
metered key such as a dRPC URL; when its balance runs out every call fails.

## Monad reserve balance (why txs are queued)

Accounts under 10 MON can only spend below the reserve with the first tx in any
~3-block window; a second one reverts and still burns the full gas limit. The
backend therefore queues transactions per sender and spaces them
(`TX_MIN_SPACING_MS`, default 1500). Keep the funder wallet topped up from
https://faucet.monad.xyz (each new player session costs `SESSION_FUND_AMOUNT`).

## Option A: Render free (no card)

1. Render dashboard > New > Blueprint > select this repo (uses `render.yaml`).
2. Set the three secrets: `CONTRACT_ADDRESS`, `FUNDER_PRIVATE_KEY`, `SESSION_SEED`.
   Reuse the **same** `SESSION_SEED` as before so player addresses stay stable.
3. Open `https://<service>.onrender.com/health` (should return `{"ok":true}`).
4. Set `REMOTE_BACKEND` in `frontend/shared.js` to that URL and redeploy Vercel.

The free plan sleeps when idle; lobbies are held in memory and are lost on sleep.

## Option B: Oracle Cloud Always Free VM (always on)

Needs a card for sign-up verification (Always Free resources are not charged).
Ampere A1 often reports "out of host capacity" in busy regions; the
E2.1.Micro shape is plenty for this backend.

1. Create an Ubuntu 24.04 instance. In the VCN security list, add ingress rules
   for TCP 80 and 443 from `0.0.0.0/0`.
2. Point a free hostname at the VM's public IP (DuckDNS `yourname.duckdns.org`,
   or no-signup `<ip-with-dashes>.sslip.io`).
3. On the VM:

```bash
sudo apt update && sudo apt install -y git curl caddy
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
git clone https://github.com/0jz/Monadrift.git && cd Monadrift/backend && npm ci
cp .env.example .env && chmod 600 .env   # fill CONTRACT_ADDRESS, FUNDER_PRIVATE_KEY, SESSION_SEED (same seed as before)

# Oracle's Ubuntu image blocks everything but SSH in iptables, on top of the security list
# insert just above the REJECT rule (its position varies by image)
sudo iptables -I INPUT $(sudo iptables -L INPUT --line-numbers | awk '/REJECT/{print $1; exit}') -p tcp -m multiport --dports 80,443 -j ACCEPT
sudo netfilter-persistent save

sudo cp ../deploy/oracle/monadrift.service /etc/systemd/system/
sudo cp ../deploy/oracle/Caddyfile /etc/caddy/Caddyfile   # then edit the hostname
sudo systemctl daemon-reload && sudo systemctl enable --now monadrift && sudo systemctl restart caddy
```

4. Check `https://<hostname>/health`, then set `REMOTE_BACKEND` in
   `frontend/shared.js` to `https://<hostname>` and redeploy Vercel.

Update later with `git pull && (cd backend && npm ci) && sudo systemctl restart monadrift`.
Logs: `journalctl -u monadrift -f`.

Oracle may reclaim Always Free instances that stay nearly idle for 7 days.
Upgrading the account to Pay-As-You-Go (still free for Always Free shapes)
stops that.
