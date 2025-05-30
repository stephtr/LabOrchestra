public class CircularBuffer<T>
{
	public readonly T[] Buffer;
	public readonly long Capacity;
	private long Head = 0;
	private long Tail = 0;
	public bool HasRolledOver { get; private set; } = false;

	public CircularBuffer(long capacity)
	{
		Capacity = capacity;
		Buffer = new T[capacity];
	}

	public void Push(T[] values, int count = -1)
	{
		if (count < 0) count = values.Length;
		if (count > Capacity)
		{
			throw new InvalidOperationException("Too many elements to push");
		}
		if (Capacity - Head >= count)
		{
			Array.Copy(values, 0, Buffer, Head, count);
			Head += count;
			if (Head == Capacity)
			{
				Head = 0;
				HasRolledOver = true;
			}
		}
		else
		{
			var valuesToCopy = Capacity - Head;
			Array.Copy(values, 0, Buffer, Head, valuesToCopy);
			Array.Copy(values, valuesToCopy, Buffer, 0, count - valuesToCopy);
			Head = count - valuesToCopy;
			if (Head >= Tail)
			{
				Tail = (Head + 1) % Capacity;
			}
			HasRolledOver = true;
		}
		if (Head > Capacity)
		{
			throw new InvalidOperationException("Head is out of bounds; this is clearly a (multi-threading) bug");
		}
	}

	private T[] PeekTail(long count, T[]? values, bool incrementTail)
	{
		if (count > Count)
		{
			throw new InvalidOperationException("Not enough elements in the buffer");
		}
		if (values == null)
		{
			values = new T[count];
		}
		if (Tail + count <= Capacity)
		{
			Array.Copy(Buffer, Tail, values, 0, count);
			if (incrementTail)
			{
				Tail += count;
				if (Tail == Capacity)
				{
					Tail = 0;
				}
			}
		}
		else
		{
			var valuesToCopy = Capacity - Tail;
			Array.Copy(Buffer, Tail, values, 0, valuesToCopy);
			Array.Copy(Buffer, 0, values, valuesToCopy, count - valuesToCopy);
			if (incrementTail) Tail = count - valuesToCopy;
		}
		return values;
	}

	public T[] Pop(long count, T[]? values = null)
	{
		return PeekTail(count, values, true);
	}

	public T[] PeekTail(long count, T[]? values = null)
	{
		return PeekTail(count, values, false);
	}

	public T[] PeekHead(long count, T[]? values = null, bool readPastTail = false)
	{
		if ((count > Count && !readPastTail) || count > Capacity)
		{
			throw new InvalidOperationException("Not enough elements in the buffer");
		}
		if (values == null)
		{
			values = new T[count];
		}
		if (Head - count >= 0)
		{
			Array.Copy(Buffer, Head - count, values, 0, count);
		}
		else
		{
			var valuesToCopy = count - Head;
			Array.Copy(Buffer, Capacity - valuesToCopy, values, 0, valuesToCopy);
			Array.Copy(Buffer, 0, values, valuesToCopy, count - valuesToCopy);
		}
		return values;
	}

	public void Clear()
	{
		Head = 0;
		Tail = 0;
		HasRolledOver = false;
		Array.Clear(Buffer);
	}

	public long Count => Head >= Tail ? Head - Tail : Capacity - Tail + Head;
	public long CountIncludingAlreadyReadItems => HasRolledOver ? Capacity : Head;

	public T[] ToArray(bool readPastTail = false)
	{
		if (!HasRolledOver) readPastTail = false;
		return PeekHead(readPastTail ? Capacity : Count, readPastTail: readPastTail);
	}
}
