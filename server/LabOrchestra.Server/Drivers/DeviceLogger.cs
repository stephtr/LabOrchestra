using LabOrchestra.Server.Logging;
using Microsoft.Extensions.Logging;

namespace LabOrchestra.Server.Drivers;

/// <summary>The log of an in-process device: into the same store as the logs of the Python devices (source "device:id").</summary>
public sealed class DeviceLogger(string id, LogStore logs) : ILogger
{
	public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

	public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Information;

	public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
	{
		if (!IsEnabled(logLevel)) return;
		var level = logLevel switch { LogLevel.Warning => "WARNING", LogLevel.Error => "ERROR", LogLevel.Critical => "CRITICAL", _ => "INFO" };
		logs.Add($"device:{id}", level, $"lab.{id}", formatter(state, exception), exception?.ToString());
	}
}
