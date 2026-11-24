using System.Collections.Concurrent;
using System.Diagnostics;
using LabOrchestra.Sdk;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace LabOrchestra.Server.Streaming;

/// <summary>
/// Sends the streams of devices to the clients that subscribed. One loop per subscription: it waits for a free slot (the client has
/// acknowledged earlier frames), asks the device for the newest frame in the shape this client asked for, sends it, and keeps to the
/// frame rate cap. What the client cannot take is simply not rendered: nothing queues up, and a slow client costs the others nothing.
/// <para>Two separate things are limited. <b>On their way</b>: frames the client has not yet confirmed to have received; that number
/// follows the round trip time (about 2 x frame rate x RTT + 1, at most 64), so that a client far away gets the full frame rate and the
/// sender never waits on a healthy link. <b>Waiting at the client</b>: frames received but not yet processed (rendered); at most 2, so that
/// a busy client falls behind by two frames, not by seconds. The client says <c>received</c> when a frame arrives and <c>ack</c> when it
/// is done with it (a simple client may only ack; that counts as both). Both are cumulative.</para>
/// </summary>
public sealed class StreamManager(DeviceRegistry registry, IHubContext<StreamHub> hub, ILogger<StreamManager> log)
{
	public const int MaxPerConnection = 32;
	public const int MaxWindow = 64;
	public const int MaxWaitingAtClient = 2;
	private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, Subscription>> _byConnection = new();

	public sealed class Subscription
	{
		public required string Id { get; init; }
		public required string Connection { get; init; }
		public required string Device { get; init; }
		public required string Stream { get; init; }
		/// <summary>The least number of frames in flight the client asked for; the window grows with the round trip time.</summary>
		public required int MinWindow { get; init; }
		public required double MaxFps { get; init; }
		public volatile int Window;
		public required CancellationTokenSource Cancel { get; init; }
		public volatile IReadOnlyDictionary<string, object?> Parameters = new Dictionary<string, object?>();
		public volatile bool Force; // the parameters changed: render again even if the data is the same
		public long Sent, Acked, Skipped, LastSequence = -1;
		public double RttMs;
		public readonly ConcurrentQueue<(long Sequence, long At)> InFlight = new(); // sent, not yet confirmed as received
		public readonly ConcurrentQueue<long> Waiting = new(); // received, not yet processed
	}

	public string Subscribe(string connection, string deviceId, string stream, IReadOnlyDictionary<string, object?> parameters, int window, double maxFps)
	{
		var entry = registry.Get(deviceId) ?? throw new HubException(Errors.Json("LookupError", $"Device '{deviceId}' does not exist"));
		var source = entry.Streams?.Find(stream) ?? throw new HubException(Errors.Json("LookupError",
			$"Device '{deviceId}' has no stream '{stream}'" + (entry.Streams is { } s && s.Names().Count > 0 ? $" (streams: {string.Join(", ", s.Names())})" : " (it offers no streams)")));
		var mine = _byConnection.GetOrAdd(connection, _ => new());
		if (mine.Count >= MaxPerConnection) throw new HubException(Errors.Json("ValueError", $"At most {MaxPerConnection} subscriptions per connection"));
		window = Math.Clamp(window, 1, MaxWindow);
		var subscription = new Subscription
		{
			Id = Guid.NewGuid().ToString("N")[..12], Connection = connection, Device = deviceId, Stream = stream, MinWindow = window,
			MaxFps = Math.Clamp(maxFps, 1, 120), Cancel = new CancellationTokenSource(),
			Parameters = parameters,
		};
		subscription.Window = window;
		mine[subscription.Id] = subscription;
		_ = Task.Run(() => LoopAsync(subscription, deviceId, stream), CancellationToken.None);
		return subscription.Id;
	}

	public void Update(string connection, string id, IReadOnlyDictionary<string, object?> parameters)
	{
		var s = Find(connection, id);
		s.Parameters = parameters;
		s.Force = true;
	}

