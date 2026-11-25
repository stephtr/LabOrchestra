using LabOrchestra.Plugins.Oscilloscope;
using LabOrchestra.Sdk;
using Microsoft.Extensions.Logging;

namespace LabOrchestra.Plugins.Picoscope;

public class PicoscopeOptions : OscilloscopeOptions { }

/// <summary>Streaming acquisition for the PicoScope 4000a and 5000a series: the unit streams 16 bit values into pinned buffers, a
/// polling loop converts the new ones to volts and hands them to the pipeline of <see cref="OscilloscopeBase{TOptions}"/>.</summary>
public abstract class PicoscopeBase : OscilloscopeBase<PicoscopeOptions>
{
	private const uint BufferLength = 65536 * 10;
	private const uint PicoOk = 0, PicoBusy = 0x27, PicoNotResponding = 7, PowerSupplyNotConnected = 0x11A, Usb3OnNonUsb3Port = 0x11E;

	internal abstract IPicoApi Api { get; }

	private readonly object _device = new();
	private short _handle;
	private bool _open;

	protected override Task OpenHardwareAsync(CancellationToken cancel)
	{
		PicoLibrary.Install();
		try
		{
			lock (_device)
			{
				var status = Api.Open(out _handle);
				if (status is PowerSupplyNotConnected or Usb3OnNonUsb3Port) status = Api.ChangePowerSource(_handle, status);
				if (status != PicoOk) throw new InvalidOperationException(Describe("open the unit", status));
				_open = true;
			}
		}
		catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
		{
			throw PicoLibrary.Missing(Api.LibraryName, e);
		}
		for (var c = 0; c < Options.ChannelCount; c++) ApplyChannel(c);
		if (Api.HasSignalGenerator) EnableGenerator(frequency: 100_000, power: Math.Round(ToDbm(0.8), 2), isOn: false); // off until asked: never output a signal unasked
		return Task.CompletedTask;
	}

	protected override void CloseHardware()
	{
		lock (_device)
		{
			if (!_open) return;
			_open = false;
			Api.Stop(_handle);
			Api.Close(_handle);
		}
	}

	protected override void ApplyChannel(int channel)
	{
		var (active, range, coupling) = Read(s => (s.Channels[channel].ChannelActive, s.Channels[channel].RangeInMillivolts, s.Channels[channel].Coupling));
		var wasRunning = Read(s => s.Running);
		lock (_device)
		{
			if (!_open) return;
			// Changing a channel needs the stream to be stopped; the running acquisition notices (and restarts, see AcquireAsync).
			var status = Api.SetChannel(_handle, channel, active, coupling == "DC", range);
			if (status != PicoOk) throw new InvalidOperationException(Describe($"set channel {channel}", status));
		}
		if (wasRunning) _ = RestartAsync();
	}

	private int _restarting;
	private async Task RestartAsync()
	{
		if (Interlocked.Exchange(ref _restarting, 1) == 1) return;
		try { await Stop(); await Start(); }
		catch (Exception e) { Log.LogError(e, "The acquisition could not be restarted after a channel changed"); }
		finally { Interlocked.Exchange(ref _restarting, 0); }
	}

	// The generator's power is given as dBm of a sine into 50 ohm (what the frequency_generator profile says); the unit takes peak-to-peak volts.
	private const double MaxPeakToPeakVolts = 4.0, MaxGeneratorHz = 20e6;
	private static double PeakToPeakVolts(double dBm) => 2 * Math.Sqrt(2) * Math.Sqrt(50 * 1e-3 * Math.Pow(10, dBm / 10));
	private static double ToDbm(double peakToPeakVolts) => 10 * Math.Log10(Math.Pow(peakToPeakVolts / (2 * Math.Sqrt(2)), 2) / 50 / 1e-3);

	protected override void ValidateGenerator(double? frequency, double? power)
	{
		if (frequency > MaxGeneratorHz) throw new ArgumentException($"The signal generator goes up to {MaxGeneratorHz / 1e6:0} MHz");
		if (power is { } p && PeakToPeakVolts(p) > MaxPeakToPeakVolts + 1e-9) throw new ArgumentException($"The signal generator gives at most {MaxPeakToPeakVolts} V peak to peak ({ToDbm(MaxPeakToPeakVolts):0.0} dBm into 50 ohm)");
	}

	protected override void ApplyGenerator()
	{
		var (frequency, power, isOn) = Read(s => (s.Generator!.Channels[0].Frequency, s.Generator.Channels[0].Power, s.Generator.Channels[0].IsOn));
		lock (_device)
		{
			if (!_open) return;
			var microvolts = isOn ? (uint)Math.Round(PeakToPeakVolts(power) * 1e6) : 0u;
			var status = Api.SetSignal(_handle, frequency, microvolts);
			if (status != PicoOk) throw new InvalidOperationException(Describe("set the signal generator", status));
		}
	}

