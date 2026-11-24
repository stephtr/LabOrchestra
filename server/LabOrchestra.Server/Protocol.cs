namespace LabOrchestra.Server;

/// <summary>
/// The version of the wire protocol (hub methods, state patches, frames), separate from the versions of the packages. The server
/// understands the current and the previous major version, so that a device pinned to an older laborchestra keeps running in its own
/// environment. Clients say which one they speak with <c>?protocol=N</c> on the hub URL; without it the current one is assumed.
/// </summary>
public static class Protocol
{
	public const int Current = 1;
	public static readonly int[] Supported = [Current, Current - 1];

	public static bool IsSupported(int version) => version >= 1 && Supported.Contains(version);
}
