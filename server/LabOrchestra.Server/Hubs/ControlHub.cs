using System.Text.Json;
using LabOrchestra.Server.Auth;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Events;
using LabOrchestra.Server.Recording;
using LabOrchestra.Server.Logging;
using LabOrchestra.Server.Supervision;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace LabOrchestra.Server.Hubs;

static class DeviceEntryExtensions
{
	/// <summary>Adds auto_restart when the entry sets it (an entry that does not say anything looks as before).</summary>
	public static Dictionary<string, object?> WithAutoRestart(this Dictionary<string, object?> map, DeviceConfig device)
	{
		if (device.AutoRestart is { } auto) map["auto_restart"] = auto;
		if (device.Remote == true) map["remote"] = true;
		return map;
	}
}

public static class Errors
{
	/// <summary>Errors cross the wire as JSON text: type, message and optionally the traceback of the original.</summary>
	public static string Json(string type, string message, string? traceback = null) => JsonSerializer.Serialize(new { type, message, traceback });

	/// <summary>Type and message of an error made by <see cref="Json"/> (and of a worker's, which has the same form).</summary>
	public static (string Type, string Message) Parse(string text)
	{
		try
		{
			using var doc = JsonDocument.Parse(text);
			return (doc.RootElement.GetProperty("type").GetString() ?? "Error", doc.RootElement.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "");
		}
		catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException) { return ("Error", text); }
	}
}

