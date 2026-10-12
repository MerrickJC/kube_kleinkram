FROM python:3.14-slim

ENV HOME=/tmp

# Install Kleinkram CLI, yaml and mcap
RUN pip install mcap
RUN pip install pyyaml
COPY --from=klein_cli . /cli
RUN pip install /cli

# Install stress-ng
RUN apt update && apt install stress-ng -y

# Copy scripts
COPY ./entrypoint.sh /entrypoint.sh
COPY ./metadata.py /metadata.py
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
