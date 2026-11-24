using System.Diagnostics;
using System.Text.Json;
using LabOrchestra.Server.Auth;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Logging;

namespace LabOrchestra.Server.Supervision;

public sealed record ServerInfo(string WorkerUrl);

/// <summary>
/// Starts one Python worker process per configured device, restarts it with increasing delays when it
/// ends, and stops it when the server stops. The server keeps each worker's stdin open: when the server dies,
/// the operating system closes it, and the worker stops by itself.
/// </summary>
public sealed class WorkerSupervisor(
	Workspace workspace,
	DeviceRegistry registry,
	LogStore logs,
	TokenService tokens,
	ServerInfo info,
	IConfiguration config,
	ILogger<WorkerSupervisor> log) : BackgroundService
{
	private static readonly TimeSpan MaxDelay = TimeSpan.FromSeconds(30);
	private static readonly TimeSpan StopGrace = TimeSpan.FromSeconds(4);

	protected override Task ExecuteAsync(CancellationToken stop) =>
		Task.WhenAll(workspace.Devices.Select(d => Task.Run(() => SuperviseAsync(d.Key, d.Value, stop), CancellationToken.None)));

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

	private Process Start(string id, DeviceConfig device, string token, Queue<string> tail)
	{
		var python = device.Python ?? config["python"] ?? (OperatingSystem.IsWindows() ? "python" : "python3");
		var info2 = new ProcessStartInfo(python)
		{
			WorkingDirectory = workspace.Path,
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};
		foreach (var arg in new[] { "-u", "-m", "laborchestra.worker", Path.GetFullPath(device.File, workspace.Path) })
			info2.ArgumentList.Add(arg);
		info2.Environment["LABORCHESTRA_URL"] = info.WorkerUrl;
		info2.Environment["LABORCHESTRA_TOKEN"] = token;
		info2.Environment["LABORCHESTRA_DEVICE_ID"] = id;
		info2.Environment["LABORCHESTRA_CONFIG"] = JsonSerializer.Serialize(device.Config ?? []);
		info2.Environment["LABORCHESTRA_WATCH_STDIN"] = "1";
		info2.Environment["PYTHONUNBUFFERED"] = "1";
		var process = new Process { StartInfo = info2, EnableRaisingEvents = true };
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
