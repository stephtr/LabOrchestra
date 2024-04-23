using System.IO.Compression;
using System.Text.Json;
using Python.Runtime;

public class PythonDevice : IDeviceHandler
{
	private readonly Dictionary<string, PyObject> _methodCache = new();
	private event Action<object>? _onStateUpdate;
	private event Action<object>? _onStreamEvent;
	protected DeviceManager? _deviceManager;
	private PyModule _pyModule;
	public PythonDevice(string filename)
	{
		using (Py.GIL())
		{
			_pyModule = Py.CreateScope();
			_pyModule.Import("json", "_json");
			_pyModule.Set("_send_status_update", new Action<string>(SendStateUpdate));
			_pyModule.Exec("def send_status_update(partial_state=None): _send_status_update(_json.dumps(partial_state if partial_state else state))");
			_pyModule.Exec("def _get_state(): return _json.dumps(state)");

			var script = File.ReadAllText(filename);
			_pyModule.Exec(script);

			dynamic inspect = Py.Import("inspect");
			foreach (var name in _pyModule.Dir())
			{
				var functionName = name.ToString();
				if (functionName == null) continue;
				var function = _pyModule.Get(functionName);
				if (inspect.isfunction(function).As<bool>())
				{
					_methodCache[functionName.ToLower()] = function;
				}
			}
		}
		if (_methodCache.ContainsKey("main"))
		{
			Task.Run(() =>
			{
				using (Py.GIL())
				{
					_methodCache["main"].Invoke();
				}
			});
		}
	}

	public object GetState()
	{
		using (Py.GIL())
		{
			string stateJson = _methodCache["_get_state"].Invoke().As<string>();
			return JsonSerializer.Deserialize<dynamic>(stateJson) ?? new object();
		}
	}

	public object HandleActionAsync(DeviceAction action)
	{
		var actionName = action.ActionName.ToLower();
		if (_methodCache.TryGetValue(actionName, out var method))
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
		_onStateUpdate += onStateUpdate;
	}

	public void SubscribeToStreamEvents(Action<object> onStreamEvent)
	{
		_onStreamEvent += onStreamEvent;
	}

	public void SendStateUpdate(string serializedPartialState)
	{
		_onStateUpdate?.Invoke(JsonSerializer.Deserialize<dynamic>(serializedPartialState)!);
	}

	public void SendStreamData(object data)
	{
		_onStreamEvent?.Invoke(data);
	}

	public void SetDeviceManager(DeviceManager deviceManager)
	{
		_deviceManager = deviceManager;
	}

	public void Dispose()
	{
		_pyModule.Dispose();
	}

	public object? OnSave(ZipArchive archive, string deviceId) { return null; }
	virtual public object? GetSettings() { return null; }
	virtual public void LoadSettings(JsonElement settings) { }
}
