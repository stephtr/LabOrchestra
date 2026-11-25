using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using LabOrchestra.Server.Logging;

namespace LabOrchestra.Server.Supervision;

/// <summary>
/// Gives every device a Python environment with exactly the dependencies of its file (PEP 723 header:
/// <c># /// script</c> ... <c>dependencies = ["pyserial"]</c>) and the laborchestra package, built with uv.
/// Environments are immutable and named by what is in them: other dependencies, another Python or another laborchestra
/// make another environment, and devices with the same needs share one.
/// </summary>
public sealed partial class EnvironmentManager(IConfiguration config, string dataDir, LogStore logs, ILogger<EnvironmentManager> log)
{
	private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new();
	private readonly Lazy<string?> _uv = new(() => FindUv(config["uv"]));
	private bool _warnedNoUv;
	private readonly ConcurrentDictionary<string, string> _inUse = new(); // device -> the environment it runs in

	// \r?: files saved on Windows have CRLF line endings
	[GeneratedRegex(@"(?m)^# /// script\r?$\s(?<content>(?:^#(?:| .*?)\r?$\s)+)^# ///\r?$")]
	private static partial Regex ScriptBlock();

	[GeneratedRegex(@"^laborchestra(?:\s|\[|<|>|=|!|~|;|$)", RegexOptions.IgnoreCase)]
	private static partial Regex OwnPackage();

