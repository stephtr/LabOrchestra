using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using LabOrchestra.Hubs;
using Microsoft.AspNetCore.SignalR;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;
using YamlDotNet.System.Text.Json;

public record DeviceAction(string DeviceId, string? ChannelId, string ActionName, object[]? Parameters);

public class DeviceManager : IDisposable
{
	private bool useSystemTempFolder = false;
	private bool SaveToNpz = false;

	private readonly IHubContext<ControlHub> ControlHub;
	private readonly IHubContext<StreamingHub> StreamingHub;
	public Dictionary<string, IDeviceHandler> Devices = new();
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

	public DeviceManager(IHubContext<ControlHub> controlHub, IHubContext<StreamingHub> streamingHub, AccessControlService accessControlService)
	{
		ControlHub = controlHub;
		StreamingHub = streamingHub;
		RegisterDevice("constants", new CoherentScatteringConstantsDevice());
		RegisterDevice("camera", new DemoCamera());

		RegisterDevice("main", MainDevice);

		LoadSettings();

		accessControlService.Passphrase = MainDevice.Passphrase;
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

	public void UnregisterDevice(IDeviceHandler deviceHandler)
	{
		var deviceId = GetDeviceId(deviceHandler);
		if (deviceId == null) return;
		Devices.Remove(deviceId);
		deviceHandler.Dispose();
	}

	public void Action(DeviceAction action)
	{
		var success = Devices.TryGetValue(action.DeviceId, out var device);
		if (!success) throw new ArgumentOutOfRangeException($"Device with ID '{action.DeviceId}' not found.");
		device!.HandleActionAsync(action);
		UpdateQueue.Add(action.DeviceId);
		if (UpdateTimer == null)
		{
			UpdateTimer = new Timer(UpdateDevices, null, TimeSpan.FromSeconds(MaxUpdateDelay), TimeSpan.Zero);
		}
	}

	public object Request(DeviceAction action)
	{
		var success = Devices.TryGetValue(action.DeviceId, out var device);
		if (!success) throw new ArgumentOutOfRangeException($"Device with ID '{action.DeviceId}' not found.");
		return device!.HandleActionAsync(action);
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
		StreamingHub.Clients.All.SendAsync("StreamData", data, deviceId);
	}

	public string GetDeviceId(IDeviceHandler deviceHandler)
	{
		return Devices.FirstOrDefault(x => x.Value == deviceHandler).Key;
	}

	public void SendStreamData<T>(string deviceId, Func<T, Dictionary<object, object>?, object> filter, T data)
	{
		foreach (var (connectionId, customizations) in StreamingContexts)
		{
			try
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
			catch
			{
				// ignored; this might be an invalid
				Console.WriteLine("Error sending stream data to client.");
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
		var tmpFolderName = SaveToNpz ? (useSystemTempFolder ? Path.Combine(Path.GetTempPath(), Path.GetTempFileName()) : $"{baseFilepath}.tmp") : baseFilepath;
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

		if (SaveToNpz)
		{
			Task.Run(() =>
			{
				Console.WriteLine("Saving snapshot to npz...");
				MainDevice.AddPendingAction();
				try
				{
					using var npzFile = new ZipArchive(new FileStream($"{baseFilepath}.npz", FileMode.CreateNew), ZipArchiveMode.Create);
					foreach (var x in fileStreams.Where((s) => s.Value.Length > 0))
					{
						x.Value.Position = 0;
						var entry = npzFile.CreateEntry(x.Key, CompressionLevel.NoCompression);
						var entryStream = entry.Open();
						x.Value.CopyTo(entryStream);
						entryStream.Dispose();
						x.Value.Dispose();
						File.Delete(x.Value.Name);
					}
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
		else
		{
			foreach (var x in fileStreams.Values)
			{
				var filename = x.Name;
				var isEmpty = x.Length == 0;
				x.Dispose();
				if (isEmpty) File.Delete(filename);
			}
		}
	}

	public bool IsRecording = false;
	public bool DiscardRecording = false;
	public void Record(string baseFilepath, CancellationToken cancellationToken)
	{
		if (IsRecording) throw new NotSupportedException("Already recording.");
		IsRecording = true;
		DiscardRecording = false;

		var yamlStream = new FileStream($"{baseFilepath}.yaml", FileMode.CreateNew);

		var tmpFolderName = SaveToNpz ? (useSystemTempFolder ? Path.Combine(Path.GetTempPath(), Path.GetTempFileName()) : $"{baseFilepath}.tmp") : baseFilepath;
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

		cancellationToken.Register(async () =>
		{
			IsRecording = false;

			MainDevice.AddPendingAction();

			await Task.WhenAll(recordingTasks);

			if (DiscardRecording)
			{
				foreach (var x in recordingStreams.Values)
				{
					var filename = x.Name;
					x.Dispose();
					File.Delete(filename);
				}
				Directory.Delete(tmpFolderName);
				File.Delete($"{baseFilepath}.yaml");
			}
			else
			{
				if (SaveToNpz)
				{
					Console.WriteLine("Saving recording to npz...");
					try
					{
						if (recordingStreams.Count > 0)
						{
							using var npzFile = new ZipArchive(new FileStream($"{baseFilepath}.npz", FileMode.CreateNew), ZipArchiveMode.Create);
							foreach (var x in recordingStreams)
							{
								var filename = x.Value.Name;
								var isEmpty = x.Value.Length == 0;
								if (!isEmpty)
								{
									x.Value.Position = 0;
									var entry = npzFile.CreateEntry(x.Key, CompressionLevel.NoCompression);
									var entryStream = entry.Open();
									await x.Value.CopyToAsync(entryStream);
									entryStream.Dispose();
								}
								x.Value.Dispose();
								File.Delete(x.Value.Name);
							}
						}
						Console.WriteLine("Recording saved.");
						Directory.Delete(tmpFolderName);
					}
					catch (Exception e)
					{
						Console.WriteLine("Error saving recording: " + e.Message);
					}
				}
				else
				{
					var numStreams = 0;
					foreach (var x in recordingStreams.Values)
					{
						var filename = x.Name;
						var isEmpty = x.Length == 0;
						x.Dispose();
						if (isEmpty)
						{
							File.Delete(filename);
						}
						else
						{
							numStreams++;
						}
					}
					if (numStreams == 0)
					{
						Directory.Delete(tmpFolderName);
					}
				}
			}
			MainDevice.FinishPendingAction();
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
		var settings = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText("settings.json"));
		if (settings == null) return;
		foreach (var (deviceId, settingObject) in settings)
		{
			try
			{
				dynamic setting = settingObject;
				if (Devices.TryGetValue(deviceId, out var device))
				{
					device.LoadSettings(setting);
				}
			}
			catch (Exception e)
			{
				Console.WriteLine("Error loading settings: " + e.Message);
			}
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
