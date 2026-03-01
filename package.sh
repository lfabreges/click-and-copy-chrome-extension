#!/bin/bash

ZIP_NAME="one-page-pdf.zip"

if [ -f "$ZIP_NAME" ]; then
    rm "$ZIP_NAME"
fi

zip -r "$ZIP_NAME" manifest.json background.js images _locales -x "*.DS_Store" "*.svg" "package.sh" ".*"
