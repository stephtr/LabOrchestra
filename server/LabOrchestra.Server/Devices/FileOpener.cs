using System.Diagnostics;

namespace LabOrchestra.Server.Devices;

/// <summary>"Open in editor" and "Show in folder" for files of the workspace. They start programs on the computer that runs the server, so they
/// work only for a client on that computer; anyone else gets the path to open themselves. The editor is the option <c>editor</c>
/// (<c>LABORCHESTRA_EDITOR</c>, e.g. "code" or "subl"), else VS Code when it is installed, else what the system opens the file with.</summary>
public sealed class FileOpener(Workspace workspace, IConfiguration config, ILogger<FileOpener> log)
{
	/// <summary>The full path of an existing file or folder inside the workspace (nothing outside it is ever opened).</summary>
	public string Resolve(string relative)
	{
		var root = Path.GetFullPath(workspace.Path);
		var full = Path.GetFullPath(Path.Combine(root, relative));
		if (!full.StartsWith(root + Path.DirectorySeparatorChar) || !(File.Exists(full) || Directory.Exists(full)))
			throw new ArgumentException($"'{relative}' is not a file in the workspace");
		return full;
	}

	public string Open(string relative, string how, bool isLocal)
	{
		var full = Resolve(relative);
		if (how is not ("editor" or "folder")) throw new ArgumentException("how must be 'editor' or 'folder'");
		if (!isLocal) throw new InvalidOperationException($"Files can be opened only from the computer that runs LabOrchestra. The file is {full}");
		var (program, arguments) = how == "folder" ? Reveal(full) : Edit(full);
		try
		{
			Process.Start(new ProcessStartInfo(program) { UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true }.WithArguments(arguments))?.Dispose();
		}
		catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
		{
			throw new InvalidOperationException($"{program} could not be started ({e.Message}). The file is {full}");
		}
		log.LogInformation("Opened {File} ({How})", full, how);
		return full;
	}

	private (string Program, string[] Arguments) Reveal(string full)
	{
		if (OperatingSystem.IsMacOS()) return ("open", ["-R", full]);
		if (OperatingSystem.IsWindows()) return ("explorer.exe", [$"/select,{full}"]);
		return ("xdg-open", [Directory.Exists(full) ? full : Path.GetDirectoryName(full)!]);
	}

	private (string Program, string[] Arguments) Edit(string full)
	{
		var editor = config["editor"];
		if (!string.IsNullOrWhiteSpace(editor)) return (editor, [full]);
		var code = OperatingSystem.IsWindows() ? "code.cmd" : "code";
		if (OnPath(code)) return (code, [Path.GetDirectoryName(full)!, "--goto", full]); // the workspace folder, with the file in it
		if (OperatingSystem.IsMacOS()) return ("open", [full]);
		if (OperatingSystem.IsWindows()) return ("cmd", ["/c", "start", "", full]);
		return ("xdg-open", [full]);
	}

	private static bool OnPath(string program) =>
		(Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator).Any(d => d.Length > 0 && File.Exists(Path.Combine(d, program)));
}

internal static class ProcessStartInfoExtensions
{
	public static ProcessStartInfo WithArguments(this ProcessStartInfo info, IEnumerable<string> arguments)
	{
		foreach (var a in arguments) info.ArgumentList.Add(a);
		return info;
	}
}
