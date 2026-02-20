#!/usr/bin/env bash

set -e

echo "🔎 Searching for BeagleBone serial device..."

DEVICE=$(ls /dev/cu.usbmodem* 2>/dev/null | head -n 1)

if [ -z "$DEVICE" ]; then
    echo "❌ No BeagleBone serial device found."
    exit 1
fi

echo "✅ Found: $DEVICE"
echo "Opening serial console (115200 baud)..."
echo "Press CTRL-A then K to exit screen."

sleep 1

screen "$DEVICE" 115200
