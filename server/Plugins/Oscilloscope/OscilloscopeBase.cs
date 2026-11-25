using System.Diagnostics;
using LabOrchestra.Sdk;
using Microsoft.Extensions.Logging;

namespace LabOrchestra.Plugins.Oscilloscope;

public class OscilloscopeOptions
{
	public int ChannelCount { get; set; } = 4;
	/// <summary>Samples per channel the FFT may be behind by (power of two).</summary>
	public int RingSamples { get; set; } = 1 << 22;
	/// <summary>Samples per channel the recording may be behind by (power of two); the writer to disk must keep up.</summary>
	public int RecordingRingSamples { get; set; } = 1 << 24;
	public int MaxDisplayPoints { get; set; } = 2000;
	public bool AutoStart { get; set; } = true;
}

public sealed class ChannelState
{
	public bool ChannelActive { get; set; }
	[Unit("mV")]
	public int RangeInMillivolts { get; set; } = 1000;
	public string Coupling { get; set; } = "AC";
}

public sealed class OscilloscopeState
{
	public bool Running { get; set; }
	public string DisplayMode { get; set; } = "fft";
	/// <summary>The top of the spectrum in Hz (half the sample rate).</summary>
	[Unit("Hz")]
	public double FftFrequency { get; set; } = 1e6;
	public int FftLength { get; set; } = 8192;
	/// <summary>"pffft" (native) or "managed" (slower fallback).</summary>
	public string FftEngine { get; set; } = "";
	public string FftAveragingMode { get; set; } = "prefer-data";
	public int FftAveragingDurationMs { get; set; } = 200;
	public string FftWindowFunction { get; set; } = "blackman";
	[Unit("Hz")]
	public double TestSignalFrequency { get; set; } = 100_000;
	[Unit("Hz")]
	public double SampleRate { get; set; }
	public bool Recording { get; set; }
	public double FftsPerSecond { get; set; }
	public long Overruns { get; set; }
	public long RecordingOverruns { get; set; }
	public List<ChannelState> Channels { get; set; } = [];
}

/// <summary>What the acquisition (the hardware, or a simulation) gets to deliver samples with.</summary>
public sealed class AcquisitionSink
{
	private readonly Action<double> _begin;
	private readonly Action<int, ReadOnlySpan<float>> _write;

	internal AcquisitionSink(Action<double> begin, Action<int, ReadOnlySpan<float>> write) => (_begin, _write) = (begin, write);

	/// <summary>Tells the pipeline the time between two samples (the hardware has the last word on it). Call once, before the first Write.</summary>
	public void Begin(double sampleIntervalSeconds) => _begin(sampleIntervalSeconds);

	/// <summary>Hands over the next samples of a channel (volts). Inactive channels are ignored.</summary>
	public void Write(int channel, ReadOnlySpan<float> samples) => _write(channel, samples);
}

/// <summary>
/// The part of an oscilloscope that does not depend on the hardware: samples go into rings (native memory), a thread turns them into
/// averaged power spectra, the display stream renders spectra or time traces for each client's range, and a recording writes the
/// raw channels to .npy files. A driver only delivers samples (<see cref="AcquireAsync"/>) and programs the hardware.
/// </summary>
[Profile("oscilloscope", 1)]
public abstract class OscilloscopeBase<TOptions> : Device<TOptions, OscilloscopeState> where TOptions : OscilloscopeOptions, new()
{
	private const int TraceCapacity = 1 << 20;

	private NativeRing[] _rings = [];
	private NativeRing[] _recordingRings = [];
	private double[][] _store = [];
	private int[] _acquired = [];
	private float[][] _trace = [];
	private long[] _traceWritten = [];
	private volatile bool[] _active = [];
	private readonly object _storeLock = new();
	private readonly object _traceLock = new();
	private readonly ReaderWriterLockSlim _parameters = new();
	private IRealFft _fft = null!;
	private float[] _window = [];
	private int _n;
	private double _dt;
	private volatile bool _preferDisplay;
	private volatile int _averagingMs;
	private long _version, _ffts;
	private TaskCompletionSource _began = new();
	private CancellationTokenSource? _run;
	private Task? _acquisition, _fftTask;
	private readonly object _runLock = new();

