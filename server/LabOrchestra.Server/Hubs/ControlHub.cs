using System.Text.Json;
using LabOrchestra.Server.Auth;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Events;
using LabOrchestra.Server.Recording;
using LabOrchestra.Server.Logging;
using LabOrchestra.Server.Supervision;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace LabOrchestra.Server.Hubs;

public static class Errors
{
	/// <summary>Errors cross the wire as JSON text: type, message and optionally the traceback of the original.</summary>
	public static string Json(string type, string message) => JsonSerializer.Serialize(new { type, message, traceback = (string?)null });
}

/// <summary>Connection of browsers, scripts and devices that talk to other devices.</summary>
[Authorize(Roles = $"{Roles.Client},{Roles.Device}")]
public sealed class ControlHub(
	DeviceRegistry registry,
	LogStore logs,
	SecretStore secrets,
	WorkerSupervisor supervisor,
	RecordingService recordings,
	EventBus bus,
	IHubContext<DeviceHub> devices) : Hub
{
	public override Task OnConnectedAsync()
	{
		// clients say what they are (?client=ui, ?client=script) so that changes can be attributed
		var name = Context.GetHttpContext()?.Request.Query["client"].ToString() ?? "";
		Context.Items["client"] = System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-z0-9_-]{1,32}$") ? name : "client";
		return base.OnConnectedAsync();
	}

	/// <summary>Who is calling: "ui", "script", ... for clients, "device:name" for devices.</summary>
	private string Caller() => Context.User?.FindFirst("device_id")?.Value is { } id ? $"device:{id}" : (string)Context.Items["client"]!;

	private static HubException Fail(Exception e) => new(Errors.Json(e is ArgumentException ? "ValueError" : "RecordingError", e.Message));

	[HubMethodName("get_recording")]
	public Dictionary<string, object?> GetRecording() => recordings.Status();

	[HubMethodName("list_recordings")]
	public List<Dictionary<string, object?>> ListRecordings(int limit) => recordings.List(Math.Clamp(limit, 1, 1000));

	[HubMethodName("start_recording")]
	public Dictionary<string, object?> StartRecording(string name, object? tags)
	{
		try { return recordings.Start(name, Plain.From(tags) as Dictionary<string, object?>, Caller()); }
		catch (Exception e) when (e is InvalidOperationException or ArgumentException or IOException) { throw Fail(e); }
	}

	[HubMethodName("stop_recording")]
	public Dictionary<string, object?> StopRecording()
	{
		try { return recordings.Stop(); }
		catch (InvalidOperationException e) { throw Fail(e); }
	}

	[HubMethodName("abort_recording")]
	public Dictionary<string, object?> AbortRecording(bool discard)
	{
		try { return recordings.Abort(discard); }
		catch (InvalidOperationException e) { throw Fail(e); }
	}

	[HubMethodName("snapshot")]
	public Dictionary<string, object?> Snapshot(string name, object? tags)
	{
		try { return recordings.Snapshot(name, Plain.From(tags) as Dictionary<string, object?>, Caller()); }
		catch (Exception e) when (e is InvalidOperationException or ArgumentException or IOException) { throw Fail(e); }
	}

	[HubMethodName("get_devices")]
	public Dictionary<string, Dictionary<string, object?>> GetDevices() => registry.All();

	/// <summary>Stops the worker of a device and starts it again (also resets the waiting time after failures).</summary>
	[HubMethodName("restart_device")]
	public async Task RestartDevice(string device)
	{
		if (!await supervisor.RestartAsync(device))
			throw new HubException(Errors.Json("LookupError", $"Device '{device}' does not exist"));
	}

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_secrets")]
	public List<string> ListSecrets() => secrets.Names();

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("set_secret")]
	public async Task SetSecret(string name, string value)
	{
		secrets.Set(name, value);
		await supervisor.SecretChangedAsync(name);
	}

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("delete_secret")]
	public async Task DeleteSecret(string name)
	{
		secrets.Delete(name);
		await supervisor.SecretChangedAsync(name);
	}

	[HubMethodName("get_device")]
	public Dictionary<string, object?> GetDevice(string device) =>
		registry.Snapshot(device) ?? throw new HubException(Errors.Json("LookupError", $"Device '{device}' does not exist"));

	/// <param name="source">"server", "device:pressure" or null for all; since = 0 returns the latest entries.</param>
	[HubMethodName("get_logs")]
	public List<Dictionary<string, object?>> GetLogs(string? source, string? level, long since, int limit) =>
		logs.Get(source, level, since, Math.Clamp(limit, 1, 2000));

	[HubMethodName("subscribe_logs")]
	public Task SubscribeLogs(string source) => Groups.AddToGroupAsync(Context.ConnectionId, "logs:" + source);

	[HubMethodName("unsubscribe_logs")]
	public Task UnsubscribeLogs(string source) => Groups.RemoveFromGroupAsync(Context.ConnectionId, "logs:" + source);

	[HubMethodName("action")]
	public async Task<object?> Action(string device, string name, object?[] args)
	{
		var entry = registry.Get(device) ?? throw new HubException(Errors.Json("LookupError", $"Device '{device}' does not exist"));
		if (entry.ConnectionId is null || entry.Status != "ready")
			throw new HubException(Errors.Json("DeviceNotReady", $"Device '{device}' is not ready (status: {entry.Status})"));
		var caller = Caller();
		bus.Publish(device, "action", caller, new() { ["action"] = name, ["args"] = Plain.From(args) });
		try
		{
			return await devices.Clients.Client(entry.ConnectionId).InvokeAsync<object?>("call", name, args, caller, Context.ConnectionAborted);
		}
		catch (HubException e) when (e.Message.TrimStart().StartsWith('{'))
		{
			throw; // structured error of the worker, passed on unchanged
		}
		catch (Exception e) when (e is not OperationCanceledException)
		{
			throw new HubException(Errors.Json("ConnectionLost", $"Device '{device}' did not answer: {e.Message}"));
		}
	}
}
