package io.github.dphilla.weave.endive;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Protocol v2 framing, [type u8][len u32 LE][payload], as weave-core's wire.rs. */
final class Wire {
    static final int PROTO = 2;
    static final int ROLE_SOURCE = 1;
    static final int ROLE_TARGET = 2;

    static final int HELLO = 1;
    static final int MODULE_META = 2;
    static final int MODULE_NEED = 3;
    static final int MODULE_HAVE = 4;
    static final int MODULE_DATA = 5;
    static final int MODULE_OK = 6;
    static final int MEM_LAYOUT = 7;
    static final int PAGE = 8;
    static final int ROUND_END = 9;
    static final int ROUND_ACK = 10;
    static final int FINAL_BEGIN = 11;
    static final int GLOBALS = 12;
    static final int SERVICES = 13;
    static final int FINAL_END = 14;
    static final int PREPARED = 15;
    static final int ABORT = 16;
    static final int CTL_MIGRATE = 17;
    static final int CTL_STATUS = 18;
    static final int CTL_OK = 19;
    static final int CTL_ERR = 20;
    static final int COMMIT = 21;
    static final int COMMIT_OK = 22;
    static final int CTL_REQUEST = 23;
    static final int CTL_RESPONSE = 24;

    static final int MAX_FRAME = 64 << 20;
    static final int MAX_CONTROL = 65536;
    static final int MODULE_CHUNK = 256 << 10;
    static final int WPAGE = 4096;
    static final byte[] EMPTY = new byte[0];

    private Wire() {}

    static final class Frame {
        final int type;
        final byte[] payload;

        Frame(int type, byte[] payload) {
            this.type = type;
            this.payload = payload;
        }

        Bytes.Reader reader() {
            return new Bytes.Reader(payload);
        }
    }

    // Payload cap per frame type, checked before allocation; -1 rejects unknown types.
    static long cap(int type) {
        switch (type) {
            case MODULE_NEED:
            case MODULE_HAVE:
            case MODULE_OK:
            case ROUND_ACK:
            case FINAL_BEGIN:
            case PREPARED:
            case CTL_STATUS:
            case COMMIT:
            case COMMIT_OK:
                return 0;
            case ROUND_END:
                return 12;
            case FINAL_END:
                return 32;
            case PAGE:
                return 9 + WPAGE;
            case MEM_LAYOUT:
                return 1 + 255 * 8;
            case MODULE_DATA:
                return 8 + MODULE_CHUNK;
            case MODULE_META:
            case GLOBALS:
            case SERVICES:
                return MAX_FRAME;
            case HELLO:
            case ABORT:
            case CTL_MIGRATE:
            case CTL_OK:
            case CTL_ERR:
            case CTL_REQUEST:
            case CTL_RESPONSE:
                return MAX_CONTROL;
            default:
                return -1;
        }
    }

    static Frame read(InputStream in) throws IOException {
        Bytes.Reader header = new Bytes.Reader(readExact(in, 5));
        int type = header.u8();
        long len = header.u32();
        if (len > cap(type)) {
            throw new FormatException(
                    "frame type " + type + " is unknown or exceeds its size limit");
        }
        return new Frame(type, readExact(in, (int) len));
    }

    static void write(OutputStream out, int type, byte[] payload) throws IOException {
        if (payload.length > cap(type)) {
            throw new FormatException(
                    "frame type " + type + " payload too large: " + payload.length);
        }
        out.write(new Bytes.Writer().u8(type).u32(payload.length).toByteArray());
        out.write(payload);
    }

    private static byte[] readExact(InputStream in, int n) throws IOException {
        byte[] buf = in.readNBytes(n);
        if (buf.length < n) {
            throw new EOFException("connection closed");
        }
        return buf;
    }

    static byte[] hello(int role, String runtime) {
        return new Bytes.Writer().u8(PROTO).u8(role).str(runtime).toByteArray();
    }

    static byte[] abort(int code, String message) {
        return new Bytes.Writer().u32(code).str(bounded(message)).toByteArray();
    }

    static byte[] str(String s) {
        return new Bytes.Writer().str(bounded(s)).toByteArray();
    }

    // Messages are bounded to 2048 UTF-8 bytes, cut on a character boundary.
    static String bounded(String s) {
        byte[] b = Bytes.utf8(s);
        int end = Math.min(b.length, 2048);
        while (end < b.length && (b[end] & 0xc0) == 0x80) {
            end--;
        }
        return end == b.length ? s : Bytes.utf8(b, 0, end);
    }

    /** The error carried by an unexpected frame, preferring the peer's ABORT. */
    static IOException unexpected(Frame f, String expected) {
        if (f.type != ABORT) {
            return new IOException("expected " + expected + ", got frame " + f.type);
        }
        try {
            Bytes.Reader r = f.reader();
            long code = r.u32();
            return new IOException("peer aborted (" + code + "): " + r.str());
        } catch (FormatException e) {
            return new IOException("peer aborted with a malformed ABORT frame");
        }
    }
}
