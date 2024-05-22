using System.IO.Compression;
using System.Text.Json;
using Python.Runtime;

public class PythonDevice : IDeviceHandler
{
	private readonly Dictionary<string, PyObject> MethodCache = new();
	private event Action<object>? OnStateUpdate;
	private event Action<object>? OnStreamEvent;
	protected DeviceManager? DeviceManager;
	private PyModule PyModule;
	public PythonDevice(string filename)
	{
		using (Py.GIL())
		{
			PyModule = Py.CreateScope();
			PyModule.Import("json", "_json");
			PyModule.Set("_send_status_update", new Action<string>(SendStateUpdate));
			PyModule.Exec("def send_status_update(partial_state=None): _send_status_update(_json.dumps(partial_state if partial_state else state))");
			PyModule.Exec("def _get_state(): return _json.dumps(state)");

			var script = File.ReadAllText(filename);
			PyModule.Exec(script);

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
			Task.Run(() =>
			{
				using (Py.GIL())
				{
					MethodCache["main"].Invoke();
				}
			});
		}
	}

	public object GetState()
	{
		using (Py.GIL())
		{
			string stateJson = MethodCache["_get_state"].Invoke().As<string>();
			return JsonSerializer.Deserialize<dynamic>(stateJson) ?? new object();
		}
	}

	public object HandleActionAsync(DeviceAction action)
	{
		var actionName = action.ActionName.ToLower();
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

	public void Dispose()
	{
		PyModule.Dispose();
	}

	public object? OnSaveSnapshot(Func<string, Stream> getStream, string deviceId) { return null; }
	virtual public void OnBeforeSaveSnapshot() { }
	virtual public void OnAfterSaveSnapshot() { }
	virtual public object? GetSettings() { return null; }
	virtual public void LoadSettings(JsonElement settings) { }
}
