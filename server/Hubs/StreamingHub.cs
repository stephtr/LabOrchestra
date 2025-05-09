namespace ExperimentControl.Hubs;

public class StreamingHub : ProtectedHub
{
	private readonly DeviceManager DeviceManager;
	public StreamingHub(DeviceManager deviceManager, AccessControlService accessControlService)
		: base(accessControlService)
	{
		DeviceManager = deviceManager;
	}

	public override Task OnConnectedAsync()
	{
		DeviceManager.StreamingContexts.TryAdd(Context.ConnectionId, new Dictionary<string, Dictionary<object, object>>());
		return base.OnConnectedAsync();
	}
	public override Task OnDisconnectedAsync(Exception? exception)
	{
		DeviceManager.StreamingContexts.TryRemove(Context.ConnectionId, out var _);
		return base.OnDisconnectedAsync(exception);
	}

	public void SetStreamCustomization(string deviceId, dynamic customization)
	{
		DeviceManager.StreamingContexts[Context.ConnectionId][deviceId] = customization;
	}
}
