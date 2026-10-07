package io.github.dphilla.weave.endive;

/** Bounded walk over a woven module's sections: {@code weave.meta} and the start-section check. */
final class WovenBytes {
    static final String META_SECTION = "weave.meta";

    private WovenBytes() {}

    /** Returns the raw {@code weave.meta} payload; rejects a core start section. */
    static byte[] metaPayload(byte[] wasm) {
        if (wasm.length < 8
                || wasm[0] != 0
                || wasm[1] != 'a'
                || wasm[2] != 's'
                || wasm[3] != 'm'
                || wasm[4] != 1
                || wasm[5] != 0
                || wasm[6] != 0
                || wasm[7] != 0) {
            throw new FormatException("not a wasm module");
        }
        byte[] meta = null;
        int[] pos = {8};
        while (pos[0] < wasm.length) {
            int id = wasm[pos[0]++] & 0xff;
            long size = leb(wasm, pos, wasm.length);
            if (size > wasm.length - pos[0]) {
                throw new FormatException("malformed wasm section");
            }
            int end = pos[0] + (int) size;
            if (id == 8) {
                throw new FormatException("woven migration module must not contain a start section");
            }
            if (id == 0 && meta == null) {
                long nameLen = leb(wasm, pos, end);
                if (nameLen > end - pos[0]) {
                    throw new FormatException("malformed custom section name");
                }
                String name = Bytes.utf8(wasm, pos[0], (int) nameLen);
                pos[0] += (int) nameLen;
                if (META_SECTION.equals(name)) {
                    meta = java.util.Arrays.copyOfRange(wasm, pos[0], end);
                }
            }
            pos[0] = end;
        }
        if (meta == null) {
            throw new FormatException("module has no weave.meta section");
        }
        return meta;
    }

    private static long leb(byte[] wasm, int[] pos, int limit) {
        long result = 0;
        for (int shift = 0; shift < 35; shift += 7) {
            if (pos[0] >= limit) {
                throw new FormatException("truncated LEB128");
            }
            int b = wasm[pos[0]++] & 0xff;
            if (shift == 28 && (b & 0xf0) != 0) {
                throw new FormatException("u32 LEB overflow");
            }
            result |= (long) (b & 0x7f) << shift;
            if ((b & 0x80) == 0) {
                return result;
            }
        }
        throw new FormatException("invalid u32 LEB");
    }
}
