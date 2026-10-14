#!/bin/bash
set -e

echo "Throttling CPU and memory for mission $KLEINKRAM_MISSION_UUID"

# Set endpoint 
klein endpoint kubernetes http://kleinkram-api-server.kleinkram.svc.cluster.local:3000 http://juicefs-s3-gateway.juicefs.svc.cluster.local:9000

# Authenticate
klein login --key "$KLEINKRAM_API_KEY"

# Download data
mkdir /tmp/data
klein download -m "$KLEINKRAM_MISSION_UUID" --dest /tmp/data --include-corrupt-files -y

# Extract bag length 
DURATION=$(python3 -c "import yaml; duration_ns = yaml.safe_load(open('/tmp/data/metadata.yaml'))['rosbag2_bagfile_information']['duration']['nanoseconds']; print(duration_ns // 1_000_000_000)")

# Run stress test
echo "Running stress test for $DURATION seconds..."
stress-ng --temp-path /tmp --vm 2 --vm-bytes 256M --pipe 2 --cpu 1 --cpu-method matrixprod --timeout "$DURATION"s --metrics-brief > /out/stress_metrics.log

echo "Stress test complete."
