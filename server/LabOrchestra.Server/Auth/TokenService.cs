using System.Collections.Concurrent;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

namespace LabOrchestra.Server.Auth;

public static class Roles
{
	public const string Client = "client";
	public const string Device = "device";
}

/// <summary>
/// Two kinds of tokens: the passphrase (browsers, scripts, MCP; role client) and one random token per
/// started worker (role device, bound to one device id, valid until the process ends).
/// </summary>
public sealed class TokenService
{
	private readonly byte[] _passphrase;
	private readonly ConcurrentDictionary<string, string> _deviceTokens = new();

	private readonly TokenStore _store;

	public TokenService(string passphrase, TokenStore store)
	{
		_passphrase = Encoding.UTF8.GetBytes(passphrase);
		_store = store;
	}

	public static string NewSecret() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).Replace('+', '-').Replace('/', '_').TrimEnd('=');

	/// <summary>Passphrase from the environment, else from a file in the data directory (created on first start).</summary>
	public static string LoadOrCreatePassphrase(string? fromConfig, string dataDir)
	{
		if (!string.IsNullOrWhiteSpace(fromConfig)) return fromConfig.Trim();
		var file = Path.Combine(dataDir, "passphrase");
		if (File.Exists(file)) return File.ReadAllText(file).Trim();
		Directory.CreateDirectory(dataDir);
		var secret = NewSecret();
		File.WriteAllText(file, secret);
		if (!OperatingSystem.IsWindows())
			File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
		return secret;
	}

	public string IssueDeviceToken(string deviceId)
	{
		var token = NewSecret();
		_deviceTokens[token] = deviceId;
		return token;
	}

	public void RevokeDeviceTokens(string deviceId)
	{
		foreach (var (token, id) in _deviceTokens)
			if (id == deviceId) _deviceTokens.TryRemove(token, out _);
	}

	public ClaimsPrincipal? Validate(string token)
	{
		if (CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(token), _passphrase))
			return Principal(Roles.Client);
		if (_deviceTokens.TryGetValue(token, out var deviceId))
			return Principal(Roles.Device, new Claim("device_id", deviceId));
		if (token.StartsWith("lo_") && _store.Find(token) is { Kind: "worker", Device: { } remoteDevice })
			return Principal(Roles.Device, new Claim("device_id", remoteDevice)); // a worker on another machine: may register this device only
		return null;
	}

	private static ClaimsPrincipal Principal(string role, params Claim[] extra) =>
		new(new ClaimsIdentity([new Claim(ClaimTypes.Role, role), .. extra], "LabOrchestra"));
}
