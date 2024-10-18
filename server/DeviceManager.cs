using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using ExperimentControl.Hubs;
using Microsoft.AspNetCore.SignalR;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;
using YamlDotNet.System.Text.Json;

public record DeviceAction(string DeviceId, string? ChannelId, string ActionName, object[]? Parameters);

public interface IAddon
{
	void DoWork(DeviceManager deviceManager, CancellationToken cancellationToken);
}

public class DeviceManager : IDisposable
{
	private readonly IHubContext<ControlHub> ControlHub;
	private readonly IHubContext<StreamingHub> StreamingHub;
	public Dictionary<string, IDeviceHandler> Devices = new();
	public List<IAddon> Addons = new();
	private List<string> UpdateQueue = new();
	private Timer? UpdateTimer = null;
	private const float MaxUpdateDelay = 0.05f;
	internal ConcurrentDictionary<string, Dictionary<string, Dictionary<object, object>>> StreamingContexts = new();
	private MainDevice MainDevice = new();
	private CancellationTokenSource GlobalCancellationTokenSource = new();

	private ISerializer yamlSerializer = new SerializerBuilder()
			.WithTypeConverter(new SystemTextJsonYamlTypeConverter())
			.WithNamingConvention(CamelCaseNamingConvention.Instance)
			.Build();

	public DeviceManager(IHubContext<ControlHub> controlHub, IHubContext<StreamingHub> streamingHub)
	{
		ControlHub = controlHub;
		StreamingHub = streamingHub;
		RegisterDevice("constants", new CoherentScatteringConstantsDevice());
		try
		{
			RegisterDevice("het", new Picoscope5000aOscilloscope());
		}
		catch
		{
			Console.WriteLine("Falling back to DemoOscilloscope");
			RegisterDevice("het", new DemoOscilloscope());
		}
		try
		{
			RegisterDevice("split", new Picoscope4000aOscilloscope());
		}
		catch
		{
			Console.WriteLine("Falling back to DemoOscilloscope");
			RegisterDevice("split", new DemoOscilloscope());
		}
		try
		{
			RegisterDevice("cavity_detuning", new PythonDevice("Devices/RS_SMA100B.py", new { ipAddress = "192.168.0.23" }));
		}
		catch
		{
			Console.WriteLine("Falling back to DemoRFGen");
			RegisterDevice("cavity_detuning", new PythonDevice("Devices/DemoRFGen.py"));
		}
		try
		{
			RegisterDevice("pressure", new PythonDevice("Devices/PfeifferPressureSensor.py", new { port = "COM4" }));
		}
		catch
		{
			Console.WriteLine("Falling back to DemoPressureSensor");
			RegisterDevice("pressure", new PythonDevice("Devices/DemoPressureSensor.py"));
		}
		try
		{
			RegisterDevice("elliptec", new PythonDevice("Devices/Elliptec.py", new { port = "COM3", channels = new object[] { new { type = "rotation", address = "A" }, new { type = "rotation", address = "B" }, new { type = "rotation", address = "C" }, new { type = "rotation", address = "D" } } }));
		}
		catch
		{
			Console.WriteLine("Falling back to DemoElliptec");
			RegisterDevice("elliptec", new PythonDevice("Devices/DemoElliptec.py"));
		}
		RegisterDevice("main", MainDevice);

		LoadSettings();

		RegisterAddon(new PressureUploader("pressure", 1, "https://pressure.cavity.at/api/updatePressure", "my-api-key", TimeSpan.FromMinutes(1)));
	}

