using System.IO.Compression;
using ExperimentControl.Hubs;
using Microsoft.AspNetCore.SignalR;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

public record DeviceAction(string DeviceId, string? ChannelId, string ActionName, object[]? Parameters);

public class DeviceManager : IDisposable
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
		RegisterDevice("main", new MainDevice());
		//RegisterDevice("myPressure", new PythonDevice("pressure.py"));
	}

	public void RegisterDevice(string deviceId, IDeviceHandler deviceHandler)
	{
		_deviceHandlers.Add(deviceId, deviceHandler);
		deviceHandler.SetDeviceManager(this);
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

	public void Save(string baseFilepath)
	{
		using var npzFile = new ZipArchive(new FileStream($"{baseFilepath}.npz", FileMode.CreateNew), ZipArchiveMode.Create);
		var yamlFile = new Dictionary<string, object>();
		foreach (var (deviceName, device) in _deviceHandlers)
		{
			var stateToWrite = device.OnSave(npzFile);
			if (stateToWrite != null)
			{
				yamlFile[deviceName] = stateToWrite;
			}
		}
		if (yamlFile.Count == 0) return;
		var serializer = new SerializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance).Build();
		var yaml = serializer.Serialize(yamlFile);
		File.WriteAllText($"{baseFilepath}.yaml", yaml);
	}

	public void Dispose()
	{
		foreach (var (_, device) in _deviceHandlers)
		{
			device.Dispose();
		}
		_deviceHandlers.Clear();
	}
}
