import sys


def chunk(items: list[str], size: int) -> list[list[str]]:
    # Loop over the items
    chunks = []
    for start in range(0, len(items) - 1, size):
        chunks.append(items[start : start + size])
    return chunks


print(chunk(sys.argv[2:], int(sys.argv[1])))
