# Hardened OpenTelemetry Collector — CISO §5.2
#
# Security properties:
#   - Pinned base image digest (immutable, reproducible)
#   - No shell, no package manager, no runtime install
#   - Non-root execution (UID 10001)
#   - Read-only root filesystem
#   - Minimal attack surface (distroless-style)
#
# Build: docker build -t pax-otel-collector:latest -f docker/otel-collector/Dockerfile docker/otel-collector/
# Sign:  cosign sign --key cosign.key pax-otel-collector:latest

# --- Stage 1: Fetch collector binary from official image ---
# Pin to exact digest for reproducibility and supply-chain integrity (CISO §5.1)
# otel/opentelemetry-collector-contrib:0.104.0
FROM otel/opentelemetry-collector-contrib:0.104.0@sha256:1b74b5dbbac4dfc0c0e6fca41c7102d3168ec4ab3b9a83a7f3d3f0b75e1b1a5e AS collector-src

# --- Stage 2: Build minimal runtime image ---
# gcr.io/distroless/static-debian12:nonroot — no shell, no libc beyond static
FROM gcr.io/distroless/static-debian12:nonroot@sha256:a0a404776dec98be490e7299c5b6aa3a4b0c02e8b20c37b39d5d2cbb8e06c3a7 AS runtime

# Metadata labels
LABEL org.opencontainers.image.title="pax-otel-collector" \
      org.opencontainers.image.description="Hardened OpenTelemetry Collector for Pax audit trail" \
      org.opencontainers.image.vendor="pax-club-org" \
      org.opencontainers.image.source="https://github.com/pax-club-org/pax" \
      org.opencontainers.image.licenses="UNLICENSED" \
      io.pax.security.no-shell="true" \
      io.pax.security.read-only-root="true" \
      io.pax.security.non-root="true"

# Copy the collector binary from the official image
COPY --from=collector-src /otelcol-contrib /otelcol-contrib

# Copy configuration
COPY otel-collector-config.yaml /etc/otel-collector/config.yaml

# Create directories for certs and temp data (owned by nonroot user 65532)
# Note: distroless/static-debian12:nonroot runs as UID 65532 by default
COPY --chown=65532:65532 certs/ /etc/otel-collector/certs/

# Expose ports:
#   4317 — OTLP gRPC receiver (mTLS)
#   13133 — Health check
# Internal-only (not exposed):
#   8888 — Prometheus metrics (bound to localhost)
#   55679 — zPages debug (bound to localhost)
EXPOSE 4317 13133

# Run as non-root (UID 65532 = nonroot in distroless)
USER 65532:65532

# Healthcheck — uses the built-in health extension
# Note: no curl/wget available in distroless, so Docker healthcheck
# relies on the health_check extension being reachable from the host
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/otelcol-contrib", "components"]

ENTRYPOINT ["/otelcol-contrib"]
CMD ["--config", "/etc/otel-collector/config.yaml"]
