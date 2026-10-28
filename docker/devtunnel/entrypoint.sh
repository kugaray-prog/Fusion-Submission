#!/bin/sh
# Hosts DEVTUNNEL_ID and forwards it to the app's port 2620.
set -e

# Keyring keeps the login token. Daemon output goes to files: $(...) would hang.
dbus-launch --sh-syntax > /tmp/dbus.env
. /tmp/dbus.env
export DBUS_SESSION_BUS_ADDRESS
mkdir -p /root/.local/share/keyrings
printf 'devtunnel' | gnome-keyring-daemon --unlock --components=secrets > /tmp/keyring.env 2>/dev/null
. /tmp/keyring.env
export GNOME_KEYRING_CONTROL

case "$1" in
  login) exec devtunnel user login -g -d ;;
  "") ;;
  *) exec devtunnel "$@" ;;
esac

if devtunnel user show 2>&1 | grep -q "Logged in"; then
  # Tunnels expire after 30 days; extend on start and daily.
  ( while :; do
      devtunnel update "$DEVTUNNEL_ID" --expiration 30d >/dev/null 2>&1 \
        || echo "Dev Tunnels: could not renew the 30-day expiration (will retry)."
      sleep 86400
    done ) &
  # Make sure the tunnel forwards the app's port (no-op if it already does).
  devtunnel port create "$DEVTUNNEL_ID" -p 2620 >/dev/null 2>&1 || true
  exec devtunnel host "$DEVTUNNEL_ID"
fi
echo "Dev Tunnels: not logged in. Run: docker compose run --rm tunnel login"
sleep 60
exit 1
