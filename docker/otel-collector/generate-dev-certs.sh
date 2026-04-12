#!/usr/bin/env bash
# Generate self-signed mTLS certificates for local development.
# NOT for production — production certs should come from a proper CA
# or GCP Certificate Authority Service.
#
# Usage: ./generate-dev-certs.sh [output-dir]
set -euo pipefail

CERT_DIR="${1:-$(dirname "$0")/certs}"
DAYS=365
KEY_SIZE=4096

mkdir -p "$CERT_DIR"

echo "Generating development mTLS certificates in $CERT_DIR..."

# --- CA ---
openssl req -x509 -newkey "rsa:$KEY_SIZE" -nodes \
  -keyout "$CERT_DIR/ca.key" \
  -out "$CERT_DIR/ca.crt" \
  -days "$DAYS" \
  -subj "/CN=pax-otel-dev-ca/O=pax-club-org/OU=audit-trail"

# --- Collector server cert (signed by CA) ---
openssl req -newkey "rsa:$KEY_SIZE" -nodes \
  -keyout "$CERT_DIR/collector.key" \
  -out "$CERT_DIR/collector.csr" \
  -subj "/CN=otel-collector/O=pax-club-org/OU=audit-trail"

openssl x509 -req \
  -in "$CERT_DIR/collector.csr" \
  -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/collector.crt" \
  -days "$DAYS" \
  -extfile <(printf "subjectAltName=DNS:otel-collector,DNS:localhost,IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth")

# --- Client cert for Paperclip server (signed by same CA) ---
openssl req -newkey "rsa:$KEY_SIZE" -nodes \
  -keyout "$CERT_DIR/client.key" \
  -out "$CERT_DIR/client.csr" \
  -subj "/CN=paperclip-server/O=pax-club-org/OU=audit-trail"

openssl x509 -req \
  -in "$CERT_DIR/client.csr" \
  -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/client.crt" \
  -days "$DAYS" \
  -extfile <(printf "keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth")

# Clean up CSRs
rm -f "$CERT_DIR/collector.csr" "$CERT_DIR/client.csr" "$CERT_DIR/ca.srl"

# Restrict permissions
chmod 600 "$CERT_DIR"/*.key
chmod 644 "$CERT_DIR"/*.crt

echo "Done. Files created:"
ls -la "$CERT_DIR"
echo ""
echo "For local dev, mount these into the collector container."
echo "For production, replace with certs from GCP Certificate Authority Service."