	private volatile bool _recording;
	private NpyWriter<float>?[] _writers = [];
	private Task[] _writerTasks = [];
	private CancellationTokenSource? _writersStop;
	private DateTime _lastOverrunLog = DateTime.MinValue;

	// --- what a driver does --------------------------------------------------------------------------------------
	/// <summary>Deliver samples with <paramref name="sink"/> until cancelled. Throw if the hardware fails.</summary>
	protected abstract Task AcquireAsync(AcquisitionSink sink, CancellationToken cancel);

	protected virtual Task OpenHardwareAsync(CancellationToken cancel) => Task.CompletedTask;
	protected virtual void CloseHardware() { }
	/// <summary>Range, coupling or active flag of a channel changed: program the hardware.</summary>
	protected virtual void ApplyChannel(int channel) { }
	protected virtual void ApplyTestSignal() { }

	// --- lifecycle -----------------------------------------------------------------------------------------------
	public override async Task ConnectAsync(CancellationToken cancel)
	{
		var channels = Options.ChannelCount;
		_rings = Enumerable.Range(0, channels).Select(_ => new NativeRing(Options.RingSamples)).ToArray();
		_recordingRings = Enumerable.Range(0, channels).Select(_ => new NativeRing(Options.RecordingRingSamples)).ToArray();
		_trace = Enumerable.Range(0, channels).Select(_ => new float[TraceCapacity]).ToArray();
		_traceWritten = new long[channels];
		_acquired = new int[channels];
		_active = new bool[channels];
		Update(s =>
		{
			s.Channels = Enumerable.Range(0, channels).Select(_ => new ChannelState()).ToList();
			s.FftLength = Math.Clamp(s.FftLength, 64, 1 << 22);
		});
		await OpenHardwareAsync(cancel);
		RebuildFft(Read(s => s.FftLength), Read(s => s.FftWindowFunction));
		_preferDisplay = Read(s => s.FftAveragingMode) == "prefer-display";
		_averagingMs = Read(s => s.FftAveragingDurationMs);
		for (var c = 0; c < channels; c++) _active[c] = Read(s => s.Channels[c].ChannelActive);
		Streams.Register("display", new DisplaySource(this));
	}

	public override async Task RunAsync(CancellationToken cancel)
	{
		if (Options.AutoStart) await Start();
		var clock = Stopwatch.StartNew();
		long lastFfts = 0;
		try
		{
			while (!cancel.IsCancellationRequested)
			{
				await Task.Delay(1000, cancel);
				var ffts = Interlocked.Read(ref _ffts);
				var rate = Math.Round((ffts - lastFfts) / clock.Elapsed.TotalSeconds, 1);
				lastFfts = ffts;
				clock.Restart();
				var failed = _acquisition is { IsFaulted: true } ? _acquisition.Exception!.InnerException : null;
				if (failed is not null) throw new InvalidOperationException($"The acquisition failed: {failed.Message}", failed);
				Update(s => s.FftsPerSecond = s.Running ? rate : 0);
			}
		}
		catch (OperationCanceledException) { }
		finally { await StopInternal(); }
	}

	public override async Task CloseAsync()
	{
		await StopInternal();
		CloseHardware();
		foreach (var ring in _rings.Concat(_recordingRings)) ring.Dispose();
		_rings = _recordingRings = [];
	}

	// --- actions -------------------------------------------------------------------------------------------------
	[Action]
	public async Task Start()
	{
		lock (_runLock)
		{
			if (_run is not null) return;
			_run = new CancellationTokenSource();
			_began = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
			foreach (var ring in _rings) ring.Clear();
			ResetStore();
			var token = _run.Token;
			var sink = new AcquisitionSink(Begin, WriteSamples);
			_acquisition = Task.Run(() => AcquireAsync(sink, token), CancellationToken.None);
		}
		var ready = await Task.WhenAny(_began.Task, _acquisition!, Task.Delay(TimeSpan.FromSeconds(15)));
		if (ready != _began.Task)
		{
			await StopInternal();
			throw new InvalidOperationException(_acquisition!.IsFaulted ? $"The acquisition could not start: {_acquisition.Exception!.InnerException!.Message}" : "The acquisition did not start within 15 s");
		}
		lock (_runLock) _fftTask = Task.Run(() => FftLoop(_run!.Token), CancellationToken.None);
		Update(s => s.Running = true);
	}

