#!/bin/bash

SCRIPT_DIR=$(dirname "$0")
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"

ZIP_NAME="click-and-copy.zip"
ZIP_PATH="$EXTENSION_DIR/dist/$ZIP_NAME"

mkdir -p "$(dirname "$ZIP_PATH")"

if [ -f "$ZIP_PATH" ]; then
    rm "$ZIP_PATH"
fi

cd "$EXTENSION_DIR"
zip -r "$ZIP_PATH" manifest.json *.css *.js *.html images/*.png _locales/**/*.json
