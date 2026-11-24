using System.Diagnostics;
using System.Text.Json;
using LabOrchestra.Server.Auth;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Logging;

namespace LabOrchestra.Server.Supervision;

public sealed record ServerInfo(string WorkerUrl);

/// <summary>
/// Keeps one Python worker process per device of devices.json: starts it, restarts it with increasing delays when
/// it ends, and follows changes of the file (new devices start, removed ones stop, changed ones restart). The server
/// keeps each worker's stdin open: when the server dies, the operating system closes it and the worker stops by itself.
/// </summary>
public sealed class WorkerSupervisor(
	Workspace workspace,
	DeviceRegistry registry,
	LogStore logs,
	SettingsStore settings,
	SecretStore secrets,
	TokenService tokens,
	ServerInfo info,
	IConfiguration config,
	ILogger<WorkerSupervisor> log) : BackgroundService
{
	private static readonly TimeSpan MaxDelay = TimeSpan.FromSeconds(30);
	private static readonly TimeSpan StopGrace = TimeSpan.FromSeconds(4);

	private sealed record Runner(DeviceConfig Config, string Signature, CancellationTokenSource Cancel, Task Task);

	private readonly Dictionary<string, Runner> _runners = new();
	private readonly SemaphoreSlim _gate = new(1, 1);
	private CancellationToken _stop;

	protected override async Task ExecuteAsync(CancellationToken stop)
	{
		_stop = stop;
		await ReconcileAsync();
		workspace.Changed += () => _ = ReconcileAsync();
		try { await Task.Delay(Timeout.Infinite, stop); } catch (OperationCanceledException) { }
		await _gate.WaitAsync(CancellationToken.None);
		try { await Task.WhenAll(_runners.Values.Select(r => r.Task)); } finally { _gate.Release(); }
	}

	/// <summary>Makes the running workers match devices.json.</summary>
	public async Task ReconcileAsync()
	{
		await _gate.WaitAsync();
		try
		{
			var wanted = workspace.Devices;
			foreach (var id in _runners.Keys.Except(wanted.Keys).ToList())
			{
				await StopRunnerAsync(id);
				registry.Remove(id);
				log.LogInformation("Device {Device} removed", id);
			}
			foreach (var (id, device) in wanted)
			{
				var signature = JsonSerializer.Serialize(device);
				if (_runners.TryGetValue(id, out var running))
				{
					if (running.Signature == signature) continue;
					logs.Add($"device:{id}", "INFO", "supervisor", "The configuration changed, restarting");
					await StopRunnerAsync(id);
				}
				StartRunner(id, device, signature);
			}
		}
		finally { _gate.Release(); }
	}

	public async Task<bool> RestartAsync(string id)
	{
		await _gate.WaitAsync();
		try
		{
			if (!_runners.TryGetValue(id, out var runner)) return false;
			logs.Add($"device:{id}", "INFO", "supervisor", "Restart requested");
			await StopRunnerAsync(id);
			StartRunner(id, runner.Config, runner.Signature);
			return true;
		}
		finally { _gate.Release(); }
	}

	/// <summary>Devices that use the secret start again, so that a newly defined secret takes effect at once.</summary>
	public async Task SecretChangedAsync(string name)
	{
		string[] affected;
		await _gate.WaitAsync();
		try { affected = _runners.Where(r => UsesSecret(r.Value.Config, name)).Select(r => r.Key).ToArray(); }
		finally { _gate.Release(); }
		foreach (var id in affected) await RestartAsync(id);
	}

	private static bool UsesSecret(DeviceConfig device, string name) =>
		device.Config?.Values.Any(v => v.ValueKind == JsonValueKind.Object && v.TryGetProperty("secret", out var s) && s.GetString() == name) == true;

	private void StartRunner(string id, DeviceConfig device, string signature)
	{
		var cancel = CancellationTokenSource.CreateLinkedTokenSource(_stop);
		_runners[id] = new Runner(device, signature, cancel, Task.Run(() => SuperviseAsync(id, device, cancel.Token), CancellationToken.None));
	}

	private async Task StopRunnerAsync(string id)
	{
		if (!_runners.Remove(id, out var runner)) return;
		runner.Cancel.Cancel();
		try { await runner.Task; } catch (Exception e) { log.LogWarning("Stopping {Device}: {Message}", id, e.Message); }
		runner.Cancel.Dispose();
	}

	private async Task SuperviseAsync(string id, DeviceConfig device, CancellationToken stop)
	{
		var delay = TimeSpan.FromMilliseconds(250);
		registry.Declare(id);
		while (!stop.IsCancellationRequested)
		{
			var tail = new Queue<string>();
			var started = DateTime.UtcNow;
			var registrations = registry.Get(id)?.Registrations ?? 0;
			Process? process = null;
			try
			{
				process = Start(id, device, tokens.IssueDeviceToken(id), tail);
				log.LogInformation("Started the worker of {Device} (pid {Pid})", id, process.Id);
				logs.Add($"device:{id}", "INFO", "supervisor", $"Started the worker (pid {process.Id})");
				await process.WaitForExitAsync(stop);
				string[] lines;
				lock (tail) lines = tail.ToArray();
				if ((registry.Get(id)?.Registrations ?? 0) == registrations)
					// never came up, so nothing was sent over the hub: keep its output in the device's log
					foreach (var line in lines) logs.Add($"device:{id}", LevelOf(line), "process", line);
				var message = $"The worker ended with exit code {process.ExitCode}" + (lines.Length > 0 ? ":\n" + string.Join('\n', lines) : "");
				registry.SetStatus(id, "error", message);
				log.LogWarning("The worker of {Device} ended with exit code {Code}", id, process.ExitCode);
				logs.Add($"device:{id}", "WARNING", "supervisor", $"The worker ended with exit code {process.ExitCode}; restarting in {delay.TotalSeconds:0.#} s");
			}
			catch (OperationCanceledException)
			{
				await StopAsync(id, process);
				break;
			}
			catch (Exception e)
			{
				registry.SetStatus(id, "error", $"Could not start the worker: {e.Message}");
				log.LogError("Could not start the worker of {Device}: {Message}", id, e.Message);
				logs.Add($"device:{id}", "ERROR", "supervisor", $"Could not start the worker: {e.Message}; trying again in {delay.TotalSeconds:0.#} s");
			}
			finally
			{
				tokens.RevokeDeviceTokens(id);
			}
			if (DateTime.UtcNow - started > TimeSpan.FromSeconds(30)) delay = TimeSpan.FromMilliseconds(250);
			try { await Task.Delay(delay, stop); } catch (OperationCanceledException) { break; }
			delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, MaxDelay.TotalMilliseconds));
			registry.Declare(id);
		}
		registry.SetStatus(id, "stopped");
	}

	/// <summary>The options as JSON; {"secret": "name"} is replaced by the secret's value.</summary>
	private string ResolveConfig(DeviceConfig device)
	{
		var resolved = new Dictionary<string, object?>();
		foreach (var (key, value) in device.Config ?? [])
		{
			if (value.ValueKind == JsonValueKind.Object && value.TryGetProperty("secret", out var name))
			{
				var secret = name.GetString() ?? "";
				resolved[key] = secrets.Get(secret) ?? throw new InvalidOperationException($"The secret '{secret}' (option '{key}') is not defined");
			}
			else resolved[key] = value;
		}
		return JsonSerializer.Serialize(resolved);
	}

	private Process Start(string id, DeviceConfig device, string token, Queue<string> tail)
	{
		var python = device.Python ?? config["python"] ?? (OperatingSystem.IsWindows() ? "python" : "python3");
		var startInfo = new ProcessStartInfo(python)
		{
			WorkingDirectory = workspace.Path,
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};
		foreach (var arg in new[] { "-u", "-m", "laborchestra.worker", Path.GetFullPath(device.File, workspace.Path) })
			startInfo.ArgumentList.Add(arg);
		startInfo.Environment["LABORCHESTRA_URL"] = info.WorkerUrl;
		startInfo.Environment["LABORCHESTRA_TOKEN"] = token;
		startInfo.Environment["LABORCHESTRA_DEVICE_ID"] = id;
		startInfo.Environment["LABORCHESTRA_CONFIG"] = ResolveConfig(device);
		startInfo.Environment["LABORCHESTRA_WATCH_STDIN"] = "1";
		if (settings.Load(id) is { } saved) startInfo.Environment["LABORCHESTRA_SETTINGS"] = saved;
		startInfo.Environment["PYTHONUNBUFFERED"] = "1";
		var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
		process.OutputDataReceived += (_, e) => Line(id, e.Data, tail);
		process.ErrorDataReceived += (_, e) => Line(id, e.Data, tail);
		process.Start();
		process.BeginOutputReadLine();
		process.BeginErrorReadLine();
		return process;
	}

	private static string LevelOf(string line) =>
		line.StartsWith("CRITICAL") ? "CRITICAL" : line.StartsWith("ERROR") ? "ERROR" : line.StartsWith("WARNING") ? "WARNING" : "INFO";

	private void Line(string id, string? line, Queue<string> tail)
	{
		if (string.IsNullOrWhiteSpace(line)) return;
		lock (tail)
		{
			tail.Enqueue(line);
			while (tail.Count > 15) tail.Dequeue();
		}
		if (line.StartsWith("ERROR") || line.StartsWith("CRITICAL")) log.LogError("[{Device}] {Line}", id, line);
		else if (line.StartsWith("WARNING")) log.LogWarning("[{Device}] {Line}", id, line);
		else log.LogInformation("[{Device}] {Line}", id, line);
	}

	private async Task StopAsync(string id, Process? process)
	{
		if (process is null || process.HasExited) return;
		try
		{
			process.StandardInput.Close(); // end of input = stop
			using var grace = new CancellationTokenSource(StopGrace);
			await process.WaitForExitAsync(grace.Token);
		}
		catch (OperationCanceledException)
		{
			log.LogWarning("The worker of {Device} did not stop in time and is killed", id);
			process.Kill(entireProcessTree: true);
		}
		catch (Exception e)
		{
			log.LogWarning("Stopping the worker of {Device}: {Message}", id, e.Message);
		}
	}
}
