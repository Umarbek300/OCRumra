#!/bin/sh
# Test fixture standing in for the `tesseract` binary: drains stdin (so the
# real spawn/stdin-pipe code path is exercised) and echoes its argv to
# stdout, so tests can assert on exactly which CLI flags runTesseractOcr
# passed, without needing a real tesseract install.
cat >/dev/null
echo "$@"
