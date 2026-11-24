using LabOrchestra.Sdk;
using Microsoft.Extensions.Logging;

namespace LabOrchestra.Plugins.Demo;

/// <summary>A small C# device that shows the whole contract: options, state, actions (also slow and failing ones), a run loop.</summary>
[Driver("demo_counter", Description = "A counter that also ticks by itself (a demonstration of C# devices).")]
public sealed class DemoCounter : Device<DemoCounter.Settings, DemoCounter.Data>
{
	public sealed class Settings
	{
		public int Step { get; set; } = 1;
		public double TickSeconds { get; set; } = 0.2;
		public bool FailOnStart { get; set; }
	}

	public sealed class Data
	{
		public int Count { get; set; }
		public int Ticks { get; set; }
		public List<Channel> Channels { get; set; } = [new() { Value = 1.5 }, new()];
	}

	public sealed class Channel
	{
		public double Value { get; set; }
		public string Status { get; set; } = "ok";
	}

	public override Task ConnectAsync(CancellationToken cancel)
	{
		if (Options.FailOnStart) throw new InvalidOperationException("told to fail on start");
		Log.LogInformation("Demo counter ready (step {Step})", Options.Step);
		return Task.CompletedTask;
	}

	public override async Task RunAsync(CancellationToken cancel)
	{
		try
		{
			while (!cancel.IsCancellationRequested)
			{
				await Task.Delay(TimeSpan.FromSeconds(Options.TickSeconds), cancel);
				Update(s => s.Ticks++);
			}
		}
		catch (OperationCanceledException) { }
	}

	[Action]
	public void Increment() => Update(s => s.Count += Options.Step);

	[Action]
	public void SetChannel(int channel, double value)
	{
		if (channel < 0 || channel >= Read(s => s.Channels.Count)) throw new ArgumentException($"There is no channel {channel}");
		Update(s => s.Channels[channel].Value = value);
	}

	[Action]
	public async Task<double> Wait(double seconds, CancellationToken cancel)
	{
		await Task.Delay(TimeSpan.FromSeconds(seconds), cancel);
		Update(s => s.Count++);
		return seconds;
	}

	[Action]
	public void Fail(string message = "failed on purpose")
	{
		Update(s => s.Count += 100); // changed before failing: must be visible
		throw new InvalidOperationException(message);
	}
}
