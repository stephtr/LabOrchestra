using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace LabOrchestra.Server.Supervision;

/// <summary>
/// Makes sure that workers do not outlive the server. A worker that waits for end-of-input stops by itself, except one that is stuck
/// (holding the GIL in a driver call) and would keep the hardware open. So, in addition:
/// Windows: every worker is in a Job Object that kills them when the server ends, however it ends;
/// Linux: workers ask the kernel to kill them with the server (PR_SET_PDEATHSIG, set by the worker; it fires when the *thread* that
/// started the process ends, so all workers are started from one thread that lives as long as the server);
/// everywhere: the PID and start time of each worker are recorded, and the next server start kills what is left over before any
/// device opens its hardware again (the only help on macOS).
/// </summary>
public sealed class WorkerGuard : IDisposable
{
	private sealed record Entry(int Pid, DateTime StartedUtc, string Device);

	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private readonly string _file;
	private readonly ILogger<WorkerGuard> _log;
	private readonly object _lock = new();
	private readonly List<Entry> _entries = [];
	private readonly BlockingCollection<(Process Process, TaskCompletionSource Done)> _starts = new();
	private readonly Thread _spawner;
	private readonly nint _job;

	public WorkerGuard(string dataDir, ILogger<WorkerGuard> log)
	{
		_file = Path.Combine(dataDir, "workers.json");
		_log = log;
		if (OperatingSystem.IsWindows()) _job = WindowsJob.Create();
		_spawner = new Thread(SpawnLoop) { IsBackground = true, Name = "worker-spawner" };
		_spawner.Start();
	}

	/// <summary>Kills workers that a server which did not shut down properly left behind. Call before any worker starts.</summary>
	public void KillLeftovers()
	{
		List<Entry> old;
		lock (_lock) old = Read();
		foreach (var entry in old)
		{
			try
			{
				using var process = Process.GetProcessById(entry.Pid);
				// the same number may belong to an unrelated process by now: only the same start time counts
				if (Math.Abs((process.StartTime.ToUniversalTime() - entry.StartedUtc).TotalSeconds) > 2) continue;
				_log.LogWarning("Killing the worker of {Device} (pid {Pid}) that a previous server left behind", entry.Device, entry.Pid);
				process.Kill(entireProcessTree: true);
				process.WaitForExit(5000);
			}
			catch (ArgumentException) { } // no such process: it ended by itself
			catch (Exception e) { _log.LogWarning("Could not clean up the worker of {Device} (pid {Pid}): {Message}", entry.Device, entry.Pid, e.Message); }
		}
		lock (_lock) Write([]);
	}

	/// <summary>Starts the process (from the thread that lives as long as the server) and puts it under the guard.</summary>
	public void Start(Process process, string device)
	{
		var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		_starts.Add((process, done));
		done.Task.GetAwaiter().GetResult();
		try { if (_job != 0) WindowsJob.Add(_job, process); }
		catch (Exception e) { _log.LogWarning("Worker of {Device} is not in the job object: {Message}", device, e.Message); }
		lock (_lock)
		{
			_entries.Add(new Entry(process.Id, process.StartTime.ToUniversalTime(), device));
			Write(_entries);
		}
		process.Exited += (_, _) => Forget(process.Id);
		if (process.HasExited) Forget(process.Id);
	}

	private void Forget(int pid)
	{
		lock (_lock)
		{
			_entries.RemoveAll(e => e.Pid == pid);
			Write(_entries);
		}
	}

	private void SpawnLoop()
	{
		foreach (var (process, done) in _starts.GetConsumingEnumerable())
		{
			try { process.Start(); done.SetResult(); }
			catch (Exception e) { done.SetException(e); }
		}
	}

	private List<Entry> Read()
	{
		try { return File.Exists(_file) ? JsonSerializer.Deserialize<List<Entry>>(File.ReadAllText(_file), Json) ?? [] : []; }
		catch (Exception e) when (e is IOException or JsonException) { return []; }
	}

	private void Write(List<Entry> entries)
	{
		try
		{
			Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
			File.WriteAllText(_file, JsonSerializer.Serialize(entries, Json));
		}
		catch (IOException e) { _log.LogWarning("Could not record the workers: {Message}", e.Message); }
	}

	public void Dispose() => _starts.CompleteAdding();

	private static class WindowsJob
	{
		// JOBOBJECT_EXTENDED_LIMIT_INFORMATION (verified on Windows in spike 02)
		[StructLayout(LayoutKind.Sequential)]
		private struct Extended
		{
			public long PerProcessUserTime, PerJobUserTime;
			public uint Flags;
			public nuint MinWorkingSet, MaxWorkingSet;
			public uint ActiveProcessLimit;
			public nuint Affinity;
			public uint Priority, Scheduling;
			public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
			public nuint ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
		}

		[DllImport("kernel32", SetLastError = true)] private static extern nint CreateJobObjectW(nint attributes, nint name);
		[DllImport("kernel32", SetLastError = true)] private static extern bool SetInformationJobObject(nint job, int kind, ref Extended info, int size);
		[DllImport("kernel32", SetLastError = true)] private static extern bool AssignProcessToJobObject(nint job, nint process);

		public static nint Create()
		{
			var job = CreateJobObjectW(0, 0);
			var info = new Extended { Flags = 0x2000 }; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
			if (job == 0 || !SetInformationJobObject(job, 9, ref info, Marshal.SizeOf<Extended>())) throw new Win32Exception();
			return job;
		}

		public static void Add(nint job, Process process)
		{
			if (!AssignProcessToJobObject(job, process.Handle)) throw new Win32Exception();
		}
	}
}
