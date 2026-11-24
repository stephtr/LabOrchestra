using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using LabOrchestra.Sdk;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Logging;

namespace LabOrchestra.Server.Drivers;

/// <summary>An error of an action of an in-process device, with the type and traceback the caller should see.</summary>
public sealed class DeviceActionException(string type, string message, string? traceback) : Exception(message)
{
	public string Type { get; } = type;
	public string? Traceback { get; } = traceback;
}

/// <summary>Runs one C# device inside the server and makes it look like any other device: registers it with its schema, publishes its
/// state as patches (collected for 50 ms, with the caller of the action that caused them), answers actions, writes its log.</summary>
public sealed class InProcessDevice(string id, DeviceConfig config, Type driver, DeviceRegistry registry, LogStore logs)
{
	public const string ConnectionPrefix = "local:";
	private static readonly AsyncLocal<string?> Caller = new();

	private readonly string _connection = $"{ConnectionPrefix}{id}:{Guid.NewGuid():N}";
	private readonly SemaphoreSlim _flushGate = new(1, 1);
	private readonly SemaphoreSlim _dirty = new(0);
	private readonly HashSet<string> _callers = new();
	private IReadOnlyDictionary<string, ActionInfo> _actions = new Dictionary<string, ActionInfo>();
	private Device _device = null!;
	private Dictionary<string, object?> _sent = new();
	private int _dirtyFlag;

	public Device Device => _device;

	/// <summary>Starts the device and keeps it running until <paramref name="stop"/>; throws if it cannot start or fails.</summary>
	public async Task RunAsync(CancellationToken stop)
	{
		_device = (Device)Activator.CreateInstance(driver)!;
		_device.Attach(id, new DeviceLogger(id, logs));
		_device.SetOptions(ParseOptions());
		_actions = DriverSchema.Actions(driver);
		var schema = DriverSchema.Build(id, driver);
		((List<object?>)schema["streams"]!).AddRange(_device.Streams.Names());

		await _device.ConnectAsync(stop);
		schema["streams"] = _device.Streams.Names().Cast<object?>().ToList();
		_sent = Snapshot();
		registry.Registered(id, _connection, schema, _sent);
		registry.SetLocalCall(id, _connection, Invoke, _device.Streams, _device);
		_device.StateChanged += OnChanged;
		using var publishing = CancellationTokenSource.CreateLinkedTokenSource(stop);
		var publisher = Task.Run(() => PublishLoopAsync(publishing.Token), CancellationToken.None);
		try
		{
			var run = _device.RunAsync(stop);
			var stopped = Task.Delay(Timeout.Infinite, stop);
			await Task.WhenAny(run, stopped);
			if (run.IsFaulted) ExceptionDispatchInfo.Capture(run.Exception!.InnerException!).Throw();
			if (!run.IsCompleted) await run.ConfigureAwait(false);
			else await stopped.ConfigureAwait(false); // RunAsync had nothing to do: the device stays until it is stopped
		}
		catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
		finally
		{
			_device.StateChanged -= OnChanged;
			publishing.Cancel();
			try { await publisher; } catch (OperationCanceledException) { }
			try { await _device.CloseAsync(); }
			catch (Exception e) { logs.Add($"device:{id}", "ERROR", "supervisor", $"CloseAsync failed: {e.Message}", e.ToString()); }
		}
	}

	private object ParseOptions()
	{
		var (optionsType, _) = DriverSchema.TypesOf(driver);
		try
		{
			var json = config.Config is null ? "{}" : JsonSerializer.Serialize(config.Config);
			return JsonSerializer.Deserialize(json, optionsType, Wire.Json)!;
		}
		catch (JsonException e)
		{
			throw new InvalidOperationException($"The options of '{id}' are not valid: {e.Message}");
		}
	}

