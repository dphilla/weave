package io.github.dphilla.weave.endive;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Comparator;

/** Little-endian codecs shared by the meta, snapshot and wire formats. */
final class Bytes {
    static final Comparator<String> UTF8_ORDER = (a, b) -> Arrays.compareUnsigned(utf8(a), utf8(b));

    private Bytes() {}

    static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    static String utf8(byte[] data, int off, int len) {
        try {
            return StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(data, off, len))
                    .toString();
        } catch (CharacterCodingException e) {
            throw new FormatException("string is not valid UTF-8");
        }
    }

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] sha256(byte[] data) {
        return sha256().digest(data);
    }

    static String hex(byte[] data) {
        StringBuilder sb = new StringBuilder();
        for (byte b : data) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    /** Bounds-checked reader; every overrun is a FormatException. */
    static final class Reader {
        private final byte[] buf;
        private final int end;
        private int pos;

        Reader(byte[] buf) {
            this(buf, 0, buf.length);
        }

        Reader(byte[] buf, int pos, int end) {
            this.buf = buf;
            this.pos = pos;
            this.end = end;
        }

        int remaining() {
            return end - pos;
        }

        private int take(long n) {
            if (n < 0 || n > end - pos) {
                throw new FormatException("truncated input");
            }
            pos += (int) n;
            return pos - (int) n;
        }

        int u8() {
            return buf[take(1)] & 0xff;
        }

        int u16() {
            return u8() | u8() << 8;
        }

        int i32() {
            return u16() | u16() << 16;
        }

        long u32() {
            return Integer.toUnsignedLong(i32());
        }

        long u64() {
            return u32() | u32() << 32;
        }

        long leb() {
            long v = 0;
            for (int shift = 0; shift < 35; shift += 7) {
                int b = u8();
                if (shift == 28 && (b & 0xf0) != 0) {
                    break;
                }
                v |= (long) (b & 0x7f) << shift;
                if ((b & 0x80) == 0) {
                    return v;
                }
            }
            throw new FormatException("invalid u32 LEB128");
        }

        byte[] bytes(long n) {
            int at = take(n);
            return Arrays.copyOfRange(buf, at, at + (int) n);
        }

        Reader slice(long n) {
            int at = take(n);
            return new Reader(buf, at, at + (int) n);
        }

        String text(long n) {
            int at = take(n);
            return utf8(buf, at, (int) n);
        }

        String str() {
            return text(u32());
        }

        byte[] blob() {
            return bytes(u32());
        }

        byte[] rest() {
            return bytes(remaining());
        }

        void end(String what) {
            if (pos != end) {
                throw new FormatException(what + ": trailing bytes");
            }
        }
    }

    static final class Writer extends ByteArrayOutputStream {
        Writer u8(int v) {
            write(v);
            return this;
        }

        Writer u16(int v) {
            return u8(v).u8(v >>> 8);
        }

        Writer u32(long v) {
            return u16((int) v).u16((int) (v >>> 16));
        }

        Writer u64(long v) {
            return u32(v).u32(v >>> 32);
        }

        Writer raw(byte[] b) {
            write(b, 0, b.length);
            return this;
        }

        Writer str(String s) {
            return blob(utf8(s));
        }

        Writer blob(byte[] b) {
            return u32(b.length).raw(b);
        }
    }
}
