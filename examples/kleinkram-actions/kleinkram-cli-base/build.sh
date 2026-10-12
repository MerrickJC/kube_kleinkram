
#!/bin/bash
echo $DOCKER_PASSWORD | docker login registry.direct.merrickcampbell.au --username merrick.campbell@monashmotorsport.com --password-stdin

docker buildx build --platform linux/amd64 --push -t registry.direct.merrickcampbell.au/kleinkram-cli-base:v1.1.0 --build-context klein_cli=../../../cli/ .
