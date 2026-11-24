using LabOrchestra.Server.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace LabOrchestra.Server.Devices;

public sealed class DeviceEntry
{
	public required string Id { get; init; }
	public string Status { get; set; } = "starting";
	public string? Error { get; set; }
	public object? Schema { get; set; }
	public Dictionary<string, object?>? State { get; set; }
	/// <summary>Counts every change of the state, so that clients notice a patch they missed.</summary>
	public long Revision { get; set; }
	public string? ConnectionId { get; set; }
	/// <summary>How often a worker registered; lets the supervisor tell whether a process ever came up.</summary>
	public int Registrations { get; set; }
}

/// <summary>All configured devices with their status, schema and last reported state. Changes go to the clients as
/// "device" (everything about one device) or "device_patch" (only what changed in the state, with the new revision).</summary>
public sealed class DeviceRegistry(IHubContext<ControlHub> control, ILogger<DeviceRegistry> log)
{
	private readonly object _lock = new();
	private readonly Dictionary<string, DeviceEntry> _devices = new();

	public void Declare(string id) => Mutate(id, true, e => { e.Status = "starting"; e.Error = null; e.ConnectionId = null; return true; });

	public void SetStatus(string id, string status, string? error = null) =>
		Mutate(id, false, e => { e.Status = status; e.Error = error; if (status != "ready") e.ConnectionId = null; return true; });

	public void Registered(string id, string connectionId, object schema, Dictionary<string, object?> state) =>
		Mutate(id, false, e =>
		{
			e.Status = "ready"; e.Error = null; e.ConnectionId = connectionId; e.Schema = schema; e.State = state;
			e.Revision++; e.Registrations++;
			return true;
		});

	/// <summary>The device sends its whole state (it does so when a patch was rejected).</summary>
	public bool StateReplaced(string id, string connectionId, Dictionary<string, object?> state) =>
		Mutate(id, false, e =>
		{
			if (e.ConnectionId != connectionId) return false;
			e.State = state; e.Revision++;
			return true;
		});

	public void StatePatched(string id, string connectionId, Dictionary<string, object?> patch)
	{
		lock (_lock)
		{
			if (!_devices.TryGetValue(id, out var e) || e.ConnectionId != connectionId || e.State is null)
				throw new InvalidOperationException("The device is not registered on this connection");
			StatePatch.Apply(e.State, patch);
			e.Revision++;
			Send("device_patch", id, e.Revision, patch); // inside the lock: updates reach the clients in order
		}
	}

	public void Disconnected(string id, string connectionId) =>
		Mutate(id, false, e =>
		{
			if (e.ConnectionId != connectionId) return false; // a newer connection already took over
			e.Status = "disconnected"; e.ConnectionId = null;
			return true;
		});

	public DeviceEntry? Get(string id)
	{
		lock (_lock) return _devices.TryGetValue(id, out var e) ? e : null;
	}

	public Dictionary<string, object?>? Snapshot(string id)
	{
		lock (_lock) return _devices.TryGetValue(id, out var e) ? Snapshot(e) : null;
	}

	public Dictionary<string, Dictionary<string, object?>> All()
	{
		lock (_lock) return _devices.ToDictionary(kv => kv.Key, kv => Snapshot(kv.Value));
	}

	private bool Mutate(string id, bool create, Func<DeviceEntry, bool> change)
	{
		lock (_lock)
		{
			if (!_devices.TryGetValue(id, out var entry))
			{
				if (!create) return false;
				_devices[id] = entry = new DeviceEntry { Id = id };
			}
			if (!change(entry)) return false;
			Send("device", id, Snapshot(entry));
			return true;
		}
	}

	private void Send(string method, params object?[] args) =>
		control.Clients.All.SendCoreAsync(method, args).ContinueWith(
			t => log.LogWarning(t.Exception, "Could not notify the clients ({Method})", method), TaskContinuationOptions.OnlyOnFaulted);

	private static Dictionary<string, object?> Snapshot(DeviceEntry e) => new()
	{
		["status"] = e.Status,
		["error"] = e.Error,
		["schema"] = e.Schema,
		["state"] = e.State,
		["revision"] = e.Revision,
	};
}
