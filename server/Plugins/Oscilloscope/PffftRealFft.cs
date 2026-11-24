using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;

namespace LabOrchestra.Plugins.Oscilloscope;

/// <summary>pffft (SIMD, single precision) through P/Invoke. Buffers are aligned native memory; the input is filled in place.</summary>
public sealed unsafe class PffftRealFft : IRealFft, IDisposable
{
	[DllImport("pffft")] private static extern nint pffft_new_setup(int n, int transform);
	[DllImport("pffft")] private static extern void pffft_destroy_setup(nint setup);
	[DllImport("pffft")] private static extern nint pffft_aligned_malloc(nuint bytes);
	[DllImport("pffft")] private static extern void pffft_aligned_free(nint pointer);
	[DllImport("pffft")] private static extern void pffft_transform_ordered(nint setup, nint input, nint output, nint work, int direction);

	private static int _resolverInstalled;
	private readonly nint _setup, _input, _output, _work;
	private readonly int _n;

	public PffftRealFft(int n)
	{
		InstallResolver();
		_n = n;
		_setup = pffft_new_setup(n, 0);
		if (_setup == 0) throw new ArgumentException($"pffft does not support the FFT length {n}");
		_input = pffft_aligned_malloc((nuint)n * sizeof(float));
		_output = pffft_aligned_malloc((nuint)n * sizeof(float));
		_work = pffft_aligned_malloc((nuint)n * sizeof(float));
	}

	public int Size => _n;
	public Span<float> Input => new((void*)_input, _n);

	public void Power(Span<float> power, float scale)
	{
		pffft_transform_ordered(_setup, _input, _output, _work, 0);
		var o = (float*)_output;
		power[0] = o[0] * o[0] * scale; // ordered format: DC and Nyquist share the first pair
		power[_n / 2] = o[1] * o[1] * scale;
		for (var k = 1; k < _n / 2; k++) power[k] = (o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1]) * scale;
	}

	public void Dispose()
	{
		pffft_destroy_setup(_setup);
		pffft_aligned_free(_input);
		pffft_aligned_free(_output);
		pffft_aligned_free(_work);
	}

	private static void InstallResolver()
	{
		if (Interlocked.Exchange(ref _resolverInstalled, 1) == 1) return;
		var assembly = typeof(PffftRealFft).Assembly;
		var folder = Path.GetDirectoryName(assembly.Location) ?? AppContext.BaseDirectory;
		NativeLibrary.SetDllImportResolver(assembly, (name, _, _) =>
		{
			if (name != "pffft") return 0;
			var file = OperatingSystem.IsWindows() ? "pffft.dll" : OperatingSystem.IsMacOS() ? "libpffft.dylib" : "libpffft.so";
			var path = Path.Combine(folder, file);
			return File.Exists(path) && NativeLibrary.TryLoad(path, out var handle) ? handle : 0;
		});
	}
}

public static class FftFactory
{
	private static int _reported;

	/// <summary>pffft where it is available (built next to the plugin), otherwise the managed FFT (about 30 times slower).</summary>
	public static IRealFft Create(int n, ILogger? log = null)
	{
		if (n >= 32 && Environment.GetEnvironmentVariable("LABORCHESTRA_MANAGED_FFT") is null)
		{
			try { return new PffftRealFft(n); }
			catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException or ArgumentException)
			{
				if (Interlocked.Exchange(ref _reported, 1) == 0) log?.LogWarning("pffft is not available ({Message}); using the slower managed FFT", e.Message);
			}
		}
		return new ManagedRealFft(n);
	}
}
