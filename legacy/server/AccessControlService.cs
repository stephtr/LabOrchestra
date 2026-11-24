public class AccessControlService
{
	public string? Passphrase { private get; set; } = null;
	public bool IsBearerValid(string? bearerToken)
	{
		if (string.IsNullOrEmpty(Passphrase) || string.IsNullOrEmpty(bearerToken))
			return false;
		return bearerToken == $"Bearer {Passphrase}";
	}
}
