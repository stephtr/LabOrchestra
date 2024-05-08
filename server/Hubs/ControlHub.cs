using Microsoft.AspNetCore.SignalR;

namespace ExperimentControl.Hubs;

public class ControlHub : Hub
{
    private readonly DeviceManager DeviceManager;
    public ControlHub(DeviceManager deviceManager)
    {
        DeviceManager = deviceManager;
    }
    public void Action(DeviceAction action)
    {
        DeviceManager.Action(action);
    }

    public Dictionary<string, object> GetFullState()
    {
        return DeviceManager.GetFullState();
    }
}
