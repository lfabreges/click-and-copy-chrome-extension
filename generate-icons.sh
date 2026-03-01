#!/bin/bash
for size in 16 48 128; do rsvg-convert -w $size -h $size images/icon.svg -o images/icon-${size}.png; done