using System.Security.Cryptography;

public static class RandomUtils
{
	private static RandomNumberGenerator rng = RandomNumberGenerator.Create();

	public static string GetRandomHash()
	{
		var randomNumber = new byte[32];
		rng.GetBytes(randomNumber);
		return Convert.ToBase64String(randomNumber);
	}
}