	private Dictionary<string, object?> Snapshot()
	{
		JsonElement element;
		lock (_device.StateLock) element = JsonSerializer.SerializeToElement(_device.StateObject, Wire.Json);
		return (Dictionary<string, object?>)Plain.FromJson(element)!;
	}

	private void OnChanged()
	{
		if (Caller.Value is { } caller) lock (_callers) _callers.Add(caller);
		if (Interlocked.Exchange(ref _dirtyFlag, 1) == 0) _dirty.Release();
	}

	private async Task PublishLoopAsync(CancellationToken cancel)
	{
		while (true)
		{
			await _dirty.WaitAsync(cancel);
			await Task.Delay(50, cancel); // collect further changes
			await FlushAsync();
		}
	}

	private async Task FlushAsync()
	{
		await _flushGate.WaitAsync();
		try
		{
			Interlocked.Exchange(ref _dirtyFlag, 0);
			var now = Snapshot();
			var patch = StateDiff.Diff(_sent, now);
			string by;
			lock (_callers) { by = _callers.Count == 0 ? "device" : string.Join(',', _callers.Order()); _callers.Clear(); }
			if (patch is null) return;
			registry.StatePatched(id, _connection, patch, by);
			_sent = now;
		}
		finally { _flushGate.Release(); }
	}

	/// <summary>An action called by someone. When it returns, its effects are already in the state the caller sees.</summary>
	private async Task<object?> Invoke(string name, object?[] args, string caller, CancellationToken cancel)
	{
		if (!_actions.TryGetValue(name, out var action))
			throw new DeviceActionException("LookupError", $"Device '{id}' has no action '{name}' (actions: {string.Join(", ", _actions.Keys)})", null);
		Caller.Value = caller;
		try
		{
			var arguments = Arguments(action, args, cancel);
			var result = action.Method.Invoke(_device, arguments);
			if (result is Task task)
			{
				await task;
				result = task.GetType().IsGenericType ? task.GetType().GetProperty("Result")!.GetValue(task) : null;
			}
			await FlushAsync();
			return result is null ? null : Plain.FromJson(JsonSerializer.SerializeToElement(result, Wire.Json));
		}
		catch (Exception e)
		{
			var cause = e is TargetInvocationException { InnerException: { } inner } ? inner : e;
			if (cause is DeviceActionException) throw cause;
			_device.Log.LogWarning(cause, "Action {Action} failed: {Type}: {Message}", name, cause.GetType().Name, cause.Message);
			await FlushAsync(); // what the action changed before it failed
			throw new DeviceActionException(cause is ArgumentException or FormatException or JsonException ? "ValueError" : cause.GetType().Name, cause.Message, cause.ToString());
		}
		finally { Caller.Value = null; }
	}

	private object?[] Arguments(ActionInfo action, object?[] given, CancellationToken cancel)
	{
		if (given.Length > action.Parameters.Length)
			throw new ArgumentException($"{action.Name}() takes {action.Parameters.Length} argument(s), got {given.Length}");
		var all = action.Method.GetParameters();
		var result = new object?[all.Length];
		var next = 0;
		for (var i = 0; i < all.Length; i++)
		{
			var parameter = all[i];
			if (parameter.ParameterType == typeof(CancellationToken)) { result[i] = cancel; continue; }
			if (next < given.Length)
			{
				try
				{
					var json = JsonSerializer.SerializeToElement(Plain.From(given[next]));
					result[i] = JsonSerializer.Deserialize(json, parameter.ParameterType, Wire.Json);
				}
				catch (JsonException)
				{
					throw new ArgumentException($"Parameter '{Wire.Name(parameter.Name!)}' must be {DriverSchema.TypeName(parameter.ParameterType)}");
				}
				next++;
			}
			else if (parameter.HasDefaultValue) result[i] = parameter.DefaultValue;
			else throw new ArgumentException($"{action.Name}() is missing the argument '{Wire.Name(parameter.Name!)}'");
		}
		return result;
	}
}
