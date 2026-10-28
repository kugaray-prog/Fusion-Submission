#!/usr/bin/env bash
# Builds the release APK. Mounts: /src (mobile/, read-only), /work (build volume), /out (public/downloads/).
set -euo pipefail

: "${API_BASE_URL:?API_BASE_URL is not set (set HOST_LAN_IP in .env)}"
APK_NAME="${APK_NAME:-GeoAttend-Local.apk}"
APK_ARCHS="${APK_ARCHS:-arm64-v8a}"
export CI=1 NODE_ENV=production

echo "==> Server address baked into the APK: $API_BASE_URL"

echo "==> Copying mobile/ into the build folder"
mkdir -p /work
find /work -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -C /src --exclude=./node_modules --exclude=./android --exclude=./ios \
    --exclude=./.expo -cf - . | tar -C /work -xf -
cd /work

# npm ci only when package-lock.json changed since the last build.
if ! cmp -s package-lock.json node_modules/.build-apk-lock 2>/dev/null; then
  echo "==> Installing npm packages"
  npm ci
  cp package-lock.json node_modules/.build-apk-lock
fi

# react-native-wifi-reborn passes unquoted names to safeExtGet, which Gradle 9 rejects.
sed -i -E "s/safeExtGet\((compileSdkVersion|minSdkVersion|targetSdkVersion),/safeExtGet('\1',/" \
  node_modules/react-native-wifi-reborn/android/build.gradle

echo "==> Generating the android/ project (expo prebuild)"
npx expo prebuild --platform android --clean --no-install

# Sign with the same debug key as earlier APKs, so the new APK installs over
# the old one without uninstalling.
if [ -f /src/android/app/debug.keystore ]; then
  cp /src/android/app/debug.keystore android/app/debug.keystore
fi

# Docker Desktop usually gives the Linux VM only a few GB of RAM.
sed -i 's/^org.gradle.jvmargs=.*/org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m/' android/gradle.properties
# Leading \n: the generated file has no trailing newline, and gluing onto its
# last line (expo.inlineModules.watchedDirectories=[]) breaks Expo's build.
printf '\nkotlin.compiler.execution.strategy=in-process\n' >> android/gradle.properties

echo "==> Building the APK ($APK_ARCHS) -- the first build takes a long time"
cd android
./gradlew assembleRelease --no-daemon \
  --max-workers="${GRADLE_WORKERS:-2}" \
  -PreactNativeArchitectures="$APK_ARCHS"

cp app/build/outputs/apk/release/app-release.apk "/out/$APK_NAME"
echo "==> Done: public/downloads/$APK_NAME"
echo "    Phone download: ${API_BASE_URL%/api}/downloads/$APK_NAME"
