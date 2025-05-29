namespace LabOrchestra.Hubs;

public class ControlHub : ProtectedHub
{
	private readonly DeviceManager DeviceManager;
	public ControlHub(DeviceManager deviceManager, AccessControlService accessControlService)
		: base(accessControlService)
	{
		DeviceManager = deviceManager;
	}
	public void Action(DeviceAction action)
	{
		DeviceManager.Action(action);
	}

	public object Request(DeviceAction action)
	{
		return DeviceManager.Request(action);
	}

	public Dictionary<string, object> GetFullState()
	{
		return DeviceManager.GetFullState();
	}
}
