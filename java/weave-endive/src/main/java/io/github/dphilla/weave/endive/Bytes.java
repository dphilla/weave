package io.github.dphilla.weave.endive;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Comparator;

/** Little-endian codec helpers shared by the meta, snapshot and wire formats. */
final class Bytes {
    private Bytes() {}

    static final Comparator<String> UTF8_ORDER =
            (a, b) -> {
                byte[] x = a.getBytes(StandardCharsets.UTF_8);
                byte[] y = b.getBytes(StandardCharsets.UTF_8);
                int n = Math.min(x.length, y.length);
                for (int i = 0; i < n; i++) {
                    int c = Integer.compare(x[i] & 0xff, y[i] & 0xff);
                    if (c != 0) {
                        return c;
                    }
                }
                return Integer.compare(x.length, y.length);
            };

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    static byte[] sha256(byte[] data) {
        return sha256().digest(data);
    }

    static String hex(byte[] data) {
        StringBuilder sb = new StringBuilder(data.length * 2);
        for (byte b : data) {
            sb.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }

    static String utf8(byte[] data, int off, int len) {
        try {
            CharBuffer chars =
                    StandardCharsets.UTF_8
                            .newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(data, off, len));
            return chars.toString();
        } catch (CharacterCodingException e) {
            throw new FormatException("string is not valid UTF-8");
        }
    }

    /** Bounds-checked little-endian reader; every overrun is a {@link FormatException}. */
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

        int pos() {
            return pos;
        }

        int remaining() {
            return end - pos;
        }

        private int need(long n, String what) {
            if (n < 0 || n > end - pos) {
                throw new FormatException("truncated " + what);
            }
            int at = pos;
            pos += (int) n;
            return at;
        }

        int u8() {
            return buf[need(1, "u8")] & 0xff;
        }

        int u16() {
            int at = need(2, "u16");
            return (buf[at] & 0xff) | (buf[at + 1] & 0xff) << 8;
        }

        int i32() {
            int at = need(4, "u32");
            return (buf[at] & 0xff)
                    | (buf[at + 1] & 0xff) << 8
                    | (buf[at + 2] & 0xff) << 16
                    | (buf[at + 3] & 0xff) << 24;
        }

        long u32() {
            return Integer.toUnsignedLong(i32());
        }

        long u64() {
            long lo = u32();
            long hi = u32();
            return lo | hi << 32;
        }

        byte[] bytes(long n, String what) {
            int at = need(n, what);
            byte[] out = new byte[(int) n];
            System.arraycopy(buf, at, out, 0, (int) n);
            return out;
        }

        String str() {
            long n = u32();
            int at = need(n, "string");
            return utf8(buf, at, (int) n);
        }

        byte[] blob() {
            return bytes(u32(), "bytes");
        }

        void expectEnd(String what) {
            if (pos != end) {
                throw new FormatException(what + ": trailing bytes");
            }
        }
    }

    /** Little-endian writer. */
    static final class Writer {
        private final ByteArrayOutputStream out = new ByteArrayOutputStream();

        Writer u8(int v) {
            out.write(v);
            return this;
        }

        Writer u16(int v) {
            out.write(v);
            out.write(v >>> 8);
            return this;
        }

        Writer u32(long v) {
            out.write((int) v);
            out.write((int) (v >>> 8));
            out.write((int) (v >>> 16));
            out.write((int) (v >>> 24));
            return this;
        }

        Writer u64(long v) {
            u32(v);
            return u32(v >>> 32);
        }

        Writer raw(byte[] b) {
            out.write(b, 0, b.length);
            return this;
        }

        Writer str(String s) {
            byte[] b = s.getBytes(StandardCharsets.UTF_8);
            u32(b.length);
            return raw(b);
        }

        Writer blob(byte[] b) {
            u32(b.length);
            return raw(b);
        }

        byte[] toByteArray() {
            return out.toByteArray();
        }
    }
}
