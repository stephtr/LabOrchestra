using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace LabOrchestra.Server.Auth;

/// <summary>A token that was created in the UI or by a script (for a worker on another machine). Only a hash of the token is stored.</summary>
public sealed record StoredToken(string Id, string Kind, string? Device, string Label, string Hash, DateTimeOffset Created);

/// <summary>The long-lived tokens (tokens.json in the data folder, readable by the account only). A token is shown once, when it is created;
/// the file has its hash, so that a copy of the file does not give access.</summary>
public sealed class TokenStore
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
	private readonly string _file;
	private readonly object _lock = new();
	private List<StoredToken> _tokens;

	public TokenStore(string dataDir)
	{
		_file = Path.Combine(dataDir, "tokens.json");
		try { _tokens = File.Exists(_file) ? JsonSerializer.Deserialize<List<StoredToken>>(File.ReadAllText(_file), Json) ?? [] : []; }
		catch (JsonException) { _tokens = []; }
	}

	public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

	/// <summary>Creates a token; returns it together with its record. The token itself is not kept.</summary>
	public (string Token, StoredToken Record) Create(string kind, string? device, string label)
	{
		var token = "lo_" + TokenService.NewSecret();
		var record = new StoredToken(Guid.NewGuid().ToString("N")[..12], kind, device, label, Hash(token), DateTimeOffset.UtcNow);
		lock (_lock) { _tokens = [.. _tokens, record]; Save(); }
		return (token, record);
	}

	public StoredToken? Find(string token)
	{
		var hash = Hash(token);
		lock (_lock) return _tokens.FirstOrDefault(t => CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(t.Hash), Encoding.ASCII.GetBytes(hash)));
	}

	public List<StoredToken> List() { lock (_lock) return [.. _tokens]; }

	public bool Revoke(string id)
	{
		lock (_lock)
		{
			var next = _tokens.Where(t => t.Id != id).ToList();
			if (next.Count == _tokens.Count) return false;
			_tokens = next;
			Save();
			return true;
		}
	}

	private void Save()
	{
		Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
		var temporary = _file + ".tmp";
		File.WriteAllText(temporary, JsonSerializer.Serialize(_tokens, Json));
		if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
		File.Move(temporary, _file, overwrite: true);
	}
}
