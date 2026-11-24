#!/bin/bash
# Builds pffft (native/pffft, BSD-style license, see there) as a shared library into the folder given as $1.
# Used by the build of the oscilloscope plugin; without a C compiler the plugin falls back to its managed FFT.
set -e
OUT="${1:?usage: build.sh <output folder>}"
HERE="$(cd "$(dirname "$0")" && pwd)/pffft"
FLAGS="-O3 -DNDEBUG -D_USE_MATH_DEFINES -w -I$HERE"
SRC="$HERE/pffft.c $HERE/pffft_common.c"
mkdir -p "$OUT"
case "$(uname -s)" in
  Darwin) clang -shared -fPIC $FLAGS $SRC -o "$OUT/libpffft.dylib" ;;
  Linux) cc -shared -fPIC $FLAGS $SRC -lm -o "$OUT/libpffft.so" ;;
  *) clang -shared -DPFFFT_EXPORTS $FLAGS $SRC -o "$OUT/pffft.dll" ;;
esac
