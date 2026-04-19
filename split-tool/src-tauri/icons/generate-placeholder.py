"""生成占位图标 PNG (1024x1024 蓝色方块)"""
import struct, zlib, os

def create_png(width, height, r, g, b):
    """创建纯色 PNG"""
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack('>I', zlib.crc32(c) & 0xffffffff)
        return struct.pack('>I', len(data)) + c + crc

    signature = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr = chunk(b'IHDR', ihdr_data)

    raw_data = b''
    row = bytes([r, g, b] * width)
    for _ in range(height):
        raw_data += b'\x00' + row  # filter byte 0 (None) + pixel data

    compressed = zlib.compress(raw_data, 9)
    idat = chunk(b'IDAT', compressed)
    iend = chunk(b'IEND', b'')

    return signature + ihdr + idat + iend

# 生成源图标 (1024x1024)
icon_dir = os.path.dirname(os.path.abspath(__file__))
source = create_png(1024, 1024, 59, 130, 246)  # 蓝色

with open(os.path.join(icon_dir, 'app-icon.png'), 'wb') as f:
    f.write(source)

# 生成各尺寸 PNG
for size in [32, 128, 256]:
    data = create_png(size, size, 59, 130, 246)
    with open(os.path.join(icon_dir, f'{size}x{size}.png'), 'wb') as f:
        f.write(data)

# 128x128@2x = 256x256
data = create_png(256, 256, 59, 130, 246)
with open(os.path.join(icon_dir, '128x128@2x.png'), 'wb') as f:
    f.write(data)

print("✓ 占位图标已生成")
