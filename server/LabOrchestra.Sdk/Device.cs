using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace LabOrchestra.Sdk;

/// <summary>Marks a device class as a driver that can be named in devices.json: <c>{"driver": "name"}</c>.</summary>
[AttributeUsage(AttributeTargets.Class, Inherited = false)]
public sealed class DriverAttribute(string name) : Attribute
{
	public string Name { get; } = name;
	public string? Description { get; init; }
}

/// <summary>Makes a public method callable from the dashboard, scripts and other devices (as snake_case: SetFftLength -> set_fft_length).</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class ActionAttribute : Attribute;

/// <summary>
/// A device that runs inside the server (for speed: an oscilloscope cannot afford a process boundary). It behaves like every other
/// device: options from devices.json, a state that is published when it changes, actions, logs, restart when it fails.
/// </summary>
public abstract class Device
{
	/// <summary>The id of the device in devices.json (set by the server).</summary>
	public string Id { get; private set; } = "";
	public ILogger Log { get; private set; } = NullLogger.Instance;
	/// <summary>Held while the state is read or changed; use <see cref="Device{TOptions,TState}.Update"/>.</summary>
	public object StateLock { get; } = new();

	public abstract object OptionsObject { get; }
	public abstract object StateObject { get; }
	public abstract void SetOptions(object options);

	/// <summary>Raised when the state changed; the server collects and publishes it.</summary>
	public event Action? StateChanged;

	/// <summary>Streams of this device (frames for displays); see <see cref="IStreamSource"/>.</summary>
	public StreamRegistry Streams { get; } = new();

	/// <summary>Used by the server before the device is started.</summary>
	public void Attach(string id, ILogger log)
	{
		Id = id;
		Log = log;
	}

	/// <summary>Open hardware. Throw to say why the device cannot start.</summary>
	public virtual Task ConnectAsync(CancellationToken cancel) => Task.CompletedTask;

	/// <summary>The long-running loop; returns when cancelled. An exception means the device failed and is restarted.</summary>
	public virtual Task RunAsync(CancellationToken cancel) => Task.CompletedTask;

	/// <summary>Release hardware after RunAsync ended.</summary>
	public virtual Task CloseAsync() => Task.CompletedTask;

	/// <summary>Called when a recording starts / stops (see <see cref="IRecordingSession"/>): write the data of the device that belongs in it.</summary>
	public virtual Task OnRecordingStartAsync(IRecordingSession session) => Task.CompletedTask;
	public virtual Task OnRecordingStopAsync(IRecordingSession session) => Task.CompletedTask;

	protected void NotifyChanged() => StateChanged?.Invoke();
}

/// <summary>Options are the public properties of <typeparamref name="TOptions"/> (a <c>required</c> property is a required option),
/// the state is the public properties of <typeparamref name="TState"/>. Names are snake_case on the wire.</summary>
public abstract class Device<TOptions, TState> : Device where TOptions : class, new() where TState : class, new()
{
	public TOptions Options { get; private set; } = new();
	public TState State { get; } = new();

	public override object OptionsObject => Options;
	public override object StateObject => State;
	public override void SetOptions(object options) => Options = (TOptions)options;

	/// <summary>Change the state (under the lock) and publish the change.</summary>
	protected void Update(Action<TState> change)
	{
		lock (StateLock) change(State);
		NotifyChanged();
	}

	protected T Read<T>(Func<TState, T> read)
	{
		lock (StateLock) return read(State);
	}
}
