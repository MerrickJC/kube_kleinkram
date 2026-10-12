
#!/bin/bash
echo $DOCKER_PASSWORD | docker login registry.direct.merrickcampbell.au --username merrick.campbell@monashmotorsport.com --password-stdin

docker buildx build --platform linux/amd64 --push -t registry.direct.merrickcampbell.au/throttle-cpu-and-memory:v0.0.3 --build-context klein_cli=../../../cli/ .
