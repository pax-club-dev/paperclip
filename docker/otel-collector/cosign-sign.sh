#!/usr/bin/env bash
# Sign the OTel collector image with cosign (Sigstore).
# Per CISO §5.2: Image signing for supply chain integrity.
#
# Prerequisites:
#   - cosign installed (https://docs.sigstore.dev/cosign/installation/)
#   - COSIGN_KEY or COSIGN_PASSWORD set for key-based signing
#   - Image must be pushed to a registry before signing
#
# Usage:
#   ./cosign-sign.sh <image-ref>
#   ./cosign-sign.sh ghcr.io/pax-club-org/pax-otel-collector:v1.0.0
#
# For keyless signing (Sigstore OIDC — recommended for CI):
#   COSIGN_EXPERIMENTAL=1 ./cosign-sign.sh <image-ref>
set -euo pipefail

IMAGE_REF="${1:?Usage: $0 <image-ref> (e.g. ghcr.io/pax-club-org/pax-otel-collector:v1.0.0)}"

# Verify cosign is installed
if ! command -v cosign &>/dev/null; then
  echo "ERROR: cosign not found. Install from https://docs.sigstore.dev/cosign/installation/" >&2
  exit 1
fi

echo "Signing image: $IMAGE_REF"

if [[ "${COSIGN_EXPERIMENTAL:-0}" == "1" ]]; then
  # Keyless signing via Sigstore OIDC (recommended for CI/CD)
  echo "Using keyless signing (Sigstore OIDC)..."
  cosign sign \
    --yes \
    -a "repo=pax-club-org/pax" \
    -a "component=otel-collector" \
    -a "security-policy=ciso-5.2" \
    "$IMAGE_REF"
elif [[ -n "${COSIGN_KEY:-}" ]]; then
  # Key-based signing
  echo "Using key-based signing..."
  cosign sign \
    --yes \
    --key "$COSIGN_KEY" \
    -a "repo=pax-club-org/pax" \
    -a "component=otel-collector" \
    -a "security-policy=ciso-5.2" \
    "$IMAGE_REF"
else
  echo "ERROR: Set COSIGN_KEY (path to private key) or COSIGN_EXPERIMENTAL=1 for keyless signing." >&2
  exit 1
fi

echo "Image signed successfully."

# Verify the signature
echo "Verifying signature..."
if [[ "${COSIGN_EXPERIMENTAL:-0}" == "1" ]]; then
  cosign verify \
    --certificate-identity-regexp=".*" \
    --certificate-oidc-issuer-regexp=".*" \
    "$IMAGE_REF" | head -5
elif [[ -n "${COSIGN_KEY:-}" ]]; then
  cosign verify \
    --key "${COSIGN_KEY%.key}.pub" \
    "$IMAGE_REF" | head -5
fi

echo "Verification complete."
