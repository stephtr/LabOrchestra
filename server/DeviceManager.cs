using ExperimentControl.Hubs;
using Microsoft.AspNetCore.SignalR;

public record DeviceAction(string DeviceId, string? ChannelId, string ActionName, object[]? Parameters);

public class DeviceManager
{
    private readonly IHubContext<ControlHub> _controlHub;
    private readonly IHubContext<StreamingHub> _streamingHub;
    private Dictionary<string, IDeviceHandler> _deviceHandlers = new();

    public DeviceManager(IHubContext<ControlHub> controlHub, IHubContext<StreamingHub> streamingHub)
    {
        _controlHub = controlHub;
        _streamingHub = streamingHub;
        RegisterDevice("myOsci", new OscilloscopeHandler());
        RegisterDevice("myPressure", new PythonDevice("pressure.py"));
    }

    public void RegisterDevice(string deviceId, IDeviceHandler deviceHandler)
    {
        _deviceHandlers.Add(deviceId, deviceHandler);
        deviceHandler.SubscribeToStateUpdates(state =>
        {
            SendPartialStateUpdateAsync(deviceId, state);
        });
        deviceHandler.SubscribeToStreamEvents(data =>
        {
            SendStreamData(deviceId, data);
        });
    }

    public void Action(DeviceAction action)
    {
        _deviceHandlers[action.DeviceId].HandleActionAsync(action);
    }

    public Dictionary<string, object> GetFullState()
    {
        var state = new Dictionary<string, object>();
        foreach (var device in _deviceHandlers)
        {
            state[device.Key] = device.Value.GetState();
        }
        return state;
    }

    public void SendPartialStateUpdateAsync(string deviceId, object partialState)
    {
        _controlHub.Clients.All.SendAsync("PartialStateUpdate", deviceId, partialState);
    }

    public void SendStreamData(string deviceId, object data)
    {
        _streamingHub.Clients.All.SendAsync("StreamData", deviceId, data);
    }
}