/// <summary>Connection of browsers, scripts and devices that talk to other devices.</summary>
[Authorize(Roles = $"{Roles.Client},{Roles.Device}")]
public sealed class ControlHub(
	DeviceRegistry registry,
	LogStore logs,
	SecretStore secrets,
	DeviceCatalog catalog,
	Drivers.DriverCatalog drivers,
	WorkerSupervisor supervisor,
	RecordingService recordings,
	Workspace workspace,
	EventBus bus,
	EventLog eventLog,
	ViewStore views,
	Devices.Scaffolder scaffolder,
	Widgets.WidgetService widgets,
	TokenStore tokenStore,
	Supervision.EnvironmentManager environments,
	IHubContext<DeviceHub> devices) : Hub
{
	public override Task OnConnectedAsync()
	{
		// clients say what they are (?client=ui, ?client=script) so that changes can be attributed
		var name = Context.GetHttpContext()?.Request.Query["client"].ToString() ?? "";
		Context.Items["client"] = System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-z0-9_-]{1,32}$") ? name : "client";
		return base.OnConnectedAsync();
	}

	/// <summary>Who is calling: "ui", "script", ... for clients, "device:name" for devices.</summary>
	private string Caller() => Context.User?.FindFirst("device_id")?.Value is { } id ? $"device:{id}" : (string)Context.Items["client"]!;

	private static HubException Fail(Exception e) => new(Errors.Json(e is ArgumentException ? "ValueError" : "RecordingError", e.Message));

	/// <summary>Where the server looks for its devices: shown by the client when there are none.</summary>
	[HubMethodName("get_info")]
	public Dictionary<string, object?> GetInfo() => new()
	{
		["workspace"] = workspace.Path,
		["devices_file"] = workspace.HasDevicesFile,
		["version"] = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString(3),
	};

	/// <summary>All views of the dashboard by id (shared by every client), each as JSON text.</summary>
	[HubMethodName("get_views")]
	public Dictionary<string, string> GetViews() => ViewStore.AsText(views.All());

	[HubMethodName("save_view")]
	public void SaveView(string id, string json)
	{
		try { views.Save(id, System.Text.Json.Nodes.JsonNode.Parse(json) ?? throw new ArgumentException("empty view")); }
		catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.Text.Json.JsonException or IOException) { throw Fail(e); }
	}

	[HubMethodName("delete_view")]
	public void DeleteView(string id)
	{
		try { views.Delete(id); }
		catch (Exception e) when (e is ArgumentException or IOException) { throw Fail(e); }
	}

	[HubMethodName("get_recording")]
	public Dictionary<string, object?> GetRecording() => recordings.Status();

	[HubMethodName("list_recordings")]
	public List<Dictionary<string, object?>> ListRecordings(int limit) => recordings.List(Math.Clamp(limit, 1, 1000));

	[HubMethodName("start_recording")]
	public Dictionary<string, object?> StartRecording(string name, object? tags)
	{
		try { return recordings.Start(name, Plain.From(tags) as Dictionary<string, object?>, Caller()); }
		catch (Exception e) when (e is InvalidOperationException or ArgumentException or IOException) { throw Fail(e); }
	}

	[HubMethodName("stop_recording")]
	public Dictionary<string, object?> StopRecording()
	{
		try { return recordings.Stop(); }
		catch (InvalidOperationException e) { throw Fail(e); }
	}

	[HubMethodName("abort_recording")]
	public Dictionary<string, object?> AbortRecording(bool discard)
	{
		try { return recordings.Abort(discard); }
		catch (InvalidOperationException e) { throw Fail(e); }
	}

	[HubMethodName("snapshot")]
	public Dictionary<string, object?> Snapshot(string name, object? tags)
	{
		try { return recordings.Snapshot(name, Plain.From(tags) as Dictionary<string, object?>, Caller()); }
		catch (Exception e) when (e is InvalidOperationException or ArgumentException or IOException) { throw Fail(e); }
	}

	[HubMethodName("get_devices")]
	public Dictionary<string, Dictionary<string, object?>> GetDevices() => registry.All();

	/// <summary>Stops the worker of a device and starts it again (also resets the waiting time after failures).</summary>
	[HubMethodName("restart_device")]
	public async Task RestartDevice(string device)
	{
		if (!await supervisor.RestartAsync(device))
			throw new HubException(Errors.Json("LookupError", $"Device '{device}' does not exist"));
	}

	private static HubException DeviceFileError(Exception e) => new(Errors.Json(e is ArgumentException ? "ValueError" : "DeviceFileError", e.Message));

	/// <summary>Python files of the workspace that can be devices, with the ids that use them.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_device_files")]
	public List<Dictionary<string, object?>> ListDeviceFiles() => catalog.ListFiles();

	/// <summary>What a device file offers: class, doc, options (name, type, default, required) and actions. Loads it in its environment.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("describe_device_file")]
	public async Task<object?> DescribeDeviceFile(string file)
	{
		try { return await catalog.DescribeAsync(file, Context.ConnectionAborted); }
		catch (Exception e) when (e is ArgumentException or InvalidOperationException or IOException) { throw DeviceFileError(e); }
	}

	/// <param name="device">{file, python?, config?, description?}</param>
	/// <summary>C# drivers that can be used with {"driver": "name"}: driver, class, doc.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_drivers")]
	public List<Dictionary<string, object?>> ListDrivers() => drivers.List();

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("describe_driver")]
	public Dictionary<string, object?> DescribeDriver(string driver) =>
		drivers.Find(driver) is { } type ? Drivers.DriverSchema.Build("describe", type) : throw new HubException(Errors.Json("LookupError", $"There is no driver '{driver}' (drivers: {string.Join(", ", drivers.Names)})"));

	/// <summary>The runtime widgets (widgets/ in the workspace): name, version (changes with the code), build error; and the version of the stylesheet.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_widgets")]
	public Dictionary<string, object?> ListWidgets() => widgets.List();

	/// <summary>The compiled module of a widget (ES module text) or why it did not build.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("get_widget")]
	public Dictionary<string, object?> GetWidget(string name)
	{
		try { return widgets.Get(name); }
		catch (ArgumentException e) { throw new HubException(Errors.Json("LookupError", e.Message)); }
	}

	/// <summary>The stylesheet of the host and all widgets.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("get_widget_css")]
	public string GetWidgetCss() => widgets.Css();

	/// <summary>The templates for "New device": id, title, description, the profile it implements.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_templates")]
	public List<Dictionary<string, object?>> ListTemplates() => scaffolder.List();

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_widget_templates")]
	public List<Dictionary<string, object?>> ListWidgetTemplates() => scaffolder.List("widget");

	/// <summary>Makes widgets/&lt;name&gt;.tsx from a template; the server builds it at once and it appears in the picker. Never overwrites.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("scaffold_widget")]
	public async Task<Dictionary<string, object?>> ScaffoldWidget(string template, string name)
	{
		try { return await scaffolder.CreateWidgetAsync(template, name); }
		catch (ArgumentException e) { throw new HubException(Errors.Json("ValueError", e.Message)); }
	}

	/// <summary>Makes devices/&lt;id&gt;.py from a template, registers it and starts it (simulated). Never overwrites.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("scaffold_device")]
	public async Task<Dictionary<string, object?>> ScaffoldDevice(string template, string id, string connection, string? python)
	{
		try { return await scaffolder.CreateAsync(template, id, connection, python); }
		catch (ArgumentException e) { throw new HubException(Errors.Json("ValueError", e.Message)); }
	}

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("add_device")]
	public async Task AddDevice(string id, object device)
	{
		try { await catalog.AddAsync(id, DeviceCatalog.Parse(device)); }
		catch (Exception e) when (e is ArgumentException or InvalidOperationException or IOException) { throw DeviceFileError(e); }
	}

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("update_device")]
	public async Task UpdateDevice(string id, object device)
	{
		try { await catalog.UpdateAsync(id, DeviceCatalog.Parse(device)); }
		catch (Exception e) when (e is ArgumentException or InvalidOperationException or IOException) { throw DeviceFileError(e); }
	}

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("remove_device")]
	public async Task RemoveDevice(string id)
	{
		try { await catalog.RemoveAsync(id); }
		catch (Exception e) when (e is ArgumentException or InvalidOperationException or IOException) { throw DeviceFileError(e); }
	}

	/// <summary>All entries of devices.json: id -> {file, driver, python, config, description}.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_device_entries")]
	public Dictionary<string, Dictionary<string, object?>> ListDeviceEntries() =>
		workspace.Devices.ToDictionary(kv => kv.Key, kv => new Dictionary<string, object?>
		{
			["file"] = kv.Value.File, ["driver"] = kv.Value.Driver, ["python"] = kv.Value.Python, ["description"] = kv.Value.Description, ["remote"] = kv.Value.Remote == true,
			["config"] = kv.Value.Config is null ? null : Plain.FromJson(System.Text.Json.JsonSerializer.SerializeToElement(kv.Value.Config)),
		}.WithAutoRestart(kv.Value));

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("get_device_config")]
	public Dictionary<string, object?> GetDeviceConfig(string id) =>
		workspace.Devices.TryGetValue(id, out var d)
			? new Dictionary<string, object?> { ["file"] = d.File, ["driver"] = d.Driver, ["python"] = d.Python, ["config"] = d.Config is null ? null : Plain.FromJson(System.Text.Json.JsonSerializer.SerializeToElement(d.Config)), ["description"] = d.Description, ["remote"] = d.Remote == true }.WithAutoRestart(d)
			: throw new HubException(Errors.Json("LookupError", $"Device '{id}' is not in devices.json"));

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_secrets")]
	public List<string> ListSecrets() => secrets.Names();

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("set_secret")]
	public async Task SetSecret(string name, string value)
	{
		secrets.Set(name, value);
		await supervisor.SecretChangedAsync(name);
	}

	[Authorize(Roles = Roles.Client)]
	[HubMethodName("delete_secret")]
	public async Task DeleteSecret(string name)
	{
		secrets.Delete(name);
		await supervisor.SecretChangedAsync(name);
	}

	[HubMethodName("get_device")]
	public Dictionary<string, object?> GetDevice(string device) =>
		registry.Snapshot(device) ?? throw new HubException(Errors.Json("LookupError", $"Device '{device}' does not exist"));

	/// <param name="source">"server", "device:pressure" or null for all; since = 0 returns the latest entries.</param>
	/// <summary>The Python environments on disk (one per set of dependencies, shared by devices that need the same).</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_environments")]
	public List<Dictionary<string, object?>> ListEnvironments() => environments.List();

	/// <summary>Removes environments that no device uses and that were not used for the given number of days; returns what was removed.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("cleanup_environments")]
	public Task<List<Dictionary<string, object?>>> CleanUpEnvironments(int olderThanDays) => environments.CleanUpAsync(Math.Max(0, olderThanDays));

	/// <summary>The Pythons that can be named in a device's "python" option.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_pythons")]
	public Task<List<Dictionary<string, object?>>> ListPythons() => environments.ListPythonsAsync();

	/// <summary>Creates a token for a worker on another machine. It may register the one device (which must be configured with "remote": true)
	/// and nothing else. The token is returned here once; only its hash is kept.</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("create_token")]
	public Dictionary<string, object?> CreateToken(string device, string? label)
	{
		if (!workspace.Devices.TryGetValue(device, out var config) || config.Remote != true)
			throw new HubException(Errors.Json("ValueError", $"'{device}' is not a remote device: add it to devices.json with \"remote\": true first"));
		var (token, record) = tokenStore.Create("worker", device, string.IsNullOrWhiteSpace(label) ? $"worker of {device}" : label.Trim());
		return new() { ["token"] = token, ["id"] = record.Id, ["device"] = device, ["label"] = record.Label };
	}

	/// <summary>The tokens that exist (never the tokens themselves).</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("list_tokens")]
	public List<Dictionary<string, object?>> ListTokens() =>
		tokenStore.List().Select(t => new Dictionary<string, object?> { ["id"] = t.Id, ["kind"] = t.Kind, ["device"] = t.Device, ["label"] = t.Label, ["created"] = t.Created.ToUnixTimeSeconds() }).ToList();

	/// <summary>Revokes a token: it cannot connect again (a connection that is open stays until it drops or the device is restarted).</summary>
	[Authorize(Roles = Roles.Client)]
	[HubMethodName("revoke_token")]
	public void RevokeToken(string id)
	{
		if (!tokenStore.Revoke(id)) throw new HubException(Errors.Json("LookupError", $"There is no token '{id}'"));
	}

	/// <summary>What happened to devices, oldest first: actions with their caller and status changes. Persistent, also outside recordings.</summary>
	[HubMethodName("get_events")]
	public List<Dictionary<string, object?>> GetEvents(string? device, string? kind, double since, double until, int limit) =>
		eventLog.Events(device, kind, since, until, Math.Clamp(limit, 1, 5000));

	/// <summary>The history of a numeric state field (one value per ten seconds is kept) as [time, value] pairs.</summary>
	[HubMethodName("get_history")]
	public List<double[]> GetHistory(string device, string path, double since, double until, int maxPoints) =>
		eventLog.History(device, path, since, until, Math.Clamp(maxPoints, 0, 20000));

	[HubMethodName("add_note")]
	public string AddNote(string text, string[]? refs)
	{
		try { return eventLog.AddNote(text, refs, Caller()); }
		catch (ArgumentException e) { throw new HubException(Errors.Json("ValueError", e.Message)); }
	}

	[HubMethodName("get_notes")]
	public List<Dictionary<string, object?>> GetNotes(string? reference, double since, int limit) => eventLog.Notes(reference, since, Math.Clamp(limit, 1, 1000));

	/// <summary>An error in a browser (React error boundary, window.onerror), so that it shows up in the server's log, where AI and people look.</summary>
	[HubMethodName("report_client_error")]
	public void ReportClientError(string message, string? stack, string? where)
	{
		var count = (int)(Context.Items["reported"] ?? 0) + 1; // a page stuck in a loop must not flood the log
		Context.Items["reported"] = count;
		if (count > 50) return;
		var client = Context.Items["client"] as string ?? "client";
		logs.Add("client", "ERROR", $"{client}:{(where ?? "page")[..Math.Min(40, (where ?? "page").Length)]}", message.Length > 2000 ? message[..2000] + "..." : message,
			stack is { Length: > 20000 } ? stack[..20000] : stack);
	}

	[HubMethodName("get_logs")]
	public List<Dictionary<string, object?>> GetLogs(string? source, string? level, long since, int limit) =>
		logs.Get(source, level, since, Math.Clamp(limit, 1, 2000));

	[HubMethodName("subscribe_logs")]
	public Task SubscribeLogs(string source) => Groups.AddToGroupAsync(Context.ConnectionId, "logs:" + source);

	[HubMethodName("unsubscribe_logs")]
	public Task UnsubscribeLogs(string source) => Groups.RemoveFromGroupAsync(Context.ConnectionId, "logs:" + source);

	[HubMethodName("action")]
	public async Task<object?> Action(string device, string name, object?[] args)
	{
		try
		{
			var result = await Invoke(device, name, args);
			registry.ActionFinished(device, null, null);
			return result;
		}
		catch (HubException e)
		{
			var (type, message) = Errors.Parse(e.Message);
			registry.ActionFinished(device, type, message);
			throw;
		}
	}

	private async Task<object?> Invoke(string device, string name, object?[] args)
	{
		var entry = registry.Get(device) ?? throw new HubException(Errors.Json("LookupError", $"Device '{device}' does not exist"));
		if (entry.ConnectionId is null || !DeviceRegistry.IsUp(entry.Status))
			throw new HubException(Errors.Json("DeviceNotReady", $"Device '{device}' is not ready (status: {entry.Status})"));
		var caller = Caller();
		bus.Publish(device, "action", caller, new() { ["action"] = name, ["args"] = Plain.From(args) });
		if (entry.LocalCall is { } local && entry.ConnectionId.StartsWith(Drivers.InProcessDevice.ConnectionPrefix))
		{
			try { return await local(name, args, caller, Context.ConnectionAborted); }
			catch (Drivers.DeviceActionException e) { throw new HubException(Errors.Json(e.Type, e.Message, e.Traceback)); }
		}
		try
		{
			return await devices.Clients.Client(entry.ConnectionId).InvokeAsync<object?>("call", name, args, caller, Context.ConnectionAborted);
		}
		catch (HubException e) when (e.Message.TrimStart().StartsWith('{'))
		{
			throw; // structured error of the worker, passed on unchanged
		}
		catch (Exception e) when (e is not OperationCanceledException)
		{
			throw new HubException(Errors.Json("ConnectionLost", $"Device '{device}' did not answer: {e.Message}"));
		}
	}
}
