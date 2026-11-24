using LabOrchestra.Server.Auth;
using LabOrchestra.Server.Streaming;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace LabOrchestra.Server.Hubs;

/// <summary>The connection for streams (traces, spectra): separate from the control connection, so that frames never delay a command.
/// A client subscribes, gets frames, and acknowledges them: only then is the next one sent.</summary>
[Authorize(Roles = Roles.Client)]
public sealed class StreamHub(StreamManager streams) : Hub
{
	/// <param name="parameters">What this client wants to see (stream specific, e.g. {"x_min": 0, "x_max": 5e6}).</param>
	/// <param name="window">The least number of frames that may be on their way without an acknowledgement (1 to 64); the server raises it by itself when the round trip is long.</param>
	/// <returns>The id of the subscription; frames arrive as <c>frame(id, sequence, meta, data)</c>.</returns>
	[HubMethodName("subscribe")]
	public string Subscribe(string device, string stream, object? parameters, int window, double max_fps) =>
		streams.Subscribe(Context.ConnectionId, device, stream, Parameters(parameters), window, max_fps);

	[HubMethodName("update")]
	public void Update(string subscription, object? parameters) => streams.Update(Context.ConnectionId, subscription, Parameters(parameters));

	/// <summary>The frame (and all before it) has arrived. Send it at once: it is how the server learns the round trip time.</summary>
	[HubMethodName("received")]
	public void Received(string subscription, long sequence) => streams.Received(Context.ConnectionId, subscription, sequence);

	/// <summary>The frame (and all before it) is processed, e.g. drawn. Without it the server sends at most two frames beyond the last one acknowledged.</summary>
	[HubMethodName("ack")]
	public void Ack(string subscription, long sequence) => streams.Ack(Context.ConnectionId, subscription, sequence);

	[HubMethodName("unsubscribe")]
	public void Unsubscribe(string subscription) => streams.Remove(Context.ConnectionId, subscription);

	[HubMethodName("get_stats")]
	public List<Dictionary<string, object?>> GetStats() => streams.Stats(Context.ConnectionId);

	public override Task OnDisconnectedAsync(Exception? exception)
	{
		streams.RemoveConnection(Context.ConnectionId);
		return base.OnDisconnectedAsync(exception);
	}

	private static IReadOnlyDictionary<string, object?> Parameters(object? given) =>
		Plain.From(given) as Dictionary<string, object?> ?? new Dictionary<string, object?>();
}