	private static string? FindUv(string? configured)
	{
		foreach (var candidate in new[] { configured, "uv" }.Where(c => !string.IsNullOrWhiteSpace(c)))
		{
			try
			{
				using var process = Process.Start(new ProcessStartInfo(candidate!, "--version") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false });
				process?.WaitForExit(5000);
				if (process?.ExitCode == 0) return candidate;
			}
			catch (System.ComponentModel.Win32Exception) { /* not there */ }
		}
		return null;
	}

	/// <summary>The dependencies and the Python requirement from the PEP 723 header of a device file (empty if there is none).</summary>
	public static (string? RequiresPython, List<string> Dependencies) ReadScriptMetadata(string file)
	{
		var match = ScriptBlock().Match(File.ReadAllText(file));
		if (!match.Success) return (null, []);
		var toml = string.Join('\n', match.Groups["content"].Value.Split('\n').Select(l => l.TrimEnd('\r')).Select(l => l.Length > 2 ? l[2..] : ""));
		var requires = Regex.Match(toml, @"requires-python\s*=\s*""([^""]*)""") is { Success: true } r ? r.Groups[1].Value : null;
		var dependencies = new List<string>();
		if (Regex.Match(toml, @"dependencies\s*=\s*\[(?<items>[^\]]*)\]") is { Success: true } d)
			dependencies.AddRange(Regex.Matches(d.Groups["items"].Value, @"""([^""]*)""").Select(m => m.Groups[1].Value));
		return (requires, dependencies.Where(x => !OwnPackage().IsMatch(x.Trim())).ToList()); // the server brings its own laborchestra
	}

	/// <summary>The interpreter to run the worker of a device with. An interpreter that is named explicitly (a path) is used as it is;
	/// otherwise an environment is made (and reused when it exists).</summary>
	public async Task<string> GetPythonAsync(string deviceId, string deviceFile, string? explicitPython, CancellationToken cancel)
	{
		explicitPython ??= config["python"];
		if (explicitPython is not null && File.Exists(explicitPython)) return explicitPython;
		var (requires, dependencies) = ReadScriptMetadata(deviceFile);
		return await BuildAsync(deviceId, requires, dependencies, explicitPython, cancel);
	}

	/// <summary>The interpreter for a device that an installed package offers: an environment with the package (a pip requirement, or the
	/// folder or wheel of one) and its dependencies. A folder is installed editable, so that changes to it are seen by the next start.</summary>
	public Task<string> GetPackagePythonAsync(string deviceId, string package, string? explicitPython, CancellationToken cancel) =>
		BuildAsync(deviceId, null, [package.Trim()], explicitPython ?? config["python"], cancel);

	private async Task<string> BuildAsync(string deviceId, string? requires, List<string> dependencies, string? explicitPython, CancellationToken cancel)
	{
		if (explicitPython is not null && File.Exists(explicitPython)) return explicitPython;
		var uv = _uv.Value;
		if (uv is null)
		{
			if (!_warnedNoUv)
			{
				_warnedNoUv = true;
				log.LogWarning("uv was not found: devices run with '{Python}' as it is. Install uv to get an environment per device (https://docs.astral.sh/uv/)", explicitPython ?? "python3");
			}
			return explicitPython ?? (OperatingSystem.IsWindows() ? "python" : "python3");
		}

		var package = config["laborchestra_package"] ?? FindPackage()
			?? throw new InvalidOperationException("The laborchestra package was not found: set 'laborchestra_package' to its folder (or wheel)");
		var wanted = explicitPython ?? requires; // a version such as "3.12", or the requirement of the file; null: uv chooses
		var identity = Directory.Exists(package) ? Path.GetFullPath(package) : $"{Path.GetFileName(package)}:{Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(package)))}";
		var identities = dependencies.Select(DependencyIdentity).Order().ToList(); // a folder or wheel is identified by where it is / what is in it
		var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', wanted ?? "", identity, string.Join('\n', identities)))))[..16].ToLowerInvariant();
		var directory = Path.Combine(dataDir, "envs", key);
		var python = Path.Combine(directory, OperatingSystem.IsWindows() ? "Scripts" : "bin", OperatingSystem.IsWindows() ? "python.exe" : "python");
		var marker = Path.Combine(directory, ".ready");

		var gate = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
		await gate.WaitAsync(cancel);
		try
		{
			if (File.Exists(marker)) { Touch(deviceId, key, directory); return python; }
			if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); // an earlier attempt that did not finish
			var source = $"device:{deviceId}";
			logs.Add(source, "INFO", "environment", $"Preparing the Python environment {key} ({(dependencies.Count == 0 ? "no extra dependencies" : string.Join(", ", dependencies))})");
			var venv = new List<string> { "venv", "--quiet" };
			if (wanted is not null) venv.AddRange(["--python", wanted]);
			venv.Add(directory);
			await RunAsync(uv, venv, source, cancel);
			var install = new List<string> { "pip", "install", "--quiet", "--python", python };
			if (Directory.Exists(package)) install.AddRange(["--editable", package]); else install.Add(package);
			foreach (var dependency in dependencies)
			{
				if (Directory.Exists(dependency)) install.AddRange(["--editable", Path.GetFullPath(dependency)]);
				else install.Add(dependency);
			}
			await RunAsync(uv, install, source, cancel);
			File.WriteAllText(marker, JsonSerializer.Serialize(new { wanted, package = identity, dependencies }));
			logs.Add(source, "INFO", "environment", $"The environment {key} is ready");
			Touch(deviceId, key, directory);
			return python;
		}
		catch
		{
			try { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); } catch (IOException) { }
			throw;
		}
		finally { gate.Release(); }
	}

	private static string DependencyIdentity(string dependency) =>
		Directory.Exists(dependency) ? Path.GetFullPath(dependency)
		: File.Exists(dependency) ? $"{Path.GetFileName(dependency)}:{Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(dependency)))}"
		: dependency;

	private void Touch(string deviceId, string key, string directory)
	{
		_inUse[deviceId] = key;
		try { File.WriteAllText(Path.Combine(directory, ".used"), DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString()); } catch (IOException) { }
	}

	private static DateTimeOffset LastUsed(string directory)
	{
		var file = Path.Combine(directory, ".used");
		return File.Exists(file) && long.TryParse(File.ReadAllText(file), out var t) ? DateTimeOffset.FromUnixTimeSeconds(t) : new DirectoryInfo(directory).LastWriteTimeUtc;
	}

	/// <summary>The environments on disk: what is in them, how big, when they were last used and by which devices right now.</summary>
	public List<Dictionary<string, object?>> List()
	{
		var root = Path.Combine(dataDir, "envs");
		if (!Directory.Exists(root)) return [];
		return Directory.GetDirectories(root).Where(d => File.Exists(Path.Combine(d, ".ready"))).Order().Select(directory =>
		{
			var key = Path.GetFileName(directory);
			var info = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(Path.Combine(directory, ".ready")));
			return new Dictionary<string, object?>
			{
				["key"] = key,
				["python"] = info.TryGetProperty("wanted", out var w) && w.ValueKind == JsonValueKind.String ? w.GetString() : null,
				["dependencies"] = info.TryGetProperty("dependencies", out var d) ? d.EnumerateArray().Select(x => x.GetString()).ToList() : [],
				["size_mb"] = Math.Round(new DirectoryInfo(directory).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1048576.0, 1),
				["last_used"] = LastUsed(directory).ToUnixTimeSeconds(),
				["used_by"] = _inUse.Where(kv => kv.Value == key).Select(kv => kv.Key).Order().ToList(),
			};
		}).ToList();
	}

	/// <summary>Deletes environments that no device runs in now and that were not used for <paramref name="olderThanDays"/> days. An environment
	/// of an older version of a device file stays for that time, which is what makes going back to the older file (git) work.</summary>
	public async Task<List<Dictionary<string, object?>>> CleanUpAsync(int olderThanDays)
	{
		var removed = new List<Dictionary<string, object?>>();
		foreach (var env in List())
		{
			var key = (string)env["key"]!;
			if (((List<string>)env["used_by"]!).Count > 0 || DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeSeconds((long)env["last_used"]!) < TimeSpan.FromDays(olderThanDays)) continue;
			var gate = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
			if (!await gate.WaitAsync(0)) continue; // being built or started just now
			try
			{
				Directory.Delete(Path.Combine(dataDir, "envs", key), recursive: true);
				log.LogInformation("Removed the unused environment {Key}", key);
				removed.Add(env);
			}
			catch (IOException e) { log.LogWarning("Could not remove the environment {Key}: {Message}", key, e.Message); }
			finally { gate.Release(); }
		}
		return removed;
	}

	/// <summary>The Pythons that uv knows on this computer (installed ones, also those it found on the system): version and path.</summary>
	public async Task<List<Dictionary<string, object?>>> ListPythonsAsync()
	{
		var uv = _uv.Value;
		if (uv is null) return [];
		var info = new ProcessStartInfo(uv, "python list --only-installed --output-format json") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
		using var process = Process.Start(info)!;
		var output = await process.StandardOutput.ReadToEndAsync();
		await process.WaitForExitAsync();
		if (process.ExitCode != 0) return [];
		var found = JsonSerializer.Deserialize<JsonElement>(output).EnumerateArray()
			.Where(p => p.TryGetProperty("path", out var path) && path.ValueKind == JsonValueKind.String)
			.Select(p => (Version: p.GetProperty("version").GetString(), Path: p.GetProperty("path").GetString()!, Implementation: p.TryGetProperty("implementation", out var i) ? i.GetString() : null));
		// One interpreter is often listed several times: python3, python3.15 and /usr/local/bin/python3.15 are links to the same file.
		// Keep one entry per real file, preferably the one that is the file itself.
		return found
			.GroupBy(p => RealPath(p.Path))
			.Select(g => g.FirstOrDefault(p => p.Path == g.Key, g.OrderBy(p => p.Path.Length).First()))
			.Select(p => new Dictionary<string, object?> { ["version"] = p.Version, ["path"] = p.Path, ["implementation"] = p.Implementation })
			.ToList();
	}

	/// <summary>The file a path finally leads to (links followed), or the path itself when that cannot be told.</summary>
	private static string RealPath(string path)
	{
		try { return new FileInfo(path).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? Path.GetFullPath(path); }
		catch (IOException) { return path; }
	}

	private async Task RunAsync(string uv, List<string> arguments, string source, CancellationToken cancel)
	{
		var info = new ProcessStartInfo(uv) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
		foreach (var a in arguments) info.ArgumentList.Add(a);
		info.Environment["UV_PYTHON_DOWNLOADS"] = config["uv_python_downloads"] ?? "never"; // downloading a Python is a decision for the user
		using var process = new Process { StartInfo = info };
		var output = new List<string>();
		void Collect(string? line) { if (!string.IsNullOrWhiteSpace(line)) lock (output) output.Add(line); }
		process.OutputDataReceived += (_, e) => Collect(e.Data);
		process.ErrorDataReceived += (_, e) => Collect(e.Data);
		process.Start();
		process.BeginOutputReadLine();
		process.BeginErrorReadLine();
		try { await process.WaitForExitAsync(cancel); }
		catch (OperationCanceledException) { try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } throw; }
		string[] lines;
		lock (output) lines = output.ToArray();
		foreach (var line in lines) logs.Add(source, process.ExitCode == 0 ? "INFO" : "ERROR", "uv", line);
		if (process.ExitCode != 0)
			throw new InvalidOperationException($"uv {string.Join(' ', arguments.Take(2))} failed (exit code {process.ExitCode}): {string.Join(" | ", lines.TakeLast(4))}");
	}

	/// <summary>The python/ folder of a source checkout (development).</summary>
	private static string? FindPackage()
	{
		foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
			for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
				if (File.Exists(Path.Combine(dir.FullName, "python", "pyproject.toml")) && Directory.Exists(Path.Combine(dir.FullName, "python", "src", "laborchestra")))
					return Path.Combine(dir.FullName, "python");
		return null;
	}
}