	/// <summary>The client has the frame (and everything before it). Measures the round trip time and sets how many frames may be on their way.</summary>
	public void Received(string connection, string id, long sequence)
	{
		if (!_byConnection.TryGetValue(connection, out var mine) || !mine.TryGetValue(id, out var s)) return;
		var received = 0;
		long at = 0;
		while (s.InFlight.TryPeek(out var oldest) && oldest.Sequence <= sequence && s.InFlight.TryDequeue(out oldest))
		{
			received++;
			at = oldest.At;
			s.Waiting.Enqueue(oldest.Sequence);
		}
		if (received == 0) return;
		var rtt = Stopwatch.GetElapsedTime(at).TotalMilliseconds;
		s.RttMs = s.RttMs == 0 ? rtt : 0.8 * s.RttMs + 0.2 * rtt;
		// the bandwidth-delay product: frames that are on their way on a healthy link, plus some room
		s.Window = Math.Clamp(Math.Max(s.MinWindow, (int)Math.Ceiling(2 * s.MaxFps * s.RttMs / 1000) + 1), 1, MaxWindow);
	}

	/// <summary>The client is done with the frame (and everything before it); implies that it was received.</summary>
	public void Ack(string connection, string id, long sequence)
	{
		if (!_byConnection.TryGetValue(connection, out var mine) || !mine.TryGetValue(id, out var s)) return;
		Received(connection, id, sequence);
		while (s.Waiting.TryPeek(out var next) && next <= sequence && s.Waiting.TryDequeue(out next)) Interlocked.Increment(ref s.Acked);
	}

	public void Remove(string connection, string id)
	{
		if (_byConnection.TryGetValue(connection, out var mine) && mine.TryRemove(id, out var s)) s.Cancel.Cancel();
	}

	public void RemoveConnection(string connection)
	{
		if (_byConnection.TryRemove(connection, out var mine)) foreach (var s in mine.Values) s.Cancel.Cancel();
	}

	public List<Dictionary<string, object?>> Stats(string connection) =>
		_byConnection.TryGetValue(connection, out var mine)
			? mine.Values.Select(s => new Dictionary<string, object?>
			{
				["subscription"] = s.Id, ["device"] = s.Device, ["stream"] = s.Stream, ["window"] = s.Window, ["in_flight"] = s.InFlight.Count, ["waiting"] = s.Waiting.Count,
				["sent"] = Interlocked.Read(ref s.Sent), ["acked"] = Interlocked.Read(ref s.Acked), ["skipped"] = Interlocked.Read(ref s.Skipped),
				["rtt_ms"] = Math.Round(s.RttMs, 2), ["last_sequence"] = s.LastSequence,
			}).ToList()
			: [];

	private Subscription Find(string connection, string id) =>
		_byConnection.TryGetValue(connection, out var mine) && mine.TryGetValue(id, out var s) ? s
			: throw new HubException(Errors.Json("LookupError", $"There is no subscription '{id}'"));

	private async Task LoopAsync(Subscription s, string deviceId, string stream)
	{
		var cancel = s.Cancel.Token;
		var interval = TimeSpan.FromSeconds(1 / s.MaxFps);
		var after = -1L;
		try
		{
			while (!cancel.IsCancellationRequested)
			{
				// the sender waits only when the client has fallen behind: more on their way than a healthy link explains, or more than
				// two frames waiting to be processed
				while (s.InFlight.Count >= s.Window || s.Waiting.Count >= MaxWaitingAtClient) await Task.Delay(2, cancel);
				var begin = Stopwatch.GetTimestamp();
				StreamFrame? frame = null;
				while (frame is null)
				{
					var source = registry.Get(deviceId)?.Streams?.Find(stream); // looked up again: the device may have restarted
					if (source is not null && (s.Force || source.LatestSequence > after))
					{
						var force = s.Force;
						s.Force = false;
						frame = source.Render(s.Parameters, force ? -1 : after);
						if (frame is not null) break;
					}
					await Task.Delay(4, cancel);
				}
				if (after >= 0 && frame.Sequence > after + 1) Interlocked.Add(ref s.Skipped, frame.Sequence - after - 1); // newer data replaced these
				after = frame.Sequence;
				s.LastSequence = frame.Sequence;
				s.InFlight.Enqueue((frame.Sequence, Stopwatch.GetTimestamp()));
				Interlocked.Increment(ref s.Sent);
				await hub.Clients.Client(s.Connection).SendAsync("frame", s.Id, frame.Sequence, frame.Meta, frame.Data, cancel);
				var rest = interval - Stopwatch.GetElapsedTime(begin);
				if (rest > TimeSpan.Zero) await Task.Delay(rest, cancel);
			}
		}
		catch (OperationCanceledException) { }
		catch (Exception e)
		{
			log.LogWarning("The stream {Stream} of {Device} to a client stopped: {Message}", stream, deviceId, e.Message);
		}
		finally { Remove(s.Connection, s.Id); }
	}
}
