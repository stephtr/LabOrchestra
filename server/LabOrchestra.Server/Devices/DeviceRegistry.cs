using LabOrchestra.Server.Events;
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
	/// <summary>For devices that run inside the server: how to call their actions (no hub in between).</summary>
	public Func<string, object?[], string, CancellationToken, Task<object?>>? LocalCall { get; set; }
	/// <summary>The streams of a device that runs inside the server.</summary>
	public LabOrchestra.Sdk.StreamRegistry? Streams { get; set; }
	/// <summary>The device itself, if it runs inside the server (recordings ask it for its own data).</summary>
	public LabOrchestra.Sdk.Device? LocalDevice { get; set; }
	/// <summary>How often a worker registered; lets the supervisor tell whether a process ever came up.</summary>
	public int Registrations { get; set; }
	/// <summary>Actions in a row that failed for a reason on the device's side (not a wrong argument).</summary>
	public int ActionFailures { get; set; }
	/// <summary>Why the status is "degraded": "actions" or "state"; null otherwise.</summary>
	public string? DegradedBy { get; set; }
	/// <summary>The device's source file changed after the worker started: what runs is not what is on disk.</summary>
	public bool Changed { get; set; }
}

/// <summary>All configured devices with their status, schema and last reported state. Changes go to the clients as
/// "device" (everything about one device) or "device_patch" (only what changed in the state, with the new revision).</summary>
public sealed class DeviceRegistry(IHubContext<ControlHub> control, EventBus bus, ILogger<DeviceRegistry> log)
{
	private readonly object _lock = new();
	private readonly Dictionary<string, DeviceEntry> _devices = new();

	public void Declare(string id) => Mutate(id, true, e => { e.Status = "starting"; e.Error = null; e.ConnectionId = null; e.Changed = false; return true; });

	public void SetChanged(string id, bool changed) => Mutate(id, false, e => { if (e.Changed == changed) return false; e.Changed = changed; return true; });

	/// <summary>A device that can be used: connected, and either fine ("ready") or working with problems ("degraded").</summary>
	public static bool IsUp(string status) => status is "ready" or "degraded";

	private const int DegradedAfter = 3;

	public void SetStatus(string id, string status, string? error = null) =>
		Mutate(id, false, e =>
		{
			e.Status = status; e.Error = error; e.ActionFailures = 0; e.DegradedBy = null;
			if (!IsUp(status)) e.ConnectionId = null;
			return true;
		});

	/// <summary>An action ended. Several failures in a row that are not the caller's mistakes make the device "degraded"; a success ends it.</summary>
	public void ActionFinished(string id, string? errorType, string? message)
	{
		Mutate(id, false, e =>
		{
			if (!IsUp(e.Status)) return false;
			if (errorType is null)
			{
				e.ActionFailures = 0;
				if (e.DegradedBy != "actions") return false;
				(e.Status, e.Error, e.DegradedBy) = ("ready", null, null);
				return true;
			}
			if (CallerMistakes.Contains(errorType)) return false;
			e.ActionFailures++;
			if (e.ActionFailures < DegradedAfter || e.Status == "degraded" && e.DegradedBy != "actions") return false;
			(e.Status, e.DegradedBy, e.Error) = ("degraded", "actions", $"{e.ActionFailures} actions in a row failed, the last with {errorType}: {message}");
			return true;
		});
	}

	/// <summary>The device sent a state update that could not be applied (the device resends its whole state; accepting that ends this).</summary>
	public void StateRejected(string id, string connectionId, string reason) =>
		Mutate(id, false, e =>
		{
			if (e.ConnectionId != connectionId || e.Status != "ready") return false;
			(e.Status, e.DegradedBy, e.Error) = ("degraded", "state", $"A state update was rejected: {reason}");
			return true;
		});

	/// <summary>Errors that say the call was wrong or was stopped on purpose, not that the device has a problem.</summary>
	private static readonly HashSet<string> CallerMistakes =
	[
		"ValueError", "TypeError", "KeyError", "LookupError", "IndexError", "SchemaError", "InterruptedError", "DeviceNotReady",
		"ArgumentException", "ArgumentNullException", "ArgumentOutOfRangeException", "NotSupportedException", "OperationCanceledException",
	];

