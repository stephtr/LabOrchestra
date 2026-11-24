using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

// taken from https://github.com/dotnet/runtime/issues/98038

public class NaturalObjectConverter : JsonConverter<object>
{
	public override object? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
		=> ReadObjectCore(ref reader);

	public override void Write(Utf8JsonWriter writer, object value, JsonSerializerOptions options)
	{
		Type runtimeType = value.GetType();
		if (runtimeType == typeof(object))
		{
			writer.WriteStartObject();
			writer.WriteEndObject();
		}
		else
		{
			JsonSerializer.Serialize(writer, value, runtimeType, options);
		}
	}

	private static object? ReadObjectCore(ref Utf8JsonReader reader)
	{
		switch (reader.TokenType)
		{
			case JsonTokenType.Null:
				return null;

			case JsonTokenType.False or JsonTokenType.True:
				return reader.GetBoolean();

			case JsonTokenType.Number:
				if (reader.TryGetInt32(out int intValue))
				{
					return intValue;
				}
				if (reader.TryGetInt64(out long longValue))
				{
					return longValue;
				}

				// TODO decimal handling?
				return reader.GetDouble();

			case JsonTokenType.String:
				return reader.GetString();

			case JsonTokenType.StartArray:
				var list = new List<object?>();
				while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
				{
					object? element = ReadObjectCore(ref reader);
					list.Add(element);
				}
				return list;

			case JsonTokenType.StartObject:
				var dict = new Dictionary<string, object?>();
				while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
				{
					Debug.Assert(reader.TokenType is JsonTokenType.PropertyName);
					string propertyName = reader.GetString()!;

					if (!reader.Read()) throw new JsonException();
					object? propertyValue = ReadObjectCore(ref reader);
					dict[propertyName] = propertyValue;
				}
				return dict;

			default:
				throw new JsonException();
		}
	}
}
