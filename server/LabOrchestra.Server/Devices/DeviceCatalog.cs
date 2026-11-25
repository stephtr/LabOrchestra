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
		var marker = await RunWorkerAsync(python, [full, "--describe"], "LABORCHESTRA-SCHEMA ", file, cancel);
		var schema = Plain.FromJson(JsonSerializer.Deserialize<JsonElement>(marker));
		_described[key] = schema;
		return schema;
	}

	/// <summary>Runs the worker module of an environment for one question and returns the JSON after the marker line it prints (the device may
	/// print on its own while it loads, so the answer is marked). A failure says what the worker wrote.</summary>
	private Task<string> RunWorkerAsync(string python, string[] arguments, string marker, string what, CancellationToken cancel) =>
		RunModuleAsync(python, "laborchestra.worker", arguments, marker, what, cancel);

	/// <summary>Like <see cref="RunWorkerAsync"/> for any module of the laborchestra package (the procedure runner, too).</summary>
	internal async Task<string> RunModuleAsync(string python, string module, string[] arguments, string marker, string what, CancellationToken cancel)
	{
		var info = new ProcessStartInfo(python) { WorkingDirectory = workspace.Path, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
		foreach (var a in new[] { "-u", "-m", module }.Concat(arguments)) info.ArgumentList.Add(a);
		using var process = Process.Start(info)!;
		var output = process.StandardOutput.ReadToEndAsync(cancel);
		var errors = process.StandardError.ReadToEndAsync(cancel);
		using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
		timeout.CancelAfter(TimeSpan.FromSeconds(60));
		try { await process.WaitForExitAsync(timeout.Token); }
		catch (OperationCanceledException) { process.Kill(entireProcessTree: true); throw new InvalidOperationException($"{what} did not finish loading within 60 s"); }
		var line = (await output).Split('\n').LastOrDefault(l => l.StartsWith(marker));
		if (process.ExitCode != 0 || line is null)
		{
			var text = (await errors).Trim().Split('\n').TakeLast(6);
			throw new InvalidOperationException($"{what} could not be loaded: {string.Join(" | ", text)}");
		}
		return line[marker.Length..];
	}

	/// <summary>The devices and widgets that a package offers (its entry points), found by building its environment and looking at what is
	/// installed there. <paramref name="package"/> is a pip requirement, or the folder or wheel of a package.</summary>
	public async Task<JsonElement> EntryPointsAsync(string package, string? python, CancellationToken cancel)
	{
		var interpreter = await environments.GetPackagePythonAsync("_describe", package, python, cancel);
		return JsonSerializer.Deserialize<JsonElement>(await RunWorkerAsync(interpreter, ["--list-entry-points"], "LABORCHESTRA-ENTRY-POINTS ", $"The package {package}", cancel));
	}

	/// <summary>What a package offers, and what one of its devices has (options and actions). Without <paramref name="entry"/> the device is
	/// chosen when the package offers exactly one.</summary>
	public async Task<Dictionary<string, object?>> DescribePackageAsync(string package, string? entry, string? python, CancellationToken cancel)
	{
		if (string.IsNullOrWhiteSpace(package)) throw new ArgumentException("Name a package: a pip requirement such as laborchestra-elliptec==1.2, or the folder of one");
		var found = await EntryPointsAsync(package, python, cancel);
		var devices = found.GetProperty("devices").EnumerateArray().Select(d => d.GetProperty("name").GetString()!).ToList();
		var widgets = found.GetProperty("widgets");
		var chosen = string.IsNullOrWhiteSpace(entry) ? (devices.Count == 1 ? devices[0] : null) : entry;
		object? schema = null;
		if (chosen is not null)
		{
			if (!devices.Contains(chosen)) throw new ArgumentException($"The package does not offer a device '{chosen}' (it offers: {(devices.Count == 0 ? "no devices" : string.Join(", ", devices))})");
			var interpreter = await environments.GetPackagePythonAsync("_describe", package, python, cancel);
			schema = Plain.FromJson(JsonSerializer.Deserialize<JsonElement>(await RunWorkerAsync(interpreter, [$"entry:{chosen}", "--describe"], "LABORCHESTRA-SCHEMA ", $"The device {chosen} of {package}", cancel)));
		}
		return new() { ["devices"] = Plain.FromJson(found.GetProperty("devices")), ["widgets"] = Plain.FromJson(widgets), ["entry"] = chosen, ["schema"] = schema };
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
		if (config.Package is not null) return; // the package is looked at when the device starts (or by "look inside" before)
		Resolve(Normalize(config.File!)); // must exist inside the workspace
	}

	/// <summary>Builds a DeviceConfig from what a client sent: {file, python?, config?, description?}.</summary>
	public static DeviceConfig Parse(object? input)
	{
		if (Plain.From(input) is not Dictionary<string, object?> map) throw new ArgumentException("The device needs to be an object with a 'file'");
		var unknown = map.Keys.Except(["file", "driver", "python", "config", "description", "auto_restart", "remote", "package", "entry"]).ToList();
		if (unknown.Count > 0) throw new ArgumentException($"Unknown field(s): {string.Join(", ", unknown)}");
		string? Text(string key) => map.TryGetValue(key, out var v) && v is not null ? v as string ?? throw new ArgumentException($"'{key}' must be text") : null;
		var file = Text("file");
		var driver = Text("driver");
		var package = string.IsNullOrWhiteSpace(Text("package")) ? null : Text("package")!.Trim();
		var remote = map.TryGetValue("remote", out var r) && r is true;
		if ((file is null ? 0 : 1) + (driver is null ? 0 : 1) + (remote ? 1 : 0) + (package is null ? 0 : 1) != 1) throw new ArgumentException("The device needs exactly one of 'file' (Python), 'package' (an installed Python package), 'driver' (C#) or 'remote' (a worker on another machine)");
		Dictionary<string, JsonElement>? options = null;
		if (map.TryGetValue("config", out var c) && c is not null)
		{
			if (c is not Dictionary<string, object?> given) throw new ArgumentException("'config' must be an object");
			options = given.ToDictionary(kv => kv.Key, kv => JsonSerializer.SerializeToElement(kv.Value));
		}
		return new DeviceConfig(file is null ? null : Normalize(file), string.IsNullOrWhiteSpace(Text("python")) ? null : Text("python"), options is { Count: > 0 } ? options : null, string.IsNullOrWhiteSpace(Text("description")) ? null : Text("description"), driver,
			map.TryGetValue("auto_restart", out var auto) && auto is not null ? auto as bool? ?? throw new ArgumentException("'auto_restart' must be true or false") : null,
			remote ? true : null, package, package is null || string.IsNullOrWhiteSpace(Text("entry")) ? null : Text("entry")!.Trim());
	}
}
