using ExperimentControl.Hubs;
using Microsoft.AspNetCore.SignalR;

public record DeviceAction(string DeviceId, string? ChannelId, string ActionName, object[]? Parameters);

public class DeviceManager: IDisposable
{
    private readonly IHubContext<ControlHub> _controlHub;
    private readonly IHubContext<StreamingHub> _streamingHub;
    private Dictionary<string, IDeviceHandler> _deviceHandlers = new();
    private List<string> _updateQueue = new();
    private Timer? _updateTimer = null;
    private const float _maxUpdateDelay = 0.05f;

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
            var stateUpdate = new Dictionary<string, object>();
            stateUpdate[deviceId] = state;
            SendPartialStateUpdateAsync(stateUpdate);
        });
        deviceHandler.SubscribeToStreamEvents(data =>
        {
            SendStreamData(deviceId, data);
        });
    }

    public void Action(DeviceAction action)
    {
        _deviceHandlers[action.DeviceId].HandleActionAsync(action);
        _updateQueue.Add(action.DeviceId);
        if (_updateTimer == null)
        {
            _updateTimer = new Timer(UpdateDevices, null, TimeSpan.FromSeconds(_maxUpdateDelay), TimeSpan.Zero);
        }
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

    public void SendPartialStateUpdateAsync(object partialState)
    {
        _controlHub.Clients.All.SendAsync("PartialStateUpdate", partialState);
    }

    public void SendStreamData(string deviceId, object data)
    {
        _streamingHub.Clients.All.SendAsync("StreamData", deviceId, data);
    }

    public void UpdateDevices(object? _ = null)
    {
        _updateTimer = null;
        var state = new Dictionary<string, object>();
        foreach (var deviceName in _updateQueue)
        {
            state[deviceName] = _deviceHandlers[deviceName].GetState();
        }
        _updateQueue.Clear();
        SendPartialStateUpdateAsync(state);
    }

	public void Dispose()
	{
		foreach (var (_, device) in _deviceHandlers) {
			device.Dispose();
		}
		_deviceHandlers.Clear();
	}
}
