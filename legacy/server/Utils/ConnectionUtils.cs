public static class ConnectionUtils
{
	public static bool IsLocal(ConnectionInfo? connectionInfo)
	{
		if (connectionInfo == null) return false;
		var ipAddress = connectionInfo.RemoteIpAddress?.ToString();
		if (string.IsNullOrEmpty(ipAddress)) return false;
		return ipAddress == "127.0.0.1" || ipAddress == "::1" || ipAddress == connectionInfo.LocalIpAddress?.ToString();
	}
}
