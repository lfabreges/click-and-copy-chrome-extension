#!/bin/bash

SCRIPT_DIR=$(dirname "$0")
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"

for size in 16 48 128; do 
  rsvg-convert -w $size -h $size "$EXTENSION_DIR/images/icon.svg" -o "$EXTENSION_DIR/images/icon-${size}.png"
done
