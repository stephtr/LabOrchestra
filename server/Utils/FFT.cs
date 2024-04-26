using System.Numerics;
using NumSharp;

public record FFTPreset(NDArray bitIndizes, NDArray w);

public static class FFT
{
	public static Dictionary<int, FFTPreset> _fftPresets = new();
	public static FFTPreset GetFFTPreset(int size)
	{
		int bits = (int)Math.Log(size, 2);
		if (1 << bits != size)
			throw new ArgumentException("The number of samples must be a power of 2.");
		if (_fftPresets.ContainsKey(size))
			return _fftPresets[size];

		var indices = np.arange(size);
		var bitReversedIndices = np.zeros_like(indices);
		for (int i = 0; i < bits; i++)
		{
			bitReversedIndices = (bitReversedIndices << 1) | (indices & 1);
			indices >>= 1;
		}

		double angle = -2 * Math.PI / size;
		var w = np.exp(np.arange(size / 2) * angle);
		var preset = new FFTPreset(bitReversedIndices, np.zeros<Complex>(size / 2));
		_fftPresets[size] = preset;
		return preset;
	}

	public static NDArray Rfft(NDArray samples)
	{
		if (samples.size == 0)
			return samples;
		var preset = GetFFTPreset(samples.size);

		samples = samples[preset.bitIndizes];

		var complexSamples = samples.astype(np.complex128);
		var halfSize = samples.size / 2;
		for (int size = 2; size <= samples.size; size *= 2)
		{
			for (int i = 0; i < samples.size; i += size)
			{
				var even = complexSamples[new Slice(i, i + halfSize)];
				var odd = complexSamples[new Slice(i + halfSize, i + size)];
				odd *= preset.w;
				complexSamples[new Slice(i, i + halfSize)] = even + odd;
				complexSamples[new Slice(i + halfSize, i + size)] = even - odd;
			}
		}

		return complexSamples[new Slice(0, samples.size / 2 + 1)];
	}
}
