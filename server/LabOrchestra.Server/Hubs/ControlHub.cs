using System.Text.Json;
using LabOrchestra.Server.Auth;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Logging;
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
public sealed class ControlHub(DeviceRegistry registry, LogStore logs, IHubContext<DeviceHub> devices) : Hub
{
	[HubMethodName("get_devices")]
	public Dictionary<string, Dictionary<string, object?>> GetDevices() => registry.All();

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
		try
		{
			return await devices.Clients.Client(entry.ConnectionId).InvokeAsync<object?>("call", name, args, Context.ConnectionAborted);
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
