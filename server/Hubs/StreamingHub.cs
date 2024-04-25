using Microsoft.AspNetCore.SignalR;

namespace ExperimentControl.Hubs;

public class StreamingHub : Hub
{
	private readonly DeviceManager _deviceManager;
	public StreamingHub(DeviceManager deviceManager)
	{
		_deviceManager = deviceManager;
	}

	public override Task OnConnectedAsync()
	{
		_deviceManager.StreamingContexts.TryAdd(Context.ConnectionId, new Dictionary<string, Dictionary<object, object>>());
		return base.OnConnectedAsync();
	}
	public override Task OnDisconnectedAsync(Exception? exception)
	{
		_deviceManager.StreamingContexts.TryRemove(Context.ConnectionId, out var _);
		return base.OnDisconnectedAsync(exception);
	}

	public void SetStreamCustomization(string deviceId, dynamic customization)
	{
		_deviceManager.StreamingContexts[Context.ConnectionId][deviceId] = customization;
	}
}
