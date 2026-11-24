namespace LabOrchestra.Server.Events;

/// <summary>Something that happened to a device. <c>Kind</c> is "patch" (set/del), "replace" (state), "status"
/// (status/error) or "action" (action/args); <c>By</c> says who caused it: "device", "ui", "script", "device:other",
/// "supervisor", ...</summary>
public sealed record DeviceEvent(DateTimeOffset Time, string Device, string Kind, string By, Dictionary<string, object?> Data);

/// <summary>Distributes events to whoever listens (recordings now, the event log and history later). Listeners are called
/// synchronously in the order of the events and must only queue the work.</summary>
public sealed class EventBus
{
	public event Action<DeviceEvent>? Published;

	public void Publish(string device, string kind, string by, Dictionary<string, object?> data) =>
		Published?.Invoke(new DeviceEvent(DateTimeOffset.UtcNow, device, kind, by, data));
}
