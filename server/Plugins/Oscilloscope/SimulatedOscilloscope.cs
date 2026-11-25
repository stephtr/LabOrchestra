using System.Diagnostics;
using LabOrchestra.Sdk;

namespace LabOrchestra.Plugins.Oscilloscope;

/// <summary>An oscilloscope without hardware: channel n shows a tone at (n+1) times the frequency of its signal generator (while that is
/// on) plus noise, delivered in real time at the sample rate that the FFT frequency asks for. For trying out dashboards and for testing
/// the pipeline. It is an oscilloscope and a frequency generator at once, like the PicoScopes that have a generator.</summary>
[Driver("simulated_oscilloscope", Description = "An oscilloscope without hardware: tones and noise in real time.", Widget = "oscilloscope")]
[Profile("frequency_generator", 1, At = nameof(OscilloscopeState.Generator))]
public sealed class SimulatedOscilloscope : OscilloscopeBase<SimulatedOscilloscope.Settings>
{
	public sealed class Settings : OscilloscopeOptions
	{
		/// <summary>Noise as a fraction of the range of the channel.</summary>
		public double Noise { get; set; } = 0.001;
		/// <summary>How many channels (counted from the first) are on when the device starts.</summary>
		public int ActiveChannels { get; set; } = 2;
	}

	[Action]
	public void SetFrequency(int channel, double frequency) => SetGenerator(channel, frequency: frequency);

	[Action]
	public void SetPower(int channel, double power) => SetGenerator(channel, power: power);

	[Action]
	public void SetOn(int channel, bool isOn) => SetGenerator(channel, isOn: isOn);

	protected override Task OpenHardwareAsync(CancellationToken cancel)
	{
		EnableGenerator(frequency: 100_000, power: 0, isOn: true);
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
			var (tone, volume, settings) = Read(s => (s.Generator!.Channels[0].IsOn ? s.Generator.Channels[0].Frequency : 0, Math.Pow(10, s.Generator.Channels[0].Power / 20), s.Channels.Select(c => (c.ChannelActive, Volts: c.RangeInMillivolts / 1000.0)).ToArray()));
			for (var c = 0; c < channels; c++)
			{
				if (!settings[c].ChannelActive) continue;
				var frequency = Math.Min(tone * (c + 1), rate / 4);
				var amplitude = tone > 0 ? 0.4 * settings[c].Volts * volume : 0; // 0 dBm: 40 % of the range; the power is relative here
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
