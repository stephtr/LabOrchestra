namespace LabOrchestra.Server.Events;

/// <summary>Things that happen on the server ("recording.finished", "snapshot.saved", "device.error", ...) that procedures can be started by.
/// Publishing never waits for a listener and never fails: a broken listener is logged, and the code that published (a recording that has just
/// been closed) goes on.</summary>
public sealed class ServerEvents(ILogger<ServerEvents> log)
{
	public static readonly string[] Names = ["recording.finished", "recording.discarded", "snapshot.saved", "device.error"];

	private readonly List<Func<string, Dictionary<string, object?>, Task>> _listeners = [];

	public void Subscribe(Func<string, Dictionary<string, object?>, Task> listener)
	{
		lock (_listeners) _listeners.Add(listener);
	}

	public void Publish(string name, Dictionary<string, object?> data)
	{
		Func<string, Dictionary<string, object?>, Task>[] listeners;
		lock (_listeners) listeners = [.. _listeners];
		data["event"] = name;
		data["time"] = DateTimeOffset.UtcNow.ToString("o");
		foreach (var listener in listeners)
			_ = Task.Run(async () =>
			{
				try { await listener(name, data); }
				catch (Exception e) { log.LogError(e, "A listener of the event {Event} failed", name); }
			});
	}
}
