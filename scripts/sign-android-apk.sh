#!/usr/bin/env bash
# Signs an unsigned release APK with the Android SDK's own zipalign and
# apksigner (#502, decision 1150), then checks the signature and writes its
# .sha256. Runs no npm or Gradle code, so the release key never meets
# third-party build code. Used by .github/workflows/android-app.yml: on a tag
# with the real key, and on other runs with a throwaway key to check that
# signing works.
#
#   KEYSTORE=path KEYSTORE_PASSWORD=… KEY_ALIAS=… [KEY_PASSWORD=…] \
#     scripts/sign-android-apk.sh unsigned.apk Tohyee-<version>.apk
set -euo pipefail

unsigned="$1"
signed="$2"
: "${KEYSTORE:?KEYSTORE is the keystore file}"
: "${KEYSTORE_PASSWORD:?KEYSTORE_PASSWORD is its password}"
: "${KEY_ALIAS:?KEY_ALIAS is the alias of the key}"
# A PKCS12 keystore (keytool's default) has one password for the store and the key.
export KEYSTORE_PASSWORD
export KEY_PASSWORD="${KEY_PASSWORD:-${KEYSTORE_PASSWORD}}"

tools="$(ls -d "${ANDROID_HOME:?ANDROID_HOME is the Android SDK}"/build-tools/* | sort -V | tail -1)"
aligned="$(mktemp --suffix=.apk)"
trap 'rm -f "${aligned}"' EXIT

"${tools}/zipalign" -p -f 4 "${unsigned}" "${aligned}"
"${tools}/apksigner" sign --ks "${KEYSTORE}" --ks-pass env:KEYSTORE_PASSWORD \
  --ks-key-alias "${KEY_ALIAS}" --key-pass env:KEY_PASSWORD \
  --out "${signed}" "${aligned}"
"${tools}/apksigner" verify --verbose "${signed}" | grep -E "^Verifies|v2 scheme"
"${tools}/apksigner" verify --print-certs "${signed}" | grep -E "certificate (DN|SHA-256 digest)"
rm -f "${signed}.idsig"
(cd "$(dirname "${signed}")" && sha256sum "$(basename "${signed}")" > "$(basename "${signed}").sha256")
