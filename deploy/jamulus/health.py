"""Check a Jamulus UDP ping response, without joining or sending audio."""
import binascii
import os
import socket
import struct

nonce = os.urandom(4)
body = struct.pack('<HHBH', 0, 1001, 0, 4) + nonce
packet = body + struct.pack('<H', binascii.crc_hqx(body, 0xffff) ^ 0xffff)
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
    sock.settimeout(2)
    sock.connect(('127.0.0.1', 22124))
    sock.send(packet)
    reply = sock.recv(128)
    if reply != packet:
        raise SystemExit('Invalid Jamulus response')
