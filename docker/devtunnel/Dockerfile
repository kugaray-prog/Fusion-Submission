# Dev Tunnels CLI; gnome-keyring + dbus persist its login token.
FROM mcr.microsoft.com/dotnet/runtime-deps:8.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates dbus-x11 gnome-keyring libsecret-1-0 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://aka.ms/TunnelsCliDownload/linux-x64 -o /usr/local/bin/devtunnel \
 && chmod +x /usr/local/bin/devtunnel
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
