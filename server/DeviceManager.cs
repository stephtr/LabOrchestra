using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text.Json;
using ExperimentControl.Hubs;
using Microsoft.AspNetCore.SignalR;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

public record DeviceAction(string DeviceId, string? ChannelId, string ActionName, object[]? Parameters);

public class DeviceManager : IDisposable
{
	private readonly IHubContext<ControlHub> ControlHub;
	private readonly IHubContext<StreamingHub> StreamingHub;
	private Dictionary<string, IDeviceHandler> DeviceHandlers = new();
	private List<string> UpdateQueue = new();
	private Timer? UpdateTimer = null;
	private const float MaxUpdateDelay = 0.05f;
	internal ConcurrentDictionary<string, Dictionary<string, Dictionary<object, object>>> StreamingContexts = new();

	public DeviceManager(IHubContext<ControlHub> controlHub, IHubContext<StreamingHub> streamingHub)
	{
		ControlHub = controlHub;
		StreamingHub = streamingHub;
		RegisterDevice("het", new OscilloscopeHandler());
		RegisterDevice("split", new OscilloscopeHandler());
		RegisterDevice("main", new MainDevice());
		LoadSettings();
		//RegisterDevice("myPressure", new PythonDevice("pressure.py"));
	}

	public void RegisterDevice(string deviceId, IDeviceHandler deviceHandler)
	{
		DeviceHandlers.Add(deviceId, deviceHandler);
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
		DeviceHandlers[action.DeviceId].HandleActionAsync(action);
		UpdateQueue.Add(action.DeviceId);
		if (UpdateTimer == null)
		{
			UpdateTimer = new Timer(UpdateDevices, null, TimeSpan.FromSeconds(MaxUpdateDelay), TimeSpan.Zero);
		}
	}

	public Dictionary<string, object> GetFullState()
	{
		var state = new Dictionary<string, object>();
		foreach (var (deviceId, device) in DeviceHandlers)
		{
			state[deviceId] = device.GetState();
		}
		return state;
	}

	public void SendPartialStateUpdateAsync(object partialState)
	{
		ControlHub.Clients.All.SendAsync("PartialStateUpdate", partialState);
	}

	public void SendStreamData(string deviceId, object data)
	{
		StreamingHub.Clients.All.SendAsync("StreamData", deviceId, data);
	}

	public string GetDeviceId(IDeviceHandler deviceHandler)
	{
		return DeviceHandlers.FirstOrDefault(x => x.Value == deviceHandler).Key;
	}

	public void SendStreamData<T>(string deviceId, Func<T, Dictionary<object, object>?, object> filter, T data)
	{
		foreach (var (connectionId, customizations) in StreamingContexts)
		{
			if (customizations.TryGetValue(deviceId, out var customization))
			{
				StreamingHub.Clients.Client(connectionId).SendAsync("StreamData", deviceId, filter(data, customization));
			}
			else
			{
				StreamingHub.Clients.Client(connectionId).SendAsync("StreamData", deviceId, filter(data, null));
			}
		}
	}

	public void UpdateDevices(object? _ = null)
	{
		UpdateTimer = null;
		var state = new Dictionary<string, object>();
		foreach (var deviceId in UpdateQueue)
		{
			state[deviceId] = DeviceHandlers[deviceId].GetState();
		}
		UpdateQueue.Clear();
		SendPartialStateUpdateAsync(state);
	}

	public void SaveSnapshot(string baseFilepath)
	{
		using var npzFile = new ZipArchive(new FileStream($"{baseFilepath}.npz", FileMode.CreateNew), ZipArchiveMode.Create);
		var yamlFile = new Dictionary<string, object>();
		foreach (var (_, device) in DeviceHandlers)
		{
			device.OnBeforeSaveSnapshot();
		}
		foreach (var (deviceId, device) in DeviceHandlers)
		{
			var stateToWrite = device.OnSaveSnapshot(npzFile, deviceId);
			if (stateToWrite != null)
			{
				yamlFile[deviceId] = stateToWrite;
			}
		}
		foreach (var (_, device) in DeviceHandlers)
		{
			device.OnAfterSaveSnapshot();
		}
		if (yamlFile.Count == 0) return;
		var serializer = new SerializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance).Build();
		var yaml = serializer.Serialize(yamlFile);
		File.WriteAllText($"{baseFilepath}.yaml", yaml);
	}

	private void SaveSettings()
	{
		var state = new Dictionary<string, dynamic>();
		foreach (var (deviceId, device) in DeviceHandlers)
		{
			var setting = device.GetSettings();
			if (setting != null)
			{
				state[deviceId] = setting;
			}
		}
		File.WriteAllText("settings.json", JsonSerializer.Serialize(state));
	}

	private void LoadSettings()
	{
		if (!File.Exists("settings.json")) return;
		try
		{
			var settings = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText("settings.json"));
			if (settings == null) return;
			foreach (var (deviceId, settingObject) in settings)
			{
				dynamic setting = settingObject;
				if (DeviceHandlers.ContainsKey(deviceId))
				{
					DeviceHandlers[deviceId].LoadSettings(setting);
				}
			}
		}
		catch (Exception e)
		{
			Console.WriteLine("Error loading settings: " + e.Message);
		}
	}

	public void Dispose()
	{
		SaveSettings();
		foreach (var (_, device) in DeviceHandlers)
		{
			device.Dispose();
		}
		DeviceHandlers.Clear();
	}
}
