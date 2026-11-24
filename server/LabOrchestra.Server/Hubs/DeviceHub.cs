using LabOrchestra.Server.Auth;
using LabOrchestra.Server.Devices;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace LabOrchestra.Server.Hubs;

/// <summary>Connection of the device workers. The server calls "call" and "get_state" on them.</summary>
[Authorize(Roles = Roles.Device)]
public sealed class DeviceHub(DeviceRegistry registry, ILogger<DeviceHub> log) : Hub
{
	private string DeviceId => Context.User!.FindFirst("device_id")!.Value;

	[HubMethodName("register")]
	public void Register(object schema, object state)
	{
		if (schema is not IDictionary<object, object> map || map.TryGetValue("id", out var id) is false || id as string != DeviceId)
			throw new HubException(Errors.Json("ValueError", $"The schema must have the id '{DeviceId}'"));
		registry.Registered(DeviceId, Context.ConnectionId, schema, state);
		log.LogInformation("Device {Device} registered", DeviceId);
	}

	[HubMethodName("update_state")]
	public void UpdateState(object state)
	{
		if (!registry.StateUpdated(DeviceId, Context.ConnectionId, state))
			throw new HubException(Errors.Json("RuntimeError", "The device is not registered on this connection"));
	}

	public override Task OnDisconnectedAsync(Exception? exception)
	{
		registry.Disconnected(DeviceId, Context.ConnectionId);
		log.LogInformation("Device {Device} disconnected", DeviceId);
		return base.OnDisconnectedAsync(exception);
	}
}
