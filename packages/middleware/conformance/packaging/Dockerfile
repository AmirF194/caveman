ARG NODE_IMAGE=node@sha256:f5a0871ab03b035c58bdb3007c3d177b001c2145c18e81817b71624dcf7d8bff
ARG PYTHON_IMAGE=python@sha256:0de818129b26ed8f46fd772f540c80e277b67a28229531a1ba0fdacfaed19bcb
ARG GO_IMAGE=golang@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd
FROM ${NODE_IMAGE} AS node_runtime
FROM ${GO_IMAGE} AS go_runtime
FROM ${PYTHON_IMAGE}
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=go_runtime /usr/local/go /usr/local/go
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
RUN python -m pip install --no-cache-dir uv==0.7.19
ENV PYTHONNOUSERSITE=1
ENV PATH="/usr/local/go/bin:${PATH}"
