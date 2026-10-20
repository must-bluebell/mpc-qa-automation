# The upstream local image ships target/debug/proxy. Keep its exact proxy
# revision and authentication behavior, replacing only the binary with a
# release build so password authentication does not dominate load tests.
FROM rust:1.88.0-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends libssl-dev pkg-config git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /neon
RUN git init && git remote add origin https://github.com/neondatabase/neon.git \
    && git fetch --depth=1 origin 58abce0207943f44ac801aebc4f3d881e90a6894 \
    && git checkout --detach FETCH_HEAD
RUN cargo build --release --locked --bin proxy --features testing --jobs 2

FROM ghcr.io/timowilhelm/local-neon-http-proxy:main@sha256:cd2ae14edf2feafbc3330492de5c80506f77274c3bd013154cdef697bdeb768a
COPY --from=builder /neon/target/release/proxy /app/neon-proxy