	[Action]
	public Task Stop() => StopInternal();

	private async Task StopInternal()
	{
		Task?[] tasks;
		lock (_runLock)
		{
			if (_run is null) return;
			_run.Cancel();
			tasks = [_acquisition, _fftTask];
			_run = null;
		}
		foreach (var task in tasks)
			try { if (task is not null) await task; } catch (OperationCanceledException) { } catch (Exception e) { Log.LogWarning("Stopping: {Message}", e.Message); }
		Update(s => { s.Running = false; s.FftsPerSecond = 0; });
	}

	[Action]
	public void SetRange(int channel, int rangeInMillivolts)
	{
		if (rangeInMillivolts <= 0) throw new ArgumentException("The range must be positive");
		Update(s => s.Channels[CheckChannel(channel)].RangeInMillivolts = rangeInMillivolts);
		ApplyChannel(channel);
	}

	[Action]
	public void SetChannelActive(int channel, bool active)
	{
		CheckChannel(channel);
		Update(s => s.Channels[channel].ChannelActive = active);
		_active[channel] = active;
		if (active) { _rings[channel].Clear(); ResetStore(channel); }
		ApplyChannel(channel);
	}

	[Action]
	public void SetCoupling(int channel, string coupling)
	{
		if (coupling is not ("AC" or "DC")) throw new ArgumentException($"Invalid coupling '{coupling}' (AC or DC)");
		Update(s => s.Channels[CheckChannel(channel)].Coupling = coupling);
		ApplyChannel(channel);
	}

	[Action]
	public async Task SetFftFrequency(double frequency)
	{
		if (frequency <= 0) throw new ArgumentException("The frequency must be positive");
		var wasRunning = Read(s => s.Running);
		if (wasRunning) await StopInternal();
		Update(s => s.FftFrequency = frequency);
		if (wasRunning) await Start();
	}

	[Action]
	public void SetFftBinCount(int length)
	{
		if (length < 64 || length > (1 << 22) || (length & (length - 1)) != 0) throw new ArgumentException("The length must be a power of two between 64 and 4194304");
		RebuildFft(length, Read(s => s.FftWindowFunction));
		Update(s => s.FftLength = length);
	}

	[Action]
	public void SetFftWindowFunction(string windowFunction)
	{
		WindowFunction.Create(windowFunction, 8); // says what is wrong with the name
		RebuildFft(_n, windowFunction);
		Update(s => s.FftWindowFunction = windowFunction);
	}

	[Action]
	public void SetAveragingMode(string mode)
	{
		if (mode is not ("prefer-data" or "prefer-display")) throw new ArgumentException($"Invalid mode '{mode}' (prefer-data or prefer-display)");
		_parameters.EnterWriteLock();
		try { _preferDisplay = mode == "prefer-display"; ResetStore(); }
		finally { _parameters.ExitWriteLock(); }
		Update(s => s.FftAveragingMode = mode);
	}

	[Action]
	public void SetFftAveragingDuration(int durationInMilliseconds)
	{
		_averagingMs = durationInMilliseconds;
		Update(s => s.FftAveragingDurationMs = durationInMilliseconds);
	}

	[Action]
	public void SetDisplayMode(string mode)
	{
		if (mode is not ("time" or "fft")) throw new ArgumentException($"Invalid mode '{mode}' (time or fft)");
		Update(s => s.DisplayMode = mode);
		Interlocked.Increment(ref _version);
	}

	[Action]
	public void SetTestSignalFrequency(double frequency)
	{
		Update(s => s.TestSignalFrequency = frequency);
		ApplyTestSignal();
	}

	[Action]
	public void ResetFftStorage() => ResetStore();