	protected override Task AcquireAsync(AcquisitionSink sink, CancellationToken cancel) => Task.Factory.StartNew(() => Acquire(sink, cancel), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

	private void Acquire(AcquisitionSink sink, CancellationToken cancel)
	{
		var channels = Options.ChannelCount;
		var buffers = Enumerable.Range(0, channels).Select(_ => GC.AllocateArray<short>((int)BufferLength, pinned: true)).ToArray();
		var volts = new float[BufferLength];
		var (fftFrequency, active, ranges) = Read(s => (s.FftFrequency, s.Channels.Select(c => c.ChannelActive).ToArray(), s.Channels.Select(c => c.RangeInMillivolts).ToArray()));
		var interval = (uint)Math.Max(1, 1e9 / 2 / fftFrequency);
		short maxValue;
		lock (_device)
		{
			Check(Api.MaximumValue(_handle, out maxValue), "read the converter range");
			for (var c = 0; c < channels; c++)
				if (active[c]) Check(Api.SetDataBuffer(_handle, c, buffers[c]), $"set the buffer of channel {c}");
			Check(Api.DisableTrigger(_handle), "disable the trigger");
			Check(Api.RunStreaming(_handle, ref interval, BufferLength), "start streaming");
		}
		sink.Begin(interval * 1e-9);

		void Ready(int count, uint start, bool autoStop)
		{
			if (count <= 0) return;
			for (var c = 0; c < channels; c++)
			{
				if (!active[c]) continue;
				var factor = ranges[c] / (maxValue * 1000f);
				var source = buffers[c].AsSpan((int)start, count);
				for (var i = 0; i < source.Length; i++) volts[i] = source[i] * factor;
				sink.Write(c, volts.AsSpan(0, count));
			}
		}

		var lastRestart = DateTime.MinValue;
		while (!cancel.IsCancellationRequested)
		{
			lock (_device)
			{
				for (var i = 0; i < 1000 && !cancel.IsCancellationRequested; i++)
				{
					var status = Api.GetLatestValues(_handle, Ready);
					if (status is PicoOk or PicoBusy) { }
					else if (status == PicoNotResponding)
					{
						Log.LogWarning("The unit does not respond; restarting the acquisition");
						Api.Stop(_handle);
						if (DateTime.UtcNow - lastRestart < TimeSpan.FromSeconds(10)) throw new InvalidOperationException("The unit stopped responding again within 10 s of restarting the acquisition");
						lastRestart = DateTime.UtcNow;
						Check(Api.RunStreaming(_handle, ref interval, BufferLength), "restart streaming");
					}
					else throw new InvalidOperationException(Describe("read the stream", status));
					Thread.Sleep(0);
				}
			}
			Thread.Yield(); // lets a SetChannel or Stop get the device lock between two bursts
		}
		lock (_device) if (_open) Api.Stop(_handle);
	}

	private void Check(uint status, string what) { if (status != PicoOk) throw new InvalidOperationException(Describe(what, status)); }

	private static string Describe(string what, uint status) => $"Could not {what} (PicoSDK status 0x{status:X}). " + status switch
	{
		3 => "No Picoscope was found; check the USB cable and that no other program (PicoScope software) uses it.",
		PowerSupplyNotConnected => "The power supply is not connected.",
		Usb3OnNonUsb3Port => "The unit needs a USB 3.0 port.",
		_ => "See PicoStatus.h of the PicoSDK for the code.",
	};
}

[Driver("picoscope_5000a", Description = "PicoScope 5000a series (needs the PicoSDK installed).", Widget = "oscilloscope")]
[Profile("frequency_generator", 1, At = nameof(OscilloscopeState.Generator))]
public sealed class Picoscope5000a : PicoscopeBase
{
	internal override IPicoApi Api { get; } = new Api5000a();

	[Action]
	public void SetFrequency(int channel, double frequency) => SetGenerator(channel, frequency: frequency);

	[Action]
	public void SetPower(int channel, double power) => SetGenerator(channel, power: power);

	[Action]
	public void SetOn(int channel, bool isOn) => SetGenerator(channel, isOn: isOn);
}

[Driver("picoscope_4000a", Description = "PicoScope 4000a series (needs the PicoSDK installed).", Widget = "oscilloscope")]
public sealed class Picoscope4000a : PicoscopeBase
{
	internal override IPicoApi Api { get; } = new Api4000a();
}
