using LabOrchestra.Sdk;

namespace LabOrchestra.Plugins.Demo;

/// <summary>Produces numbered frames fast (to test that slow clients are not flooded and that every client can ask for its own view).</summary>
[Driver("demo_stream", Description = "Produces frames at a configurable rate (a demonstration of streams).")]
public sealed class DemoStream : Device<DemoStream.Settings, DemoStream.Data>
{
	public sealed class Settings
	{
		public double FramesPerSecond { get; set; } = 200;
		public int Size { get; set; } = 8;
	}

	public sealed class Data
	{
		public long Produced { get; set; }
	}

	private sealed class Source(DemoStream owner) : IStreamSource
	{
		public long LatestSequence => Interlocked.Read(ref owner._sequence);

		public StreamFrame? Render(IReadOnlyDictionary<string, object?> parameters, long afterSequence)
		{
			var sequence = LatestSequence;
			if (sequence <= afterSequence || sequence == 0) return null;
			var scale = parameters.TryGetValue("scale", out var s) && s is not null ? Convert.ToSingle(s) : 1f;
			var values = new float[owner.Options.Size];
			values[0] = sequence;
			for (var i = 1; i < values.Length; i++) values[i] = scale * i;
			var data = new byte[values.Length * sizeof(float)];
			Buffer.BlockCopy(values, 0, data, 0, data.Length);
			return new StreamFrame(sequence, new() { ["size"] = values.Length, ["scale"] = scale }, data);
		}
	}

	private long _sequence;

	public override Task ConnectAsync(CancellationToken cancel)
	{
		Streams.Register("frames", new Source(this));
		return Task.CompletedTask;
	}

	public override async Task RunAsync(CancellationToken cancel)
	{
		var period = TimeSpan.FromSeconds(1 / Options.FramesPerSecond);
		var clock = System.Diagnostics.Stopwatch.StartNew();
		try
		{
			while (!cancel.IsCancellationRequested)
			{
				await Task.Delay(period, cancel);
				// numbered by the clock, not by the ticks: timers are coarse on some systems (15 ms on Windows), the rate stays exact
				var number = (long)(clock.Elapsed.TotalSeconds * Options.FramesPerSecond);
				Interlocked.Exchange(ref _sequence, number);
				Update(s => s.Produced = number);
			}
		}
		catch (OperationCanceledException) { }
	}
}
