# Sign402 Recovery Runbook

This runbook covers the current single-VPS beta deployment that stores Sign402
state in SQLite and JSON files.

Host, account, and paths below are placeholders. Real values live in private
ops notes. The names match [production-beta-checklist.md](production-beta-checklist.md):
`<PROD_HOST>`, `<DEPLOY_USER>`, `<APP_CHECKOUT>`, `<STATE_DIR>`, `<AGENT_HOME>`,
`<GATEWAY_ENV>`, `<BACKUP_ROOT>`.

## Critical State

The deployment is recoverable only if both state files and secrets are preserved.

State files:

```text
<STATE_DIR>/user-wallets.db
<STATE_DIR>/imessage-approvals.db
<STATE_DIR>/bankr-llm.db
<STATE_DIR>/user-spend-limits.json
<APP_CHECKOUT>/demo-dashboard/bitrefill-orders.sqlite3
<APP_CHECKOUT>/demo-dashboard/latest-run.json
<APP_CHECKOUT>/demo-dashboard/agent-state.json
```

Secret/config files:

```text
<AGENT_HOME>/.env
<GATEWAY_ENV>
```

The most important value is `SIGN402_WALLET_MASTER_KEY`. If the encrypted wallet
database exists but the master key is lost, custodial private keys cannot be
decrypted.

## Create Backup

As `<DEPLOY_USER>` on the VPS, with `SIGN402_BACKUP_ROOT`, `SIGN402_STATE_DIR`,
`SIGN402_HERMES_ENV`, and `SIGN402_SYSTEM_ENV` set from the private ops notes:

```bash
cd <APP_CHECKOUT>
./scripts/backup-sign402-state.sh
```

Backups are stored in:

```text
<BACKUP_ROOT>/<timestamp>/
```

Keep these backups private. They may contain API tokens and the wallet master
key.

## Restore Procedure

1. SSH to the VPS.

```bash
ssh <DEPLOY_USER>@<PROD_HOST>
```

2. Stop services.

```bash
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user stop hermes-gateway
sudo systemctl stop sign402-gateway
```

3. Take a pre-restore backup of the current state.

```bash
cd <APP_CHECKOUT>
./scripts/backup-sign402-state.sh
```

4. Restore state files from the selected backup.

```bash
BACKUP=<BACKUP_ROOT>/YYYYMMDDTHHMMSSZ

mkdir -p <STATE_DIR>
cp -p "$BACKUP/state/"* <STATE_DIR>/ 2>/dev/null || true
cp -p "$BACKUP/repo-state/bitrefill-orders.sqlite3" <APP_CHECKOUT>/demo-dashboard/ 2>/dev/null || true
cp -p "$BACKUP/repo-state/latest-run.json" <APP_CHECKOUT>/demo-dashboard/ 2>/dev/null || true
cp -p "$BACKUP/repo-state/agent-state.json" <APP_CHECKOUT>/demo-dashboard/ 2>/dev/null || true
```

5. Restore secrets only when intentionally rolling back env values.

```bash
cp -p "$BACKUP/secrets/hermes.env" <AGENT_HOME>/.env
sudo cp -p "$BACKUP/secrets/sign402-gateway.env" <GATEWAY_ENV>
```

6. Fix permissions.

```bash
chmod 700 <STATE_DIR>
chmod 600 <STATE_DIR>/* 2>/dev/null || true
chmod 600 <AGENT_HOME>/.env
sudo chmod 600 <GATEWAY_ENV>
```

7. Start services.

```bash
sudo systemctl start sign402-gateway
systemctl --user start hermes-gateway
```

8. Verify.

```bash
curl -sS http://127.0.0.1:8099/health
systemctl is-active sign402-gateway
systemctl --user is-active hermes-gateway
```

## User-Level Verification

From Telegram:

1. Send `Wallet` and confirm the expected Base address appears.
2. Send `Balance`.
3. Send `Connect iMessage` only if pairing needs to be repaired.
4. Send `Last Purchase` if restoring Bitrefill order state.

## Emergency Close

If public beta needs to be closed quickly, restore a Telegram allowlist in
`<AGENT_HOME>/.env` and restart Hermes gateway:

```env
SIGN402_TELEGRAM_ALLOWED_USERS=<operator Telegram ID>
TELEGRAM_ALLOWED_USERS=<operator Telegram ID>
```

```bash
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user restart hermes-gateway
```
