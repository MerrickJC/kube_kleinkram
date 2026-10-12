FROM python:3.14-slim

ENV HOME=/tmp

# Install Kleinkram CLI and mcap
COPY --from=klein_cli . /cli
RUN pip install /cli

RUN klein endpoint kubernetes http://kleinkram-api-server.kleinkram.svc.cluster.local:3000 http://juicefs-s3-gateway.juicefs.svc.cluster.local:9000
