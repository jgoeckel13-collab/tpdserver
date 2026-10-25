#!/usr/bin/env bash
# One-time launch on Fly.io. Run from this folder:  bash deploy-fly.sh
# Optional: APP=my-unique-name ORG=johnathon-goeckel REGION=bos bash deploy-fly.sh
set -euo pipefail
APP="${APP:-tisbury-pd-receptionist}"; ORG="${ORG:-johnathon-goeckel}"; REGION="${REGION:-bos}"
command -v fly >/dev/null || { echo "Install flyctl first: https://fly.io/docs/flyctl/install/"; exit 1; }
fly auth whoami >/dev/null 2>&1 || fly auth login
sed -i.bak "s/^app = .*/app = \"$APP\"/; s/^primary_region = .*/primary_region = \"$REGION\"/" fly.toml && rm -f fly.toml.bak
fly apps list --org "$ORG" 2>/dev/null | grep -q "^$APP " || fly apps create "$APP" --org "$ORG"
fly volumes list -a "$APP" 2>/dev/null | grep -q pdrecep_data || fly volumes create pdrecep_data --size 1 --region "$REGION" -a "$APP" -y
# Optional settings (email / translation), e.g.:
#   fly secrets set -a "$APP" SMTP_HOST=smtp.example.com SMTP_USER=you SMTP_PASS=secret SMTP_FROM="Tisbury PD <noreply@example.org>" ANTHROPIC_API_KEY=sk-ant-...
fly deploy -a "$APP" --ha=false
fly status -a "$APP"
echo "Open https://$APP.fly.dev  (officer portal: /officer/). Tap 'Staff setup' to create the admin account."
