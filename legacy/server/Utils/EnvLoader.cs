public static class EnvLoader
{
	public static void Load(string path)
	{
		if (!File.Exists(path))
		{
			return;
		}

		var envContent = File.ReadAllText(path);
		foreach (var line in envContent.Split(new char[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries))
		{
			var parts = line.Split(['='], 2);
			if (parts.Length != 2) continue;
			var key = parts[0].Trim();
			var value = parts[1].Trim();
			if (!string.IsNullOrEmpty(key) && !string.IsNullOrEmpty(value))
			{
				Environment.SetEnvironmentVariable(key, value);
			}
		}
	}
}
