using System.Diagnostics;
using LabOrchestra.Sdk;

namespace LabOrchestra.Plugins.Oscilloscope;

/// <summary>An oscilloscope without hardware: channel n shows a tone at (n+1) times the test signal frequency plus noise, delivered in
/// real time at the sample rate that the FFT frequency asks for. For trying out dashboards and for testing the pipeline.</summary>
[Driver("simulated_oscilloscope", Description = "An oscilloscope without hardware: tones and noise in real time. State says simulated.")]
public sealed class SimulatedOscilloscope : OscilloscopeBase<SimulatedOscilloscope.Settings>
{
	public sealed class Settings : OscilloscopeOptions
	{
		/// <summary>Noise as a fraction of the range of the channel.</summary>
		public double Noise { get; set; } = 0.001;
		/// <summary>How many channels (counted from the first) are on when the device starts.</summary>
		public int ActiveChannels { get; set; } = 2;
	}

	protected override Task OpenHardwareAsync(CancellationToken cancel)
	{
		Update(s =>
		{
			for (var c = 0; c < Math.Min(Options.ActiveChannels, s.Channels.Count); c++) s.Channels[c].ChannelActive = true;
		});
		return Task.CompletedTask;
	}

	protected override async Task AcquireAsync(AcquisitionSink sink, CancellationToken cancel)
	{
		var (rate, channels) = Read(s => (2 * s.FftFrequency, s.Channels.Count));
		sink.Begin(1 / rate);
		var block = Math.Clamp((int)(rate / 200), 256, 16384); // about 5 ms
		var samples = new float[block];
		var random = new Random(1);
		var clock = Stopwatch.StartNew();
		long position = 0;
		while (!cancel.IsCancellationRequested)
		{
			var (tone, settings) = Read(s => (s.TestSignalFrequency, s.Channels.Select(c => (c.ChannelActive, Volts: c.RangeInMillivolts / 1000.0)).ToArray()));
			for (var c = 0; c < channels; c++)
			{
				if (!settings[c].ChannelActive) continue;
				var frequency = Math.Min(tone * (c + 1), rate / 4);
				var amplitude = 0.4 * settings[c].Volts;
				var noise = Options.Noise * settings[c].Volts;
				for (var i = 0; i < block; i++)
				{
					var gauss = Math.Sqrt(-2 * Math.Log(1 - random.NextDouble())) * Math.Cos(2 * Math.PI * random.NextDouble());
					samples[i] = (float)(amplitude * Math.Sin(2 * Math.PI * frequency * (position + i) / rate) + noise * gauss);
				}
				sink.Write(c, samples);
			}
			position += block;
			var early = position / rate - clock.Elapsed.TotalSeconds; // real time: not faster than the sample rate
			if (early > 0.001) await Task.Delay(TimeSpan.FromSeconds(early), cancel);
		}
	}
}
