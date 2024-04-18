using System.Reflection;

public interface IDeviceHandler
{
    object HandleActionAsync(DeviceAction action);
    object GetState();
    void SubscribeToStateUpdates(Action<object> onStateUpdate);
    void SubscribeToStreamEvents(Action<object> onStreamEvent);
}

public abstract class DeviceHandlerBase<TState> : IDeviceHandler where TState : class, new()
{
    private readonly Dictionary<string, MethodInfo> _methodCache = new();
    protected TState _state = new TState();
    private event Action<object>? _onStateUpdate;
    private event Action<object>? _onStreamEvent;
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
                // Check if method parameters match expected action parameters
                // and adjust as needed before invoking
                return method.Invoke(this, action.Parameters) ?? new object();
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
}