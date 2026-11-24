using LabOrchestra.Server.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace LabOrchestra.Server.Devices;

public sealed class DeviceEntry
{
	public required string Id { get; init; }
	public string Status { get; set; } = "starting";
	public string? Error { get; set; }
	public object? Schema { get; set; }
	public object? State { get; set; }
	public string? ConnectionId { get; set; }
}

/// <summary>All configured devices with their status, schema and last reported state. Schema and state are kept as
/// received (maps and arrays), the server does not interpret them.</summary>
public sealed class DeviceRegistry(IHubContext<ControlHub> control, ILogger<DeviceRegistry> log)
{
	private readonly object _lock = new();
	private readonly Dictionary<string, DeviceEntry> _devices = new();

	public void Declare(string id) => Change(id, e => { e.Status = "starting"; e.Error = null; e.ConnectionId = null; }, create: true);

	public void SetStatus(string id, string status, string? error = null) =>
		Change(id, e => { e.Status = status; e.Error = error; if (status != "ready") e.ConnectionId = null; });

	public void Registered(string id, string connectionId, object schema, object state) =>
		Change(id, e => { e.Status = "ready"; e.Error = null; e.ConnectionId = connectionId; e.Schema = schema; e.State = state; });

	public bool StateUpdated(string id, string connectionId, object state)
	{
		var accepted = false;
		Change(id, e =>
		{
			if (e.ConnectionId != connectionId) return;
			e.State = state;
			accepted = true;
		}, notifyIf: () => accepted);
		return accepted;
	}

	public void Disconnected(string id, string connectionId) =>
		Change(id, e =>
		{
			if (e.ConnectionId != connectionId) return; // a newer connection already took over
			e.Status = "disconnected";
			e.ConnectionId = null;
		}, notifyIf: null);

	public DeviceEntry? Get(string id)
	{
		lock (_lock) return _devices.TryGetValue(id, out var e) ? e : null;
	}

	public Dictionary<string, Dictionary<string, object?>> All()
	{
		lock (_lock) return _devices.ToDictionary(kv => kv.Key, kv => Snapshot(kv.Value));
	}

	private void Change(string id, Action<DeviceEntry> change, bool create = false, Func<bool>? notifyIf = null)
	{
		lock (_lock)
		{
			if (!_devices.TryGetValue(id, out var entry))
			{
				if (!create) return;
				_devices[id] = entry = new DeviceEntry { Id = id };
			}
			change(entry);
			if (notifyIf != null && !notifyIf()) return;
			// called inside the lock so that updates reach the clients in order
			control.Clients.All.SendAsync("device", id, Snapshot(entry)).ContinueWith(
				t => log.LogWarning(t.Exception, "Could not notify clients about device {Device}", id), TaskContinuationOptions.OnlyOnFaulted);
		}
	}

	private static Dictionary<string, object?> Snapshot(DeviceEntry e) => new()
	{
		["status"] = e.Status,
		["error"] = e.Error,
		["schema"] = e.Schema,
		["state"] = e.State,
	};
}
