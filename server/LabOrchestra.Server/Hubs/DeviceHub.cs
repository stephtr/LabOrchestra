using LabOrchestra.Server.Auth;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Logging;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace LabOrchestra.Server.Hubs;

/// <summary>Connection of the device workers. The server calls "call" and "get_state" on them.</summary>
[Authorize(Roles = Roles.Device)]
public sealed class DeviceHub(DeviceRegistry registry, LogStore logs, SettingsStore settings, ILogger<DeviceHub> log) : Hub
{
	private string DeviceId => Context.User!.FindFirst("device_id")!.Value;

	[HubMethodName("register")]
	public void Register(object schema, object state)
	{
		if (schema is not IDictionary<object, object> map || map.TryGetValue("id", out var id) is false || id as string != DeviceId)
			throw new HubException(Errors.Json("ValueError", $"The schema must have the id '{DeviceId}'"));
		registry.Registered(DeviceId, Context.ConnectionId, Plain.From(schema)!, (Dictionary<string, object?>)Plain.From(state)!);
		log.LogInformation("Device {Device} registered", DeviceId);
	}

	/// <summary>Replaces the whole state. Normally the device sends patches; this is the way back to a known state.</summary>
	[HubMethodName("update_state")]
	public void UpdateState(object state)
	{
		if (Plain.From(state) is not Dictionary<string, object?> map || !registry.StateReplaced(DeviceId, Context.ConnectionId, map))
			throw new HubException(Errors.Json("RuntimeError", "The device is not registered on this connection"));
	}

	/// <summary>What changed in the state since the last patch or registration, e.g. {"set": {"channels.1.pressure": 3e-7}}.</summary>
	[HubMethodName("patch_state")]
	public void PatchState(object patch)
	{
		try
		{
			registry.StatePatched(DeviceId, Context.ConnectionId, (Dictionary<string, object?>)Plain.From(patch)!);
		}
		catch (Exception e) when (e is InvalidOperationException or InvalidCastException)
		{
			throw new HubException(Errors.Json("PatchError", e.Message));
		}
	}

	/// <summary>The values of the device's "persist" keys after a change.</summary>
	[HubMethodName("save_settings")]
	public void SaveSettings(object values)
	{
		if (Plain.From(values) is Dictionary<string, object?> map) settings.Save(DeviceId, map);
	}

	/// <summary>Batches of log records of the device: time (epoch seconds), level, logger, message, traceback.</summary>
	[HubMethodName("log")]
	public void Log(object?[] records)
	{
		foreach (var record in records)
		{
			if (record is not IDictionary<object, object?> r) continue;
			string? Text(string key) => r.TryGetValue(key, out var v) ? v as string : null;
			var time = r.TryGetValue("time", out var t) && t is not null ? DateTimeOffset.FromUnixTimeMilliseconds((long)(Convert.ToDouble(t) * 1000)) : (DateTimeOffset?)null;
			logs.Add($"device:{DeviceId}", Text("level"), Text("logger") ?? "", Text("message") ?? "", Text("traceback"), time);
		}
	}

	public override Task OnDisconnectedAsync(Exception? exception)
	{
		registry.Disconnected(DeviceId, Context.ConnectionId);
		log.LogInformation("Device {Device} disconnected", DeviceId);
		return base.OnDisconnectedAsync(exception);
	}
}
