using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using LabOrchestra.Server.Supervision;

namespace LabOrchestra.Server.Devices;

/// <summary>What the management UI works with: the device files of the workspace, what a file offers (its options and actions),
/// and adding, changing and removing entries of devices.json.</summary>
public sealed partial class DeviceCatalog(Workspace workspace, EnvironmentManager environments, WorkerSupervisor supervisor, Drivers.DriverCatalog drivers, ILogger<DeviceCatalog> log)
{
	private readonly ConcurrentDictionary<(string File, long Stamp), object?> _described = new();

	[GeneratedRegex("^[a-z][a-z0-9]*(_[a-z0-9]+)*$")]
	private static partial Regex SnakeCase();

	/// <summary>The *.py files under the workspace (devices/ first) with the ids of the devices that use them.</summary>
	public List<Dictionary<string, object?>> ListFiles()
	{
		var root = Path.GetFullPath(workspace.Path);
		var used = workspace.Devices.Where(d => d.Value.File is not null).GroupBy(d => Normalize(d.Value.File!)).ToDictionary(g => g.Key, g => g.Select(d => d.Key).Order().ToList());
		return Directory.Exists(root)
			? Directory.EnumerateFiles(root, "*.py", SearchOption.AllDirectories)
				.Select(f => Path.GetRelativePath(root, f).Replace('\\', '/'))
				.Where(f => !f.Split('/').Any(part => part.StartsWith('_') || part.StartsWith('.') || part == "node_modules"))
				.OrderBy(f => f.StartsWith("devices/") ? 0 : 1).ThenBy(f => f)
				.Select(f => new Dictionary<string, object?> { ["file"] = f, ["devices"] = used.GetValueOrDefault(f) ?? [] })
				.ToList()
			: [];
	}

	private static string Normalize(string file) => file.Replace('\\', '/').TrimStart('.', '/');

	/// <summary>Full path of a file inside the workspace (the UI does not reach outside it).</summary>
	private string Resolve(string file)
	{
		var root = Path.GetFullPath(workspace.Path);
		var full = Path.GetFullPath(Path.Combine(root, file));
		if (!full.StartsWith(root + Path.DirectorySeparatorChar) || !File.Exists(full) || !full.EndsWith(".py"))
			throw new ArgumentException($"'{file}' is not a Python file in the workspace");
		return full;
	}

	/// <summary>Loads the device class of the file in its environment, without starting it, and returns its options, actions and doc.</summary>
	public async Task<object?> DescribeAsync(string file, CancellationToken cancel)
	{
		var full = Resolve(file);
		var key = (full, File.GetLastWriteTimeUtc(full).Ticks);
		if (_described.TryGetValue(key, out var known)) return known;
		var python = await environments.GetPythonAsync("_describe", full, null, cancel);
		var info = new ProcessStartInfo(python) { WorkingDirectory = workspace.Path, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
		foreach (var a in new[] { "-u", "-m", "laborchestra.worker", full, "--describe" }) info.ArgumentList.Add(a);
		using var process = Process.Start(info)!;
		var output = process.StandardOutput.ReadToEndAsync(cancel);
		var errors = process.StandardError.ReadToEndAsync(cancel);
		using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
		timeout.CancelAfter(TimeSpan.FromSeconds(60));
		try { await process.WaitForExitAsync(timeout.Token); }
		catch (OperationCanceledException) { process.Kill(entireProcessTree: true); throw new InvalidOperationException("The device file did not finish loading within 60 s"); }
		var marker = (await output).Split('\n').LastOrDefault(l => l.StartsWith("LABORCHESTRA-SCHEMA "));
		if (process.ExitCode != 0 || marker is null)
		{
			var text = (await errors).Trim().Split('\n').TakeLast(6);
			throw new InvalidOperationException($"{file} could not be loaded: {string.Join(" | ", text)}");
		}
		var schema = Plain.FromJson(JsonSerializer.Deserialize<JsonElement>(marker["LABORCHESTRA-SCHEMA ".Length..]));
		_described[key] = schema;
		return schema;
	}

	public async Task AddAsync(string id, DeviceConfig config)
	{
		Check(id, config);
		workspace.Update(devices =>
		{
			if (devices.ContainsKey(id)) throw new ArgumentException($"There is already a device '{id}'");
			devices[id] = config;
		});
		log.LogInformation("Device {Device} added ({File})", id, config.File);
		await supervisor.ReconcileAsync();
	}

	public async Task UpdateAsync(string id, DeviceConfig config)
	{
		Check(id, config);
		workspace.Update(devices =>
		{
			if (!devices.TryGetValue(id, out var old)) throw new ArgumentException($"There is no device '{id}'");
			devices[id] = config with { AutoRestart = config.AutoRestart ?? old.AutoRestart }; // not mentioned: stays as it was
		});
		log.LogInformation("Device {Device} changed", id);
		await supervisor.ReconcileAsync();
	}

	public async Task RemoveAsync(string id)
	{
		workspace.Update(devices =>
		{
			if (!devices.Remove(id)) throw new ArgumentException($"There is no device '{id}'");
		});
		log.LogInformation("Device {Device} removed from devices.json", id);
		await supervisor.ReconcileAsync();
	}

	private void Check(string id, DeviceConfig config)
	{
		if (!SnakeCase().IsMatch(id)) throw new ArgumentException($"The id '{id}' must be snake_case (lowercase letters, digits, underscores)");
		if (config.Driver is not null)
		{
			if (drivers.Find(config.Driver) is null) throw new ArgumentException($"There is no driver '{config.Driver}' (drivers: {string.Join(", ", drivers.Names)})");
			return;
		}
		if (config.Remote == true) return; // no file: the worker runs elsewhere
		Resolve(Normalize(config.File!)); // must exist inside the workspace
	}

	/// <summary>Builds a DeviceConfig from what a client sent: {file, python?, config?, description?}.</summary>
	public static DeviceConfig Parse(object? input)
	{
		if (Plain.From(input) is not Dictionary<string, object?> map) throw new ArgumentException("The device needs to be an object with a 'file'");
		var unknown = map.Keys.Except(["file", "driver", "python", "config", "description", "auto_restart", "remote"]).ToList();
		if (unknown.Count > 0) throw new ArgumentException($"Unknown field(s): {string.Join(", ", unknown)}");
		string? Text(string key) => map.TryGetValue(key, out var v) && v is not null ? v as string ?? throw new ArgumentException($"'{key}' must be text") : null;
		var file = Text("file");
		var driver = Text("driver");
		var remote = map.TryGetValue("remote", out var r) && r is true;
		if ((file is null ? 0 : 1) + (driver is null ? 0 : 1) + (remote ? 1 : 0) != 1) throw new ArgumentException("The device needs exactly one of 'file' (Python), 'driver' (C#) or 'remote' (a worker on another machine)");
		Dictionary<string, JsonElement>? options = null;
		if (map.TryGetValue("config", out var c) && c is not null)
		{
			if (c is not Dictionary<string, object?> given) throw new ArgumentException("'config' must be an object");
			options = given.ToDictionary(kv => kv.Key, kv => JsonSerializer.SerializeToElement(kv.Value));
		}
		return new DeviceConfig(file is null ? null : Normalize(file), string.IsNullOrWhiteSpace(Text("python")) ? null : Text("python"), options is { Count: > 0 } ? options : null, string.IsNullOrWhiteSpace(Text("description")) ? null : Text("description"), driver,
			map.TryGetValue("auto_restart", out var auto) && auto is not null ? auto as bool? ?? throw new ArgumentException("'auto_restart' must be true or false") : null,
			remote ? true : null);
	}
}
