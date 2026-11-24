using System.Dynamic;
using System.Text.Json;
using Python.Runtime;

public static class JsonElementExtensions
{
	public static dynamic? ToDynamic(this JsonElement element)
	{
		if (element.ValueKind == JsonValueKind.Object)
		{
			var expando = new ExpandoObject() as IDictionary<string, object>;
			foreach (var property in element.EnumerateObject())
			{
				expando.Add(property.Name, property.Value.ToDynamic());
			}
			return expando;
		}
		else if (element.ValueKind == JsonValueKind.Array)
		{
			var list = new List<object>();
			foreach (var item in element.EnumerateArray())
			{
				list.Add(item.ToDynamic());
			}
			return list;
		}
		else if (element.ValueKind == JsonValueKind.Number)
		{
			if (element.TryGetInt32(out int intVal))
			{
				return intVal;
			}
			if (element.TryGetInt64(out long longVal))
			{
				return longVal;
			}
			return element.GetDouble();
		}
		else
		{
			return element.ValueKind switch
			{
				JsonValueKind.String => element.GetString(),
				JsonValueKind.Number => element.GetDecimal(), // Change to GetInt32() or others if needed
				JsonValueKind.True => true,
				JsonValueKind.False => false,
				JsonValueKind.Null => null,
				_ => element,
			};
		}
	}
}

public class PythonDevice : IDeviceHandler
{
	private readonly Dictionary<string, PyObject> MethodCache = new();
	private event Action<object>? OnStateUpdate;
	private event Action<object>? OnStreamEvent;
	protected DeviceManager? DeviceManager;
	private PyModule PyModule;
	public PythonDevice(string filename, object? arguments = null)
	{
		using (Py.GIL())
		{
			PyModule = Py.CreateScope();
			PyModule.Import("json", "_json");
			PyModule.Exec("state = None");
			PyModule.Set("_send_status_update", new Action<string>(SendStateUpdate));
			PyModule.Exec("def send_status_update(partial_state=None): _send_status_update(_json.dumps(partial_state if partial_state else state))");
			PyModule.Exec("def _get_state(): return _json.dumps(state)");
			PyModule.Exec("def _on_save_snapshot(): return _json.dumps(on_save_snapshot())");
			PyModule.Set("_get_device_state", (string deviceName) =>
				{
					var device = DeviceManager?.Devices[deviceName];
					if (device == null) throw new ArgumentException($"Device {deviceName} doesn't exist.");
					return JsonSerializer.Serialize(device.GetState());
				});
			PyModule.Exec("def get_device_state(device_name): return _json.loads(_get_device_state(device_name))");
			PyModule.Set("action", (string deviceId, string? channelId, string actionName, object[]? parameters) => DeviceManager?.Action(new DeviceAction(deviceId, channelId, actionName, parameters)));
			PyModule.Set("_request", (string deviceId, string? channelId, string actionName, object[]? parameters) => JsonSerializer.Serialize(DeviceManager?.Request(new DeviceAction(deviceId, channelId, actionName, parameters))));
			PyModule.Exec("def request(device_id, channel_id, action_name, parameters): return _json.loads(_request(device_id, channel_id, action_name, parameters))");
			PyModule.Set("print", (string text) => Console.WriteLine(text));
			PyModule.Exec("def _get_settings(): return _json.dumps(get_settings())");
			PyModule.Exec("def _load_settings(settings): load_settings(_json.loads(settings))");
			PyModule.Set("is_running", true);

			if (arguments != null)
			{
				PyModule.Set("argv", arguments.ToPython());
			}

			var script = File.ReadAllText(filename);
			try
			{
				PyModule.Exec(script);
			}
			catch (PythonException e)
			{
				Console.WriteLine($"PythonDevice error: {e.Message}\n{e.StackTrace}");
				Dispose();
				throw;
			}

			dynamic inspect = Py.Import("inspect");
			foreach (var name in PyModule.Dir())
			{
				var functionName = name.ToString();
				if (functionName == null) continue;
				var function = PyModule.Get(functionName);
				if (inspect.isfunction(function).As<bool>())
				{
					MethodCache[functionName.ToLower()] = function;
				}
			}
		}
		if (MethodCache.ContainsKey("main"))
		{
			Task.Factory.StartNew(() =>
			{
				try
				{
					using (Py.GIL())
					{
						MethodCache["main"].Invoke();
					}
				}
				catch (PythonException e)
				{
					Console.WriteLine($"PythonDevice error: {e.Message}\n{e.StackTrace}");
					Dispose();
				}
			}, TaskCreationOptions.LongRunning);
		}
	}

