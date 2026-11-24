#!/bin/bash
# Builds pffft (https://github.com/marton78/pffft, pinned commit) as a shared library for the benchmark.
set -e
COMMIT=38e70163a2d3f00bbb4c3df8881ef9ccf15ee1aa
if [ ! -d pffft-src ]; then
  git clone -q https://github.com/marton78/pffft.git pffft-src
  git -C pffft-src checkout -q $COMMIT
fi
FLAGS="-O3 -ffast-math -DNDEBUG -D_USE_MATH_DEFINES -Ipffft-src/include -Ipffft-src/include/pffft -Ipffft-src/src"
SRC="pffft-src/src/pffft.c pffft-src/src/pffft_common.c"
case "$(uname -s)" in
  Darwin) clang -shared -fPIC $FLAGS $SRC -o libpffft.dylib ;;
  Linux) cc -shared -fPIC $FLAGS $SRC -lm -o libpffft.so ;;
  *) clang -shared $FLAGS $SRC -o pffft.dll \
       -Xlinker -export:pffft_new_setup -Xlinker -export:pffft_transform_ordered \
       -Xlinker -export:pffft_simd_size -Xlinker -export:pffft_aligned_malloc ;;
esac
