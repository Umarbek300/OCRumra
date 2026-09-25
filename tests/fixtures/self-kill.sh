#!/bin/sh
# Test fixture standing in for a Tesseract process that gets terminated by a
# signal (e.g. the OOM killer sending SIGKILL) rather than exiting normally.
# Drains stdin first (exercising the real spawn/stdin-pipe path), then kills
# itself — reproducing Node's close event firing with code=null and a
# non-null signal, which runTesseractOcr must surface, not silently drop.
cat >/dev/null
kill -9 $$
