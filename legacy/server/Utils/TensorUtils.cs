using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;

public static class TensorUtils
{
	[MethodImpl(MethodImplOptions.AggressiveInlining)]
	public static void AbsSquared(float[] inp, float[] outp, float fftFactor = 1)
	{
		if (Avx512F.IsSupported)
		{
			var indicesEven = Vector512.Create(0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30);
			var indicesOdd = Vector512.Create(1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31);
			var vFFTFactor = Vector512.Create(fftFactor);
			var vectors = MemoryMarshal.Cast<float, Vector512<float>>(inp);
			for (int j = 0; j < vectors.Length / 2; j++)
			{
				var v1 = vectors[j * 2];
				var v2 = vectors[j * 2 + 1];
				var vReal = Avx512F.PermuteVar16x32x2(v1, indicesEven, v2);
				var vImag = Avx512F.PermuteVar16x32x2(v1, indicesOdd, v2);
				var vMagnitudeSquared = Avx512F.FusedMultiplyAdd(vReal, vReal, Avx512F.Multiply(vImag, vImag));
				vMagnitudeSquared = Avx512F.Multiply(vMagnitudeSquared, vFFTFactor);
				vMagnitudeSquared.CopyTo(outp, j * Vector512<float>.Count);
			}
			for (var k = vectors.Length / 2 * Vector512<float>.Count; k < inp.Length; k += 2)
			{
				outp[k / 2] = (inp[k] * inp[k] + inp[k + 1] * inp[k + 1]) * fftFactor;
			}
		}
		else if (Avx2.IsSupported)
		{
			var indicesEven = Vector256.Create(0, 2, 4, 6, 0, 2, 4, 6);
			var indicesOdd = Vector256.Create(1, 3, 5, 7, 1, 3, 5, 7);
			var vFFTFactor = Vector256.Create(fftFactor);
			var vectors = MemoryMarshal.Cast<float, Vector256<float>>(inp);
			for (int j = 0; j < vectors.Length / 2; j++)
			{
				var v1 = vectors[j * 2];
				var v2 = vectors[j * 2 + 1];
				var v1Even = Avx2.PermuteVar8x32(v1, indicesEven);
				var v2Even = Avx2.PermuteVar8x32(v2, indicesEven);
				var v1Odd = Avx2.PermuteVar8x32(v1, indicesOdd);
				var v2Odd = Avx2.PermuteVar8x32(v2, indicesOdd);
				var vReal = Avx.Blend(v1Even, v2Even, 0xF0);
				var vImag = Avx.Blend(v1Odd, v2Odd, 0xF0);
				var vMagnitudeSquared = Fma.MultiplyAdd(vReal, vReal, Avx.Multiply(vImag, vImag));
				vMagnitudeSquared = Avx.Multiply(vMagnitudeSquared, vFFTFactor);
				vMagnitudeSquared.CopyTo(outp, j * Vector256<float>.Count);
			}
			for (var k = vectors.Length / 2 * Vector512<float>.Count; k < inp.Length; k += 2)
			{
				outp[k / 2] = (inp[k] * inp[k] + inp[k + 1] * inp[k + 1]) * fftFactor;
			}
		}
		else
		{
			for (var k = 0; k < inp.Length; k += 2)
			{
				outp[k / 2] = (inp[k] * inp[k] + inp[k + 1] * inp[k + 1]) * fftFactor;
			}
		}
	}
}
