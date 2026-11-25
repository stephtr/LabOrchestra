using LabOrchestra.Server.Events;
using LabOrchestra.Server.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace LabOrchestra.Server.Devices;

/// <summary>Calls an action of a device on behalf of a caller (the hub for browsers and scripts, the MCP endpoint for AI clients): checks that the
/// device is up, lets a procedure use only the devices it declared, records the call in the event log with its caller, and passes a structured
/// error of the device on unchanged.</summary>
public sealed class ActionInvoker(DeviceRegistry registry, EventBus bus, Procedures.ProcedureService procedures, IHubContext<DeviceHub> devices)
{
	/// <summary>The call, and what it means for the health of the device (several failures in a row make it "degraded").</summary>
	public async Task<object?> ActionAsync(string device, string name, object?[] args, string caller, CancellationToken cancel)
	{
		try
		{
			var result = await InvokeAsync(device, name, args, caller, cancel);
			registry.ActionFinished(device, null, null);
			return result;
		}
		catch (HubException e)
		{
			var (type, message) = Errors.Parse(e.Message);
			registry.ActionFinished(device, type, message);
			throw;
		}
	}

	private async Task<object?> InvokeAsync(string device, string name, object?[] args, string caller, CancellationToken cancel)
	{
		var entry = registry.Get(device) ?? throw new HubException(Errors.Json("LookupError", $"Device '{device}' does not exist"));
		if (entry.ConnectionId is null || !DeviceRegistry.IsUp(entry.Status))
			throw new HubException(Errors.Json("DeviceNotReady", $"Device '{device}' is not ready (status: {entry.Status})"));
		if (caller.StartsWith("run:")) procedures.CheckAccess(caller[4..], device); // a procedure uses the devices it declared
		bus.Publish(device, "action", caller, new() { ["action"] = name, ["args"] = Plain.From(args) });
		if (entry.LocalCall is { } local && entry.ConnectionId.StartsWith(Drivers.InProcessDevice.ConnectionPrefix))
		{
			try { return await local(name, args, caller, cancel); }
			catch (Drivers.DeviceActionException e) { throw new HubException(Errors.Json(e.Type, e.Message, e.Traceback)); }
		}
		try
		{
			return await devices.Clients.Client(entry.ConnectionId).InvokeAsync<object?>("call", name, args, caller, cancel);
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