	public object GetState()
	{
		using (Py.GIL())
		{
			string stateJson = MethodCache["_get_state"].Invoke().As<string>();
			return JsonSerializer.Deserialize<JsonElement>(stateJson).ToDynamic() ?? new object();
		}
	}

	public object HandleActionAsync(DeviceAction action)
	{
		var actionName = action.ActionName.ToLower();
		if (actionName == "getstate")
		{
			return GetState();
		}
		if (MethodCache.TryGetValue(actionName, out var method))
		{
			try
			{
				using (Py.GIL())
				{
					return method.Invoke(action.Parameters?.Select(x => x.ToPython()).ToArray() ?? []);
				}
			}
			catch (Exception ex)
			{
				throw new InvalidOperationException($"Failed to invoke action method {action.ActionName}.", ex);
			}
		}
		else
		{
			throw new InvalidOperationException($"Action method {action.ActionName} not found.");
		}
	}

	public void SubscribeToStateUpdates(Action<object> onStateUpdate)
	{
		OnStateUpdate += onStateUpdate;
	}

	public void SubscribeToStreamEvents(Action<object> onStreamEvent)
	{
		OnStreamEvent += onStreamEvent;
	}

	public void SendStateUpdate(string serializedPartialState)
	{
		OnStateUpdate?.Invoke(JsonSerializer.Deserialize<dynamic>(serializedPartialState)!);
	}

	public void SendStreamData(object data)
	{
		OnStreamEvent?.Invoke(data);
	}

	public void SetDeviceManager(DeviceManager deviceManager)
	{
		DeviceManager = deviceManager;
	}

	private bool HasBeenDisposed = false;
	public void Dispose()
	{
		if (HasBeenDisposed) return;
		HasBeenDisposed = true;
		DeviceManager?.UnregisterDevice(this);
		using (Py.GIL())
		{
			PyModule.Set("is_running", false);
			Thread.Sleep(10);
			PyModule.Dispose();
		}
	}

	public object? OnSaveSnapshot(Func<string, Stream>? getStream, string deviceId)
	{
		using (Py.GIL())
		{
			// here we intentionally use the prefixed snapshot function to get the snapshot as JSON
			var methodName = MethodCache.ContainsKey("on_save_snapshot") ? "_on_save_snapshot" : "_get_state";
			var snapshotJson = MethodCache[methodName].Invoke().As<string>();
			return JsonSerializer.Deserialize<dynamic>(snapshotJson) ?? null;
		}
	}

	virtual public void OnBeforeSaveSnapshot() { }
	virtual public void OnAfterSaveSnapshot() { }
	virtual public Task OnRecord(Func<string, Stream> getStream, string deviceId, CancellationToken cancellationToken) { return Task.CompletedTask; }
	public object? GetSettings()
	{
		using (Py.GIL())
		{
			if (!MethodCache.ContainsKey("get_settings")) return null;
			var settings = MethodCache["_get_settings"].Invoke().As<string>();
			return JsonSerializer.Deserialize<dynamic>(settings) ?? null;
		}
	}
	public void LoadSettings(JsonElement settings)
	{
		using (Py.GIL())
		{
			if (!MethodCache.ContainsKey("load_settings")) return;
			MethodCache["_load_settings"].Invoke(JsonSerializer.Serialize(settings).ToPython());
		}
	}
}
