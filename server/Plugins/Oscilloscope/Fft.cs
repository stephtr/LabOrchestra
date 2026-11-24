namespace LabOrchestra.Plugins.Oscilloscope;

/// <summary>A real FFT that gives the power of each bin: |X[k]|^2 * scale for k = 0 .. n/2.</summary>
public interface IRealFft
{
	int Size { get; }
	/// <summary>The samples to transform go here (native, aligned memory for the native FFT: fill it directly, without another copy).</summary>
	Span<float> Input { get; }
	/// <summary>Transforms <see cref="Input"/>; <c>power</c> has Size / 2 + 1 values. The input is left in an undefined state.</summary>
	void Power(Span<float> power, float scale);
}

/// <summary>A plain radix-2 FFT in managed code (a real FFT through a complex one of half the size). Slower than a native library but
/// needs nothing installed; <see cref="Create"/> will prefer a native one when there is one.</summary>
public sealed class ManagedRealFft : IRealFft
{
	private readonly int _n, _m;
	private readonly float[] _re, _im, _cos, _sin, _postCos, _postSin;
	private readonly int[] _bitReverse;

	public ManagedRealFft(int n)
	{
		if (n < 8 || (n & (n - 1)) != 0) throw new ArgumentException("The FFT length must be a power of two, at least 8");
		(_n, _m) = (n, n / 2);
		_re = new float[_m];
		_im = new float[_m];
		_cos = new float[_m / 2];
		_sin = new float[_m / 2];
		for (var k = 0; k < _m / 2; k++)
		{
			_cos[k] = (float)Math.Cos(2 * Math.PI * k / _m);
			_sin[k] = (float)Math.Sin(2 * Math.PI * k / _m);
		}
		_postCos = new float[_m + 1];
		_postSin = new float[_m + 1];
		for (var k = 0; k <= _m; k++)
		{
			_postCos[k] = (float)Math.Cos(2 * Math.PI * k / n);
			_postSin[k] = (float)Math.Sin(2 * Math.PI * k / n);
		}
		_bitReverse = new int[_m];
		var bits = (int)Math.Log2(_m);
		for (var i = 0; i < _m; i++)
		{
			var r = 0;
			for (var b = 0; b < bits; b++) if ((i & (1 << b)) != 0) r |= 1 << (bits - 1 - b);
			_bitReverse[i] = r;
		}
	}

	public int Size => _n;

	private float[]? _input;
	public Span<float> Input => _input ??= new float[_n];

	public void Power(Span<float> power, float scale) => Power(Input, power, scale);

	public void Power(ReadOnlySpan<float> input, Span<float> power, float scale)
	{
		var m = _m;
		for (var k = 0; k < m; k++)
		{
			_re[_bitReverse[k]] = input[2 * k];
			_im[_bitReverse[k]] = input[2 * k + 1];
		}
		for (var length = 2; length <= m; length <<= 1)
		{
			var half = length / 2;
			var step = m / length;
			for (var i = 0; i < m; i += length)
				for (var j = 0; j < half; j++)
				{
					float wr = _cos[j * step], wi = -_sin[j * step];
					var a = i + j;
					var b = a + half;
					var vr = _re[b] * wr - _im[b] * wi;
					var vi = _re[b] * wi + _im[b] * wr;
					_re[b] = _re[a] - vr;
					_im[b] = _im[a] - vi;
					_re[a] += vr;
					_im[a] += vi;
				}
		}
		for (var k = 0; k <= m; k++)
		{
			int k1 = k % m, k2 = (m - k) % m;
			float zr = _re[k1], zi = _im[k1], cr = _re[k2], ci = -_im[k2];
			float er = (zr + cr) / 2, ei = (zi + ci) / 2; // even part
			float or = (zi - ci) / 2, oi = -(zr - cr) / 2; // odd part (divided by 2i)
			float wr = _postCos[k], wi = -_postSin[k];
			float xr = er + or * wr - oi * wi, xi = ei + or * wi + oi * wr;
			power[k] = (xr * xr + xi * xi) * scale;
		}
	}
}

public static class WindowFunction
{
	public static readonly string[] Names = ["rectangular", "hann", "blackman", "nuttall", "blackman-nuttall"];

	/// <summary>The window, scaled so that its power equals that of a rectangular window (the same convention as before).</summary>
	public static float[] Create(string name, int length)
	{
		var w = new float[length];
		var n = length - 1.0;
		for (var i = 0; i < length; i++)
		{
			var x = 2 * Math.PI * i / n;
			w[i] = (float)(name switch
			{
				"rectangular" => 1.0,
				"hann" => Math.Pow(Math.Sin(Math.PI * i / n), 2),
				"blackman" => 0.42 - 0.5 * Math.Cos(x) + 0.08 * Math.Cos(2 * x),
				"nuttall" => 0.355768 - 0.487396 * Math.Cos(x) + 0.144232 * Math.Cos(2 * x) - 0.012604 * Math.Cos(3 * x),
				"blackman-nuttall" => 0.3635819 - 0.4891775 * Math.Cos(x) + 0.1365995 * Math.Cos(2 * x) - 0.0106411 * Math.Cos(3 * x),
				_ => throw new ArgumentException($"Unknown window function '{name}' (known: {string.Join(", ", Names)})"),
			});
		}
		var norm = Math.Sqrt(w.Sum(v => (double)v * v));
		var factor = (float)(length / norm);
		for (var i = 0; i < length; i++) w[i] *= factor;
		return w;
	}
}

public static class Decimation
{
	/// <summary>Cuts the part [xStart, xEnd] out of a signal that spans [xMin, xMax] and, if it has more than about <paramref name="maxSamples"/>
	/// points, reduces it to pairs of (minimum, maximum) per bucket, so that no peak gets lost. Returns the points and the x range they cover.</summary>
	public static (float[] Data, double XMin, double XMax, bool Envelope) Decimate(ReadOnlySpan<float> signal, double xMin, double xMax, double xStart, double xEnd, int maxSamples)
	{
		if (xMax <= xMin || signal.Length < 2) return ([], xMin, xMin, false);
		xStart = Math.Max(xStart, xMin);
		xEnd = Math.Min(xEnd, xMax);
		var dx = (xMax - xMin) / (signal.Length - 1);
		var start = (int)Math.Floor((xStart - xMin) / dx);
		var count = Math.Max(2, (int)Math.Ceiling((xEnd - xStart) / dx) + 1);
		count = Math.Min(count, signal.Length - start);
		var decimation = 2 * count / maxSamples;
		if (decimation <= 2) return (signal.Slice(start, count).ToArray(), xMin + start * dx, xMin + (start + count - 1) * dx, false);
		start = Math.Max(0, start - decimation / 2);
		count = Math.Min(signal.Length - start, count + decimation);
		var buckets = count / decimation;
		var result = new float[2 * buckets];
		for (var b = 0; b < buckets; b++)
		{
			var min = float.MaxValue;
			var max = float.MinValue;
			foreach (var v in signal.Slice(start + b * decimation, decimation))
			{
				if (v < min) min = v;
				if (v > max) max = v;
			}
			result[2 * b] = min;
			result[2 * b + 1] = max;
		}
		return (result, xMin + (start + (decimation - 1) / 2.0) * dx, xMin + (start + buckets * decimation - 1 - (decimation - 1) / 2.0) * dx, true);
	}
}
