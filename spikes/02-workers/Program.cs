using System.Diagnostics; using System.Runtime.InteropServices;
Process Start(string mode) { var p = Process.Start(new ProcessStartInfo(args[0]) { ArgumentList = { "dev.py", mode }, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true })!;
  if (OperatingSystem.IsWindows() && args.Contains("job")) Job.Add(p);
  p.OutputDataReceived += (_, e) => { if (e.Data != null) Console.WriteLine($"  [{mode}] {e.Data}"); }; p.BeginOutputReadLine(); p.BeginErrorReadLine(); return p; }
if (args[1] == "hold") { Start("normal"); Start("blocked"); Start("gil"); Thread.Sleep(60000); return; }
foreach (var m in new[] { "normal", "blocked", "gil" }) { var p = Start(m); Thread.Sleep(1500); var w = Stopwatch.StartNew(); p.StandardInput.Close();
  var ok = p.WaitForExit(4000); if (!ok) { p.Kill(true); p.WaitForExit(); } Console.WriteLine($"stop {m}: {(ok ? "exited by itself" : "had to be killed")}, code {p.ExitCode}, {w.ElapsedMilliseconds} ms"); }
for (int i = 0; i < 2; i++) { var p = Start("crash"); p.WaitForExit(); Console.WriteLine($"crash #{i + 1} detected, code {p.ExitCode}"); }
static class Job {
  [DllImport("kernel32", SetLastError = true)] static extern nint CreateJobObjectW(nint a, nint n);
  [DllImport("kernel32", SetLastError = true)] static extern bool SetInformationJobObject(nint j, int c, ref Ext i, int l);
  [DllImport("kernel32", SetLastError = true)] static extern bool AssignProcessToJobObject(nint j, nint p);
  [StructLayout(LayoutKind.Sequential)] struct Ext { public long T1, T2; public uint Flags; public nuint Min, Max; public uint Act; public nuint Aff; public uint Prio, Sched; public ulong a, b, c, d, e, f; public nuint g, h, i, j; }
  static readonly nint H = Make();
  static nint Make() { var h = CreateJobObjectW(0, 0); var i = new Ext { Flags = 0x2000 }; if (!SetInformationJobObject(h, 9, ref i, Marshal.SizeOf<Ext>())) throw new System.ComponentModel.Win32Exception(); return h; }
  public static void Add(Process p) { if (!AssignProcessToJobObject(H, p.Handle)) throw new System.ComponentModel.Win32Exception(); }
}