	public void RegisterDevice(string deviceId, IDeviceHandler deviceHandler)
	{
		Devices.Add(deviceId, deviceHandler);
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

	public void RegisterAddon(IAddon addon)
	{
		Addons.Add(addon);
		Task.Run(() => addon.DoWork(this, GlobalCancellationTokenSource.Token));
	}

	public void UnregisterDevice(IDeviceHandler deviceHandler)
	{
		var deviceId = GetDeviceId(deviceHandler);
		if (deviceId == null) return;
		Devices.Remove(deviceId);
		deviceHandler.Dispose();
	}

	public void Action(DeviceAction action)
	{
		Devices[action.DeviceId].HandleActionAsync(action);
		UpdateQueue.Add(action.DeviceId);
		if (UpdateTimer == null)
		{
			UpdateTimer = new Timer(UpdateDevices, null, TimeSpan.FromSeconds(MaxUpdateDelay), TimeSpan.Zero);
		}
	}

	public object Request(DeviceAction action)
	{
		return Devices[action.DeviceId].HandleActionAsync(action);
	}

	public Dictionary<string, object> GetFullState()
	{
		var state = new Dictionary<string, object>();
		foreach (var (deviceId, device) in Devices)
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
		return Devices.FirstOrDefault(x => x.Value == deviceHandler).Key;
	}

	public void SendStreamData<T>(string deviceId, Func<T, Dictionary<object, object>?, object> filter, T data)
	{
		foreach (var (connectionId, customizations) in StreamingContexts)
		{
			// NOTE: payload and deviceId are switched in order to not have a varying byte offset of the payload (and potential 4-byte-alignment issues)
			if (customizations.TryGetValue(deviceId, out var customization))
			{
				StreamingHub.Clients.Client(connectionId).SendAsync("StreamData", filter(data, customization), deviceId);
			}
			else
			{
				StreamingHub.Clients.Client(connectionId).SendAsync("StreamData", filter(data, null), deviceId);
			}
		}
	}

	public void UpdateDevices(object? _ = null)
	{
		UpdateTimer = null;
		var state = new Dictionary<string, object>();
		foreach (var deviceId in UpdateQueue)
		{
			state[deviceId] = Devices[deviceId].GetState();
		}
		UpdateQueue.Clear();
		SendPartialStateUpdateAsync(state);
	}

	private ConcurrentDictionary<string, object> GetSnapshot(Func<string, Stream>? getStream = null)
	{
		var snapshot = new ConcurrentDictionary<string, object>();
		Parallel.ForEach(Devices, (kvp) =>
		{
			var (deviceId, device) = kvp;
			var stateToWrite = device.OnSaveSnapshot(getStream, deviceId);
			if (stateToWrite != null)
			{
				snapshot[deviceId] = stateToWrite;
			}
		});
		return snapshot;
	}

	public void SaveSnapshot(string baseFilepath)
	{
		foreach (var (_, device) in Devices)
		{
			device.OnBeforeSaveSnapshot();
		}
		var tmpFolderName = Path.Join(Path.GetTempPath(), Path.GetRandomFileName());
		Directory.CreateDirectory(tmpFolderName);
		var fileStreams = new ConcurrentDictionary<string, FileStream>();
		Stream getStream(string filename)
		{
			fileStreams[filename] = new FileStream(Path.Join(tmpFolderName, filename), FileMode.OpenOrCreate);
			return fileStreams[filename];
		}
		var state = GetSnapshot(getStream);
		foreach (var (_, device) in Devices)
		{
			device.OnAfterSaveSnapshot();
		}

		var yaml = yamlSerializer.Serialize(state);
		File.WriteAllText($"{baseFilepath}.yaml", yaml);

		if (fileStreams.Count == 0) return;
		Task.Run(() =>
		{
			Console.WriteLine("Saving snapshot to npz...");
			MainDevice.AddPendingAction();
			try
			{
				using var npzFile = new ZipArchive(new FileStream($"{baseFilepath}.npz", FileMode.CreateNew), ZipArchiveMode.Create);
				fileStreams.Where((s) => s.Value.Length > 0).ToList().ForEach(x =>
				{
					x.Value.Position = 0;
					var entry = npzFile.CreateEntry(x.Key, CompressionLevel.Fastest);
					var entryStream = entry.Open();
					x.Value.CopyTo(entryStream);
					entryStream.Dispose();
					x.Value.Dispose();
					File.Delete(x.Value.Name);
				});
				MainDevice.FinishPendingAction();
				Console.WriteLine("Snapshot saved.");
				Directory.Delete(tmpFolderName);
			}
			catch (Exception e)
			{
				Console.WriteLine("Error saving snapshot: " + e.Message);
			}
		});
	}

	public bool IsRecording = false;
	public void Record(string baseFilepath, CancellationToken cancellationToken)
	{
		if (IsRecording) throw new NotSupportedException("Already recording.");
		IsRecording = true;

		var yamlStream = new FileStream($"{baseFilepath}.yaml", FileMode.CreateNew);

		var tmpFolderName = Path.Join(Path.GetTempPath(), Path.GetRandomFileName());
		Directory.CreateDirectory(tmpFolderName);
		var recordingStreams = new ConcurrentDictionary<string, FileStream>();
		Stream getStream(string filename)
		{
			recordingStreams[filename] = new FileStream(Path.Join(tmpFolderName, filename), FileMode.OpenOrCreate);
			return recordingStreams[filename];
		}

		var recordingTasks = Devices.Select((kvp, _) =>
		{
			var (deviceId, device) = kvp;
			return device.OnRecord(getStream, deviceId, cancellationToken);
		}).Append(Task.Run(() =>
		{
			var timestampStart = DateTime.Now;
			while (!cancellationToken.IsCancellationRequested)
			{
				var state = GetSnapshot();
				var timestamp = DateTime.Now;
				var elapsed = (timestamp - timestampStart).TotalSeconds;

				yamlStream.Write(
					Encoding.UTF8.GetBytes(
						yamlSerializer.Serialize(
							new object[] { new {
								time = timestamp.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
								t = elapsed,
								state,
							} }
						)
					)
				);
				Thread.Sleep(500);
			}
			yamlStream.Dispose();
		})).ToArray();

		Task.Run(() =>
		{
			cancellationToken.WaitHandle.WaitOne();

			IsRecording = false;

			if (recordingStreams.Count == 0) return;
			MainDevice.AddPendingAction();

			Task.WaitAll(recordingTasks);

			Console.WriteLine("Saving recording to npz...");
			try
			{
				using var npzFile = new ZipArchive(new FileStream($"{baseFilepath}.npz", FileMode.CreateNew), ZipArchiveMode.Create);
				recordingStreams.Where((s) => s.Value.Length > 0).ToList().ForEach(x =>
				{
					x.Value.Position = 0;
					var entry = npzFile.CreateEntry(x.Key, CompressionLevel.Fastest);
					var entryStream = entry.Open();
					x.Value.CopyTo(entryStream);
					entryStream.Dispose();
					x.Value.Dispose();
					File.Delete(x.Value.Name);
				});
				MainDevice.FinishPendingAction();
				Console.WriteLine("Recording saved.");
				Directory.Delete(tmpFolderName);
			}
			catch (Exception e)
			{
				Console.WriteLine("Error saving recording: " + e.Message);
			}
		});
	}

	private void SaveSettings()
	{
		var state = new Dictionary<string, dynamic>();
		foreach (var (deviceId, device) in Devices)
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
				if (Devices.ContainsKey(deviceId))
				{
					Devices[deviceId].LoadSettings(setting);
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
		GlobalCancellationTokenSource.Cancel();
		SaveSettings();
		foreach (var (_, device) in Devices)
		{
			device.Dispose();
		}
		Devices.Clear();
	}
}
