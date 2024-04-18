using Microsoft.AspNetCore.SignalR;

namespace ExperimentControl.Hubs;

public class ControlHub : Hub
{
    private readonly DeviceManager _deviceManager;
    public ControlHub(DeviceManager deviceManager)
    {
        _deviceManager = deviceManager;
    }
    public void Action(DeviceAction action)
    {
        _deviceManager.Action(action);
    }

    public Dictionary<string, object> GetFullState()
    {
        return _deviceManager.GetFullState();
    }
}
