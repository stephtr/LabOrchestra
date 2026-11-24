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

	[GeneratedRegex(@"(?m)^# /// script$\s(?<content>(?:^#(?:| .*)$\s)+)^# ///$")]
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
		var (requires, dependencies) = ReadScriptMetadata(deviceFile);
		var wanted = explicitPython ?? requires; // a version such as "3.12", or the requirement of the file; null: uv chooses
		var identity = Directory.Exists(package) ? Path.GetFullPath(package) : $"{Path.GetFileName(package)}:{Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(package)))}";
		var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', wanted ?? "", identity, string.Join('\n', dependencies.Order())))))[..16].ToLowerInvariant();
		var directory = Path.Combine(dataDir, "envs", key);
		var python = Path.Combine(directory, OperatingSystem.IsWindows() ? "Scripts" : "bin", OperatingSystem.IsWindows() ? "python.exe" : "python");
		var marker = Path.Combine(directory, ".ready");

		var gate = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
		await gate.WaitAsync(cancel);
		try
		{
			if (File.Exists(marker)) return python;
			if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); // an earlier attempt that did not finish
			var source = $"device:{deviceId}";
			logs.Add(source, "INFO", "environment", $"Preparing the Python environment {key} ({(dependencies.Count == 0 ? "no extra dependencies" : string.Join(", ", dependencies))})");
			var venv = new List<string> { "venv", "--quiet" };
			if (wanted is not null) venv.AddRange(["--python", wanted]);
			venv.Add(directory);
			await RunAsync(uv, venv, source, cancel);
			var install = new List<string> { "pip", "install", "--quiet", "--python", python };
			if (Directory.Exists(package)) install.AddRange(["--editable", package]); else install.Add(package);
			install.AddRange(dependencies);
			await RunAsync(uv, install, source, cancel);
			File.WriteAllText(marker, JsonSerializer.Serialize(new { wanted, package = identity, dependencies }));
			logs.Add(source, "INFO", "environment", $"The environment {key} is ready");
			return python;
		}
		catch
		{
			try { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); } catch (IOException) { }
			throw;
		}
		finally { gate.Release(); }
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