	public void Registered(string id, string connectionId, object schema, Dictionary<string, object?> state) =>
		Mutate(id, false, e =>
		{
			e.Status = "ready"; e.Error = null; e.DegradedBy = null; e.ActionFailures = 0; e.ConnectionId = connectionId; e.Schema = schema; e.State = state;
			e.Revision++; e.Registrations++;
			return true;
		}, replaced: true);

	/// <summary>The device sends its whole state (it does so when a patch was rejected).</summary>
	public bool StateReplaced(string id, string connectionId, Dictionary<string, object?> state) =>
		Mutate(id, false, e =>
		{
			if (e.ConnectionId != connectionId) return false;
			e.State = state; e.Revision++;
			if (e.DegradedBy == "state") (e.Status, e.Error, e.DegradedBy) = ("ready", null, null);
			return true;
		}, replaced: true);

	public void StatePatched(string id, string connectionId, Dictionary<string, object?> patch, string by)
	{
		lock (_lock)
		{
			if (!_devices.TryGetValue(id, out var e) || e.ConnectionId != connectionId || e.State is null)
				throw new InvalidOperationException("The device is not registered on this connection");
			StatePatch.Apply(e.State, patch);
			e.Revision++;
			Send("device_patch", id, e.Revision, patch); // inside the lock: updates reach the clients in order
			bus.Publish(id, "patch", by, patch);
		}
	}

	public void Disconnected(string id, string connectionId) =>
		Mutate(id, false, e =>
		{
			if (e.ConnectionId != connectionId) return false; // a newer connection already took over
			e.Status = "reconnecting"; e.ConnectionId = null; // the process lives and connects again by itself; if it ended, the supervisor says so
			return true;
		});

	public void SetLocalCall(string id, string connectionId, Func<string, object?[], string, CancellationToken, Task<object?>> call, LabOrchestra.Sdk.StreamRegistry streams, LabOrchestra.Sdk.Device device)
	{
		lock (_lock)
			if (_devices.TryGetValue(id, out var e) && e.ConnectionId == connectionId) (e.LocalCall, e.Streams, e.LocalDevice) = (call, streams, device);
	}

	/// <summary>The devices that run inside the server and are ready.</summary>
	public List<(string Id, LabOrchestra.Sdk.Device Device)> LocalDevices()
	{
		lock (_lock) return _devices.Values.Where(e => e is { LocalDevice: not null } && IsUp(e.Status)).Select(e => (e.Id, e.LocalDevice!)).ToList();
	}

	public void Remove(string id)
	{
		lock (_lock)
			if (_devices.Remove(id)) Send("device_removed", id);
	}

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

	/// <summary>Runs a change; if it changed something, tells the clients and publishes events (status, and the whole state when it was replaced).</summary>
	private bool Mutate(string id, bool create, Func<DeviceEntry, bool> change, bool replaced = false)
	{
		lock (_lock)
		{
			if (!_devices.TryGetValue(id, out var entry))
			{
				if (!create) return false;
				_devices[id] = entry = new DeviceEntry { Id = id };
			}
			var (status, error) = (entry.Status, entry.Error);
			if (!change(entry)) return false;
			Send("device", id, Snapshot(entry));
			if (entry.Status != status || entry.Error != error)
				bus.Publish(id, "status", "supervisor", new() { ["status"] = entry.Status, ["error"] = entry.Error });
			if (replaced && entry.State is not null)
				bus.Publish(id, "replace", "device", new() { ["state"] = Plain.Clone(entry.State) });
			return true;
		}
	}

	/// <summary>Takes the current states and starts listening for events in one step, so that nothing is lost or counted twice.</summary>
	public Dictionary<string, Dictionary<string, object?>> SnapshotAndSubscribe(Action<DeviceEvent> listener)
	{
		lock (_lock)
		{
			var all = _devices.ToDictionary(kv => kv.Key, kv => (Dictionary<string, object?>)Plain.Clone(Snapshot(kv.Value))!);
			bus.Published += listener;
			return all;
		}
	}

	public void Unsubscribe(Action<DeviceEvent> listener) => bus.Published -= listener;

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
		["changed"] = e.Changed,
	};
}