	/// <summary>The averaged spectrum of a channel in dB between two frequencies: [frequencies, values].</summary>
	[Action]
	public float[][] GetFft(int channel, double fMin, double fMax)
	{
		CheckChannel(channel);
		if (_dt == 0) return [[], []];
		var (frequencies, values) = Spectrum(channel);
		var df = 1 / (_n * _dt);
		var from = fMin <= 0 ? 0 : Math.Clamp((int)Math.Ceiling(fMin / df), 0, values.Length - 1);
		var to = fMax <= 0 ? values.Length - 1 : Math.Clamp((int)Math.Floor(fMax / df), from, values.Length - 1);
		return [frequencies[from..(to + 1)], values[from..(to + 1)]];
	}

	/// <summary>Checks the FFT against a plain DFT of random data; returns the largest relative deviation.</summary>
	[Action]
	public double FftSelfTest(int length = 256)
	{
		var rnd = new Random(7);
		var x = new float[length];
		for (var i = 0; i < length; i++) x[i] = (float)(rnd.NextDouble() - 0.5);
		var power = new float[length / 2 + 1];
		var real = FftFactory.Create(length, Log);
		using var _ = real as IDisposable;
		x.CopyTo(real.Input);
		real.Power(power, 1);
		double worst = 0;
		for (var k = 0; k <= length / 2; k++)
		{
			double re = 0, im = 0;
			for (var t = 0; t < length; t++) { re += x[t] * Math.Cos(2 * Math.PI * k * t / length); im -= x[t] * Math.Sin(2 * Math.PI * k * t / length); }
			var expected = re * re + im * im;
			worst = Math.Max(worst, Math.Abs(power[k] - expected) / Math.Max(expected, 1e-3));
		}
		return worst;
	}

	private int CheckChannel(int channel) => channel >= 0 && channel < _active.Length ? channel : throw new ArgumentException($"There is no channel {channel} (0 to {_active.Length - 1})");

	// --- the pipeline --------------------------------------------------------------------------------------------
	private void Begin(double sampleIntervalSeconds)
	{
		_dt = sampleIntervalSeconds;
		Update(s => s.SampleRate = 1 / sampleIntervalSeconds);
		_began.TrySetResult();
	}

	private void WriteSamples(int channel, ReadOnlySpan<float> samples)
	{
		if (channel < 0 || channel >= _active.Length || !_active[channel]) return;
		if (!_rings[channel].Write(samples))
		{
			_rings[channel].RequestReset(); // the FFT lags: it drops what has piled up and goes on with the newest
			_rings[channel].Write(samples);
			Update(s => s.Overruns++);
		}
		lock (_traceLock)
		{
			var trace = _trace[channel];
			var position = (int)(_traceWritten[channel] % TraceCapacity);
			var first = Math.Min(samples.Length, TraceCapacity - position);
			samples[..first].CopyTo(trace.AsSpan(position, first));
			samples[first..].CopyTo(trace.AsSpan(0, samples.Length - first));
			_traceWritten[channel] += samples.Length;
		}
		if (_recording && !_recordingRings[channel].Write(samples))
		{
			Update(s => s.RecordingOverruns++); // data is lost: say so, loudly, but not for every block
			if (DateTime.UtcNow - _lastOverrunLog > TimeSpan.FromSeconds(5))
			{
				_lastOverrunLog = DateTime.UtcNow;
				Log.LogError("The recording cannot keep up (channel {Channel}): samples are lost", channel + 1);
			}
		}
		Interlocked.Increment(ref _version);
	}

	private void RebuildFft(int length, string window)
	{
		_parameters.EnterWriteLock();
		try
		{
			_n = length;
			(_fft as IDisposable)?.Dispose();
			_fft = FftFactory.Create(length, Log);
			_window = WindowFunction.Create(window, length);
			ResetStore();
		}
		finally { _parameters.ExitWriteLock(); }
		Update(s => s.FftEngine = _fft is PffftRealFft ? "pffft" : "managed");
	}

	private void ResetStore(int? channel = null)
	{
		lock (_storeLock)
		{
			if (_store.Length != _active.Length) _store = new double[_active.Length][];
			for (var c = 0; c < _store.Length; c++)
			{
				if (channel is not null && channel != c) continue;
				_store[c] = new double[_n / 2 + 1];
				_acquired[c] = 0;
			}
		}
		Interlocked.Increment(ref _version);
	}

