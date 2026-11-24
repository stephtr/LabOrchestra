#!/bin/bash
# Builds pffft (https://github.com/marton78/pffft, pinned commit) as a shared library for the benchmark.
set -e
COMMIT=38e70163a2d3f00bbb4c3df8881ef9ccf15ee1aa
if [ ! -d pffft-src ]; then
  git clone -q https://github.com/marton78/pffft.git pffft-src
  git -C pffft-src checkout -q $COMMIT
fi
FLAGS="-O3 -DNDEBUG -D_USE_MATH_DEFINES -Ipffft-src/include -Ipffft-src/include/pffft -Ipffft-src/src"
SRC="pffft-src/src/pffft.c pffft-src/src/pffft_common.c"
case "$(uname -s)" in
  Darwin) clang -shared -fPIC $FLAGS $SRC -o libpffft.dylib ;;
  Linux) cc -shared -fPIC $FLAGS $SRC -lm -o libpffft.so ;;
  *) clang -shared -DPFFFT_EXPORTS -w $FLAGS $SRC -o pffft.dll ;;
esac

# ffts fork (https://github.com/linkotec/ffts, pinned commit)
COMMIT=2c8da4877588e288ff4cd550f14bec2dc7bf668c
if [ ! -d ffts-src ]; then
  git clone -q https://github.com/linkotec/ffts.git ffts-src
  git -C ffts-src checkout -q $COMMIT
fi
FSRC=$(for f in ffts ffts_chirp_z ffts_cpu ffts_nd ffts_real ffts_real_nd ffts_static ffts_transpose ffts_trig; do echo ffts-src/src/$f.c; done)
FDEF="-O3 -shared -fPIC -w -DDYNAMIC_DISABLED -DFFTS_PREFIX=ffts -DHAVE_STDINT_H -DHAVE_STDLIB_H -DHAVE_STRING_H -DHAVE_STDIO_H -DHAVE_SYS_MMAN_H -DHAVE_UNISTD_H -Iffts-src/include -Iffts-src/src -U__ARM_NEON__"
CM="-S ffts-src -DENABLE_SHARED=ON -DENABLE_STATIC=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -Wno-dev -DCMAKE_BUILD_TYPE=Release"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    clang $FDEF $FSRC -lm -o libffts-scalar.dylib
    # NEON intrinsics header, without HAVE_NEON (which would pull in 32-bit ARM assembly)
    clang $FDEF -DFFTS_MACROS_ALPHA_H -include ffts-src/src/ffts_attributes.h -include ffts-src/src/macros-neon.h $FSRC -lm -o libffts-neon.dylib 2>/dev/null || echo "NEON intrinsics variant does not build"
    ;;
  Linux-*)
    cmake $CM -B ffts-src/build > /dev/null && cmake --build ffts-src/build 2>&1 | grep -E "error|Error" || true
    cp -L $(find ffts-src/build -name 'libffts*.so' | head -1) libffts-fork.so || echo "ffts fork does not build" ;;
  *)
    cmake $CM -B ffts-src/build -A x64 > /dev/null && cmake --build ffts-src/build --config Release 2>&1 | grep -E "error" || true
    cp "$(find ffts-src/build -name '*.dll' | head -1)" ffts-fork.dll || echo "ffts fork does not build" ;;
esac
