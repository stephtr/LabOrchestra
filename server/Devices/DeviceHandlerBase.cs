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
	object? OnSaveSnapshot(Func<string, Stream>? getStream, string deviceId);
	void OnStartRecording(Func<string, Stream> getStream, string deviceId);
	void OnStopRecording(Func<string, Stream> getStream, string deviceId);
	object? GetSettings();
	void LoadSettings(JsonElement settings);
}

public abstract class DeviceHandlerBase<TState> : IDeviceHandler where TState : class, new()
{
	private readonly Dictionary<string, MethodInfo> MethodCache = new();
	protected TState State = new TState();
	private event Action<object>? OnStateUpdate;
	private event Action<object>? OnStreamEvent;
	protected DeviceManager? DeviceManager;
	protected DeviceHandlerBase()
	{
		// Populate the method cache with the derived type's methods
		var methods = GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance);
		foreach (var method in methods)
		{
			if (!MethodCache.ContainsKey(method.Name.ToLower()))
			{
				MethodCache[method.Name.ToLower()] = method;
			}
		}
	}

	public object GetState()
	{
		return State;
	}

	public object HandleActionAsync(DeviceAction action)
	{
		var actionName = action.ActionName.ToLower();
		if (MethodCache.TryGetValue(actionName, out var method))
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
		OnStateUpdate += onStateUpdate;
	}

	public void SubscribeToStreamEvents(Action<object> onStreamEvent)
	{
		OnStreamEvent += onStreamEvent;
	}

	public void SendStateUpdate(object partialState)
	{
		OnStateUpdate?.Invoke(partialState);
	}

	public void SendStreamData(object data)
	{
		OnStreamEvent?.Invoke(data);
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
		DeviceManager = deviceManager;
	}

	virtual public void Dispose() { }

	virtual public object? OnSaveSnapshot(Func<string, Stream>? getStream, string deviceId) { return null; }
	virtual public void OnStartRecording(Func<string, Stream> getStream, string deviceId) { }
	virtual public void OnStopRecording(Func<string, Stream> getStream, string deviceId) { }
	virtual public void OnBeforeSaveSnapshot() { }
	virtual public void OnAfterSaveSnapshot() { }
	virtual public object? GetSettings() { return null; }
	virtual public void LoadSettings(JsonElement settings) { }
}
