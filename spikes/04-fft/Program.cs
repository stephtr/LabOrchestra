using System.Diagnostics;
using System.Numerics;
using System.Runtime.InteropServices;
using MathNet.Numerics.IntegralTransforms;
using PetterPet.FFTSSharp;

// Real-input FFT benchmark: single thread, float, speed and accuracy against a double-precision reference.
unsafe
{
	Console.WriteLine($"{RuntimeInformation.OSDescription} {RuntimeInformation.ProcessArchitecture}, {RuntimeInformation.FrameworkDescription}");
	var lib = OperatingSystem.IsWindows() ? "pffft.dll" : OperatingSystem.IsMacOS() ? "libpffft.dylib" : "libpffft.so";
	NativeLibrary.SetDllImportResolver(typeof(Pf).Assembly, (name, _, _) => name == "pffft" ? NativeLibrary.Load(Path.GetFullPath(lib)) : 0);
	Console.WriteLine($"pffft SIMD width {Pf.pffft_simd_size()}");

	var hasFfts = false;
	if (OperatingSystem.IsWindows())
	{
		try { FFTSManager.LoadAppropriateDll(FFTSManager.InstructionType.Auto); hasFfts = true; }
		catch (Exception e) { Console.WriteLine($"ffts not available: {e.Message}"); }
	}

	foreach (var n in new[] { 1024, 8192, 65536, 1048576 })
	{
		var random = new Random(1);
		var x = new float[n];
		for (var i = 0; i < n; i++) x[i] = random.NextSingle() - .5f;
		var c = new Complex[n];
		for (var i = 0; i < n; i++) c[i] = x[i];
		Fourier.Forward(c, FourierOptions.NoScaling);
		var reference = c.Take(n / 2 + 1).Select(v => v.Magnitude * v.Magnitude).ToArray();

		void Run(string name, Action transform, Func<int, double> power)
		{
			var w = Stopwatch.StartNew();
			while (w.ElapsedMilliseconds < 500) transform(); // warm-up
			var best = double.MaxValue;
			for (var r = 0; r < 5; r++)
			{
				w.Restart();
				long k = 0;
				while (w.ElapsedMilliseconds < 200) { transform(); k++; }
				best = Math.Min(best, w.Elapsed.TotalSeconds / k);
			}
			double err = 0, sum = 0;
			for (var i = 1; i < n / 2; i++)
			{
				var d = power(i) - reference[i];
				err += d * d;
				sum += reference[i] * reference[i];
			}
			Console.WriteLine($"{n,8} {name,-16} {best * 1e6,10:F2} us {n / best / 1e6,8:F0} MS/s  rel.err {Math.Sqrt(err / sum):E1}");
		}

		var setup = Pf.pffft_new_setup(n, 0);
		var input = Pf.pffft_aligned_malloc((nuint)n * 4);
		var output = Pf.pffft_aligned_malloc((nuint)n * 4);
		var work = Pf.pffft_aligned_malloc((nuint)n * 4);
		Run("pffft", () =>
		{
			x.AsSpan().CopyTo(new Span<float>((void*)input, n)); // copy included, as for managed buffers
			Pf.pffft_transform_ordered(setup, input, output, work, 0);
		}, i => { var p = (float*)output; return (double)p[2 * i] * p[2 * i] + (double)p[2 * i + 1] * p[2 * i + 1]; });

		if (hasFfts)
		{
			var f = FFTS.Real(FFTS.Forward, n);
			var o = new float[n + 2];
			Run("ffts", () => f.Execute(x, o), i => (double)o[2 * i] * o[2 * i] + (double)o[2 * i + 1] * o[2 * i + 1]);
		}

		var nw = new NWaves.Transforms.RealFft(n);
		var re = new float[n];
		var im = new float[n];
		Run("NWaves", () => nw.Direct(x, re, im), i => (double)re[i] * re[i] + (double)im[i] * im[i]);

		if (n <= 65536)
		{
			Run("Accord", () =>
			{
				for (var i = 0; i < n; i++) c[i] = x[i];
				Accord.Math.Transforms.FourierTransform2.FFT(c, Accord.Math.FourierTransform.Direction.Forward);
			}, i => c[i].Magnitude * c[i].Magnitude);
		}
	}
}

static class Pf
{
	[DllImport("pffft")] public static extern nint pffft_new_setup(int n, int transform);
	[DllImport("pffft")] public static extern nint pffft_aligned_malloc(nuint bytes);
	[DllImport("pffft")] public static extern int pffft_simd_size();
	[DllImport("pffft")] public static extern void pffft_transform_ordered(nint setup, nint input, nint output, nint work, int direction);
}
