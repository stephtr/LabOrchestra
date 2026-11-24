using System.Runtime.InteropServices;

namespace LabOrchestra.Plugins.Picoscope;

/// <summary>The few calls of a PicoSDK driver library that streaming needs. The 4000a and 5000a wrappers have the same shape under
/// different names and enums; one adapter each hides that, so the acquisition is written once.</summary>
internal interface IPicoApi
{
	string LibraryName { get; }
	int ChannelCount { get; }
	/// <summary>Opens the first unit found at 14 bit; returns the status and the handle.</summary>
	uint Open(out short handle);
	uint ChangePowerSource(short handle, uint status);
	uint SetChannel(short handle, int channel, bool enabled, bool dc, int rangeInMillivolts);
	uint MaximumValue(short handle, out short value);
	uint SetDataBuffer(short handle, int channel, short[] buffer);
	uint DisableTrigger(short handle);
	/// <summary>Starts streaming with the given sample interval in ns (the driver may change it).</summary>
	uint RunStreaming(short handle, ref uint sampleIntervalNanoseconds, uint bufferLength);
	uint GetLatestValues(short handle, StreamingReady callback);
	uint Stop(short handle);
	uint Close(short handle);
	/// <summary>A sine of the given frequency on the signal generator output; null when the unit has none.</summary>
	uint? SetTestSignal(short handle, double frequency);
}

internal delegate void StreamingReady(int sampleCount, uint startIndex, bool autoStop);

internal static class PicoRanges
{
	public static readonly int[] Millivolts = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];

	public static int Index(int millivolts, int highest)
	{
		var index = Array.IndexOf(Millivolts, millivolts);
		if (index < 0 || index > highest) throw new ArgumentException($"The range {millivolts} mV does not exist; use one of {string.Join(", ", Millivolts.Take(highest + 1))}");
		return index;
	}
}

/// <summary>Finds the PicoSDK driver libraries, which are installed by the user (they are not shipped with LabOrchestra).</summary>
internal static class PicoLibrary
{
	private static int _installed;

	public const string Download = "https://www.picotech.com/downloads";

	public static void Install()
	{
		if (Interlocked.Exchange(ref _installed, 1) == 1) return;
		NativeLibrary.SetDllImportResolver(typeof(PicoLibrary).Assembly, (name, _, _) => Find(name));
	}

	private static nint Find(string name)
	{
		foreach (var path in Candidates(name))
			if (File.Exists(path) && NativeLibrary.TryLoad(path, out var handle)) return handle;
		return 0; // the default search (PATH, system folders) follows
	}

	private static IEnumerable<string> Candidates(string name)
	{
		var stem = Path.GetFileNameWithoutExtension(name);
		if (stem.StartsWith("lib")) stem = stem[3..];
		var folders = new List<string>();
		if (OperatingSystem.IsWindows())
		{
			foreach (var root in new[] { Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramFiles(x86)") }.Where(r => r is not null))
			{
				folders.Add(Path.Combine(root!, "Pico Technology", "SDK", "lib"));
				if (Directory.Exists(Path.Combine(root!, "Pico Technology")))
					folders.AddRange(Directory.GetDirectories(Path.Combine(root!, "Pico Technology"), "PicoScope*"));
			}
			yield return Path.Combine(AppContext.BaseDirectory, stem + ".dll");
			foreach (var folder in folders) yield return Path.Combine(folder, stem + ".dll");
		}
		else if (OperatingSystem.IsMacOS())
		{
			foreach (var folder in new[] { "/Applications/PicoScope 7 T&M.app/Contents/Resources/lib", "/Applications/PicoScope 6.app/Contents/Resources/lib", "/Library/Application Support/PicoScope/lib", "/usr/local/lib", "/opt/homebrew/lib" })
				yield return Path.Combine(folder, "lib" + stem + ".dylib");
		}
		else
		{
			foreach (var folder in new[] { "/opt/picoscope/lib", "/usr/local/lib", "/usr/lib", "/usr/lib/x86_64-linux-gnu" })
				yield return Path.Combine(folder, "lib" + stem + ".so");
		}
	}

	/// <summary>A missing library is a normal state of a PC that has no Picoscope: say what to install.</summary>
	public static Exception Missing(string library, Exception inner) => new InvalidOperationException(
		$"The PicoSDK driver library '{library}' was not found. Install the PicoSDK (or PicoScope 7) from {Download} and restart the device. LabOrchestra does not ship the library.", inner);
}
