# Click & Copy

A Chrome extension that restores right-click, text selection, and copy/paste on websites that block them.

## Features

- Bypasses `preventDefault()` on context menu, selection, copy, and cut events
- Overrides CSS `user-select: none` rules
- 3-level control: global, per-site, and per-page rules
- Works in incognito mode without saving anything to storage

## Usage

1. Click the extension icon to toggle for the current site
2. Right-click the icon for more options:
   - Enable/disable globally
   - Enable/disable for the current site or page
   - Reset site rules

A green **✓** badge indicates the extension is active on the current page.

## Installation

1. Clone this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the extension folder

Compatible with Chrome, Edge, and other Chromium-based browsers (Manifest V3).