	private void FftLoop(CancellationToken cancel)
	{
		var power = new float[0];
		while (!cancel.IsCancellationRequested)
		{
			var worked = false;
			_parameters.EnterReadLock();
			try
			{
				var n = _n;
				if (power.Length != n / 2 + 1) power = new float[n / 2 + 1];
				var factor = (float)(2 * _dt / n);
				for (var c = 0; c < _active.Length; c++)
				{
					if (!_active[c] || _rings[c].Available < n) continue;
					_rings[c].ReadWindowed(_fft.Input, _window);
					_fft.Power(power, factor);
					var weight = 1.0 / (_acquired[c] + 1);
					if (_averagingMs == 0) weight = 1;
					else if (_averagingMs > 0) weight = Math.Max(weight, 1 - Math.Exp(-_dt * n / (_averagingMs / 1000.0)));
					lock (_storeLock)
					{
						var store = _store[c];
						for (var k = 0; k < power.Length; k++)
						{
							var v = _preferDisplay ? 10 * Math.Log10(Math.Max(power[k], 1e-30)) : power[k];
							store[k] = store[k] * (1 - weight) + v * weight;
						}
						_acquired[c]++;
					}
					worked = true;
				}
			}
			finally { _parameters.ExitReadLock(); }
			if (worked) { Interlocked.Increment(ref _version); Interlocked.Increment(ref _ffts); }
			else Thread.Sleep(1);
		}
	}

	/// <summary>The stored spectrum of a channel in dB with its frequency axis.</summary>
	private (float[] Frequencies, float[] Values) Spectrum(int channel)
	{
		double[] copy;
		int n;
		lock (_storeLock) { n = _n; copy = (double[])_store[channel].Clone(); }
		var df = 1 / (n * _dt);
		var f = new float[copy.Length];
		var v = new float[copy.Length];
		for (var k = 0; k < copy.Length; k++)
		{
			f[k] = (float)(k * df);
			v[k] = (float)(_preferDisplay ? copy[k] : 10 * Math.Log10(Math.Max(copy[k], 1e-30)));
		}
		return (f, v);
	}

	// --- the display stream --------------------------------------------------------------------------------------
	private sealed class DisplaySource(OscilloscopeBase<TOptions> owner) : IStreamSource
	{
		public long LatestSequence => Interlocked.Read(ref owner._version);
		public StreamFrame? Render(IReadOnlyDictionary<string, object?> parameters, long afterSequence) => owner.RenderDisplay(parameters, afterSequence);
	}

	private static double Number(IReadOnlyDictionary<string, object?> p, string key, double fallback) => p.TryGetValue(key, out var v) && v is not null ? Convert.ToDouble(v) : fallback;

	private StreamFrame? RenderDisplay(IReadOnlyDictionary<string, object?> parameters, long after)
	{
		var version = Interlocked.Read(ref _version);
		if (version <= after || _dt == 0) return null;
		var mode = parameters.TryGetValue("mode", out var m) && m is string given ? given : Read(s => s.DisplayMode);
		var maxPoints = (int)Number(parameters, "max_points", Options.MaxDisplayPoints);
		var channels = Enumerable.Range(0, _active.Length).Where(c => _active[c]).ToList();
		var columns = new List<float[]>();
		double xMin, xMax, from = double.NegativeInfinity, to = double.PositiveInfinity;
		double decimatedMin = 0, decimatedMax = 0;
		var envelope = false;
		if (mode == "fft")
		{
			(xMin, xMax) = (0, 1 / (2 * _dt));
			(from, to) = (Number(parameters, "x_min", xMin), Number(parameters, "x_max", xMax));
			foreach (var c in channels.ToList())
			{
				if (_acquired[c] == 0) { channels.Remove(c); continue; }
				var (_, values) = Spectrum(c);
				var (data, lo, hi, env) = Decimation.Decimate(values, xMin, xMax, from, to, maxPoints);
				columns.Add(data);
				(decimatedMin, decimatedMax, envelope) = (lo, hi, env);
			}
		}
		else
		{
			var length = Read(s => s.FftLength);
			(xMin, xMax) = (0, (length - 1) * _dt);
			(from, to) = (Number(parameters, "x_min", xMin), Number(parameters, "x_max", xMax));
			foreach (var c in channels.ToList())
			{
				float[] signal;
				lock (_traceLock)
				{
					var count = (int)Math.Min(_traceWritten[c], length);
					if (count < 2) { channels.Remove(c); continue; }
					signal = new float[length];
					var start = _traceWritten[c] - count;
					for (var i = 0; i < count; i++) signal[length - count + i] = _trace[c][(start + i) % TraceCapacity];
				}
				var (data, lo, hi, env) = Decimation.Decimate(signal, xMin, xMax, from, to, maxPoints);
				columns.Add(data);
				(decimatedMin, decimatedMax, envelope) = (lo, hi, env);
			}
		}
		if (columns.Count == 0) return null;
		var bytes = new byte[columns.Sum(c => c.Length) * sizeof(float)];
		var offset = 0;
		foreach (var column in columns)
		{
			Buffer.BlockCopy(column, 0, bytes, offset, column.Length * sizeof(float));
			offset += column.Length * sizeof(float);
		}
		return new StreamFrame(version, new()
		{
			["mode"] = mode, ["x_min"] = xMin, ["x_max"] = xMax, ["x_min_decimated"] = decimatedMin, ["x_max_decimated"] = decimatedMax,
			["length"] = columns[0].Length, ["channels"] = channels.Cast<object?>().ToList(), ["envelope"] = envelope,
			["sample_rate"] = 1 / _dt, ["fft_length"] = _n, ["running"] = Read(s => s.Running),
		}, bytes);
	}

