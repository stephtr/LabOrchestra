using System.IO.Compression;
using System.Reflection;
using System.Text.Json;

public interface IDeviceHandler : IDisposable
{
	object HandleActionAsync(DeviceAction action);
	object GetState();
	void SubscribeToStateUpdates(Action<object> onStateUpdate);
	void SubscribeToStreamEvents(Action<object> onStreamEvent);
	void SetDeviceManager(DeviceManager deviceManager);
	void OnBeforeSaveSnapshot();
	void OnAfterSaveSnapshot();
	object? OnSaveSnapshot(ZipArchive archive, string deviceId);
	object? GetSettings();
	void LoadSettings(JsonElement settings);
}

public abstract class DeviceHandlerBase<TState> : IDeviceHandler where TState : class, new()
{
	private readonly Dictionary<string, MethodInfo> _methodCache = new();
	protected TState _state = new TState();
	private event Action<object>? _onStateUpdate;
	private event Action<object>? _onStreamEvent;
	protected DeviceManager? _deviceManager;
	protected DeviceHandlerBase()
	{
		// Populate the method cache with the derived type's methods
		var methods = GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance);
		foreach (var method in methods)
		{
			if (!_methodCache.ContainsKey(method.Name.ToLower()))
			{
				_methodCache[method.Name.ToLower()] = method;
			}
		}
	}

	public object GetState()
	{
		return _state;
	}

	public object HandleActionAsync(DeviceAction action)
	{
		var actionName = action.ActionName.ToLower();
		if (_methodCache.TryGetValue(actionName, out var method))
		{
			try
			{
				ParameterInfo[] parametersInfo = method.GetParameters();
				object[] parameters = new object[action.Parameters?.Length ?? 0];
				if (parametersInfo.Length != parameters.Length)
				{
					throw new InvalidOperationException($"Action method {action.ActionName} expects {parametersInfo.Length} parameters, but {parameters.Length} were provided.");
				}
				for (int i = 0; i < parametersInfo.Length; i++)
				{
					Type parameterType = parametersInfo[i].ParameterType;
					object parameterValue = action.Parameters![i];

					// Convert JsonElement to appropriate type if necessary
					if (parameterValue is JsonElement jsonElement)
					{
						parameters[i] = ConvertJsonElement(jsonElement, parameterType);
					}
					else
					{
						parameters[i] = Convert.ChangeType(parameterValue, parameterType);
					}
				}
				// Check if method parameters match expected action parameters
				// and adjust as needed before invoking
				return method.Invoke(this, parameters) ?? new object();
			}
			catch (Exception ex)
			{
				// Handle or log exception
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

	public void SendStateUpdate(object partialState)
	{
		_onStateUpdate?.Invoke(partialState);
	}

	public void SendStreamData(object data)
	{
		_onStreamEvent?.Invoke(data);
	}

	private static object ConvertJsonElement(JsonElement element, Type targetType)
	{
		// Add checks and conversions based on the targetType
		return (targetType switch
		{
			Type t when t == typeof(string) => element.GetString(),
			Type t when t == typeof(int) => element.GetInt32(),
			Type t when t == typeof(long) => element.GetInt64(),
			Type t when t == typeof(bool) => element.GetBoolean(),
			Type t when t == typeof(float) => element.GetSingle(),
			Type t when t == typeof(double) => element.GetDouble(),
			Type t when t == typeof(DateTime) => element.GetDateTime(),
			// Add other types as needed
			//_ => JsonSerializer.DeserializeObject(element.GetRawText(), targetType)
			_ => throw new Exception("Unsupported type")
		})!;
	}

	public void SetDeviceManager(DeviceManager deviceManager)
	{
		_deviceManager = deviceManager;
	}

	virtual public void Dispose() { }

	virtual public object? OnSaveSnapshot(ZipArchive archive, string deviceId) { return null; }
	virtual public void OnBeforeSaveSnapshot() { }
	virtual public void OnAfterSaveSnapshot() { }
	virtual public object? GetSettings() { return null; }
	virtual public void LoadSettings(JsonElement settings) { }
}
