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

On an Ubuntu VM (Ampere A1 or E2.1.Micro), with ports 80 and 443 open in both the
VCN security list and the instance firewall:

```bash
sudo apt update && sudo apt install -y git curl debian-keyring caddy
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
git clone https://github.com/0jz/Monadrift.git && cd Monadrift/backend && npm ci
cp .env.example .env   # fill CONTRACT_ADDRESS, FUNDER_PRIVATE_KEY, SESSION_SEED; RPC_URL=https://testnet-rpc.monad.xyz
```

systemd unit `/etc/systemd/system/monadrift.service`:

```ini
[Unit]
Description=Monadrift backend
After=network-online.target
[Service]
WorkingDirectory=/home/ubuntu/Monadrift/backend
ExecStart=/usr/bin/node src/index.js
Restart=always
User=ubuntu
[Install]
WantedBy=multi-user.target
```

HTTPS with a free hostname (e.g. DuckDNS `yourname.duckdns.org` pointing at the VM IP), in `/etc/caddy/Caddyfile`:

```
yourname.duckdns.org {
  reverse_proxy localhost:8787
}
```

Then `sudo systemctl enable --now monadrift caddy`. Caddy gets the certificate
automatically and proxies WebSockets.