	// --- recording -----------------------------------------------------------------------------------------------
	public override Task OnRecordingStartAsync(IRecordingSession session)
	{
		var channels = _active.Select((a, c) => (a, c)).Where(t => t.a).Select(t => t.c).ToList();
		_writers = new NpyWriter<float>?[_active.Length];
		_writerTasks = [];
		_writersStop = new CancellationTokenSource();
		foreach (var c in channels)
		{
			_writers[c] = new NpyWriter<float>(session.CreateFile($"{Id}_C{c + 1}.npy"));
			_recordingRings[c].Clear();
		}
		_recording = true;
		var stop = _writersStop.Token;
		_writerTasks = channels.Select(c => Task.Factory.StartNew(() => WriterLoop(c, stop), TaskCreationOptions.LongRunning)).ToArray();
		Update(s => s.Recording = true);
		return Task.CompletedTask;
	}

	private void WriterLoop(int channel, CancellationToken stop)
	{
		var ring = _recordingRings[channel];
		var block = new float[1 << 20];
		var writer = _writers[channel]!;
		while (true)
		{
			var stopping = stop.IsCancellationRequested;
			var available = ring.Available;
			if (available < 300_000 && !stopping) { Thread.Sleep(1); continue; } // large writes: the disk likes them
			if (available == 0) break;
			var count = ring.Read(block);
			writer.Write(block.AsSpan(0, count));
		}
	}

	public override async Task OnRecordingStopAsync(IRecordingSession session)
	{
		_recording = false;
		_writersStop?.Cancel();
		await Task.WhenAll(_writerTasks);
		// each channel has its own writer thread, which stop at slightly different samples: all channels get the length of the shortest
		var common = _writers.Where(w => w is not null).Select(w => w!.Count).DefaultIfEmpty(0).Min();
		var lengths = new List<long>();
		for (var c = 0; c < _writers.Length; c++)
		{
			if (_writers[c] is not { } writer) continue;
			lengths.Add(writer.Count);
			writer.TrimTo(common);
			writer.Dispose();
			_writers[c] = null;
			if (_acquired[c] == 0) continue;
			using var spectrum = new NpyWriter<float>(session.CreateFile($"{Id}_F{c + 1}.npy")); // the averaged spectrum at the end, in dB
			spectrum.Write(Spectrum(c).Values);
		}
		if (lengths.Distinct().Count() > 1) Log.LogDebug("The channel writers ended at different samples ({Lengths}); all were cut to {Common}", string.Join(", ", lengths), common);
		using (var axis = new NpyWriter<float>(session.CreateFile($"{Id}_f.npy"))) axis.Write(Spectrum(0).Frequencies); // frequencies of the spectra
		Update(s => s.Recording = false);
	}
}
